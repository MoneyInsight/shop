"""건강산 도매몰(ggsan.com) → data/건강산상품.csv
건강산은 로그인해야 가격·상세가 보여서, 대표님 로그인 브라우저에서 읽은 값 3개를 씀:
- data/ggsan_products.json : 상품명·대표사진·상세사진 (브라우저에서 내려받은 파일)
- data/ggsan_prices.txt    : 상품번호끝5자리,분류,정가,공급가,배송비,무료배송기준,품절(1) ; 구분
- data/ggsan_minprice.txt  : 상품번호끝5자리:공급사최저판매가[:i] , 구분 (i = 유통기한 임박·반품불가 → 안 올림)
가격: 순마진 10% (config pricing.source_margin.GS), 공급사 최저판매가가 있으면 그 가격 이상 (product_import 공급사최저판매가)
배송비: 주문당 3,000원 (GS 규칙)
"""
import csv, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAT = {"눈건": "눈건강", "간건": "간건강", "건강": "건강기능식품기타", "혈행": "혈행건강", "비타": "비타민/미네랄", "전립": "전립선건강",
       "관절": "관절/뼈건강", "장건": "장건강", "다이": "다이어트/뷰티", "반려": "반려동물용품", "생활": "생활/뷰티"}
SUPP = {"눈건", "간건", "건강", "혈행", "비타", "전립", "관절", "장건", "다이"}


def main():
    prices = {x.split(",")[0]: x.split(",") for x in (ROOT / "data/ggsan_prices.txt").read_text(encoding="utf-8").strip().split(";") if x}
    mins = {}
    for x in (ROOT / "data/ggsan_minprice.txt").read_text(encoding="utf-8").strip().split(","):
        p = x.split(":")
        mins[p[0]] = (int(p[1]), len(p) > 2 and p[2] == "i")
    info = {str(d["no"])[-5:]: d for d in json.loads((ROOT / "data/ggsan_products.json").read_text(encoding="utf-8")) if not d.get("err")}
    out, skip = [], {"품절": 0, "가격없음": 0, "임박·반품불가": 0, "정보없음": 0}
    for no5, (_, cat, fixed, price, ship, free, so) in prices.items():
        d = info.get(no5) or {}
        if so == "1":
            skip["품절"] += 1; continue
        if int(price) <= 0:
            skip["가격없음"] += 1; continue
        mp, imm = mins.get(no5, (0, False))
        if imm:
            skip["임박·반품불가"] += 1; continue
        if not d.get("name") or not d.get("img") or not d.get("det"):
            skip["정보없음"] += 1; continue
        detail = "".join(f'<img src="{s}" alt="">' for s in d["det"][:40])
        out.append({"상품코드": "GS10000" + no5, "상품명": d["name"][:100],
                    "카테고리명": ("식품>건강식품>" + CAT[cat]) if cat in SUPP else ("생활/건강>반려동물" if cat == "반려" else ""),
                    "공급가": price, "공급 배송비": ship if int(ship) > 0 else "3000", "묶음배송수량": "0", "공급사최저판매가": mp or "",
                    "대표 이미지 주소": d["img"], "추가 이미지 주소": "|".join(i for i in (d.get("imgs") or []) if i != d["img"])[:1000],
                    "상세 설명": detail})
    with open(ROOT / "data/건강산상품.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
    print(f"건강산상품.csv {len(out)}개 · 제외 {skip}")
    if len(out) < 100:
        sys.exit("상품이 너무 적음 — 확인 필요")


if __name__ == "__main__":
    main()
