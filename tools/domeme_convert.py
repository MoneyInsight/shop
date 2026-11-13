"""도매매 스마트스토어용 DB 엑셀(판매가 요율 0 = 도매가) → 땡잡았땡 상품 CSV
사용: python3 tools/domeme_convert.py <SMARTSTORE_x.xlsx> [옵션품절 xlsx] [이미지목록 txt]
 - 판매가 열 = 도매가 → '공급가'로 넣어 쇼핑몰이 (도매가+배송비)+12% 가격을 계산
 - 유료·착불 배송비는 선결제가 되면 '공급 배송비'로 따로 넣음 (착불만 되는 상품은 제외)
 - 수량별 배송비(N개마다 1건)는 '묶음배송수량', 조건부 무료배송 기준은 '무료배송기준금액'으로 → 수량 할인 계산에 사용
 - 대표 이미지는 도매매 CDN 주소(이미지목록 txt: '상품번호 날짜 키')로 연결
 - 재고 0 옵션은 빼고, 옵션이 1개뿐이면 옵션 없이 등록
"""
import csv, json, math, sys
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from product_import import price_from_cost

PRICING = json.load(open(ROOT / "config.json", encoding="utf-8"))["pricing"]


def rows_of(path):
    ws = openpyxl.load_workbook(path, read_only=True).active
    rows = [[("" if v is None else str(v)).strip() for v in r] for r in ws.iter_rows(values_only=True)]
    return rows[0], rows[1:]


def main(src, sold_out=None, imgs=None, out=ROOT / "data" / "도매매상품.csv"):
    h, rows = rows_of(src)
    c = {k: i for i, k in enumerate(h)}
    img = {}
    if imgs and Path(imgs).exists():
        for line in open(imgs, encoding="utf-8"):
            p = line.split()
            if len(p) == 3:
                img[p[0]] = f"https://cdn1.domeggook.com/upload/item/{p[1]}/{p[2]}/{p[2]}_img_760"
    zero = set()
    if sold_out and Path(sold_out).exists():
        sh, srows = rows_of(sold_out)
        for r in srows:
            if r[4] in ("0", ""):
                zero.add((r[0], r[2]))
    fields = ["상품코드", "상품명", "카테고리코드", "공급가", "공급 배송비", "묶음배송수량", "무료배송기준금액", "반품배송비", "교환배송비", "대표 이미지 주소", "브랜드", "제조사", "원산지", "상세 설명", "재고", "옵션명", "옵션"]
    out_rows, skip = [], 0
    for r in rows:
        g = lambda k: r[c[k]] if k in c and c[k] < len(r) else ""
        no, name = g("판매자 상품코드"), g("상품명")
        cost = int(float(g("판매가") or 0))
        if not no or not name or not cost:
            skip += 1; continue
        ship_type, pay = g("배송비 유형"), g("배송비 결제방식")
        ship = 0
        if ship_type not in ("무료", ""):
            # 착불만 되면 고객이 택배기사에게 돈을 내야 하므로 제외, 선결제가 되면 우리가 내고 원가에 포함
            if pay and "선결제" not in pay:
                skip += 1; continue
            ship = int(float(g("기본배송비") or 0))
        box = 1 if "수량" in ship_type else 0  # 수량별비례: 첫 상자 수량을 알 수 없어 1개 = 택배 1건 (손해 방지)
        free_over = int(float(g("조건부무료-상품판매가합계") or 0)) if "조건" in ship_type and (g("조건부무료-상품판매가합계") or "").strip() else 0
        goods = cost
        cost += ship
        vals = g("옵션값").split("\n") if g("옵션값") else []
        adds = g("옵션가").split("\n") if g("옵션가") else []
        stocks = g("옵션 재고수량").split("\n") if g("옵션 재고수량") else []
        base = price_from_cost(cost, PRICING)
        opts = []
        for i, v in enumerate(vals):
            v = v.strip()
            a = int(float(adds[i])) if i < len(adds) and adds[i].strip().lstrip("-").isdigit() else 0
            st = stocks[i].strip() if i < len(stocks) else ""
            if not v or st == "0" or (no, v) in zero:
                continue
            opts.append(f"{v.replace('|', '/').replace('=', '-')}={price_from_cost(cost + a, PRICING) - base if a else 0}")
        if vals and not opts:
            skip += 1; continue  # 전 옵션 품절
        if len(opts) == 1:
            opts = []
        out_rows.append({
            "상품코드": "DM" + no, "상품명": name, "카테고리코드": g("카테고리ID"), "공급가": goods, "공급 배송비": ship, "묶음배송수량": box or "", "무료배송기준금액": free_over or "", "반품배송비": g("반품배송비"), "교환배송비": g("교환배송비"),
            "대표 이미지 주소": img.get(no, ""), "브랜드": g("브랜드"), "제조사": g("제조사"), "원산지": g("원산지 직접입력") or "상세설명 참조",
            "상세 설명": g("상품 상세정보"), "재고": g("재고수량"), "옵션명": g("옵션명") if opts else "", "옵션": "|".join(opts),
        })
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(out_rows)
    print(f"변환 {len(out_rows)}개 → {out} (제외 {skip}개, 이미지 없음 {sum(1 for x in out_rows if not x['대표 이미지 주소'])}개)")


if __name__ == "__main__":
    main(*sys.argv[1:4])
