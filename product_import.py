"""땡잡았땡 상품등록 엑셀 → 쇼핑몰 상품 변환
data/ 폴더의 .xlsx / .csv 를 읽어 쇼핑몰 상품으로 바꿉니다.
열 순서는 상관없고 열 이름으로 찾습니다. (다른 판매채널에서 내려받은 엑셀의 흔한 열 이름도 함께 인식)

가격 규칙 (전 상품 무료배송, 고객은 오픈마켓보다 5% 싸게):
  기준가 = 오픈마켓 판매가(무료배송 기준) [또는 판매가 − 즉시할인 + 기본배송비]
  쇼핑몰 판매가 = 기준가 × 0.95 (10원 단위 올림),  정가 표시 = 기준가
"""
import csv, math, re
from pathlib import Path

# 엑셀 열 이름 → 내부 이름 (여러 표기를 모두 받음)
ALIASES = {
    "name": ["상품명"],
    "price": ["오픈마켓 판매가", "오픈마켓판매가", "판매가", "판매가격"],
    "stock": ["재고수량", "재고"],
    "category_id": ["카테고리ID", "카테고리코드", "카테고리 ID"],
    "category_name": ["카테고리명"],
    "image": ["대표 이미지 주소", "대표이미지주소", "기본이미지", "목록이미지", "이미지1", "상품이미지", "메인이미지", "대표 이미지 파일명", "대표이미지", "대표 이미지", "대표이미지 URL", "대표 이미지 URL", "대표이미지URL"],
    "images": ["추가 이미지 주소", "추가 이미지 파일명", "추가이미지", "추가 이미지 URL"],
    "detail": ["상세 설명", "상품 상세정보", "상세페이지", "상품상세설명", "상세설명HTML", "상세내용", "상품설명", "본문", "description", "상세설명", "상품상세", "상세정보"],
    "code": ["상품코드", "상품번호(오너클랜)", "오너클랜상품코드", "도매매상품번호", "판매자 상품코드", "판매자상품코드"],
    "product_no": ["상품번호"],
    "maker": ["제조사"],
    "brand": ["브랜드"],
    "origin": ["원산지 직접입력", "원산지"],
    "ship_type": ["배송비 유형"],
    "ship_fee": ["기본배송비"],
    "discount": ["즉시할인 값(기본할인)", "즉시할인 값", "PC 즉시할인 값"],
    "discount_unit": ["즉시할인 단위(기본할인)", "즉시할인 단위", "PC 즉시할인 단위"],
    "status": ["판매상태", "상품상태"],
    "mall_category": ["카테고리", "쇼핑몰카테고리", "자체몰카테고리"],
    "summary": ["한 줄 소개", "한줄소개"],
    "event": ["홍보문구", "이벤트문구"],
    "naver_low": ["네이버 최저가", "네이버최저가", "최저가"],
    "cost": ["공급가", "공급가격", "도매가", "매입가", "원가", "판매가(공급가)", "오너클랜판매가", "도매매가"],
    "cost_ship": ["공급 배송비", "공급배송비", "배송비(공급)", "택배비", "배송비"],
    "opt_name": ["옵션명"],
    "opt_values": ["옵션값"],
    "opt_prices": ["옵션가"],
    "options": ["옵션"],
}

