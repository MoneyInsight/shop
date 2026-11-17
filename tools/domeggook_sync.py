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
sys.path.insert(0, str(ROOT))
KEY = os.environ.get("DOMEGGOOK_API_KEY", "")
LIMIT = int(os.environ.get("LIMIT", "4000"))
CACHE = ROOT / "data" / "domeme_api_cache.json"
CSVS = [ROOT / "data" / "도매매묶음상품.csv", ROOT / "data" / "도매매상품.csv", ROOT / "data" / "도매매API상품.csv"]
MAX_RANK = 8
BUNDLE_BOX = 1  # 고정배송비 = 1개마다 배송비 (대표님 확인)


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
    if v.get("errors") or not v.get("basis"):  # 호출 한도 초과 등 오류 응답은 '품절'로 오해하지 않고 건너뜀 (다음 점검에서 다시)
        return {"err": str(v.get("errors") or "빈 응답")[:200]}
    b, deli, sel = v.get("basis", {}), v.get("deli", {}), v.get("seller", {})
    sup = deli.get("supply") or {}  # 도매매(위탁) 배송정보만 (도매꾹 도매 배송정보로 대신하지 않음)
    kw = (b.get("keywords") or {}).get("kw") or []
    if isinstance(kw, str):
        kw = [kw]
    price = (v.get("price") or {}).get("supply")
    resale = (v.get("price") or {}).get("resale") or {}
    minp = resale.get("minimum") if isinstance(resale, dict) else ""
    opts, oname, so = [], "", v.get("selectOpt")
    if so:  # 도매처 옵션 그대로 (위탁 판매 가능·숨김 아님·재고 있는 것만)
        try:
            so = json.loads(so) if isinstance(so, str) else so
            oname = " / ".join(x.get("name", "") for x in so.get("set") or [])
            opts = [[str(o.get("name", "")).replace("|", "/").replace("=", "-"), num(o.get("supPrice"))] for o in (so.get("data") or {}).values()
                    if o.get("sup") == "1" and o.get("hid") in ("0", 0, None) and num(o.get("qty")) > 0]
            if not opts:
                opts = "soldout"
        except Exception:
            opts = None
    unit = num((v.get("qty") or {}).get("supplyUnit")) or 1  # 위탁 판매 단위 (2 이상이면 낱개 주문 불가)
    return {"unit": unit, "opts": opts, "oname": oname, "minp": minp or "", "status": b.get("status", ""), "adult": b.get("adult", ""), "rank": str(sel.get("rank", "")),
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
    zero = {r["상품코드"][2:] for rows in rows_by_file.values() for r in rows if r["상품코드"].startswith("DM") and num(r.get("공급 배송비")) == 0}
    codes = list(dict.fromkeys(codes))
    codes.sort(key=lambda c: (c not in zero or bool(cache.get(c, {}).get("checked")), cache.get(c, {}).get("checked", "")))  # 배송비 0(확인 전) 먼저
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
    done = 0
    t0, max_min = time.time(), float(os.environ.get("MAX_MIN", "290"))  # 작업 제한 시간 전에 멈추고 여기까지 저장 (통째로 날리지 않게)
    for c in codes[:LIMIT]:
        if time.time() - t0 > max_min * 60:
            print(f"시간 다 됨 → {done}개까지 반영, 나머지는 다음 점검에서")
            break
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
            if "minp" in info and str(num(info.get("minp")) or "") != str(r.get("공급사최저판매가") or ""):
                r["공급사최저판매가"] = str(num(info.get("minp")) or ""); repriced += 1
            if num(info.get("unit")) > 1:  # 판매 단위가 묶음(예: 10개 단위)인 상품은 낱개로 팔면 손해 → 내림
                soldout.append(c); continue
            if info.get("opts") == "soldout":
                soldout.append(c); continue
            if isinstance(info.get("opts"), list) and "옵션" in r:  # 옵션을 도매처와 똑같이 (추가금은 원가 차이만큼 판매가에 반영)
                from product_import import price_from_cost
                PR = json.load(open(ROOT / "config.json", encoding="utf-8"))["pricing"]
                cost0, sh0 = num(r.get("공급가")), num(r.get("공급 배송비"))
                base = price_from_cost(cost0 + sh0, PR)
                ol = info["opts"]
                newo = "|".join(f'{n}={price_from_cost(cost0 + a + sh0, PR) - base if a else 0}' for n, a in ol) if len(ol) > 1 else ""
                newn = info.get("oname", "") if newo else ""
                if r.get("옵션", "") != newo or r.get("옵션명", "") != newn:
                    r["옵션"], r["옵션명"] = newo, newn; changed += 1
            ship = num(r.get("공급 배송비"))
            import dm_ship  # 배송 규칙 해석은 새 상품 찾기·결제 직전 확인과 같은 함수로 (고정 = 주문당 1번, 수량별비례 = N개마다)
            try:
                fee2, box = dm_ship.parse(json.loads(info.get("ship_raw") or "{}"))
            except Exception:
                fee2, box = num(info.get("ship_fee")), "1"
            if info.get("pay", "선결제") != "선결제":
                box = "1"  # 착불 등은 1개마다 (손해 방지)
            if fee2 and fee2 != ship:
                r["공급 배송비"] = str(fee2); ship = fee2; repriced += 1
            if ship and "묶음배송수량" in r:
                box = str(box)
                fixed += box != "1"
                if r.get("묶음배송수량") != box:
                    r["묶음배송수량"] = box; changed += 1
        with open(p, "w", encoding="utf-8-sig", newline="") as f:
            keys = list(rows[0].keys()) + (["공급사최저판매가"] if any("공급사최저판매가" in r for r in rows) and "공급사최저판매가" not in rows[0] else [])
            w = csv.DictWriter(f, fieldnames=keys, restval=""); w.writeheader(); w.writerows(rows)
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
