"""도매꾹 Open API로 도매매 새 상품 찾아 등록 (GitHub Actions에서 매일 실행, Claude 사용량 0)
- 도매꾹 카테고리(맨 끝 분류) 이름으로 도매매 상품 검색 → 상품정보 조회 → 기준 통과한 것만 data/도매매API상품.csv 에 추가
- 기준: 판매중·재고 있음·공급사 1~8등급·19세 아님·해외배송 아님·착불 아님·상세 이미지 사용 허락·상세페이지 있음
       식품·건강식품·의료·성인 분류 제외, 도매처 배송비 3,500원 이하(부피 큰 상품 제외)
- 배송비: '고정배송비'(주문당 1회)만 묶음 할인, 나머지는 1개 = 택배 1건
- 진행 상태(다음에 볼 카테고리·이미 본 상품)는 data/domeme_discover_state.json
환경변수: DOMEGGOOK_API_KEY, NEW_LIMIT(하루에 상품정보 조회할 최대 수, 기본 3000)
"""
import csv, json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from product_import import price_from_cost

KEY = os.environ.get("DOMEGGOOK_API_KEY", "")
NEW_LIMIT = int(os.environ.get("NEW_LIMIT", "10000"))
MAX_TOTAL = int(os.environ.get("MAX_TOTAL", "40000"))  # 정적 사이트(GitHub Pages 1GB) 한도 안전선 — 넘으면 상품 DB 모드로 전환 필요
PRICING = json.load(open(ROOT / "config.json", encoding="utf-8"))["pricing"]
OUT = ROOT / "data" / "도매매API상품.csv"
STATE = ROOT / "data" / "domeme_discover_state.json"
KWF = ROOT / "data" / "domeme_keywords.json"
EXISTING = [ROOT / "data" / f for f in ("도매매묶음상품.csv", "도매매상품.csv", "도매매API상품.csv")]
SKIP_CAT = ("식품", "건강", "의료", "성인", "의약", "다이어트", "담배", "주류")
MAX_RANK, MAX_SHIP, BUNDLE_BOX = 8, 3500, 10
FIELDS = ["상품코드", "상품명", "카테고리명", "공급가", "공급 배송비", "묶음배송수량", "반품배송비", "교환배송비",
          "대표 이미지 주소", "브랜드", "제조사", "상세 설명", "재고", "옵션명", "옵션", "공급사등급"]


def api(params):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    for t in range(3):
        try:
            with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception:
            time.sleep(3 * (t + 1))
    return {}


def num(s):
    try:
        return int(float(str(s).replace(",", "")))
    except Exception:
        return 0


def leaves(node, path, out):
    for v in (node or {}).values():
        p = path + [v.get("name", "")]
        if v.get("child"):
            leaves(v["child"], p, out)
        else:
            out.append(p)


def build_row(no, v):
    b, deli, sel = v.get("basis", {}), v.get("deli", {}), v.get("seller", {})
    if b.get("status") != "판매중" or b.get("adult") == "true":
        return None, "판매중 아님/19세"
    rank = num(sel.get("rank")) or 99
    if rank > MAX_RANK:
        return None, "공급사 등급"
    if deli.get("fromOversea") == "true":
        return None, "해외배송"
    if "선결제" not in (deli.get("pay") or "") and "선불" not in (deli.get("pay") or ""):
        return None, "착불"
    cat = v.get("category") or {}
    names = [e.get("name", "") for e in ((cat.get("parents") or {}).get("elem") or [])] + [(cat.get("current") or {}).get("name", "")]
    if any(k in n for n in names for k in SKIP_CAT):
        return None, "식품·건강·성인 분류"
    desc = v.get("desc") or {}
    if (desc.get("license") or {}).get("usable") != "true":
        return None, "이미지 사용 불가"
    html = (desc.get("contents") or {}).get("item") or ""
    if "<img" not in html.lower():
        return None, "상세페이지 없음"
    inv = num((v.get("qty") or {}).get("inventory"))
    if inv <= 0:
        return None, "재고 없음"
    price = num((v.get("price") or {}).get("supply"))
    if not price:
        return None, "가격 없음"
    sup = deli.get("supply") or deli.get("dome") or {}
    stype = sup.get("type", "")
    ship = 0 if "무료" in stype else num(sup.get("fee"))
    if ship > MAX_SHIP:
        return None, "배송비 큼"
    box = (BUNDLE_BOX if stype == "고정배송비" else 1) if ship else ""
    base = price_from_cost(price + ship, PRICING)
    opts, oname = [], ""
    so = v.get("selectOpt")
    if so:
        try:
            so = json.loads(so) if isinstance(so, str) else so
            oname = " / ".join(s.get("name", "") for s in so.get("set") or [])
            for o in (so.get("data") or {}).values():
                if o.get("sup") != "1" or o.get("hid") not in ("0", 0, None) or num(o.get("qty")) <= 0:
                    continue
                add = num(o.get("supPrice"))
                opts.append(f'{str(o.get("name", "")).replace("|", "/").replace("=", "-")}={price_from_cost(price + add + ship, PRICING) - base if add else 0}')
        except Exception:
            return None, "옵션 해석 실패"
        if not opts:
            return None, "전 옵션 품절"
    if len(opts) == 1:
        opts = []
    detail = v.get("detail") or {}
    ret = num((v.get("return") or {}).get("deliAmt"))
    thumb = (v.get("thumb") or {}).get("original", "")
    kw = (b.get("keywords") or {}).get("kw") or []
    return {"상품코드": "DM" + str(no), "상품명": b.get("title", "").strip(), "카테고리명": ">".join(n for n in names if n),
            "공급가": price, "공급 배송비": ship, "묶음배송수량": box, "반품배송비": ret, "교환배송비": ret * 2,
            "대표 이미지 주소": thumb.split("?")[0], "브랜드": "", "제조사": detail.get("manufacturer", ""), "상세 설명": html,
            "재고": inv, "옵션명": oname if opts else "", "옵션": "|".join(opts), "공급사등급": rank}, (kw if isinstance(kw, list) else [kw])


