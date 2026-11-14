"""오너클랜 공식 '상품 DB 다운로드' 엑셀(브라우저에서 필요한 열만 JSON으로 묶은 것) → 올채움 상품 CSV
사용: python3 tools/ownerclan_db_convert.py <grades.json> <set1.json> [set2.json ...]
 - grades.json: {상품코드: [공급사코드, icon번호, 묶음배송가능수량]} 또는 {"vendors": {공급사코드: icon번호}, "products": {...}, "clusters": {...}}
 - 공급사 등급 = 18 - icon번호. config sourcing.ownerclan_max_grade(8) 이하만 등록 (신규·주의·BAD·미확인 제외)
 - 착불만 되는 상품, 19세 상품, 상세페이지 없는 상품, KC 신고대상인데 인증정보 없는 상품 제외
 - 묶음배송가능수량이 '무제한'/N개로 명시된 경우에만 묶음 할인(배송비 절약형) 적용
 - 결과: data/오너클랜DB상품.csv (기존 오너클랜상품.csv 와 겹치는 코드는 이 파일에서 뺌)
"""
import csv, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from product_import import price_from_cost, SS_CATEGORY

CFG = json.load(open(ROOT / "config.json", encoding="utf-8"))
PRICING = CFG["pricing"]
MAX_GRADE = CFG.get("sourcing", {}).get("ownerclan_max_grade", 8)
OUT = ROOT / "data" / "오너클랜DB상품.csv"
EXIST = ROOT / "data" / "오너클랜상품.csv"
FIELDS = ["상품코드", "상품명", "카테고리코드", "카테고리명", "공급가", "공급 배송비", "묶음배송수량", "반품배송비", "교환배송비",
          "대표 이미지 주소", "브랜드", "제조사", "상세 설명", "인증정보", "옵션명", "옵션", "공급사등급"]


def grade_of(icon):
    return 18 - icon if isinstance(icon, int) and icon > 0 else None


def box_qty(s):
    s = (s or "").strip()
    if s == "무제한":
        return 99
    m = re.match(r"(\d+)개", s)
    return int(m.group(1)) if m else 0


def main(gpath, sets):
    G = json.load(open(gpath, encoding="utf-8"))
    prod = G.get("products", G)
    clusters = G.get("clusters", {})
    # 같은 상세 이미지 호스트(=같은 공급사) 묶음: 대표 상품의 공급사를 묶음 전체에 적용 (대표가 모두 같은 공급사일 때만)
    by_code = {}
    for key, codes in clusters.items():
        known = [prod[c] for c in codes if c in prod and prod[c][0] not in ("", "X")]
        vcs = {k[0] for k in known}
        if len(vcs) == 1:
            for c in codes:
                by_code.setdefault(c, known[0])
    for c, v in prod.items():
        if v[0] not in ("", "X"):
            by_code[c] = v
    exist = set()
    if EXIST.exists():
        exist = {r["상품코드"] for r in csv.DictReader(open(EXIST, encoding="utf-8-sig"))}
    out, skip, seen = [], {}, set()
    def no(reason):
        skip[reason] = skip.get(reason, 0) + 1
    for sp in sets:
        d = json.load(open(sp, encoding="utf-8"))
        h = d["h"]
        for r in d["rows"]:
            x = dict(zip(h, r))
            code = x["상품코드"]
            if code in seen or code in exist:
                no("중복"); continue
            v = by_code.get(code)
            g = grade_of(v[1]) if v else None
            if g is None:
                no("공급사 등급 미확인/신규·주의·BAD"); continue
            if g > MAX_GRADE:
                no(f"공급사 {MAX_GRADE}등급 초과"); continue
            if "금지" in (x.get("19세미만판매금지") or ""):
                no("19세"); continue
            try:
                cn = int(x.get("카테고리코드") or 0)
            except Exception:
                cn = 0
            if any(lo <= cn <= hi and slug == "food" for lo, hi, slug in SS_CATEGORY) or (x.get("카테고리명") or "").startswith("식품"):
                no("식품"); continue
            if (x.get("상품상태") or "").strip():
                no("상태 이상"); continue
            st = x.get("배송유형") or ""
            if "착불" in st:
                no("착불"); continue
            detail = x.get("본문상세설명") or ""
            if "<img" not in detail.lower():
                no("상세페이지 없음"); continue
            cert = (x.get("인증구분") or "").strip()
            if cert == "신고대상" and not (x.get("인증정보") or "").strip():
                no("KC 정보 없음"); continue
            try:
                base = int(float(x["오너클랜판매가"]))
            except Exception:
                no("가격 없음"); continue
            if base <= 0:
                no("가격 없음"); continue
            ship = int(float(x.get("배송비") or 0)) if "무료" not in st else 0
            bq = box_qty(v[2])
            base_price = price_from_cost(base + ship, PRICING)
            opts = []
            for line in (x.get("조합형옵션") or "").splitlines():
                p = line.rsplit(",", 2)
                if len(p) != 3:
                    continue
                name, add, stock = p
                try:
                    add, stock = int(float(add)), int(float(stock))
                except Exception:
                    continue
                if stock <= 0 or not name.strip():
                    continue
                padd = price_from_cost(base + add + ship, PRICING) - base_price if add else 0
                opts.append(f"{name.strip().replace('|', '/').replace('=', '-')}={padd}")
            if (x.get("조합형옵션") or "").strip() and not opts:
                no("전 옵션 품절"); continue
            oname = " / ".join(n for n in (x.get("옵션1명"), x.get("옵션2명")) if n)
            ret = int(float(x.get("반품배송비") or 0) or 0)
            cert_txt = (x.get("인증정보") or "").strip() if cert not in ("신고대상 아님",) else ""
            out.append({"상품코드": code, "상품명": (x.get("원본상품명") or "").strip(), "카테고리코드": x.get("카테고리코드", ""),
                        "카테고리명": x.get("카테고리명", ""), "공급가": base, "공급 배송비": ship, "묶음배송수량": bq if ship else "",
                        "반품배송비": ret, "교환배송비": ret * 2, "대표 이미지 주소": x.get("이미지대", ""),
                        "브랜드": x.get("브랜드", ""), "제조사": x.get("제작/수입사", ""), "상세 설명": detail, "인증정보": cert_txt,
                        "옵션명": oname if len(opts) > 1 else "", "옵션": "|".join(opts) if len(opts) > 1 else "", "공급사등급": g})
            seen.add(code)
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS); w.writeheader(); w.writerows(out)
    print(f"오너클랜 DB {len(out)}개 저장 → {OUT.name}, 제외: {skip}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
