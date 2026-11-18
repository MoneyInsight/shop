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
# 사이트별 설정: --site cmt = 화장품스토리(cmtstory.com, 같은 회사 건강산의 화장품 도매몰) → 코드 CM, 뷰티·미용
SITE = "cmt" if "--site" in sys.argv and sys.argv[sys.argv.index("--site") + 1] == "cmt" else "gs"
S = {"gs": {"pre": "GS", "files": ("ggsan_prices.txt", "ggsan_minprice.txt", "ggsan_products.json"), "out": "건강산상품.csv"},
     "cmt": {"pre": "CM", "files": ("cmt_prices.txt", "cmt_minprice.txt", "cmt_products.json"), "out": "화장품스토리상품.csv"}}[SITE]
ARGS = [a for i, a in enumerate(sys.argv[1:], 1) if a != "--site" and sys.argv[i - 1] != "--site"]
CAT = {"눈건": "눈건강", "간건": "간건강", "건강": "건강기능식품기타", "혈행": "혈행건강", "비타": "비타민/미네랄", "전립": "전립선건강",
       "관절": "관절/뼈건강", "장건": "장건강", "다이": "다이어트/뷰티", "반려": "반려동물용품", "생활": "생활/뷰티"}
SUPP = {"눈건", "간건", "건강", "혈행", "비타", "전립", "관절", "장건", "다이"}


def from_full(path):
    """ggsan_crawl.js 결과(가격·최저가·임박 포함) → 이 스크립트가 쓰는 세 파일로 갱신"""
    items = [d for d in json.loads(Path(path).read_text(encoding="utf-8")) if not d.get("err")]
    short = {v: k for k, v in CAT.items()}
    (ROOT / "data" / S["files"][0]).write_text(";".join(f'{str(d["no"])[-5:]},{short.get(d["cat"], d["cat"][:2])},{d.get("fixed", 0)},{d.get("price", 0)},{d.get("ship", 0)},200000,{1 if d.get("so") else 0}' for d in items), encoding="utf-8")
    (ROOT / "data" / S["files"][1]).write_text(",".join(f'{str(d["no"])[-5:]}:{d.get("min", 0)}' + (":i" if d.get("imm") else "") for d in items if not d.get("so") and d.get("price")), encoding="utf-8")
    (ROOT / "data" / S["files"][2]).write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    print(f"건강산 최신 정보 {len(items)}개 반영")


def main():
    if ARGS:
        from_full(ARGS[0])
    prices = {x.split(",")[0]: x.split(",") for x in (ROOT / "data" / S["files"][0]).read_text(encoding="utf-8").strip().split(";") if x}
    mins = {}
    for x in (ROOT / "data" / S["files"][1]).read_text(encoding="utf-8").strip().split(","):
        p = x.split(":")
        mins[p[0]] = (int(p[1]), len(p) > 2 and p[2] == "i")
    info = {str(d["no"])[-5:]: d for d in json.loads((ROOT / "data" / S["files"][2]).read_text(encoding="utf-8")) if not d.get("err")}
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
        full_no = str(d.get("no") or ("10000" + no5))
        out.append({"상품코드": S["pre"] + full_no, "쇼핑몰카테고리": "뷰티·미용" if SITE == "cmt" else "", "상품명": d["name"][:100],
                    "카테고리명": ("식품>건강식품>" + CAT[cat]) if cat in SUPP else ("생활/건강>반려동물" if cat == "반려" else ""),
                    "공급가": price, "공급 배송비": ship if int(ship) > 0 else "3000", "묶음배송수량": "0", "공급사최저판매가": mp or "",
                    "대표 이미지 주소": d["img"], "추가 이미지 주소": "|".join(i for i in (d.get("imgs") or []) if i != d["img"])[:1000],
                    "상세 설명": detail})
    with open(ROOT / "data" / S["out"], "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
    print(f"{S['out']} {len(out)}개 · 제외 {skip}")
    if len(out) < (30 if SITE == "cmt" else 100):
        sys.exit("상품이 너무 적음 — 확인 필요")


if __name__ == "__main__":
    main()
