"""도매매 '묶음배송상품DB' 엑셀(브라우저에서 필요한 열만 JSON으로 묶은 것) → 땡잡았땡 상품 CSV
사용: python3 tools/domeme_db_convert.py <domeme.json> [...]
 - 판매가설정 요율 0 으로 받은 DB → 판매가 = 도매매 공급가
 - 도매매 '묶음배송' 공급사 상품: 같은 공급사 상품은 한 상자로 묶여 배송비 1회 → 묶음배송수량(기본 10개, 조심스럽게) 적용
   단, 공급사가 '수량별 부과'를 명시했으면 그 수량을 씀
 - 착불만 되는 상품, 19세, 상세페이지·대표이미지 없는 상품, 식품 카테고리, 공급사 8등급 초과 제외
"""
import csv, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from product_import import price_from_cost, SS_CATEGORY

CFG = json.load(open(ROOT / "config.json", encoding="utf-8"))
PRICING = CFG["pricing"]
MAX_GRADE = CFG.get("sourcing", {}).get("domeme_max_grade", 8)
BUNDLE_BOX = 10
OUT = ROOT / "data" / "도매매묶음상품.csv"
EXIST = ROOT / "data" / "도매매상품.csv"
FIELDS = ["상품코드", "상품명", "카테고리코드", "공급가", "공급 배송비", "묶음배송수량", "무료배송기준금액", "반품배송비", "교환배송비",
          "대표 이미지 주소", "브랜드", "제조사", "상세 설명", "재고", "인증정보", "옵션명", "옵션", "공급사등급"]


def num(s):
    try:
        return int(float(str(s).replace(",", "").strip() or 0))
    except Exception:
        return 0


def is_food(code):
    n = num(code)
    return any(lo <= n <= hi and slug == "food" for lo, hi, slug in SS_CATEGORY)


def split(s):
    s = s or ""
    return s.split("\n") if "\n" in s else s.split(",")


def main(paths):
    exist = set()
    if EXIST.exists():
        exist = {r["상품코드"] for r in csv.DictReader(open(EXIST, encoding="utf-8-sig"))}
    out, skip, seen = [], {}, set()
    def no(r):
        skip[r] = skip.get(r, 0) + 1
    for p in paths:
        d = json.load(open(p, encoding="utf-8"))
        h = d["h"]
        for r in d["rows"]:
            x = dict(zip(h, r))
            code = "DM" + str(x.get("판매자 상품코드", "")).strip()
            name = (x.get("상품명") or "").strip()
            cost = num(x.get("판매가"))
            if code == "DM" or not name or not cost:
                no("정보 부족"); continue
            if code in seen or code in exist:
                no("중복"); continue
            g = num(x.get("grade"))
            if not g or g > MAX_GRADE:
                no("공급사 등급"); continue
            if (x.get("미성년자 구매") or "").strip().upper() == "N":
                no("19세"); continue
            if num(x.get("재고수량")) <= 0:
                no("품절"); continue
            if is_food(x.get("카테고리ID")):
                no("식품"); continue
            img = (x.get("img") or "").split()
            if len(img) != 2:
                no("대표이미지 없음"); continue
            detail = x.get("상품 상세정보") or ""
            if "<img" not in detail.lower():
                no("상세페이지 없음"); continue
            st, pay = (x.get("배송비 유형") or "").strip(), (x.get("배송비 결제방식") or "")
            ship = 0
            if st not in ("무료", ""):
                if pay and "선결제" not in pay:
                    no("착불"); continue
                ship = num(x.get("기본배송비"))
            box = num(x.get("수량별부과-수량")) if "수량" in st else 0
            if ship and not box:
                box = BUNDLE_BOX  # 도매매 묶음배송 공급사: 여러 개 사도 배송비 1회
            free_over = num(x.get("조건부무료-상품판매가합계")) if "조건" in st else 0
            base = price_from_cost(cost + ship, PRICING)
            vals, adds, stocks = split(x.get("옵션값")), split(x.get("옵션가")), split(x.get("옵션 재고수량"))
            vals = [v for v in vals if v.strip()] if (x.get("옵션값") or "").strip() else []
            opts = []
            for i, v in enumerate(vals):
                a = num(adds[i]) if i < len(adds) else 0
                s = (stocks[i].strip() if i < len(stocks) else "")
                if s == "0":
                    continue
                opts.append(f"{v.strip().replace('|', '/').replace('=', '-')}={price_from_cost(cost + a + ship, PRICING) - base if a else 0}")
            if vals and not opts:
                no("전 옵션 품절"); continue
            if len(opts) == 1:
                opts = []
            cert = (x.get("상품정보제공고시 인증허가사항") or "").strip()
            out.append({"상품코드": code, "상품명": name, "카테고리코드": x.get("카테고리ID", ""), "공급가": cost, "공급 배송비": ship,
                        "묶음배송수량": box or "", "무료배송기준금액": free_over or "", "반품배송비": num(x.get("반품배송비")), "교환배송비": num(x.get("교환배송비")),
                        "대표 이미지 주소": f"https://cdn1.domeggook.com/upload/item/{img[0]}/{img[1]}/{img[1]}_img_760",
                        "브랜드": (x.get("브랜드") or "").strip(), "제조사": (x.get("제조사") or "").strip(), "상세 설명": detail,
                        "재고": num(x.get("재고수량")), "인증정보": "" if cert in ("", "해당사항없음", "상세설명참조") else cert,
                        "옵션명": (x.get("옵션명") or "") if opts else "", "옵션": "|".join(opts), "공급사등급": g})
            seen.add(code)
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(out)
    print(f"도매매 묶음배송 {len(out)}개 저장 → {OUT.name}, 제외: {skip}")


if __name__ == "__main__":
    main(sys.argv[1:])
