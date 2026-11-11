"""스마트스토어 엑셀 양식 → 쇼핑몰 상품 변환
data/ 폴더의 .xlsx / .csv 중 스마트스토어 '상품 일괄등록' 양식(또는 같은 열 이름을 쓰는 파일)을 읽어
쇼핑몰 상품으로 바꿉니다. 열 순서는 상관없고 열 이름으로 찾습니다.

가격 규칙 (전 상품 무료배송, 고객은 오픈마켓보다 5% 싸게):
  기준가 = 판매가 − 즉시할인 + 기본배송비(유료배송일 때)
  쇼핑몰 판매가 = 기준가 × 0.95 (10원 단위 올림),  정가 표시 = 기준가
"""
import csv, math, re
from pathlib import Path

# 스마트스토어 열 이름 → 내부 이름 (여러 표기를 모두 받음)
ALIASES = {
    "name": ["상품명"],
    "price": ["판매가", "판매가격"],
    "stock": ["재고수량", "재고"],
    "category_id": ["카테고리ID", "카테고리코드", "카테고리 ID"],
    "category_name": ["카테고리명", "카테고리"],
    "image": ["대표 이미지 파일명", "대표이미지", "대표 이미지", "대표이미지 URL", "대표 이미지 URL", "대표이미지URL"],
    "images": ["추가 이미지 파일명", "추가이미지", "추가 이미지 URL"],
    "detail": ["상품 상세정보", "상세설명", "상품상세", "상세정보"],
    "code": ["판매자 상품코드", "판매자상품코드"],
    "product_no": ["상품번호", "상품번호(스마트스토어)", "스마트스토어 상품번호"],
    "maker": ["제조사"],
    "brand": ["브랜드"],
    "origin": ["원산지 직접입력", "원산지"],
    "ship_type": ["배송비 유형"],
    "ship_fee": ["기본배송비"],
    "discount": ["즉시할인 값(기본할인)", "즉시할인 값", "PC 즉시할인 값"],
    "discount_unit": ["즉시할인 단위(기본할인)", "즉시할인 단위", "PC 즉시할인 단위"],
    "status": ["판매상태", "상품상태"],
    "mall_category": ["쇼핑몰카테고리", "자체몰카테고리"],
    "event": ["홍보문구", "이벤트문구"],
    "naver_low": ["네이버 최저가", "네이버최저가", "최저가"],
}

# 상품명 키워드로 쇼핑몰 카테고리 자동 분류 (쇼핑몰카테고리 열이 비어 있을 때)
KEYWORDS = [
    ("jewelry", "14K 14k 금침 귀걸이 목걸이 반지 팔찌 피어싱 실버 골드필드 크리스탈 귀찌 큐빅"),
    ("fashion", "부츠 로퍼 구두 단화 슈즈 브라 거들 니트 모자 벨트 반바지 우산 가방 파우치 선글라스 앞치마"),
    ("pet", "강아지 고양이 애견 반려 펫 목줄 하네스 리드줄 개껌 방묘문"),
    ("kitchen", "팬 냄비 도마 찜기 텀블러 보온병 식기 수저 주방 싱크 육수통 곰솥 계량 튀김 소분 용기 커피 쌀통 쌀독 뒤주"),
    ("food", "엿 차 티백 간장 기름 오란다 감초 홍차 과자 캡슐커피"),
    ("digital", "케이블 HDMI 랜 충전 USB 외장하드 SSD 마우스 케이스 갤럭시 아이패드 거치대 모니터 안테나 멀티코드 조명 LED"),
    ("office", "볼펜 형광펜 샤프 연필 마카 화일 리갈패드 재단기 수정테이프 문서 명찰 화이트보드 보면대"),
    ("tools", "공구 엔드밀 인서트 렌치 측정기 게이지 하조기 사다리 펌프 밴드쏘 검전기 조정기 호스 대차 카트 수레 구루마 밀차 핸드카 파렛트"),
    ("furniture", "테이블 의자 협탁 화장대 거울 행거 옷걸이 선반 랙 렉 수납장 신발장 앵글 트롤리 책상 스툴 쇼파 침대"),
    ("season", "히터 난로 전기요 전기방석 장판 방풍 뽁뽁이 단열 가습 선풍기 방충 모기장 찜질"),
    ("sleep", "베개 이불 패드 매트 담요 쿠션 안대"),
]


def _norm(s):
    return re.sub(r"\s+", "", str(s or "")).strip()


def _num(v):
    try:
        return int(float(str(v).replace(",", "").strip()))
    except Exception:
        return 0