def main():
    if not KEY:
        sys.exit("DOMEGGOOK_API_KEY 없음")
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"cat": 0, "seen": {}}
    seen = state.setdefault("seen", {})
    have = set()
    for p in EXISTING:
        if p.exists():
            have |= {r["상품코드"][2:] for r in csv.DictReader(open(p, encoding="utf-8-sig"))}
    rows = list(csv.DictReader(open(OUT, encoding="utf-8-sig"))) if OUT.exists() else []
    kwmap = json.loads(KWF.read_text(encoding="utf-8")) if KWF.exists() else {}
    tree = (api({"ver": "1.0", "mode": "getCategoryList"}).get("domeggook") or {}).get("items") or {}
    cats = []
    leaves(tree, [], cats)
    cats = [c for c in cats if not any(k in n for n in c for k in SKIP_CAT)]
    if not cats:
        sys.exit("카테고리 목록을 못 받음")
    views, added, why, errs = 0, 0, {}, 0
    total = sum(1 for p in [ROOT / "data" / f for f in ("도매매묶음상품.csv", "도매매상품.csv", "오너클랜DB상품.csv", "오너클랜상품.csv")] if p.exists()
                for _ in csv.DictReader(open(p, encoding="utf-8-sig"))) + len(rows)
    ci = state.get("cat", 0) % len(cats)
    loops = 0
    while views < NEW_LIMIT and loops < len(cats) and total + added < MAX_TOTAL and errs < 20:
        kw = cats[ci][-1]
        ci = (ci + 1) % len(cats); loops += 1
        d = (api({"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": kw, "sz": "100", "pg": "1"}).get("domeggook") or {})
        items = (d.get("list") or {}).get("item") or []
        if isinstance(items, dict):
            items = [items]
        for it in items:
            no = str(it.get("no", ""))
            if not no or no in have or no in seen or it.get("adultOnly") == "true" or num((it.get("deli") or {}).get("fee")) > MAX_SHIP:
                continue
            if views >= NEW_LIMIT or total + added >= MAX_TOTAL or errs >= 20:
                break
            v = (api({"ver": "4.5", "mode": "getItemView", "no": no}).get("domeggook") or {})
            views += 1
            time.sleep(0.25)
            if not v or "basis" not in v:
                if not why.get("조회 실패"):
                    print("첫 조회 실패 응답:", str(v)[:300])
                why["조회 실패"] = why.get("조회 실패", 0) + 1
                errs += 1  # 연속 실패가 쌓이면(하루 호출 한도 등) 멈추고 내일 이어서
                continue
            errs = 0
            row, info = build_row(no, v)
            if row is None:
                seen[no] = info
                why[info] = why.get(info, 0) + 1
                continue
            rows.append(row); have.add(no); added += 1
            if info:
                kwmap["DM" + no] = info[:12]
        time.sleep(0.3)
    state["cat"] = ci
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
    STATE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    KWF.write_text(json.dumps(kwmap, ensure_ascii=False), encoding="utf-8")
    print(f"[전체 {total + added}개] 새 상품 {added}개 추가 (상품정보 조회 {views}회, 카테고리 {loops}개 검색) / 누적 {len(rows)}개 / 제외 사유 {why}")


if __name__ == "__main__":
    main()
