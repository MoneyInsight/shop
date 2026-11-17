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
sys.path.insert(0, str(Path(__file__).resolve().parent))
NEW_LIMIT = int(os.environ.get("NEW_LIMIT", "10000"))
MAX_TOTAL = int(os.environ.get("MAX_TOTAL", "96000"))  # 정적 사이트(GitHub Pages 1GB) 한도 안전선 — 넘으면 상품 DB 모드로 전환 필요
PRICING = json.load(open(ROOT / "config.json", encoding="utf-8"))["pricing"]
OUT = ROOT / "data" / "도매매API상품.csv"
STATE = ROOT / "data" / "domeme_discover_state.json"
KWF = ROOT / "data" / "domeme_keywords.json"
WH = ROOT / "warehouse"  # 상품 창고: 사이트 한도(MAX_TOTAL)를 넘는 상품은 여기로 → 상품 DB(D1)에만 올림
WH_MAX = int(os.environ.get("WH_MAX", "1000000"))
ADD_TARGET = int(os.environ.get("ADD_TARGET", "27000"))  # 하루 새 상품 목표 (도매꾹 하루 호출 한도에 먼저 닿으면 거기서 멈춤)
MAX_MIN = float(os.environ.get("MAX_MIN", "290"))
TOP_PAGES = int(os.environ.get("TOP_PAGES", "5"))  # 분류마다 도매꾹 랭킹순(인기순) 상위 5쪽(500개)까지만 — 인기 없는 상품은 안 가져옴  # 실행 시간 상한(분) — GitHub 작업 6시간 제한 안에서 저장까지
EXISTING = [ROOT / "data" / f for f in ("도매매묶음상품.csv", "도매매상품.csv", "도매매API상품.csv")]
SKIP_CAT = ("식품", "건강", "의료", "성인", "의약", "다이어트", "담배", "주류")


def skip_cat(names):
    """건강기능식품(식품>건강식품)은 판매업 신고가 있어 가져오고, 다이어트식품·일반 식품·의료·성인은 제외"""
    names = [n for n in names if n]
    if len(names) >= 2 and names[0] == "식품" and names[1] == "건강식품" and not any("다이어트" in n for n in names):
        return False
    return any(k in n for n in names for k in SKIP_CAT)
