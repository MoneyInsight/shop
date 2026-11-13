"""상품 검색 노출(SEO) — 검색 잘 되는 제목·설명·태그를 상품마다 자동으로 만듦
- 태그: 상품명 핵심 단어 + 카테고리 + 브랜드 + 카테고리별 대표 검색어(용도·선물 등), 중복·잡단어 제거, 최대 12개
- 제목(<title>): 상품명 + 상품명에 없는 핵심 태그 2개 + '무료배송' + 쇼핑몰 이름 (60자 안쪽)
- 설명(meta description): 상품명·카테고리·가격·무료배송·수량 할인·회원 할인·출고일을 한 문장으로 (150자 안쪽)
"""
import re

# 카테고리별로 사람들이 함께 검색하는 말 (상품명에 없을 때만 태그로 보탬)
CAT_WORDS = {
    "jewelry": "여자목걸이 데일리액세서리 선물추천", "fashion": "데일리룩 패션소품 선물추천",
    "kitchen": "주방용품 살림템 주방정리", "living": "생활용품 살림템 자취필수템", "bath": "욕실용품 욕실정리 살림템",
    "furniture": "인테리어 수납정리 홈인테리어", "sleep": "침구 꿀잠템 홈인테리어", "season": "계절가전 겨울필수템 여름필수템",
    "digital": "디지털액세서리 전자기기 가성비", "office": "사무용품 문구 학용품", "tools": "공구 DIY 산업용품",
    "car": "차량용품 자동차용품 차박", "leisure": "캠핑용품 레저 아웃도어", "garden": "원예용품 가드닝 텃밭",
    "pet": "반려동물용품 강아지용품 고양이용품", "kids": "유아용품 아이선물 육아템", "beauty": "뷰티 미용소품 셀프케어",
    "health": "건강관리 생활건강 홈케어", "food": "간식 먹거리 선물세트",
}
STOP = set("세트 1개 2개 3개 1P 2P 신상 신상품 인기 특가 초특가 당일 당일출고 당일발송 정품 국산 고급 최고급 무료배송 빠른배송 대용량 소형 대형 중형 "
           "블랙 화이트 그레이 베이지 브라운 네이비 레드 블루 그린 핑크 옐로우 퍼플 아이보리 실버 골드 색상 컬러 택1 1+1 사이즈 프리 FREE "
           "col 3col 2col 4col 5col 개입 매입 묶음 용 겸용 및 외 등".split())


def _tokens(name):
    name = re.sub(r"\[[^\]]*\]|\([^)]*\)|【[^】]*】", " ", name)  # [특가] (당일) 같은 괄호 문구 제거
    out = []
    for w in re.split(r"[\s/,+·|_~!?*#&]+", name):
        w = w.strip("-.'\"")
        if len(w) < 2 or w in STOP or w.upper() in STOP or re.fullmatch(r"[\d.,x×*%cmkgmlLM]+", w, re.I):
            continue
        if re.fullmatch(r"\d+(cm|mm|m|ml|l|g|kg|개|매|p|P|종|구|단|인용|ea|EA)", w):
            continue
        out.append(w)
    return out


_KW = None


def _supplier_kw(pid):
    """도매처가 정한 검색 키워드 (도매꾹 API로 매일 갱신되는 data/domeme_keywords.json)"""
    global _KW
    if _KW is None:
        import json, pathlib
        f = pathlib.Path(__file__).resolve().parent / "data" / "domeme_keywords.json"
        _KW = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    return _KW.get(pid, [])


def tags(p, limit=12):
    seen, out = set(), []
    def add(w):
        w = w.strip()
        k = w.lower()
        if w and k not in seen and len(w) <= 20:
            seen.add(k); out.append(w)
    toks = _tokens(p.get("name", ""))
    for w in toks:
        add(w)
    for w in _supplier_kw(p.get("id", ""))[:6]:  # 도매처 검색 키워드 (실제 많이 찾는 말)
        add(w)
    # 두 단어 붙인 검색어 (예: 원통 목걸이 → 원통목걸이)
    for a, b in zip(toks, toks[1:]):
        if len(a + b) <= 10:
            add(a + b)
    if p.get("brand") and p["brand"] not in ("자체제작", "오너클랜", "기타", "없음"):
        add(p["brand"])
    if p.get("category_name"):
        for w in re.split(r"[/·>\s]+", p["category_name"]):
            if len(w) >= 2:
                add(w)
    for w in CAT_WORDS.get(p.get("category", ""), "").split():
        add(w)
    return out[:limit]


def title(p, shop):
    t = tags(p)
    extra = [w for w in t if w.lower() not in p["name"].lower() and " " not in w][:2]
    base = f'{p["name"]} {" ".join(extra)}'.strip()
    s = f"{base} 무료배송 | {shop}"
    return s if len(s) <= 60 else f'{p["name"][:60 - len(shop) - 10]} 무료배송 | {shop}'


def description(p, max_deal=0, member_rate=0):
    price = f'{int(p["price"]):,}원'
    parts = [f'{p["name"]} {price}, 전 상품 무료배송.']
    if max_deal:
        parts.append(f"2개부터 자동 할인 최대 {max_deal}%.")
    if member_rate:
        parts.append(f"회원은 {round(member_rate * 100)}% 더 할인.")
    parts.append("결제 후 1~3일 출고.")
    t = [w for w in tags(p) if w not in p["name"]][:4]
    if t:
        parts.append(" ".join("#" + w for w in t))
    s = " ".join(parts)
    return s[:150]


def max_deal(p):
    qt = p.get("qt") or []
    if len(qt) < 3 or not qt[0]:
        return 0
    return round((1 - min(qt[:5]) / qt[0]) * 100)  # 상품 화면 표와 같게 5개까지 기준
