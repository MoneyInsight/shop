"""도매처 재고·가격 확인 결과를 data/stock.json 에 합치는 도구
사용: python3 tools/stock_sync.py <결과.json> [...]
결과.json 형식 (도매처마다 하나):
  {"source": "domeme" | "ownerclan" | "기타",
   "checked": ["코드", ...],          # 이번에 확인한 상품 (없으면 soldout·cost에 나온 것만 갱신)
   "soldout": ["코드", ...],          # 품절·판매중지·단종
   "cost": {"코드": 배송비포함원가},   # 도매가가 바뀐 상품
   "opts_soldout": {"코드": ["옵션값", ...]}}
코드 규칙: 도매매 상품번호는 앞에 DM 을 붙여 쇼핑몰 코드로 바꿈, 오너클랜 W코드는 그대로.
확인 대상인데 품절 목록에 없으면 → 판매 재개(품절 해제).
"""
import datetime, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STOCK = ROOT / "data" / "stock.json"


def code_of(source, c):
    c = str(c).strip()
    return ("DM" + c) if source == "domeme" and not c.startswith("DM") else c


def merge(paths):
    st = json.loads(STOCK.read_text(encoding="utf-8")) if STOCK.exists() else {"items": {}}
    items = st.setdefault("items", {})
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
    report = {"품절": [], "재입고": [], "가격변동": []}
    for p in paths:
        r = json.load(open(p, encoding="utf-8"))
        src = r.get("source", "")
        sold = {code_of(src, c) for c in r.get("soldout", [])}
        checked = {code_of(src, c) for c in r.get("checked", [])} | sold | {code_of(src, c) for c in r.get("cost", {})}
        for c in checked:
            it = items.setdefault(c, {})
            was = bool(it.get("soldout"))
            it["soldout"] = c in sold
            it["checked"] = now
            if it["soldout"] and not was: report["품절"].append(c)
            if was and not it["soldout"]: report["재입고"].append(c)
        for c, v in r.get("cost", {}).items():
            c = code_of(src, c); it = items.setdefault(c, {})
            if int(v) and it.get("cost") != int(v):
                report["가격변동"].append(c); it["cost"] = int(v)
        for c, vs in r.get("opts_soldout", {}).items():
            items.setdefault(code_of(src, c), {})["opts_soldout"] = vs
    st["updated"] = now
    STOCK.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: len(v) for k, v in report.items()}, ensure_ascii=False), {k: v[:10] for k, v in report.items() if v})
    return report


if __name__ == "__main__":
    merge(sys.argv[1:])