MAX_RANK, MAX_SHIP, BUNDLE_BOX = 8, 3500, 1  # 고정배송비 = 1개마다 배송비 (대표님 확인)
FIELDS = ["상품코드", "상품명", "카테고리명", "공급가", "공급 배송비", "묶음배송수량", "반품배송비", "교환배송비",
          "대표 이미지 주소", "브랜드", "제조사", "상세 설명", "재고", "옵션명", "옵션", "공급사등급", "공급사최저판매가"]


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
    sc = sel.get("score") or {}
    if num(sc.get("cnt")) >= 5 and num(str(sc.get("avg", "")).rstrip("%")) < 90:
        return None, "공급사 평점 90% 미만"  # 구매자 평가가 나쁜 공급사 제외
    if num(deli.get("sendAvg")) > 3:
        return None, "평균 발송 3일 초과"
    if deli.get("fromOversea") == "true":
        return None, "해외배송"
    if "선결제" not in (deli.get("pay") or "") and "선불" not in (deli.get("pay") or ""):
        return None, "착불"
    cat = v.get("category") or {}
    names = [e.get("name", "") for e in ((cat.get("parents") or {}).get("elem") or [])] + [(cat.get("current") or {}).get("name", "")]
    if skip_cat(names):
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
    sup = deli.get("supply") or {}  # 도매매(위탁) 배송정보만 씀 — 도매꾹(도매·최소구매수량) 배송정보로 대신하면 배송비 0원으로 잘못 잡힘
    if not sup:
        return None, "도매매 배송정보 없음"
    import dm_ship
    ship, box = dm_ship.parse(sup)  # 고정배송비 = 주문당 1번(빈칸), 수량별비례 = N개마다, 차등 = 첫 구간마다
    if num((v.get("qty") or {}).get("supplyUnit")) > 1:
        return None, "묶음 판매 단위"
    if ship > MAX_SHIP:
        return None, "배송비 큼"
    if not ship and "무료" not in str(sup.get("type") or ""):
        return None, "배송비 확인 불가"  # 배송비를 못 읽었는데 무료로 올리면 손해
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
            "재고": inv, "옵션명": oname if opts else "", "옵션": "|".join(opts), "공급사등급": rank,
            "공급사최저판매가": num(((v.get("price") or {}).get("resale") or {}).get("minimum") if isinstance((v.get("price") or {}).get("resale"), dict) else 0) or ""}, (kw if isinstance(kw, list) else [kw])


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
    import gzip, io, datetime
    WH.mkdir(exist_ok=True)
    wh_have = 0
    for p in WH.glob("dm_*.csv.gz"):
        for r in csv.DictReader(io.StringIO(gzip.decompress(p.read_bytes()).decode("utf-8-sig"))):
            have.add(r["상품코드"][2:]); wh_have += 1
    wh_rows = []
    pgs = state.setdefault("pg", {})
    kwmap = json.loads(KWF.read_text(encoding="utf-8")) if KWF.exists() else {}
    raw = api({"ver": "1.0", "mode": "getCategoryList"})
    tree = (raw.get("domeggook") or {}).get("items") or {}
    CATF = ROOT / "data/domeggook_cats.json"  # 분류 목록은 거의 안 바뀜 → 받아지면 저장, 못 받으면 저장본으로 계속 (API 오류로 수집이 통째로 멈추지 않게)
    if tree:
        CATF.write_text(json.dumps(tree, ensure_ascii=False), encoding="utf-8")
    else:
        print("분류 목록 못 받음 — 응답:", str(raw)[:300])
        if CATF.exists():
            tree = json.loads(CATF.read_text(encoding="utf-8")); print("저장해 둔 분류 목록 사용")
    cats = []
    leaves(tree, [], cats)
    print("도매꾹 분류(맨 끝):", len(cats), "개")
    cats = [c for c in cats if not skip_cat(c)]
    # 우선순위: ① 문구·사무·학용품 (기업 거래처용) ② 건강식품 ③ 나머지 — 매일 이 순서로 돌며 새 상품을 채움
    OFFICE = ("문구", "사무", "오피스", "학용품", "필기", "화일", "파일/바인더", "제도", "포장/배송")
    def prio(c):
        if any(k in n for n in c for k in OFFICE): return 0
        if len(c) > 1 and c[1] == "건강식품": return 1
        return 2
    BEAUTY = ("화장품", "뷰티", "미용", "스킨케어", "메이크업", "향수", "헤어케어", "바디케어", "네일")
    def focus(c):  # 화장품·건강기능식품 (대표님: 전부 가져오기)
        return any(k in n for n in c for k in BEAUTY) or (len(c) > 1 and c[1] == "건강식품")
    _p = prio
    prio = lambda c: 0 if focus(c) else _p(c) + 1
    cats.sort(key=prio)
    global TOP_PAGES
    if os.environ.get("FOCUS"):  # 화장품·건강식품만 깊게 (랭킹 상위 N쪽까지)
        cats = [c for c in cats if focus(c)]
        TOP_PAGES = int(os.environ.get("FOCUS_PAGES", "50"))
        state.setdefault("focus_cat", 0)
        print("집중 수집: 화장품·건강식품 분류", len(cats), "개, 분류마다", TOP_PAGES, "쪽까지")
    if not state.get("office_first"):
        state["office_first"] = True; state["supp_first"] = True; state["cat"] = 0
    print("우선 분류(문구·사무):", sum(1 for c in cats if prio(c) == 0), "개 / 건강식품:", sum(1 for c in cats if prio(c) == 1), "개")
    if not cats:
        sys.exit("카테고리 목록을 못 받음")
    views, added, why, errs = 0, 0, {}, 0
    total = 0  # 사이트 전체 상품 줄 수 (온채널 포함) — 1GB 한도 안전선
    for p in (ROOT / "data").glob("*.csv"):
        if p.name not in ("products.csv", "도매매API상품.csv"):
            total += sum(1 for _ in csv.reader(open(p, encoding="utf-8-sig"))) - 1
    total += len(rows)
    ck = "focus_cat" if os.environ.get("FOCUS") else "cat"
    ci = state.get(ck, 0) % len(cats)
    loops = 0
    t0 = time.time()
    def more():
        return (views < NEW_LIMIT and errs < 20 and added + len(wh_rows) < ADD_TARGET and wh_have + len(wh_rows) < WH_MAX
                and time.time() - t0 < MAX_MIN * 60)
    while more() and loops < len(cats) * max(30, TOP_PAGES):
        kw = cats[ci][-1]
        ci = (ci + 1) % len(cats); loops += 1
        pk = ("f:" if os.environ.get("FOCUS") else "") + kw  # 집중 수집은 쪽 번호를 따로 기억
        pg = int(pgs.get(pk, 1))
        d = (api({"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": kw, "sz": "100", "pg": str(pg), "so": "rd"}).get("domeggook") or {})
        items = (d.get("list") or {}).get("item") or []
        if isinstance(items, dict):
            items = [items]
        pgs[pk] = pg + 1 if len(items) >= 100 and pg < TOP_PAGES else 1  # 다음 방문 땐 다음 쪽 (끝까지 가면 처음부터)
        for it in items:
            no = str(it.get("no", ""))
            if not no or no in have or no in seen or it.get("adultOnly") == "true" or num((it.get("deli") or {}).get("fee")) > MAX_SHIP:
                continue
            if not more():
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
            if total + added < MAX_TOTAL:
                rows.append(row); added += 1  # 정적 사이트 (1GB 한도 안)
            else:
                wh_rows.append(row)  # 상품 창고 → 상품 DB
            have.add(no)
            if info:
                kwmap["DM" + no] = info[:12]
        time.sleep(0.3)
    state[ck] = ci
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
    if wh_rows:
        day = WH / f"dm_{datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))):%Y%m%d}.csv.gz"
        old = list(csv.DictReader(io.StringIO(gzip.decompress(day.read_bytes()).decode("utf-8-sig")))) if day.exists() else []
        buf = io.StringIO(); w = csv.DictWriter(buf, fieldnames=FIELDS); w.writeheader(); w.writerows(old + wh_rows)
        day.write_bytes(gzip.compress(buf.getvalue().encode("utf-8-sig"), 9))
    STATE.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    KWF.write_text(json.dumps(kwmap, ensure_ascii=False), encoding="utf-8")
    print(f"상품 창고: 새 {len(wh_rows)}개 / 창고 누적 {wh_have + len(wh_rows)}개")
    print(f"[전체 {total + added}개] 새 상품 {added}개 추가 (상품정보 조회 {views}회, 카테고리 {loops}개 검색) / 누적 {len(rows)}개 / 제외 사유 {why}")


if __name__ == "__main__":
    main()
