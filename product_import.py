"""땡잡았땡 상품등록 엑셀 → 쇼핑몰 상품 변환
data/ 폴더의 .xlsx / .csv 를 읽어 쇼핑몰 상품으로 바꿉니다.
열 순서는 상관없고 열 이름으로 찾습니다. (다른 판매채널에서 내려받은 엑셀의 흔한 열 이름도 함께 인식)

가격 규칙 (전 상품 무료배송, 일괄 할인 없음 — 3개 이상 대량 구매는 고객이 최대 3%까지 가격 제안):
  쇼핑몰 판매가 = 오픈마켓 판매가(무료배송 기준) [또는 판매가 − 즉시할인 + 기본배송비]
  공급가가 있으면 원가 기반 얇은 마진 가격
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
    "box_qty": ["묶음배송수량", "묶음배송 수량", "수량별부과-수량"],
    "free_over": ["무료배송기준금액", "조건부무료-상품판매가합계"],
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


# 스마트스토어 카테고리코드 → 쇼핑몰 카테고리 (대표님 스마트스토어 상품의 코드 기준으로 묶음)
SS_CATEGORY = [(int(a.split("-")[0]), int(a.split("-")[-1]), b) for a, b in
               (x.split() for x in "50000022 leisure|50000216 kitchen|50000233 garden|50000243 fashion|50000255-50000256 digital|50000290-50000319 beauty|50000375 beauty|50000381 pet|50000406-50000407 beauty|50000434 digital|50000435 fashion|50000444 beauty|50000458 bath|50000478 kids|50000539-50000570 fashion|50000580 kids|50000639-50000836 fashion|50000850 living|50000867 furniture|50000964 office|50000966-50000968 furniture|50000970-50000976 sleep|50000981-50000983 furniture|50001054 furniture|50001061 living|50001062 tools|50001069 furniture|50001179-50001304 leisure|50001307-50001347 furniture|50001350 leisure|50001360 furniture|50001434-50001555 leisure|50001571-50001588 digital|50001605-50001610 leisure|50001615-50001769 digital|50001796-50001805 garden|50001810 living|50001819-50001834 health|50001836 kitchen|50001837 living|50001840-50001849 bath|50001853 season|50001878 food|50001931-50001932 health|50001937-50001939 bath|50001945-50001946 health|50001991 beauty|50002012 office|50002019 food|50002057 fashion|50002063 health|50002068 sleep|50002074-50002130 digital|50002272-50002274 bath|50002310 living|50002312 health|50002328-50002356 digital|50002384-50002432 food|50002466-50002475 furniture|50002477-50002479 living|50002490 kitchen|50002513-50002557 season|50002583 kitchen|50002622 food|50002639-50002667 leisure|50002696 bath|50002697-50002700 living|50002701 garden|50002703 furniture|50002705-50002710 living|50002783-50002868 leisure|50002925 digital|50002988-50003048 leisure|50003118-50003148 digital|50003166-50003188 leisure|50003232-50003266 furniture|50003282-50003329 tools|50003330-50003350 furniture|50003370-50003376 garden|50003383-50003468 tools|50003479-50003500 sleep|50003502 health|50003514-50003526 furniture|50003527 kitchen|50003540-50003548 tools|50003550-50003598 office|50003631 fashion|50003642-50003656 sleep|50003692 tools|50003695 furniture|50003696 living|50003734-50003751 office|50003766 living|50003767-50003789 office|50003791 tools|50003817-50003859 fashion|50003884-50003899 office|50003912-50003959 car|50003988-50004024 fashion|50004060-50004112 car|50004146-50004147 fashion|50004152-50004174 jewelry|50004190-50004191 fashion|50004193-50004194 jewelry|50004367-50004368 living|50004381-50004397 beauty|50004450-50004485 kids|50004516-50004578 kitchen|50004581 beauty|50004637-50004639 digital|50004757-50004843 kitchen|50004844 living|50005256 kitchen|50005260 furniture|50005289 beauty|50005401 bath|50006195 tools|50006203-50006371 digital|50006374-50006376 leisure|50006637-50006738 pet|50006839 leisure|50006877 furniture|50006909 living|50006958 tools|50007048 sleep|50007150-50007161 pet|50007217 digital|50007238-50007241 leisure|50007508 living|50007608-50007828 office|50007849 living|50007968 office|50007969 digital|50008049-50008288 office|50008290 bath|50008409-50008428 pet|50008471-50008728 bath|50008888 office|50009000 furniture|50009060 tools|50009182 leisure|50009200 season|50009240 leisure|50009420 kitchen|50009460-50009540 leisure|50009600 food|50009740 kitchen|50011861-50014121 food|50014920-50015080 car|50015601-50015980 pet|50016541 kids|50016880-50016920 sleep|50017221 jewelry|50017960-50017980 digital|50019399 living|50019539-50019679 bath|50019780 tools|50019999 health|50020199 living|50020579 tools|50020639 furniture|50020679 sleep|50022259-50022260 kitchen|50022359 living|50022739 food|50022839 leisure|50022859-50022879 food|50023499 furniture|50023879 fashion".split("|"))]


def cat_from_code(code, cats):
    try:
        n = int(str(code).strip())
    except ValueError:
        return ""
    slugs = {c["slug"] for c in cats}
    for lo, hi, slug in SS_CATEGORY:
        if lo <= n <= hi and slug in slugs:
            return slug
    return ""


def guess_category(name, cats):
    slugs = {c["slug"] for c in cats}
    name = re.sub(r"블랙|팬던트|팬츠|팬트리|화분대", " ", name)  # 짧은 키워드(랙·팬·화분)가 엉뚱하게 걸리지 않게
    for slug, words in KEYWORDS:
        if slug in slugs and any(w in name for w in words.split()):
            return slug
    return "living" if "living" in slugs else cats[0]["slug"]


def price_from_cost(cost, pricing):
    """원가(공급가+배송비)에서 판매가 계산: 카드수수료·부가세·운영비 빼고 원가의 net_margin(최소 min_margin_won)이 남게, 10원 단위 올림"""
    net = max(cost * pricing.get("net_margin", 0.05), pricing.get("min_margin_won", 500))
    ops = pricing.get("ops_cost_won", 0)  # 건당 운영비(알림톡·서버·반품 예비비)
    # 남는 돈 = 판매가 − 카드수수료 − 부가세차액((판매가−원가)/11) − 원가 − 운영비 = net 이 되도록 판매가를 역산
    card = pricing.get("card_fee", 0.034)
    return math.ceil((cost * 10 / 11 + ops + net) / (1 - card - 1 / 11) / 10) * 10


QT_MAX = 10  # 수량별 개당 가격을 1~10개까지 계산 (11개 이상은 10개 가격)


def ship_rule(ship, box_qty, pricing):
    """한 박스(택배 1건)에 넣는 개수: 도매처 '수량별 부과' 값이 있으면 그대로,
    없으면 배송비가 기준(기본 3,500원) 이하인 일반 택배는 3개까지 한 박스, 넘으면 1개씩 따로 (부피 큰 상품)"""
    q = pricing.get("qty_price", {}) if pricing else {}
    if ship > q.get("max_ship_won", 3500):
        return 1  # 부피 큰 상품은 묶음 정보가 있어도 1개씩
    if box_qty:
        return max(1, int(box_qty))  # 도매처가 밝힌 묶음 수량
    return q.get("default_box_qty", 1)  # 묶음 정보가 없으면 1개 = 택배 1건 (손해 방지)


def qty_prices(goods, ship, box_qty, free_over, pricing):
    """n개 살 때 개당 가격 [1개, 2개, … 10개]
    ① 배송비 절약형(도매처 배송비를 따로 내고 여러 개를 한 박스로): 2개 최소 3%, 3개 이상 최소 5% 할인,
       아낀 배송비만큼(n개 원가 = 상품원가×n + 배송비×택배건수 → 12% 공식) 더 싸지면 그 가격
    ② 개수만큼 배송비가 드는 상품(도매처 무료배송·1개마다 배송비·부피 큰 상품): 마진에서만 2개 2%, 3개 이상 4%
    어느 경우든 원가 대비 순마진이 min_net_margin(8%) 아래로는 내려가지 않음"""
    if not goods or not pricing:
        return []
    q = pricing.get("qty_price", {})
    k = ship_rule(ship, box_qty, pricing)
    saving = ship > 0 and k > 1
    rates = q.get("save_rates" if saving else "nosave_rates") or ({"2": 0.03, "3": 0.05} if saving else {"2": 0.02, "3": 0.04})
    floor_m = q.get("min_net_margin", 0.08)
    card, ops = pricing.get("card_fee", 0.034), pricing.get("ops_cost_won", 0)
    p1 = price_from_cost(goods + ship, pricing)
    out = []
    for n in range(1, QT_MAX + 1):
        boxes = -(-n // k) if saving else n
        sh = 0 if (free_over and goods * n >= free_over) else ship * boxes
        cost_n = goods * n + sh
        d = 0 if n == 1 else rates.get(str(min(n, 3)), 0)
        target = p1 * (1 - d)
        if saving:
            target = min(target, price_from_cost(cost_n, pricing) / n)
        floor = (cost_n * 10 / 11 + ops + cost_n * floor_m) / (1 - card - 1 / 11) / n  # 순마진 8% 되는 개당 가격
        out.append(p1 if n == 1 else math.ceil(max(target, floor) / 10) * 10)
    # 택배가 한 건 더 늘어나는 수량에서 개당 가격이 다시 오르지 않게, 뒤쪽 수량의 가장 높은 값으로 맞춤 (손해 없이 '많이 살수록 싸지게')
    for i in range(len(out) - 2, -1, -1):
        out[i] = max(out[i], out[i + 1])
    return out if len(out) > 1 and out[1] < out[0] else []


def load(data_dir, cats, discount=0, pricing=None, require_detail=True, check_low=False):
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
        skipped = no_detail = 0
        for r in rows[h + 1:]:
            name = get(r, "name")
            price = _num(get(r, "price"))
            cost = _num(get(r, "cost"))
            qt, sm = [], ""
            if cost and pricing:  # 공급가가 있으면 원가 기반 가격 (배송비 포함, 무료배송)
                goods, cship = cost, _num(get(r, "cost_ship"))
                cost = goods + cship
                price = price_from_cost(cost, pricing)
                qt = qty_prices(goods, cship, _num(get(r, "box_qty")), _num(get(r, "free_over")), pricing)
                sm = "선불" if cship else "무료"  # 도매처 발주서의 배송방식
                if qt:
                    qt[0] = price
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
            cat = cat_by_name.get(mc) or (mc if mc in {c["slug"] for c in cats} else "") or cat_from_code(get(r, "category_id"), cats) or guess_category(name, cats)
            img = get(r, "image")
            detail = get(r, "detail")
            if require_detail and not detail.strip():
                no_detail += 1; continue  # 상세페이지 없는 상품은 올리지 않음
            products.append({
                "id": code, "name": name[:100], "cost": cost if (cost and pricing) else 0, "qt": qt, "sm": sm, "category": cat, "price": str(sale), "normal_price": str(base),
                "shipping_fee": "0", "image": img if (img.startswith("http") or img.startswith("uploads/")) else (f"uploads/{img}" if img else ""),
                "brand": get(r, "brand"), "maker": get(r, "maker"), "origin": get(r, "origin"),
                "event": get(r, "event") or "무료배송", "badge": "", "summary": get(r, "summary"),
                "description": "" if detail.lstrip().startswith("<") else detail.replace("\n", "|"),
                "detail_html": clean_html(detail) if detail.lstrip().startswith("<") else "",
                "supplier": "직영", "status": "판매중", "naver_low": str(low or ""),
                "options": parse_options(get, r, discount), "option_name": get(r, "opt_name").replace("\n", " / "),
                "images": [x for x in re.split(r"[|\n,]", get(r, "images")) if x.strip().startswith("http")][:9],
            })
        if skipped:
            warns.append(f"{path.name}: 상품명 또는 판매가가 없는 {skipped}줄은 건너뜀")
        if no_detail:
            warns.append(f"{path.name}: 상세페이지가 없는 {no_detail}개는 올리지 않음")
    keep = []
    for p in products:
        low = _num(p.get("naver_low")) if check_low else 0  # 최저가 비교는 기본으로 끔
        if low and int(p["price"]) >= low:
            excluded.append({"name": p["name"], "price": int(p["price"]), "naver_low": low, "file": "자동확인" if not p.get("_low_from_file") else p.get("_file", "")})
        else:
            keep.append(p)
    products = keep
    if excluded:
        warns.append(f"네이버 최저가보다 비싸서 등록 안 한 상품 {len(excluded)}개 (관리자 페이지에서 확인)")
    return products, warns, excluded