# 상품명 키워드로 쇼핑몰 카테고리 자동 분류 (쇼핑몰카테고리 열이 비어 있을 때)
KEYWORDS = [
    ("pet", "강아지 고양이 애견 반려 펫 목줄 하네스 리드줄 개껌 방묘문 개줄"),
    ("kids", "아기 유아 어린이 아동 완구 장난감 교구 놀이방 퍼즐 블럭 도미노 트램폴린 줄넘기 분유 유치원 아이들"),
    ("car", "차량 자동차 앞유리 트렁크 주차 테슬라 세차"),
    ("leisure", "캠핑 골프 낚시 등산 자전거 헬스 웨지 퍼터 텐트 떡밥 드라이버커버 야구"),
    ("garden", "원예 화분 모종 씨앗 농업 예초기 분무기 가드닝 텃밭 서리방지 농산물"),
    ("jewelry", "14K 14k 금침 귀걸이 목걸이 반지 팔찌 피어싱 실버 골드필드 크리스탈 귀찌 큐빅"),
    ("fashion", "부츠 로퍼 구두 단화 슈즈 브라 거들 니트 모자 벨트 반바지 우산 가방 파우치 선글라스 앞치마"),
    ("pet", "강아지 고양이 애견 반려 펫 목줄 하네스 리드줄 개껌 방묘문"),
    ("kitchen", "팬 냄비 도마 찜기 텀블러 보온병 식기 수저 주방 싱크 육수통 곰솥 계량 튀김 소분 용기 커피 쌀통 쌀독 뒤주"),
    ("food", "인진쑥엿 티백 간장 맛기름 오란다 감초 홍차 과자 캡슐커피 아이스티 게간장 호박팥차"),
    ("digital", "케이블 HDMI 랜 충전 USB 외장하드 SSD 마우스 케이스 갤럭시 아이패드 거치대 모니터 안테나 멀티코드 조명 LED"),
    ("office", "볼펜 형광펜 샤프 연필 마카 화일 리갈패드 재단기 수정테이프 문서 명찰 화이트보드 보면대"),
    ("tools", "공구 엔드밀 인서트 렌치 측정기 게이지 하조기 사다리 펌프 밴드쏘 검전기 조정기 호스 대차 카트 수레 구루마 밀차 핸드카 파렛트"),
    ("furniture", "테이블 의자 협탁 화장대 거울 행거 옷걸이 선반 랙 렉 수납장 신발장 앵글 트롤리 책상 스툴 쇼파 침대"),
    ("season", "히터 난로 전기요 전기방석 장판 방풍 뽁뽁이 단열 가습 선풍기 방충 모기장 찜질"),
    ("sleep", "베개 이불 패드 매트 담요 쿠션 안대"),
]


def clean_html(h):
    """공급처 상세 HTML 정리: 스크립트·이벤트 속성 제거, http 이미지는 https로"""
    h = re.sub(r"(?is)<(script|iframe|style)[^>]*>.*?</\1>", "", h)
    h = re.sub(r"(?i)\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", h)
    h = re.sub(r"(?i)javascript:", "", h)
    return h.replace('src="http://', 'src="https://')


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
    """엑셀 위쪽에 안내문이 있을 수 있어서, '상품명'이 있는 줄을 헤더로 찾음"""
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


def parse_options(get, r, discount):
    """옵션을 [{"v": "블랙 / M", "add": 추가금}] 로. 두 가지 형식 지원:
       ① 옵션 열: '블랙 M=0|블랙 L=1000'   ② 옵션명/옵션값/옵션가 열(줄바꿈 구분, 값은 쉼표로 조합)"""
    opts = []
    raw = get(r, "options")
    if raw:
        for part in raw.split("|"):
            if not part.strip():
                continue
            v, _, add = part.partition("=")
            opts.append((v.strip(), _num(add)))
    elif get(r, "opt_values"):
        vals = get(r, "opt_values").split("\n")
        prices = get(r, "opt_prices").split("\n")
        for i, v in enumerate(vals):
            if v.strip():
                opts.append((" / ".join(x.strip() for x in v.split(",") if x.strip()), _num(prices[i]) if i < len(prices) else 0))
    return [{"v": v[:60], "add": math.ceil(a * (1 - discount) / 10) * 10 if a > 0 else (-math.floor(-a * (1 - discount) / 10) * 10 if a < 0 else 0)} for v, a in opts][:200]


def guess_category(name, cats):
    slugs = {c["slug"] for c in cats}
    name = re.sub(r"블랙|팬던트|팬츠|팬트리|화분대", " ", name)  # 짧은 키워드(랙·팬·화분)가 엉뚱하게 걸리지 않게
    for slug, words in KEYWORDS:
        if slug in slugs and any(w in name for w in words.split()):
            return slug
    return "living" if "living" in slugs else cats[0]["slug"]


