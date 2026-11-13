"""오너클랜 상품 조회 결과(JSON, ownerclan_convert 와 같은 형식) → 재고·가격 확인 결과(stock_sync 형식)
사용: python3 tools/ownerclan_stock.py <oc_result.json> > /tmp/oc_stock.json && python3 tools/stock_sync.py /tmp/oc_stock.json
 - 판매중지·가격없음·전 옵션 품절 → 품절, 다시 팔리면 품절 해제
 - 원가 = 판매가 + 유료 배송비 (바뀌면 12% 공식으로 판매가 다시 계산)
 - 품절 옵션은 옵션 목록에서 [품절] 표시
"""
import json, re, sys


def won(s):
    m = re.search(r"([\d,]+)\s*원", s or "")
    return int(m.group(1).replace(",", "")) if m else 0


def main(src):
    res = json.load(open(src, encoding="utf-8"))
    res = res.get("res", res)
    out = {"source": "ownerclan", "checked": [], "soldout": [], "cost": {}, "opts_soldout": {}}
    for code, x in res.items():
        out["checked"].append(code)
        if x.get("error") or not x.get("base") or x.get("soldout") or x.get("stat") not in ("SELL", ""):
            out["soldout"].append(code); continue
        ship = 0 if "무료" in (x.get("ship") or "") else won(x.get("ship"))
        out["cost"][code] = x["base"] + ship
        gone = [o["v"] for o in x.get("opts") or [] if o.get("so")]
        if gone:
            out["opts_soldout"][code] = gone
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1])
