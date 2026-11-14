"""온채널 스마트스토어 엑셀(상품센터 엑셀폼) → data/온채널상품.csv
사용: python3 tools/onch_convert.py <엑셀폴더> [가격준수 공급가 json]

- 엑셀 '판매가' = 공급가 × (1 + 온채널 '상품 보내기 기본 마진' 1%), 10원 올림
  → 공급가 = 판매가 ÷ 1.01 (10원 올림, 실제보다 조금 높게 잡아 마진 안전)
- 가격준수 상품은 엑셀 판매가가 준수가(최저판매가) → 공급사최저판매가로 넣고,
  공급가는 json(코드→판매사가)에서 가져옴
- 우리 판매가는 build 단계에서 순마진 12% 규칙으로 다시 계산
- 금칙어(상표 등)가 있는 상품, 미성년자 구매 불가 상품, 재고 0 상품은 뺌
"""
import csv, json, math, sys
from pathlib import Path
import openpyxl
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from product_import import cat_from_code
CATS = json.loads((Path(__file__).resolve().parent.parent / "config.json").read_text())["categories"]

MARGIN = 1.01
args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)  # --out=파일이름 --cat=쇼핑몰카테고리
src = Path(args[0])
strict = json.loads(Path(args[1]).read_text()) if len(args) > 1 else {}
out = Path(__file__).resolve().parent.parent / "data" / opt.get("out", "온채널상품.csv")
MALL_CAT = opt.get("cat", "")

COLS = ["상품코드", "상품명", "카테고리코드", "카테고리명", "공급가", "공급 배송비", "공급사최저판매가", "반품배송비", "교환배송비",
        "대표 이미지 주소", "추가 이미지 주소", "브랜드", "제조사", "원산지", "상세 설명", "인증정보", "옵션명", "옵션", "쇼핑몰카테고리"]


def n(v):
    try:
        return int(float(str(v).replace(",", "")))
    except Exception:
        return 0


seen, rows = set(), []
stat = {"금칙어": 0, "성인": 0, "재고0": 0, "중복": 0, "가격없음": 0}
for f in sorted(src.glob("*.xlsx")):
    ws = openpyxl.load_workbook(f, read_only=True).active
    it = ws.iter_rows(values_only=True)
    next(it)
    head = [str(x or "").strip() for x in next(it)]
    ix = {h: i for i, h in enumerate(head)}
    g = lambda r, k: ("" if ix.get(k) is None or r[ix[k]] is None else str(r[ix[k]]).strip())
    for r in it:
        code = g(r, "판매자 상품코드")
        if not code:
            continue
        if code in seen:
            stat["중복"] += 1; continue
        seen.add(code)
        if g(r, "금칙어"):
            stat["금칙어"] += 1; continue
        if g(r, "미성년자 구매").upper() == "N":
            stat["성인"] += 1; continue
        if cat_from_code(g(r, "카테고리코드"), CATS) in ("food", "adult"):
            stat["식품·성인"] = stat.get("식품·성인", 0) + 1; continue
        if n(g(r, "재고수량")) <= 0:
            stat["재고0"] += 1; continue
        sale = n(g(r, "판매가"))
        if code in strict:
            cost, minp = int(strict[code]), sale
        else:
            cost, minp = math.ceil(sale / MARGIN / 10) * 10, 0
        if cost <= 0:
            stat["가격없음"] += 1; continue
        ship = 0 if "무료" in g(r, "배송비유형") else n(g(r, "기본배송비"))
        vals = [v.strip() for v in g(r, "옵션값").split(",")]
        adds = [n(a) for a in g(r, "옵션가").split(",")]
        stocks = [n(s) for s in g(r, "옵션 재고수량").split(",")] if g(r, "옵션 재고수량") else []
        opts = []
        if len([v for v in vals if v]) > 1:
            for i, v in enumerate(vals):
                if v and (i >= len(stocks) or stocks[i] > 0):
                    opts.append(f"{v.replace('|', '/').replace('=', '-')}={math.ceil((adds[i] if i < len(adds) else 0) / MARGIN / 10) * 10}")
        rows.append([code, g(r, "상품명"), g(r, "카테고리코드"), "" if MALL_CAT else "생활/건강>문구/사무용품", cost, ship, minp,
                     n(g(r, "반품배송비")), n(g(r, "교환배송비")), g(r, "대표이미지"),
                     "|".join(x for x in g(r, "추가이미지").replace("\n", ",").split(",") if x.strip().startswith("http")),
                     g(r, "브랜드"), g(r, "제조사"), g(r, "원산지 직접입력"), g(r, "상세설명"), g(r, "상품정보제공고시인증허가사항"),
                     "옵션" if opts else "", "|".join(opts), MALL_CAT])

PICK = [k for k in opt.get("pick", "").split(",") if k]  # 상품명에 이 단어가 있는 것만, 앞 단어일수록 먼저
MAX = int(opt.get("max", 0) or 0)
old, prev = 0, []
seen_ok = {r[0] for r in rows}
if out.exists():
    with out.open(encoding="utf-8-sig") as fp:
        prev = [r[0] for r in list(csv.reader(fp))[1:]]
old = len(prev)
if PICK:
    pos = lambda name: next((i for i, k in enumerate(PICK) if k in name), None)
    keep = [r for r in rows if pos(r[1]) is not None]
    stat["키워드밖"] = len(rows) - len(keep)
    had = set(prev)
    keep.sort(key=lambda r: (r[0] not in had, pos(r[1]), r[4]))  # 이미 올린 상품 → 키워드 순 → 싼 순
    if MAX and len(keep) > MAX:
        stat["한도초과"] = len(keep) - MAX; keep = keep[:MAX]
    rows = keep
    seen_ok = {r[0] for r in rows}
if old and len(rows) < old * 0.7 and "--force" not in sys.argv:
    sys.exit(f"중단: 새로 받은 상품 {len(rows)}개가 기존 {old}개의 70%보다 적어요 (엑셀 일부가 빠졌을 수 있음). 확인 후 --force")
with out.open("w", newline="", encoding="utf-8-sig") as fp:
    w = csv.writer(fp)
    w.writerow(COLS)
    w.writerows(rows)
print(f"{out.name}: {len(rows)}개 저장 (이전 {old}개, 빠짐={len(set(prev) - seen_ok)} 새로={len(seen_ok - set(prev))}) / 제외 {stat}")