def price_from_cost(cost, pricing):
    """원가(공급가+배송비)에서 판매가 계산: 카드수수료·부가세 빼고 순마진이 net_margin(최소 min_margin_won) 남게, 10원 단위 올림
    판매가 X: (X×(1−카드) − 원가) × 10/11 = 순마진  →  X = (원가 + 순마진×1.1) / (1 − 카드)"""
    net = max(cost * pricing.get("net_margin", 0.05), pricing.get("min_margin_won", 500))
    return math.ceil((cost + net * 1.1) / (1 - pricing.get("card_fee", 0.034)) / 10) * 10


def load(data_dir, cats, discount=0.05, pricing=None):
    """data_dir 안의 상품등록 엑셀 파일들을 읽어 상품 목록과 경고 메시지를 돌려줌"""
    products, warns = [], []
    excluded = []  # 네이버 최저가보다 싸지 않아 등록하지 않은 상품
    cat_by_name = {c["name"]: c["slug"] for c in cats}
    for path in sorted(Path(data_dir).glob("*")):
        if path.name in ("products.csv", "땡잡았땡_상품등록양식.xlsx") or path.suffix.lower() not in (".xlsx", ".xlsm", ".csv"):
            continue
        rows = _read_rows(path)
        h, col = _find_header(rows)
        if h is None:
            warns.append(f"{path.name}: '상품명' 열을 찾지 못해 건너뜀 (땡잡았땡 상품등록 양식의 열 이름이 있어야 해요)")
            continue
        get = lambda r, k: (r[col[k]].strip() if k in col and col[k] < len(r) and r[col[k]] else "")
        skipped = 0
        for r in rows[h + 1:]:
            name = get(r, "name")
            price = _num(get(r, "price"))
            cost = _num(get(r, "cost"))
            if cost and pricing:  # 공급가가 있으면 원가 기반 가격 (배송비 포함, 무료배송)
                price = price_from_cost(cost + _num(get(r, "cost_ship")), pricing)
            if name.startswith("필수"):
                continue  # 양식 안내 줄
            if not name or not price:
                skipped += 1; continue
            if get(r, "status") in ("판매중지", "판매종료", "품절"):
                continue
            disc = _num(get(r, "discount"))
            if disc and "%" in get(r, "discount_unit"):
                disc = round(price * disc / 100)
            ship = _num(get(r, "ship_fee")) if "무료" not in get(r, "ship_type") else 0
            base = price - disc + ship
            sale = base if (cost and pricing) else math.ceil(base * (1 - discount) / 10) * 10
            low = _num(get(r, "naver_low"))
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
                "event": get(r, "event") or "오픈마켓보다 5% 저렴 · 무료배송", "badge": "", "summary": get(r, "summary"),
                "description": "" if detail.lstrip().startswith("<") else detail.replace("\n", "|"),
                "detail_html": clean_html(detail) if detail.lstrip().startswith("<") else "",
                "supplier": "직영", "status": "판매중", "naver_low": str(low or ""),
                "options": parse_options(get, r, discount), "option_name": get(r, "opt_name").replace("\n", " / "),
                "images": [x for x in re.split(r"[|\n,]", get(r, "images")) if x.strip().startswith("http")][:9],
            })
        if skipped:
            warns.append(f"{path.name}: 상품명 또는 판매가가 없는 {skipped}줄은 건너뜀")
    keep = []
    for p in products:
        low = _num(p.get("naver_low"))
        if low and int(p["price"]) >= low:
            excluded.append({"name": p["name"], "price": int(p["price"]), "naver_low": low, "file": "자동확인" if not p.get("_low_from_file") else p.get("_file", "")})
        else:
            keep.append(p)
    products = keep
    if excluded:
        warns.append(f"네이버 최저가보다 비싸서 등록 안 한 상품 {len(excluded)}개 (관리자 페이지에서 확인)")
    return products, warns, excluded
