"""오너클랜 상품 조회 결과(JSON) → 땡잡았땡 상품 CSV (배송비 포함 원가 + 마진 12%)
사용: python3 tools/ownerclan_convert.py <oc_result.json>
 - 기존 data/직영상품.csv 에서 같은 코드 줄은 빼고(중복 방지) data/오너클랜상품.csv 로 저장
 - 상품명·카테고리코드는 기존 스마트스토어용 값을 그대로 씀(없으면 오너클랜 값)
"""
import csv, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from product_import import price_from_cost

PRICING = json.load(open(ROOT / "config.json", encoding="utf-8"))["pricing"]
OLD = ROOT / "data" / "직영상품.csv"
OUT = ROOT / "data" / "오너클랜상품.csv"


def won(s):
    m = re.search(r"([\d,]+)\s*원", s or "")
    return int(m.group(1).replace(",", "")) if m else 0


def main(src):
    res = json.load(open(src, encoding="utf-8"))
    res = res.get("res", res)
    old_rows = list(csv.DictReader(open(OLD, encoding="utf-8-sig")))
    old = {r["상품코드"]: r for r in old_rows}
    fields = ["상품코드", "상품명", "카테고리코드", "공급가", "공급 배송비", "대표 이미지 주소", "추가 이미지 주소", "원산지", "상세 설명", "옵션명", "옵션"]
    out, used, skipped = [], set(), []
    for code, x in res.items():
        if x.get("error") or not x.get("base") or x.get("stat") not in ("SELL", ""):
            skipped.append((code, x.get("error") or x.get("stat") or "가격없음")); continue
        ship = 0 if "무료" in (x.get("ship") or "") else won(x.get("ship"))
        cost = x["base"] + ship
        base_price = price_from_cost(cost, PRICING)
        opts = []
        for o in x.get("opts") or []:
            if o.get("so") or not o.get("v"):
                continue
            add = price_from_cost(o["p"] + ship, PRICING) - base_price if o.get("p") and o["p"] != x["base"] else 0
            opts.append(f"{o['v'].replace('|', '/').replace('=', '-')}={add}")
        if (x.get("opts") and not opts):
            skipped.append((code, "전 옵션 품절")); continue
        o_row = old.get(code, {})
        imgs = x.get("imgs") or []
        out.append({"상품코드": code, "상품명": o_row.get("상품명") or x.get("name"), "카테고리코드": o_row.get("카테고리코드", ""),
                    "공급가": x["base"], "공급 배송비": ship, "대표 이미지 주소": imgs[0] if imgs else o_row.get("대표 이미지 주소", ""),
                    "추가 이미지 주소": "|".join(imgs[1:9]), "원산지": o_row.get("원산지", ""), "상세 설명": x.get("detail", ""),
                    "옵션명": (x.get("optLabel") or o_row.get("옵션명", "")) if len(opts) > 1 else "", "옵션": "|".join(opts) if len(opts) > 1 else ""})
        used.add(code)
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(out)
    # 같은 코드는 기존 파일에서 제거 (조회 실패·품절 코드도 판매 중지 대상이므로 함께 제거)
    drop = used | {c for c, _ in skipped}
    keep = [r for r in old_rows if r["상품코드"] not in drop]
    with open(OLD, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(old_rows[0].keys())); w.writeheader(); w.writerows(keep)
    print(f"오너클랜 {len(out)}개 저장, 제외 {len(skipped)}개 {skipped[:10]}, 기존 파일 {len(old_rows)}→{len(keep)}개")


if __name__ == "__main__":
    main(sys.argv[1])