def _read_rows(path):
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        ws = openpyxl.load_workbook(path, read_only=True, data_only=True).active
        rows = [[("" if c is None else str(c)) for c in r] for r in ws.iter_rows(values_only=True)]
    else:
        raw = path.read_bytes()
        for enc in ("utf-8-sig", "cp949"):
            try:
                text = raw.decode(enc); break
            except UnicodeDecodeError:
                continue
        rows = list(csv.reader(text.splitlines()))
    return [r for r in rows if any(str(c).strip() for c in r)]


def _find_header(rows):
    """스마트스토어 양식은 위에 안내문이 있을 수 있어서, '상품명'이 있는 줄을 헤더로 찾음"""
    for i, r in enumerate(rows[:15]):
        cells = [_norm(c) for c in r]
        if "상품명" in cells:
            col = {}
            for key, names in ALIASES.items():
                for n in names:
                    if _norm(n) in cells:
                        col[key] = cells.index(_norm(n)); break
            return i, col
    return None, None


def guess_category(name, cats):
    slugs = {c["slug"] for c in cats}
    for slug, words in KEYWORDS:
        if slug in slugs and any(w in name for w in words.split()):
            return slug
    return "living" if "living" in slugs else cats[0]["slug"]


def load(data_dir, cats, discount=0.05):
    """data_dir 안의 스마트스토어 양식 파일들을 읽어 상품 목록과 경고 메시지를 돌려줌"""
    products, warns = [], []
    excluded = []  # 네이버 최저가보다 싸지 않아 등록하지 않은 상품
    cat_by_name = {c["name"]: c["slug"] for c in cats}
    for path in sorted(Path(data_dir).glob("*")):
        if path.name == "products.csv" or path.suffix.lower() not in (".xlsx", ".xlsm", ".csv"):
            continue
        rows = _read_rows(path)
        h, col = _find_header(rows)
        if h is None:
            warns.append(f"{path.name}: '상품명' 열을 찾지 못해 건너뜀 (스마트스토어 양식의 열 이름이 있어야 해요)")
            continue
        get = lambda r, k: (r[col[k]].strip() if k in col and col[k] < len(r) and r[col[k]] else "")
        skipped = 0
        for r in rows[h + 1:]:
            name = get(r, "name")
            price = _num(get(r, "price"))
            if not name or name.startswith("필수") or not price:
                skipped += 1; continue
            if get(r, "status") in ("판매중지", "판매종료", "품절"):
                continue
            disc = _num(get(r, "discount"))
            if disc and "%" in get(r, "discount_unit"):
                disc = round(price * disc / 100)
            ship = _num(get(r, "ship_fee")) if "무료" not in get(r, "ship_type") else 0
            base = price - disc + ship
            sale = math.ceil(base * (1 - discount) / 10) * 10
            low = _num(get(r, "naver_low"))
            if low and sale >= low:
                excluded.append({"name": name, "price": sale, "naver_low": low, "file": path.name})
                continue
            code = get(r, "code") or get(r, "product_no") or f"SS{len(products)+1:05d}"
            code = re.sub(r"[^0-9A-Za-z_-]", "", code) or f"SS{len(products)+1:05d}"
            mc = get(r, "mall_category")
            cat = cat_by_name.get(mc) or (mc if mc in {c["slug"] for c in cats} else guess_category(name, cats))
            img = get(r, "image")
            detail = get(r, "detail")
            products.append({
                "id": code, "name": name[:100], "category": cat, "price": str(sale), "normal_price": str(base),
                "shipping_fee": "0", "image": img if (img.startswith("http") or img.startswith("uploads/")) else (f"uploads/{img}" if img else ""),
                "brand": get(r, "brand"), "maker": get(r, "maker"), "origin": get(r, "origin"),
                "event": get(r, "event") or "오픈마켓보다 5% 저렴 · 무료배송", "badge": "", "summary": "",
                "description": "" if detail.lstrip().startswith("<") else detail.replace("\n", "|"),
                "detail_html": detail if detail.lstrip().startswith("<") else "",
                "supplier": "직영", "status": "판매중", "naver_low": str(low or ""),
            })
        if skipped:
            warns.append(f"{path.name}: 상품명 또는 판매가가 없는 {skipped}줄은 건너뜀")
    if excluded:
        warns.append(f"네이버 최저가보다 비싸서 등록 안 한 상품 {len(excluded)}개 (관리자 페이지에서 확인)")
    return products, warns, excluded
