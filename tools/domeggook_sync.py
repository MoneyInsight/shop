"""도매꾹 Open API로 도매매 상품 매일 점검 (GitHub Actions에서 실행, Claude 사용량 0)
- 상품마다 상품정보(getItemView)를 조회해 캐시(data/domeme_api_cache.json)에 저장 — 하루 최대 LIMIT개씩 순서대로 돌아가며 갱신
- 배송비 방식: '고정배송비'(주문당 1회)로 확인된 상품만 묶음(여러 개 사도 택배비 1회) 할인 → data/도매매묶음상품.csv 의 묶음배송수량 갱신
  그 밖(수량별·차등·미확인)은 1개 = 택배 1건 (손해 방지)
- 공급사 등급 8등급 초과·판매중지·재고 0·19세 → 품절 처리 (data/stock.json, tools/stock_sync.py 형식)
- 도매가·배송비 변동 → 원가 갱신 (가격 12% 기준 자동 재계산)
- 공급사 검색 키워드 → data/domeme_keywords.json (상품 태그·검색 노출에 사용)
환경변수: DOMEGGOOK_API_KEY, LIMIT(기본 4000)
"""
import csv, datetime, json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY = os.environ.get("DOMEGGOOK_API_KEY", "")
LIMIT = int(os.environ.get("LIMIT", "4000"))
CACHE = ROOT / "data" / "domeme_api_cache.json"
CSVS = [ROOT / "data" / "도매매묶음상품.csv", ROOT / "data" / "도매매상품.csv"]
MAX_RANK = 8
BUNDLE_BOX = 10


def view(no):
    q = urllib.parse.urlencode({"ver": "4.5", "mode": "getItemView", "no": no, "aid": KEY, "om": "json"})
    for t in range(3):
        try:
            with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=30) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            return d.get("domeggook") or {"_err": str(d)[:200]}
        except Exception as e:
            err = str(e)
            time.sleep(3 * (t + 1))
    return {"_err": err}


def summarize(v):
    if "_err" in v:
        return {"err": v["_err"][:200]}
    b, deli, sel = v.get("basis", {}), v.get("deli", {}), v.get("seller", {})
    sup = deli.get("supply") or deli.get("dome") or {}
    kw = (b.get("keywords") or {}).get("kw") or []
    if isinstance(kw, str):
        kw = [kw]
    price = (v.get("price") or {}).get("supply")
    return {"status": b.get("status", ""), "adult": b.get("adult", ""), "rank": str(sel.get("rank", "")),
            "ship_type": sup.get("type", ""), "ship_fee": sup.get("fee", ""), "ship_raw": json.dumps(sup, ensure_ascii=False)[:300],
            "pay": deli.get("pay", ""), "merge": (deli.get("merge") or {}).get("enable", ""),
            "price": price, "inv": (v.get("qty") or {}).get("inventory", ""), "kw": kw[:12]}


def num(s):
    try:
        return int(float(str(s).replace(",", "")))
    except Exception:
        return 0


def main():
    if not KEY:
        sys.exit("DOMEGGOOK_API_KEY 없음")
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    rows_by_file = {p: list(csv.DictReader(open(p, encoding="utf-8-sig"))) for p in CSVS if p.exists()}
    codes = [r["상품코드"][2:] for rows in rows_by_file.values() for r in rows if r["상품코드"].startswith("DM")]
    # 한 번도 안 본 상품 먼저, 그다음 오래전에 본 순서
    codes.sort(key=lambda c: cache.get(c, {}).get("checked", ""))
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
    done = 0
    for c in codes[:LIMIT]:
        s = summarize(view(c))
        s["checked"] = today
        cache[c] = s
        done += 1
        time.sleep(0.25)
        if done % 500 == 0:
            print("조회", done)
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    # 1) 묶음배송수량·원가 갱신은 CSV에 바로 (수량 할인표까지 새 원가로 다시 계산되게), 2) 품절은 stock 결과로
    fixed = changed = repriced = 0
    soldout, checked = [], []
    for p, rows in rows_by_file.items():
        for r in rows:
            c = r["상품코드"][2:]
            info = cache.get(c) or {}
            if not info or "err" in info:
                continue
            checked.append(c)
            rank = num(info.get("rank")) or 99
            if info.get("status") != "판매중" or num(info.get("inv")) <= 0 or rank > MAX_RANK or info.get("adult") == "true":
                soldout.append(c); continue
            if num(info.get("price")) and num(info.get("price")) != num(r.get("공급가")):
                r["공급가"] = str(num(info.get("price"))); repriced += 1
            ship = num(r.get("공급 배송비"))
            if ship and num(info.get("ship_fee")) and num(info.get("ship_fee")) != ship:
                r["공급 배송비"] = str(num(info.get("ship_fee"))); ship = num(info.get("ship_fee")); repriced += 1
            if ship and "묶음배송수량" in r:
                box = str(BUNDLE_BOX) if info.get("ship_type") == "고정배송비" and info.get("pay", "선결제") == "선결제" else "1"
                fixed += box != "1"
                if r.get("묶음배송수량") != box:
                    r["묶음배송수량"] = box; changed += 1
        with open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    res = ROOT / "data" / "_domeme_stock_result.json"
    res.write_text(json.dumps({"source": "domeme", "checked": checked, "soldout": soldout}, ensure_ascii=False), encoding="utf-8")

    # 3) 검색 키워드
    kw = {"DM" + c: v["kw"] for c, v in cache.items() if v.get("kw")}
    (ROOT / "data" / "domeme_keywords.json").write_text(json.dumps(kw, ensure_ascii=False), encoding="utf-8")
    types = {}
    for v in cache.values():
        types[v.get("ship_type") or v.get("err", "?")[:20]] = types.get(v.get("ship_type") or v.get("err", "?")[:20], 0) + 1
    print(f"이번 조회 {done}개 / 누적 {len(cache)}개 · 배송비 방식 {types} · 묶음 적용 {fixed}개(변경 {changed}) · 품절 {len(soldout)} · 원가변동 {repriced}")


if __name__ == "__main__":
    main()
