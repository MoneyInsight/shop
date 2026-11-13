#!/usr/bin/env python3
"""쇼핑몰 생성기 — data/products.csv + config.json → site/ 폴더에 정적 쇼핑몰 생성
실행: python3 build.py
생성물: 메인·카테고리·상품상세·검색·장바구니·주문결제·완료/실패·약관·공급사·관리자 페이지,
        products.json, naver_ep.txt(네이버쇼핑 EP 3.0), sitemap.xml, robots.txt
"""
import os, re, csv, json, html, shutil, datetime, hashlib
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "site"
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
BIZ = CFG["business"]
BASE = CFG["base_url"].rstrip("/")
CATS = CFG["categories"]
SHOW_CATS = [c for c in CATS if not c.get("adult") or CFG.get("adult_verified")]
CAT_NAME = {c["slug"]: c["name"] for c in CATS}
e = html.escape
won = lambda n: f"{int(n):,}원"


# ---------------- 데이터 ----------------
def placeholder_svg(p):
    """사진이 없는 상품용 임시 이미지"""
    hue = int(hashlib.md5(p["id"].encode()).hexdigest()[:2], 16) * 360 // 256
    cat = next((c for c in CATS if c["slug"] == p["category"]), {"emoji": "📦"})
    name = e(p["name"][:16])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({hue},70%,92%)"/><stop offset="1" stop-color="hsl({hue},60%,80%)"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/><text x="300" y="300" font-size="180" text-anchor="middle">{cat["emoji"]}</text>
<text x="300" y="440" font-size="34" font-weight="700" text-anchor="middle" fill="#333" font-family="sans-serif">{name}</text>
<text x="300" y="490" font-size="22" text-anchor="middle" fill="#666" font-family="sans-serif">상품 사진 준비중</text></svg>'''


def load_products():
    import product_import
    rows = list(csv.DictReader((ROOT / "data/products.csv").open(encoding="utf-8-sig")))
    ss_rows, warns, excluded = product_import.load(Path(os.environ.get("DATA_DIR") or ROOT / "data"), CATS, CFG.get("customer_discount", 0), CFG.get("pricing"), CFG.get("require_detail", True))
    write("price_check.json", json.dumps(excluded, ensure_ascii=False))
    for w in warns:
        print("⚠️", w)
    seen = {r["id"] for r in rows}
    rows += [r for r in ss_rows if r["id"] not in seen]
    out = []
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    for r in rows:
        if r.get("status", "판매중") not in ("판매중", ""):
            continue
        p = {k: (v.strip() if isinstance(v, str) else (v if v is not None else "")) for k, v in r.items()}
        p["price"] = int(p["price"] or 0)
        p["normal_price"] = int(p["normal_price"] or 0) or p["price"]
        p["shipping_fee"] = int(p["shipping_fee"] or 0)
        p["category_name"] = CAT_NAME.get(p["category"], "기타")
        br = re.sub(r"\(주\)|주식회사|㈜", "", p.get("brand", "")).strip()
        p["brand"] = "" if re.fullmatch(r"[A-Za-z.\s]{1,3}", br) or "partner" in br.lower() or "협력사" in br else br
        p["naver_low"] = int(p.get("naver_low") or 0) if CFG.get("show_naver", True) else 0
        p["save"] = p["naver_low"] - p["price"] if p["naver_low"] > p["price"] else 0
        p["desc_lines"] = [x for x in p["description"].split("|") if x.strip()]
        p.setdefault("detail_html", "")
        p["options"] = p.get("options") or []
        p["option_name"] = p.get("option_name") or "옵션"
        p["images"] = p.get("images") or []
        if p["image"] and not p["image"].startswith("http") and not (ROOT / p["image"]).exists():
            p["image"] = ""
        if not p["image"]:
            fn = f"img/p{p['id']}.svg"
            (OUT / fn).write_text(placeholder_svg(p), encoding="utf-8")
            p["image"] = fn
        elif p["image"].startswith("http"):
            pass  # 외부 이미지 주소
        out.append(p)
    # 재고 동기화 결과(data/stock.json) 반영: 품절 표시, 도매가 변동 시 12% 기준 재계산, 품절 옵션 제외
    stock = json.loads((ROOT / "data/stock.json").read_text(encoding="utf-8")) if (ROOT / "data/stock.json").exists() else {}
    import product_import as _pi
    for p in out:
        st = (stock.get("items") or {}).get(p["id"]) or {}
        p["soldout"] = bool(st.get("soldout"))
        if st.get("cost") and p.get("cost") and int(st["cost"]) != int(p["cost"]) and CFG.get("pricing"):
            new = _pi.price_from_cost(int(st["cost"]), CFG["pricing"])
            p["price"] = new; p["normal_price"] = new
            p["qt"] = []  # 도매가가 바뀌면 수량 할인은 다음 상품 가져오기 때 다시 계산
        if st.get("opts_soldout") and p["options"]:
            gone = set(st["opts_soldout"])  # 순서(번호)는 유지하고 표시만 (장바구니의 옵션 번호가 어긋나지 않게)
            for o in p["options"]:
                o["so"] = o["v"] in gone
            if all(o.get("so") for o in p["options"]):
                p["soldout"] = True
    # 네이버 최저가보다 많이 싼 상품(절약률 큰 순)이 위로, 최저가 정보 없는 상품은 뒤로
    if CFG.get("show_naver", True):
        out.sort(key=lambda p: -(p["save"] / p["naver_low"]) if p["save"] else 1)
    out.sort(key=lambda p: p["soldout"])  # 품절 상품은 목록 맨 뒤로
    return out


def abs_img(p):
    return p["image"] if p["image"].startswith("http") else f"{BASE}/{p['image']}"


def rate(p):
    return round((1 - p["price"] / p["normal_price"]) * 100) if p["normal_price"] > p["price"] else 0


# ---------------- 아이콘 ----------------
def ico(path, extra=""):
    return f'<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"{extra}>{path}</svg>'

I_SEARCH = ico('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>')
I_HEART = ico('<path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>')
I_BAG = ico('<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>')
I_BOX = ico('<path d="M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5L12 11.5l8.5-4M12 11.5v9"/>')
I_HOME = ico('<path d="M4 11l8-7 8 7v8.5h-5.5V14h-5v5.5H4z"/>')
I_USER = ico('<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.2-3.8 4-5.6 7.5-5.6s6.3 1.8 7.5 5.6"/>')
I_MENU = ico('<path d="M4 7h16M4 12h16M4 17h16"/>')
I_TRUCK = ico('<path d="M2.5 6.5h11v10h-11zM13.5 10h4l3 3v3.5h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>')
I_SHIELD = ico('<path d="M12 3.5l7 2.5v5.5c0 4.2-3 7.3-7 9-4-1.7-7-4.8-7-9V6z"/><path d="M9 12l2.2 2.200L15.2 10"/>')
I_RETURN = ico('<path d="M4 9h11a4.5 4.5 0 0 1 0 9H8"/><path d="M7.5 5.500L4 9l3.5 3.5"/>')
I_TAG = ico('<path d="M3.5 12.500V4.500h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.3"/>')
I_CHAT = ico('<path d="M4 5.500h16v11H10l-4.5 3.500v-3.500H4z"/>')
I_PHONE = ico('<path d="M6.5 3.500h3l1.5 4-2 1.500a11 11 0 0 0 6 6l1.5-2 4 1.500v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.500a2 2 0 0 1 2-2z"/>')


# ---------------- 공통 레이아웃 ----------------
def layout(title, body, root="./", desc="", canonical="", extra_head="", scripts="", og_img="", active=""):
    desc = desc or CFG["slogan"]
    verify = ""
    if CFG.get("naver_site_verification"):
        verify += f'<meta name="naver-site-verification" content="{e(CFG["naver_site_verification"])}">'
    if CFG.get("google_site_verification"):
        verify += f'<meta name="google-site-verification" content="{e(CFG["google_site_verification"])}">'
    public_cfg = {k: CFG.get(k) for k in ("toss_client_key", "worker_url", "free_shipping_over", "shop_name", "catalog_api", "order_sheets", "remote_ship")}
    if os.environ.get("CATALOG_API"):  # 테스트용: 설정을 안 바꾸고 DB 모드로 빌드
        public_cfg["catalog_api"] = CFG["catalog_api"] = True
    if CFG.get("catalog_api"):
        public_cfg["cat_names"] = {c["slug"]: c["name"] for c in CFG["categories"]}
    name = e(CFG["shop_name"])
    on = lambda c: ' class="on"' if active == c["slug"] else ""
    gnb = "".join(f'<a href="{root}category/{c["slug"]}.html"{on(c)}>{e(c["name"])}</a>' for c in SHOW_CATS)
    logo = f'<a class="logo" href="{root}index.html" aria-label="{name} 홈">{name}<i></i></a>'
    return f'''<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title><meta name="description" content="{e(desc)}">
{f'<link rel="canonical" href="{canonical}">' if canonical else ""}
<meta property="og:type" content="website"><meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}"><meta property="og:site_name" content="{name}">
{f'<meta property="og:image" content="{og_img}">' if og_img else ""}
{verify}<meta name="theme-color" content="#fdf8ef">
<link rel="icon" href="{root}favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="{root}icons/icon-180.png"><link rel="manifest" href="{root}manifest.json">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="{name}">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;600;700&display=swap">
<link rel="stylesheet" href="{root}style.css">{extra_head}
<script>window.SHOP_CFG={json.dumps(public_cfg, ensure_ascii=False)}</script>
</head><body data-root="{root}">
<div class="util"><div class="wrap"><span>전 상품 무료배송 · 회원가입 없이 바로 주문</span>
<nav><a href="#" class="install-link" style="display:none">앱 설치</a><a href="{root}bulk.html">대량 구매</a><a href="{root}orders.html">주문·배송 조회</a><a href="{root}cs.html">고객센터</a><a href="{root}seller.html">공급사 입점</a></nav></div></div>
<header class="head"><div class="wrap">{logo}
<form class="search" action="{root}search.html" role="search"><input name="q" placeholder="찾으시는 상품을 검색해 보세요" aria-label="상품 검색"><button aria-label="검색">{I_SEARCH}</button></form>
<div class="head-icons"><a class="icon-btn login-link" href="{root}login.html">{I_USER}<span class="login-txt">로그인</span></a><a class="icon-btn" href="{root}orders.html">{I_BOX}주문조회</a>
<a class="icon-btn" href="{root}wish.html">{I_HEART}찜<span class="count" data-count="wish" style="display:none">0</span></a>
<a class="icon-btn" href="{root}cart.html">{I_BAG}장바구니<span class="count" data-count="cart" style="display:none">0</span></a></div>
</div></header>
<nav class="gnb" aria-label="카테고리"><div class="wrap"><a class="all" href="{root}search.html">전체 상품</a>{gnb}</div></nav>
<main>{body}</main>
<footer><div class="wrap">
<div class="f-top"><div>{logo}<p>{e(CFG["slogan"])}</p></div>
<div><h4>고객센터</h4><div class="tel">{e(BIZ["phone"])}</div><p>{e(BIZ["cs_hours"])}<br>{e(BIZ["email"])}</p></div>
<div><h4>쇼핑 안내</h4><ul><li><a href="{root}orders.html">주문·배송 조회</a></li><li><a href="{root}cs.html">자주 묻는 질문</a></li><li><a href="{root}cs.html#inquiry">1:1 문의</a></li><li><a href="{root}refund.html">교환·환불 안내</a></li></ul></div>
<div><h4>회사</h4><ul><li><a href="{root}terms.html">이용약관</a></li><li><a href="{root}privacy.html"><b>개인정보처리방침</b></a></li><li><a href="{root}seller.html">공급사 입점</a></li><li><a href="#" class="install-link" style="display:none">앱 설치하기</a></li></ul></div></div>
<p>상호 {e(BIZ["company"])} · 대표 {e(BIZ["ceo"])} · 사업자등록번호 {e(BIZ["biz_no"])} · 통신판매업신고 {e(BIZ["mail_order_no"])} <a href="https://www.ftc.go.kr/bizCommPop.do?wrkr_no={"".join(ch for ch in BIZ["biz_no"] if ch.isdigit())}" target="_blank" rel="noopener" style="text-decoration:underline">사업자정보 확인</a><br>
주소 {e(BIZ["address"])} · 개인정보보호책임자 {e(BIZ["privacy_officer"])} · 호스팅 제공 GitHub, Inc.<br>
고객님의 안전한 거래를 위해 토스페이먼츠 구매안전(에스크로) 서비스를 이용하실 수 있습니다.<br>
© {datetime.date.today().year} {name}. All rights reserved.</p>
</div></footer>
<nav class="tabbar" aria-label="하단 메뉴"><a href="{root}index.html">{I_HOME}홈</a><a href="{root}search.html">{I_MENU}전체</a><a href="{root}orders.html">{I_BOX}주문조회</a>
<a href="{root}wish.html">{I_HEART}찜<span class="count" data-count="wish" style="display:none">0</span></a><a href="{root}cart.html">{I_BAG}장바구니<span class="count" data-count="cart" style="display:none">0</span></a></nav>
{scripts}<script src="{root}app.js"></script>
</body></html>'''


def card(p, root):
    r = rate(p)
    img = p["image"] if p["image"].startswith("http") else root + p["image"]
    return f'''<a class="p-card{' is-soldout' if p.get("soldout") else ''}" href="{root}product/{p["id"]}.html">
<div class="p-thumb"><img src="{e(img)}" alt="{e(p["name"])}" loading="lazy">{f'<span class="badge {e(p["badge"])}">{e(p["badge"])}</span>' if p["badge"] else ""}{'<span class="soldout-cover">일시품절</span>' if p.get("soldout") else ""}
<button class="wish-btn" data-wish="{e(p["id"])}" aria-label="찜하기">{I_HEART}</button></div>
<div class="p-brand">{e(p["brand"])}</div><div class="p-name">{e(p["name"])}</div>
<div class="p-price">{f'<span class="rate">{r}%</span>' if r else ""}<span>{won(p["price"])}</span>{f"<del>{won(p['normal_price'])}</del>" if r else ""}</div>
<div class="p-ship">{"배송비 " + won(p["shipping_fee"]) if p["shipping_fee"] else "무료배송"}</div></a>'''


def write(path, text):
    f = OUT / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text, encoding="utf-8")


SORT_BAR = '''<div class="sort" role="group" aria-label="정렬"><button data-sort="rec" class="on">추천순</button><button data-sort="low">낮은 가격순</button>
<button data-sort="high">높은 가격순</button><button data-sort="sale">할인율순</button><button data-sort="name">이름순</button></div>'''


def listing(title, mode, items, root, cat="", count=None):
    """목록 틀: 첫 화면은 미리 그려 두고(검색엔진용), 정렬·페이지는 app.js가 처리"""
    n = len(items) if count is None else count
    return f'''<div class="wrap" id="listing" data-mode="{mode}" data-cat="{cat}">
<div class="list-head"><h1 id="list-title">{e(title)}<span class="cnt" id="list-count">{n:,}개</span></h1>{SORT_BAR}</div>
<div class="grid" id="list-grid">{"".join(card(p, root) for p in items[:40])}</div><div class="pager" id="pager"></div></div>'''


# ---------------- 페이지 ----------------
def build_home(ps):
    # 수량 할인 최대 비율 (상품 중 가장 많이 내려가는 값, 내림)
    max_deal = int(max([(1 - p['qt'][-1] / p['qt'][0]) * 100 for p in ps if p.get('qt')] or [0]) + 1e-9)
    ld = {"@context": "https://schema.org", "@type": "WebSite", "name": CFG["shop_name"], "url": BASE + "/",
          "potentialAction": {"@type": "SearchAction", "target": BASE + "/search.html?q={q}", "query-input": "required name=q"}}
    by_cat = {c["slug"]: [p for p in ps if p["category"] == c["slug"]] for c in SHOW_CATS}
    art = [p for p in ps if p["image"].startswith("http")][:4] or ps[:4]
    tiles = "".join(f'<a href="category/{c["slug"]}.html">{e(c["name"])}<small>{len(by_cat[c["slug"]]):,}개</small></a>' for c in SHOW_CATS if by_cat[c["slug"]])
    top = sorted([c for c in SHOW_CATS if len(by_cat[c["slug"]]) >= 4], key=lambda c: -len(by_cat[c["slug"]]))[:4]
    sections = "".join(f'''<section class="section"><div class="wrap"><div class="sec-head"><div><h2>{e(c["name"])}</h2></div><a href="category/{c["slug"]}.html">더 보기</a></div>
<div class="grid">{"".join(card(p, "./") for p in by_cat[c["slug"]][:4])}</div></div></section>''' for c in top)
    body = f'''<section class="hero"><div class="wrap"><div><small>THE HONEST PRICE</small>
<h1>좋은 물건을,<br>군더더기 없는 가격으로.</h1>
<p>유통 단계의 수수료를 덜어내고 꼭 필요한 만큼만 남겼습니다. 모든 상품은 무료로 배송해 드립니다.</p>
{f'<p class="hero-deal"><b>많이 살수록 더 싸게!</b> 같은 상품 2개부터 자동 할인, <b>최대 {max_deal}%</b>까지 내려가요.</p>' if max_deal >= 2 else ''}
<a class="btn" href="search.html">전체 상품 보기</a></div>
<div class="hero-art">{"".join(f'<a href="product/{p["id"]}.html"><img src="{e(p["image"])}" alt="{e(p["name"])}"></a>' for p in art)}</div></div></section>
<div class="benefits"><div class="wrap">
<div>{I_TRUCK}<p><b>전 상품 무료배송</b><span>금액과 상관없이 배송비 0원</span></p></div>
<div>{I_TAG}<p><b>정직한 가격</b><span>수수료 거품을 뺀 판매가</span></p></div>
<div>{I_SHIELD}<p><b>안전 결제</b><span>토스페이먼츠 구매안전 서비스</span></p></div>
<div>{I_RETURN}<p><b>7일 교환·반품</b><span>받아보고 결정하세요</span></p></div></div></div>
<section class="section"><div class="wrap"><div class="sec-head"><div><h2>새로 들어온 상품</h2><p>이번 주에 새로 만나보실 수 있는 상품입니다.</p></div><a href="search.html">전체 {len(ps):,}개 보기</a></div>
<div class="grid">{"".join(card(p, "./") for p in ps[:8])}</div></div></section>
<section class="section"><div class="wrap"><div class="sec-head"><div><h2>카테고리</h2></div></div><div class="cat-tiles">{tiles}</div></div></section>
{sections}
<section class="section" id="recent-box" style="display:none"><div class="wrap"><div class="sec-head"><div><h2>최근 본 상품</h2></div></div><div class="grid" id="recent-grid"></div></div></section>
<div class="section last"></div>'''
    write("index.html", layout(f'{CFG["shop_name"]} — {CFG["slogan"]}', body, "./", canonical=BASE + "/",
          extra_head=f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'))


def build_categories(ps):
    for c in CATS:
        if c.get("adult") and not CFG.get("adult_verified"):
            body = f'''<div class="wrap page"><div class="done-box"><div class="mark" style="font-weight:700">19</div><h2>청소년 이용불가</h2>
<p>이 카테고리는 만 19세 이상 성인인증 후 이용하실 수 있습니다.<br>성인인증 서비스를 준비하고 있습니다.</p></div></div>'''
            write(f'category/{c["slug"]}.html', layout(f'{c["name"]} — {CFG["shop_name"]}', body, "../"))
            continue
        items = [p for p in ps if p["category"] == c["slug"]]
        body = f'<div class="wrap"><div class="crumb"><a href="../index.html">홈</a> / {e(c["name"])}</div></div>' + listing(c["name"], "cat", items, "../", c["slug"])
        write(f'category/{c["slug"]}.html', layout(f'{c["name"]} — {CFG["shop_name"]}', body, "../", active=c["slug"],
              desc=f'{CFG["shop_name"]} {c["name"]} 상품 {len(items)}개. 전 상품 무료배송.', canonical=f'{BASE}/category/{c["slug"]}.html'))


def deal_shown(p):
    """3개 살 때 3% 이상 싸질 때만 안내 표시 (가격 계산은 항상 적용)"""
    qt = p.get("qt") or []
    return bool(len(qt) >= 3 and not p.get("soldout") and qt[2] <= qt[0] * 0.97)


def qty_table(p):
    """많이 살수록 싸지는 수량 할인 안내 (1·2·3·5개)"""
    qt = p.get("qt") or []
    if not deal_shown(p):
        return '<div class="qty-deal" id="qty-deal" hidden></div>'
    cells = "".join(f'<button type="button" data-q="{n}"><b>{n}개</b><span>개당 {won(qt[n - 1])}</span>{f"<em>{round((1 - qt[n - 1] / qt[0]) * 100)}%↓</em>" if n > 1 and qt[n - 1] < qt[0] else "<em>&nbsp;</em>"}</button>'
                    for n in (1, 2, 3, 5) if n <= len(qt) and not (n == 5 and qt[4] >= qt[2]))  # 5개가 3개보다 안 싸면 칸 생략
    return f'<div class="qty-deal" id="qty-deal"><p><b>많이 살수록 개당 가격이 내려가요</b> <span class="muted">2개부터 자동 할인 · 옵션이 달라도 같은 상품이면 합산돼요</span></p><div class="qty-cells">{cells}</div></div>'


def product_body(p, related):
    """상품 상세 본문 (정적 상품 페이지와 DB용 템플릿 item.html이 함께 씀)"""
    r = rate(p)
    img = p["image"] if p["image"].startswith("http") else "../" + p["image"]
    url = f'{BASE}/product/{p["id"]}.html'
    ld = {"@context": "https://schema.org", "@type": "Product", "name": p["name"], "image": [abs_img(p)] + p["images"],
          "description": p["summary"] or p["name"], "sku": p["id"], "brand": {"@type": "Brand", "name": p["brand"] or CFG["shop_name"]},
          "offers": {"@type": "Offer", "url": url, "priceCurrency": "KRW", "price": p["price"],
                     "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/NewCondition",
                     "shippingDetails": {"@type": "OfferShippingDetails", "shippingRate": {"@type": "MonetaryAmount", "value": p["shipping_fee"], "currency": "KRW"}}}}
    gallery = [img] + p["images"]
    thumbs = ('<div class="thumbs">' + "".join(f'<button data-src="{e(u)}" class="{"on" if i == 0 else ""}" aria-label="사진 {i + 1}"><img src="{e(u)}" alt="" loading="lazy"></button>' for i, u in enumerate(gallery)) + "</div>") if len(gallery) > 1 else ""
    desc = "".join(f"<p>{e(x)}</p>" for x in p["desc_lines"]) + (f'<div class="detail-html">{p["detail_html"]}</div>' if p["detail_html"] else "")
    if not desc:
        desc = f'<img src="{e(img)}" alt="{e(p["name"])}" loading="lazy" style="max-width:640px;width:100%"><p style="margin-top:18px">{e(p["name"])}</p><p class="muted">자세한 상품 정보는 고객센터로 문의해 주시면 안내해 드리겠습니다.</p>'
    opts = ""
    if p["options"]:
        opts = f'<label class="opt-label" for="opt">{e(p["option_name"])}</label><select id="opt" class="opt-select"><option value="">선택해 주세요</option>' + "".join(
            f'<option value="{i}"{" disabled" if o.get("so") else ""}>{"[품절] " if o.get("so") else ""}{e(o["v"])}{(" (+" + won(o["add"]) + ")") if o["add"] > 0 else ((" (" + won(o["add"]) + ")") if o["add"] < 0 else "")}</option>' for i, o in enumerate(p["options"])) + "</select>"
    body = f'''<div class="wrap"><div class="crumb"><a href="../index.html">홈</a> / <a href="../category/{p["category"]}.html">{e(p["category_name"])}</a></div>
<div class="detail">
<div class="gallery"><div class="main-img"><img id="main-img" src="{e(img)}" alt="{e(p["name"])}">{f'<span class="badge {e(p["badge"])}">{e(p["badge"])}</span>' if p["badge"] else ""}</div>{thumbs}</div>
<div class="d-info-box">{f'<div class="d-brand">{e(p["brand"])}</div>' if p["brand"] else ""}<h1 class="d-name">{e(p["name"])}</h1>
{f'<p class="d-summary">{e(p["summary"])}</p>' if p["summary"] else ""}<div class="d-rating" id="d-rating"></div>
<div class="d-price">{f'<span class="rate">{r}%</span>' if r else ""}<span class="now">{won(p["price"])}</span>{f"<del>{won(p['normal_price'])}</del>" if r else ""}</div>
<dl class="d-meta"><dt>배송비</dt><dd>{"<b>무료배송</b>" if not p["shipping_fee"] else won(p["shipping_fee"])}</dd>
<dt>배송 안내</dt><dd>결제 후 영업일 1~3일 안에 출고</dd></dl>
{opts}
<div class="qty-row"><span>수량</span><div class="qty"><button id="minus" aria-label="빼기">−</button><input id="qty" value="1" inputmode="numeric" aria-label="수량"><button id="plus" aria-label="더하기">+</button></div></div>
<div class="d-total"><span>총 상품 금액</span><strong id="d-total">{won(p["price"])}</strong></div>
<div class="d-btns" id="buy" data-id="{e(p["id"])}" data-name="{e(p["name"])}" data-price="{p["price"]}" data-opts='{e(json.dumps([o["add"] for o in p["options"]]))}' data-qt='{e(json.dumps(p.get("qt") or []))}'>
<button class="wish-toggle" aria-label="찜하기">{I_HEART}</button>{'<button class="btn btn-soldout" disabled>일시품절 · 입고되면 다시 판매해요</button>' if p.get("soldout") else '<button class="btn btn-line" id="add-cart">장바구니</button><button class="btn btn-dark" id="buy-now">바로 구매</button>'}</div>
{qty_table(p)}
<a class="bulk-box" id="bulk-box" href="../bulk.html?id={e(p["id"])}"{' hidden' if p.get("soldout") else ''}><span class="bulk-ico">📦</span><span><b>대량 구매 · 기업/단체 견적</b><small>10개 이상, 사은품·판촉물·회사 비품 — 수량에 맞춰 더 좋은 가격으로 견적 드려요</small></span><span class="bulk-go">견적 요청 ›</span></a>
<div class="d-share"><button id="share-btn">공유하기</button><a href="../cs.html#inquiry">문의하기</a></div>
</div></div>
<nav class="tabs"><a href="#info" class="on">상세정보</a><a href="#review">리뷰 <span class="rv-count">0</span></a><a href="#qna">문의 <span class="qa-count">0</span></a><a href="#guide">배송·교환·반품</a></nav>
<section class="tab-sec" id="info"><div class="detail-body">{desc}</div>
<h3 style="margin-top:56px">상품정보 제공고시</h3><table class="notice-table">
<tr><th>상품명</th><td>{e(p["name"])}</td></tr><tr><th>브랜드</th><td>{e(p["brand"] or "상세설명 참조")}</td></tr>
<tr><th>제조자 / 수입자</th><td>{e(p["maker"] or "상세설명 참조")}</td></tr><tr><th>제조국</th><td>상세페이지 참조</td></tr>
<tr><th>품질보증 기준</th><td>관련 법 및 소비자분쟁해결기준에 따름</td></tr>
<tr><th>A/S 책임자와 전화번호</th><td>{e(BIZ["company"])} {e(BIZ["phone"])}</td></tr></table></section>
<section class="tab-sec" id="review"><h3>리뷰 <button class="btn btn-line sm" id="rv-open">리뷰 쓰기</button></h3>
<div class="mini-form" id="rv-form"><p class="muted">상품을 구매하신 분만 작성하실 수 있습니다. 주문번호와 주문 시 입력한 연락처를 입력해 주세요.</p>
<div class="star-pick" aria-label="별점">{"".join(f'<button data-v="{i}" aria-label="{i}점">★</button>' for i in range(1, 6))}</div>
<div class="form"><div class="row"><input id="rv-order" placeholder="주문번호" aria-label="주문번호"><input id="rv-phone" placeholder="연락처" inputmode="tel" aria-label="연락처"></div>
<textarea id="rv-text" placeholder="상품은 어떠셨나요? (5자 이상)" style="margin-top:8px" aria-label="리뷰 내용"></textarea></div>
<button class="btn btn-dark sm" id="rv-submit" style="margin-top:10px">등록하기</button></div>
<div id="rv-box"><p class="empty">리뷰를 불러오고 있습니다.</p></div></section>
<section class="tab-sec" id="qna"><h3>상품 문의 <button class="btn btn-line sm" id="qa-open">문의하기</button></h3>
<div class="mini-form" id="qa-form"><div class="form"><div class="row"><input id="qa-name" placeholder="이름" aria-label="이름"><input id="qa-contact" placeholder="연락처 (답변 알림용, 선택)" aria-label="연락처"></div>
<textarea id="qa-text" placeholder="궁금하신 점을 남겨 주세요. (5자 이상)" style="margin-top:8px" aria-label="문의 내용"></textarea>
<label class="check"><input type="checkbox" id="qa-secret">비밀글로 문의하기</label></div>
<button class="btn btn-dark sm" id="qa-submit">등록하기</button></div>
<div id="qa-box"></div></section>
<section class="tab-sec" id="guide"><h3>배송·교환·반품 안내</h3><table class="notice-table">
<tr><th>배송</th><td>결제 확인 후 영업일 기준 1~3일 안에 출고되며, 출고 후 1~2일 안에 받아보실 수 있습니다. 전 상품 무료배송입니다. (제주 3,000원, 도서산간 5,000원 추가 배송비가 결제할 때 자동으로 더해집니다.)</td></tr>
<tr><th>교환·반품 기간</th><td>단순 변심: 상품을 받으신 날부터 7일 이내<br>상품 불량·오배송: 받으신 날부터 3개월 이내 또는 그 사실을 안 날부터 30일 이내</td></tr>
<tr><th>교환·반품 비용</th><td>단순 변심은 왕복 배송비를 고객님께서 부담하시며, 상품 불량·오배송은 판매자가 부담합니다.</td></tr>
<tr><th>교환·반품이 어려운 경우</th><td>고객님의 책임으로 상품이 훼손된 경우, 사용하거나 일부 소비하여 가치가 현저히 떨어진 경우, 포장을 개봉하여 재판매가 어려운 경우</td></tr>
<tr><th>신청 방법</th><td><a href="../orders.html" style="text-decoration:underline">주문·배송 조회</a>에서 주문번호와 연락처를 입력하신 뒤 신청하실 수 있습니다.</td></tr></table></section>
{f'<section class="section last"><div class="sec-head"><div><h2>함께 보면 좋은 상품</h2></div><a href="../category/{p["category"]}.html">{e(p["category_name"])} 더 보기</a></div><div class="grid">{"".join(card(x, "../") for x in related)}</div></section>' if related else '<div class="section last"></div>'}
</div>'''
    return body, ld, url, img


def build_products(ps):
    by_cat = {}
    for p in ps:
        by_cat.setdefault(p["category"], []).append(p)
    for p in ps:
        sib = by_cat[p["category"]]
        k = sib.index(p)
        related = [x for x in (sib[k + 1:k + 5] + sib[:4]) if x is not p][:4]
        body, ld, url, img = product_body(p, related)
        write(f'product/{p["id"]}.html', layout(f'{p["name"]} — {CFG["shop_name"]}', body, "../", active=p["category"],
              desc=f'{p["name"]} {won(p["price"])} 무료배송. {p["summary"]}'.strip(), canonical=url, og_img=abs_img(p),
              extra_head=f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'))
    # 상품 DB용 템플릿: product/item.html?id=상품번호 → 브라우저가 서버(/catalog/item)에서 받아 채움 (100만 개도 페이지 1장)
    blank = {"id": "", "name": "상품 정보를 불러오고 있어요", "price": 0, "normal_price": 0, "image": "noimg.svg", "images": [], "summary": "",
             "brand": "", "shipping_fee": 0, "desc_lines": [], "detail_html": "", "options": [], "option_name": "옵션", "category": "",
             "category_name": "", "badge": "", "origin": "", "maker": "", "soldout": False}
    body = product_body(blank, [])[0].replace('<div class="wrap"><div class="crumb">', '<div class="wrap" id="item-tpl"><div class="crumb">', 1)
    write("product/item.html", layout(f'상품 — {CFG["shop_name"]}', body, "../", extra_head='<meta name="robots" content="noindex">'))


def simple(path, title, inner, scripts="", root="./", heading=True):
    h = f'<h1 class="page-title">{e(title)}</h1>' if heading else ""
    write(path, layout(f'{title} — {CFG["shop_name"]}', f'<div class="wrap page">{h}{inner}</div>', root, scripts=scripts))


FAQ = [
    ("회원가입을 해야 주문할 수 있나요?", "아니요. 회원가입 없이 바로 주문하실 수 있습니다. 주문 후에는 주문번호와 연락처로 배송 상황을 확인하실 수 있습니다."),
    ("배송비는 얼마인가요?", "모든 상품은 무료로 배송해 드립니다. 다만 제주는 3,000원, 울릉·섬 지역 등 도서산간은 5,000원의 추가 배송비가 결제할 때 자동으로 더해집니다."),
    ("배송은 얼마나 걸리나요?", "결제 확인 후 영업일 기준 1~3일 안에 출고되며, 출고 후 보통 1~2일 안에 받아보실 수 있습니다. 여러 상품을 함께 주문하시면 상품별로 따로 배송될 수 있습니다."),
    ("주문을 취소하고 싶어요.", "주문·배송 조회에서 직접 취소하실 수 있습니다. 상품 준비 전에는 즉시 취소·환불되며, 이미 출고된 경우에는 반품으로 진행됩니다."),
    ("교환이나 반품은 어떻게 하나요?", "상품을 받으신 날부터 7일 이내에 주문·배송 조회에서 신청하실 수 있습니다. 단순 변심은 왕복 배송비를 부담하셔야 하며, 불량·오배송은 무료로 처리해 드립니다."),
    ("환불은 언제 되나요?", "취소는 즉시, 반품은 상품이 도착해 확인된 뒤 3영업일 안에 결제하신 수단으로 환불됩니다. 카드사 사정에 따라 3~7영업일이 더 걸릴 수 있습니다."),
    ("어떤 결제 수단을 쓸 수 있나요?", "신용·체크카드, 계좌이체, 가상계좌, 간편결제(토스페이 등)를 이용하실 수 있습니다. 결제는 토스페이먼츠를 통해 안전하게 처리됩니다."),
    ("현금영수증이나 세금계산서를 받을 수 있나요?", "현금영수증은 결제 단계에서 신청하실 수 있습니다. 세금계산서가 필요하시면 1:1 문의로 사업자 정보를 남겨 주세요."),
    ("여러 개 사면 할인되나요?", "같은 상품을 3개 이상 사실 때 상품 페이지의 ‘대량 구매 가격 제안’으로 개당 최대 3%까지 낮은 가격을 제안하실 수 있습니다. 판매자가 48시간 안에 답변하며, 수락되면 72시간 안에 제안 가격으로 주문하실 수 있습니다. 결과는 주문·배송 조회 아래 ‘가격 제안 내역’에서 확인하세요."),
    ("쿠폰은 어디에 입력하나요?", "주문서의 결제 금액 영역에서 쿠폰 코드를 입력하고 적용 버튼을 누르시면 됩니다."),
    ("리뷰는 누구나 쓸 수 있나요?", "실제로 구매하신 분만 작성하실 수 있습니다. 상품이 발송된 뒤 상품 페이지에서 주문번호와 연락처를 입력해 작성해 주세요."),
]


def build_shop_pages():
    write("search.html", layout(f'상품 검색 — {CFG["shop_name"]}', listing("전체 상품", "search", [], "./", count=0), "./"))
    write("wish.html", layout(f'찜한 상품 — {CFG["shop_name"]}', listing("찜한 상품", "wish", [], "./", count=0), "./"))
    simple("cart.html", "장바구니", '''<div class="steps"><b>장바구니</b><span>›</span><span>주문/결제</span><span>›</span><span>주문 완료</span></div>
<div class="main"><div class="card"><div id="cart-box"></div></div><div class="sticky"><div class="card" id="cart-sum"></div></div></div>''')
    test = "" if not CFG["toss_client_key"].startswith("test_") else \
        '<div class="note">지금은 <b>테스트 결제</b> 모드입니다. 실제로 결제되지 않습니다.</div>'
    simple("checkout.html", "주문/결제", f'''<div class="steps"><span>장바구니</span><span>›</span><b>주문/결제</b><span>›</span><span>주문 완료</span></div>{test}
<div class="main" id="checkout"><div>
<div class="card"><h2>주문 상품</h2><div id="order-items"></div></div>
<div class="card form"><h2>배송지</h2>
<label for="name">받는 분</label><input id="name" autocomplete="name">
<label for="phone">연락처</label><input id="phone" inputmode="tel" placeholder="010-0000-0000" autocomplete="tel">
<label for="email">이메일 (선택 · 주문·배송 알림 메일)</label><input id="email" type="email" autocomplete="email">
<label for="zip">주소</label><div class="row"><input id="zip" placeholder="우편번호" readonly><button type="button" id="find-addr">주소 찾기</button></div>
<input id="addr1" placeholder="기본 주소" readonly style="margin-top:8px" aria-label="기본 주소"><input id="addr2" placeholder="상세 주소" style="margin-top:8px" aria-label="상세 주소" autocomplete="address-line2">
<label for="memo-sel">배송 메모</label><select id="memo-sel"><option value="">선택 안 함</option><option>문 앞에 놓아 주세요</option><option>경비실에 맡겨 주세요</option><option>배송 전에 연락 주세요</option><option>부재 시 문 앞에 놓아 주세요</option><option>직접 입력</option></select>
<input id="memo" placeholder="배송 메모를 입력해 주세요" style="margin-top:8px;display:none" aria-label="배송 메모">
<label class="check" style="margin-top:14px"><input type="checkbox" id="save-addr" checked>이 기기에 배송지 저장하기</label></div>
<div class="card"><h2>결제 수단</h2><div id="payment-method"></div><div id="agreement"></div></div></div>
<div class="sticky"><div class="card"><h2>결제 금액</h2>
<label class="opt-label" for="coupon-in">쿠폰 코드</label><div class="coupon-row"><input id="coupon-in" placeholder="코드 입력" autocomplete="off"><button type="button" id="coupon-btn">적용</button></div>
<p id="coupon-msg" class="muted" style="margin:6px 0 14px;min-height:20px"></p>
<div id="order-sum"></div>
<div style="margin-top:18px"><label class="check all"><input type="checkbox" id="agree-all">전체 동의</label>
<label class="check"><input type="checkbox" class="agree-req">[필수] 주문 내용을 확인했으며 결제에 동의합니다.</label>
<label class="check"><input type="checkbox" class="agree-req"><span>[필수] 개인정보 수집·이용에 동의합니다. <a href="privacy.html" target="_blank">보기</a></span></label>
<label class="check"><input type="checkbox" class="agree-req">[필수] 배송을 위한 개인정보 제3자(택배사·공급사) 제공에 동의합니다.</label></div>
<button class="btn btn-dark" id="pay-btn" style="margin-top:14px">결제하기</button></div></div></div>''',
           scripts='<script src="https://js.tosspayments.com/v2/standard"></script><script src="https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"></script>')
    simple("success.html", "주문 완료", '<div class="card done-box" id="success">결제를 확인하고 있습니다.</div>', heading=False)
    simple("fail.html", "결제 실패", '<div class="card done-box" id="fail"><h2>결제가 완료되지 않았습니다</h2><p id="fail-msg"></p><a class="btn btn-dark sm" style="max-width:220px;margin:24px auto 0" href="cart.html">장바구니로</a></div>', heading=False)
    simple("orders.html", "주문·배송 조회", '''<div class="narrow"><div class="card form"><p class="muted">주문번호와 주문하실 때 입력한 연락처로 조회하실 수 있습니다. 취소·반품·교환도 여기에서 신청합니다.</p>
<label for="o-id">주문번호</label><input id="o-id" placeholder="예) T261112-AB12CD">
<label for="o-phone">연락처</label><input id="o-phone" inputmode="tel" placeholder="010-0000-0000">
<button class="btn btn-dark" id="o-btn" style="margin-top:18px">조회하기</button></div>
<div class="card" id="my-orders" style="display:none"></div></div>
<div class="narrow" id="order-result" style="margin-top:16px;max-width:760px"></div>
''')
    simple("login.html", "로그인", f'''<div class="narrow"><div class="card login-box" id="login-box">
<p class="login-lead">회원가입 없이 쓰던 계정으로 <b>3초 만에</b> 시작하세요</p>
<a class="sns-btn naver" data-provider="naver" href="#"><span class="sns-ico">N</span>네이버로 시작하기</a>
<a class="sns-btn kakao" data-provider="kakao" href="#"><span class="sns-ico">●</span>카카오로 시작하기</a>
<a class="sns-btn google" data-provider="google" href="#"><span class="sns-ico">G</span>구글로 시작하기</a>
<ul class="login-merit"><li>주문 내역·배송 조회를 어느 기기에서나</li><li>배송지 자동 입력으로 빠른 결제</li><li>찜한 상품·가격 제안 내역 보관</li></ul>
<p class="muted" style="margin-top:14px">로그인하면 <a href="terms.html" style="text-decoration:underline">이용약관</a>과 <a href="privacy.html" style="text-decoration:underline">개인정보처리방침</a>에 동의한 것으로 봅니다. 회원이 아니어도 <a href="orders.html" style="text-decoration:underline">비회원 주문 조회</a>와 주문을 그대로 이용할 수 있어요.</p></div>
<div class="card" id="me-box" hidden></div></div>''')
    faq = "".join(f"<details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in FAQ)
    simple("cs.html", "고객센터", f'''<div class="policy" style="margin-top:0"><div class="cs-grid">
<div>{I_PHONE}<b>{e(BIZ["phone"])}</b>{e(BIZ["cs_hours"])}</div>
<a href="orders.html">{I_BOX}<b>주문·배송 조회</b>취소·반품·교환 신청</a>
<a href="#inquiry">{I_CHAT}<b>1:1 문의</b>남겨주시면 답변드립니다</a>
<a href="bulk.html">{I_BOX}<b>대량 구매 문의</b>기업·단체·사은품 견적</a></div>
<div class="card"><h2>자주 묻는 질문</h2><div class="faq">{faq}</div></div>
<div class="card form" id="inquiry"><h2>1:1 문의</h2>
<div class="row"><input id="inq-name" placeholder="이름" aria-label="이름"><input id="inq-contact" placeholder="연락처 또는 이메일" aria-label="연락처"></div>
<label for="inq-type">문의 유형</label><select id="inq-type"><option>배송</option><option>주문·결제</option><option>취소·반품·교환</option><option>상품</option><option>기타</option></select>
<label for="inq-order">주문번호 (선택)</label><input id="inq-order">
<label for="inq-text">문의 내용</label><textarea id="inq-text" style="height:140px"></textarea>
<label class="check"><input type="checkbox" id="inq-agree"><span>문의 답변을 위한 개인정보(이름·연락처) 수집·이용에 동의합니다.</span></label>
<button class="btn btn-dark" id="inq-btn" style="margin-top:8px">문의 보내기</button></div></div>''')
    simple("bulk.html", "대량 구매 문의", '''<div class="narrow"><div class="card form" id="bulk">
<p class="muted">회사·단체 구매, 행사 사은품, 판촉물처럼 많은 수량이 필요하시면 남겨 주세요. 수량과 일정에 맞춰 견적을 보내 드립니다.<br>
<b>10개 이하</b>는 상품 페이지에서 바로 주문하시면 수량 할인이 자동으로 적용돼요.</p>
<div id="bulk-item" class="bulk-item" hidden></div>
<label for="bk-product">상품명 또는 상품 주소</label><input id="bk-product" placeholder="예) 메탈 선반 4단 화이트">
<div class="row"><div><label for="bk-qty">필요 수량</label><input id="bk-qty" inputmode="numeric" placeholder="예) 200"></div><div><label for="bk-date">받고 싶은 날짜 (선택)</label><input id="bk-date" type="date"></div></div>
<label for="bk-price">희망 단가 또는 예산 (선택)</label><input id="bk-price" placeholder="예) 개당 15,000원 / 총 300만 원">
<div class="row"><div><label for="bk-name">회사·단체명 / 담당자</label><input id="bk-name" placeholder="예) 땡잡았땡상사 홍길동"></div><div><label for="bk-contact">연락처</label><input id="bk-contact" inputmode="tel" placeholder="010-0000-0000"></div></div>
<label for="bk-email">이메일 (견적서 받을 곳, 선택)</label><input id="bk-email" type="email">
<label class="check"><input type="checkbox" id="bk-tax"><span>세금계산서 발행이 필요해요</span></label>
<label class="check"><input type="checkbox" id="bk-print"><span>로고 인쇄·개별 포장 등 맞춤 작업이 필요해요</span></label>
<label for="bk-text">요청 사항</label><textarea id="bk-text" style="height:110px" placeholder="옵션(색상·사이즈)별 수량, 배송지가 여러 곳인지 등"></textarea>
<label class="check"><input type="checkbox" id="bk-agree"><span>견적 안내를 위한 개인정보(이름·연락처·이메일) 수집·이용에 동의합니다.</span></label>
<button class="btn btn-dark" id="bk-btn" style="margin-top:8px">견적 요청 보내기</button></div></div>''')
    write("404.html", layout(f'페이지를 찾을 수 없습니다 — {CFG["shop_name"]}', f'''<div class="wrap page"><div class="done-box"><div class="mark">?</div><h2>페이지를 찾을 수 없습니다</h2>
<p>주소가 바뀌었거나 판매가 끝난 상품일 수 있습니다.</p><a class="btn btn-dark sm" style="max-width:220px;margin:24px auto 0" href="{BASE}/">홈으로</a></div></div>''', BASE + "/"))
    write("noimg.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f3f1ed"/><g fill="none" stroke="#c9c5bc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><rect x="130" y="145" width="140" height="110"/><circle cx="170" cy="182" r="12"/><path d="M130 235l42-36 34 26 26-20 38 30"/></g></svg>')
    write("favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#16171a"/><text x="32" y="44" font-size="34" font-weight="700" text-anchor="middle" fill="#fff" font-family="serif">땡</text><circle cx="52" cy="50" r="4" fill="#9a7b4f"/></svg>')
    write("manifest.json", json.dumps({"name": CFG["shop_name"], "short_name": CFG["shop_name"], "description": CFG["slogan"], "lang": "ko",
          "start_url": "./index.html", "scope": "./", "display": "standalone", "background_color": "#fbfaf8", "theme_color": "#fdf8ef",
          "icons": [{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                    {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
          "shortcuts": [{"name": "주문·배송 조회", "url": "./orders.html"}, {"name": "장바구니", "url": "./cart.html"}]}, ensure_ascii=False))
    simple("offline.html", "인터넷 연결을 확인해 주세요", '<div class="done-box"><p>지금은 인터넷에 연결되어 있지 않습니다.<br>연결된 뒤 다시 시도해 주세요.</p><a class="btn btn-dark sm" style="max-width:220px;margin:24px auto 0" href="index.html">다시 시도</a></div>')


def build_policies():
    c, s = BIZ["company"], CFG["shop_name"]
    simple("terms.html", "이용약관", f'''<div class="card policy">
<h3>제1조 (목적)</h3><p>이 약관은 {e(c)}(이하 "회사")가 운영하는 {e(s)}(이하 "몰")에서 제공하는 전자상거래 서비스의 이용 조건과 절차, 회사와 이용자의 권리·의무를 정합니다.</p>
<h3>제2조 (구매 신청)</h3><p>이용자는 몰에서 상품을 선택하고 배송지 정보를 입력한 뒤 결제하는 방법으로 구매를 신청합니다. 회원가입 없이 비회원으로 구매할 수 있습니다.</p>
<h3>제3조 (계약의 성립)</h3><p>회사가 결제 승인을 확인하면 구매 계약이 성립합니다. 재고 부족 등으로 공급이 어려운 경우 지체 없이 알리고 결제를 취소합니다.</p>
<h3>제4조 (배송)</h3><p>결제 확인 후 영업일 기준 1~3일 안에 출고합니다. 일부 상품은 공급사에서 직접 발송됩니다.</p>
<h3>제5조 (청약철회)</h3><p>이용자는 「전자상거래 등에서의 소비자보호에 관한 법률」에 따라 상품을 받은 날부터 7일 이내에 청약을 철회할 수 있습니다. 자세한 사항은 교환·환불 안내를 따릅니다.</p>
<h3>제6조 (분쟁 해결)</h3><p>분쟁이 생기면 고객센터({e(BIZ["phone"])})로 접수해 주시면 성실히 처리합니다. 해결되지 않으면 공정거래위원회 또는 시·도지사가 의뢰하는 분쟁조정기관의 조정을 따를 수 있습니다.</p>
<p style="margin-top:20px;color:#888">시행일: {datetime.date.today():%Y-%m-%d}</p></div>''')
    simple("privacy.html", "개인정보처리방침", f'''<div class="card policy">
<p>{e(c)}(이하 "회사")는 「개인정보 보호법」에 따라 이용자의 개인정보를 보호하고 관련 고충을 신속하게 처리하기 위해 다음과 같이 개인정보처리방침을 둡니다.</p>
<h3>1. 수집하는 개인정보 항목과 수집 방법</h3>
<ul style="padding-left:18px;list-style:disc"><li>주문 시: 받는 분 이름, 연락처, 주소, 배송 메모, 이메일(선택)</li>
<li>상품 문의·1:1 문의 시: 이름, 연락처 또는 이메일(선택), 문의 내용</li><li>리뷰 작성 시: 주문번호, 연락처(구매 확인용), 리뷰 내용</li>
<li>사이트 이용 시 자동 수집: 이 브라우저에 저장되는 무작위 방문자 번호, 방문한 페이지, 유입 경로(어느 사이트에서 왔는지) — 이름·연락처 등 개인을 알아볼 수 있는 정보는 수집하지 않으며 방문 통계에만 씁니다.</li>
<li>대량 구매 문의 시: 회사·단체명, 담당자 이름, 연락처, 이메일(선택), 문의 내용</li>
<li>간편 로그인(네이버·카카오·구글) 시: 각 서비스의 회원 고유번호, 이름(또는 별명), 이메일, 휴대전화번호(동의한 경우에 한함) — 이용자가 해당 서비스에서 제공에 동의한 항목만 받습니다. 비밀번호는 받지 않습니다.</li>
<li>공급사 입점 신청 시: 회사명, 사업자등록번호, 담당자 이름, 연락처, 이메일</li>
<li>결제 정보(카드번호 등)는 결제대행사가 직접 처리하며 회사는 저장하지 않습니다.</li></ul>
<h3>2. 이용 목적</h3><p>회원 식별과 로그인 유지, 주문 내역·배송지·찜 목록 보관, 주문 확인과 상품 배송, 결제·환불 처리, 교환·반품 처리, 고객 문의 응대, 리뷰 작성 자격 확인, 공급사 입점 심사.</p>
<h3>3. 보유 및 이용 기간</h3><p>「전자상거래 등에서의 소비자보호에 관한 법률」에 따라 계약 또는 청약철회 등에 관한 기록 5년, 대금결제 및 재화 등의 공급에 관한 기록 5년, 소비자의 불만 또는 분쟁처리에 관한 기록 3년간 보관한 뒤 지체 없이 파기합니다. 회원 정보는 탈퇴를 요청하실 때까지 보관하며, 1년 동안 로그인하지 않으면 분리 보관하거나 삭제합니다. 문의 내용은 답변 완료 후 3년간 보관합니다.</p>
<h3>4. 개인정보의 제3자 제공</h3><p>회사는 배송을 위해 필요한 범위에서만 개인정보를 제공합니다.</p>
<table class="notice-table"><tr><th>제공받는 자</th><td>택배사, 해당 상품의 공급사(도매꾹·도매매, 오너클랜 등 도매처와 그 상품 공급업체)</td></tr><tr><th>제공 항목</th><td>받는 분 이름, 연락처, 주소, 배송 메모</td></tr>
<tr><th>이용 목적</th><td>상품 배송</td></tr><tr><th>보유 기간</th><td>배송 완료 후 3개월</td></tr></table>
<h3>5. 개인정보 처리 위탁</h3>
<table class="notice-table"><tr><th>(주)토스페이먼츠</th><td>결제 처리 및 결제 도용 방지</td></tr><tr><th>Netlify, Inc. (미국)</th><td>주문·문의 데이터 보관 및 서버 운영 (국외 이전: 주문·문의 시 네트워크를 통해 전송, 위 보유 기간 동안 보관)</td></tr>
<tr><th>GitHub, Inc. (미국)</th><td>웹사이트 호스팅 (개인정보는 저장하지 않음)</td></tr>
<tr><th>tracker.delivery</th><td>배송 조회 (택배사·송장번호만 전달, 이름·주소는 전달하지 않음)</td></tr></table>
<h3>6. 이용자 기기에 저장되는 정보</h3><p>장바구니, 찜, 최근 본 상품, 배송지(저장을 선택한 경우), 주문번호는 이용자의 브라우저에 저장됩니다. 로그인한 회원은 찜 목록과 저장을 선택한 배송지가 회원 정보에도 보관되어 다른 기기에서도 볼 수 있습니다. 로그인 상태는 브라우저에 저장된 로그인 키로 유지되며 30일이 지나면 만료됩니다. 브라우저 설정에서 사이트 데이터를 삭제하면 지워집니다.</p>
<h3>7. 이용자의 권리와 행사 방법</h3><p>이용자는 언제든지 자신의 개인정보에 대해 열람, 정정, 삭제, 처리정지를 요청할 수 있습니다. 고객센터({e(BIZ["phone"])}) 또는 이메일({e(BIZ["email"])})로 요청하시면 지체 없이 처리합니다. 만 14세 미만 아동의 개인정보는 수집하지 않습니다.</p>
<h3>8. 파기 절차와 방법</h3><p>보유 기간이 지나거나 처리 목적이 달성된 개인정보는 복구할 수 없는 방법으로 지체 없이 삭제합니다.</p>
<h3>9. 안전성 확보 조치</h3><p>전송 구간 암호화(HTTPS), 관리자 접근 통제, 결제 정보 미보관 등의 조치를 하고 있습니다.</p>
<h3>10. 개인정보 보호책임자</h3><p>{e(BIZ["privacy_officer"])} · {e(BIZ["phone"])} · {e(BIZ["email"])}</p>
<h3>11. 권익침해 구제 방법</h3><p>개인정보침해신고센터(privacy.kisa.or.kr, 국번 없이 118), 개인정보분쟁조정위원회(www.kopico.go.kr, 1833-6972), 경찰청 사이버수사국(ecrm.police.go.kr, 182)</p>
<p style="margin-top:20px;color:#888">시행일: {datetime.date.today():%Y-%m-%d}</p></div>''')
    simple("refund.html", "교환·환불 안내", f'''<div class="card policy">
<h3>신청 기간</h3><p>단순 변심: 상품 수령 후 7일 이내 / 상품 불량·오배송: 수령 후 3개월 이내 또는 사실을 안 날부터 30일 이내</p>
<h3>배송비</h3><p>단순 변심은 왕복 배송비를 고객님이 부담하며, 불량·오배송은 회사가 부담합니다.</p>
<h3>교환·반품이 어려운 경우</h3><ul style="padding-left:18px"><li>고객님의 책임으로 상품이 훼손된 경우</li><li>사용 또는 일부 소비로 상품 가치가 크게 떨어진 경우 (식품 개봉 등)</li><li>시간이 지나 재판매가 어려울 만큼 가치가 떨어진 경우</li></ul>
<h3>환불</h3><p>반품 상품 확인 후 3영업일 안에 결제수단으로 환불합니다.</p>
<h3>신청 방법</h3><p>고객센터 {e(BIZ["phone"])} 또는 {e(BIZ["email"])}로 주문번호와 함께 연락 주세요.</p></div>''')


def build_partner_pages():
    cats = "".join(f'<option value="{c["slug"]}">{e(c["name"])}</option>' for c in CATS)
    simple("seller.html", "공급사 입점", f'''<div class="main"><div>
<div class="card"><h2>공급사 입점 안내</h2><p style="color:#555">{e(CFG["shop_name"])}에 상품을 공급해 주실 도매·제조 공급사를 모집해요.
상품을 올려주시면 검수 후 쇼핑몰에 노출하고, 주문이 들어오면 발주서를 보내드려요. 공급사는 고객에게 직접 배송만 해주시면 돼요.</p>
<ol style="padding-left:20px;margin-top:10px;color:#333"><li>아래에서 입점 신청 → 승인되면 <b>입점코드</b>를 받아요</li><li>입점코드로 상품 등록 (공급가·배송비·사진·설명)</li><li>검수 후 판매 시작, 주문 시 발주 안내</li></ol></div>
<div class="card form" id="apply-form"><h2>1. 입점 신청</h2>
<label>회사명</label><input name="company"><label>사업자등록번호</label><input name="biz_no" placeholder="000-00-00000">
<label>담당자</label><input name="manager"><label>연락처</label><input name="phone"><label>이메일</label><input name="email" type="email">
<label>주요 취급 상품</label><textarea name="items"></textarea>
<button class="btn btn-dark" style="margin-top:14px" data-api="/seller/apply">입점 신청하기</button></div>
<div class="card form" id="product-form"><h2>2. 상품 등록 (입점코드 필요)</h2>
<label>입점코드</label><input name="code" placeholder="승인 시 받은 코드">
<label>상품명</label><input name="name"><label>카테고리</label><select name="category" >{cats}</select>
<label>오픈마켓 판매가 (원, 무료배송 기준 — 쿠팡·11번가 등에서 지금 파는 가격)</label><input name="market_price" inputmode="numeric" id="market-in">

<div id="price-preview" class="note" style="margin:10px 0 0;line-height:1.8">오픈마켓 판매가를 입력하면 판매가·정산금이 자동 계산돼요.<br>판매가 = 오픈마켓가 그대로 / 정산금 = 판매가 − 카드수수료 − 플랫폼 3% (전 상품 무료배송)<br>고객이 3개 이상 살 때 최대 3%까지 가격 제안을 할 수 있고, 수락 여부는 공급사가 정해요.</div>
<label>권장 소비자가 (선택)</label><input name="normal_price" inputmode="numeric">
<label>브랜드 / 제조사 / 원산지</label><div class="row"><input name="brand" placeholder="브랜드"><input name="maker" placeholder="제조사"><input name="origin" placeholder="원산지"></div>
<label>대표 이미지 (정사각형 권장, 2MB 이하)</label><input name="image" type="file" accept="image/*" style="padding-top:10px">
<label>한 줄 소개</label><input name="summary">
<label>상세 설명 (줄마다 한 가지 특징)</label><textarea name="description" style="height:120px"></textarea>
<button class="btn btn-dark" style="margin-top:14px" data-api="/seller/product">상품 등록 요청</button></div>
<div class="card form" id="bulk-form"><h2>3. 엑셀로 한꺼번에 등록</h2>
<p style="color:#555;font-size:15px">땡잡았땡 상품등록 양식을 내려받아 채워서 올려 주세요. 수백 개도 한 번에 접수돼요.<br>
가격은 <b>오픈마켓 판매가(무료배송 기준)</b>이 그대로 판매가가 되고, 대표 이미지는 <b>이미지 주소(https://…)</b>로 적어 주세요.</p>
<a class="btn btn-line" style="margin-top:12px" href="product_template.xlsx" download>땡잡았땡 상품등록 양식 내려받기 (.xlsx)</a>
<label>입점코드</label><input id="bulk-code" placeholder="승인 시 받은 코드">
<label>작성한 엑셀 파일</label><input id="bulk-file" type="file" accept=".xlsx,.xls,.csv" style="padding-top:10px">
<button class="btn btn-dark" style="margin-top:14px" id="bulk-btn">엑셀 상품 등록 요청</button>
<div id="bulk-result" style="margin-top:14px;font-size:14px"></div></div>
</div><div><div class="card"><h2>공급사 혜택</h2><ul class="why" style="padding:0"><li>수수료는 카드수수료 + 3%뿐 (오픈마켓 10~13%)</li><li>입점비·월 이용료 없음</li><li>주문 즉시 발주 안내</li><li>많이 살수록 자동 수량 할인으로 객단가 상승</li></ul></div></div></div>''',
           scripts='<script>window.SHOP_CATS=' + json.dumps({"cats": CATS, "keywords": __import__("product_import").KEYWORDS}, ensure_ascii=False) + '</script><script src="partner.js"></script>')
    simple("admin.html", "관리자", '''<div class="narrow"><div class="card form" id="admin-login"><label for="admin-pw">관리자 비밀번호</label><input id="admin-pw" type="password" autocomplete="current-password">
<button class="btn btn-dark" style="margin-top:14px" id="admin-enter">들어가기</button></div></div>
<div id="admin-body" style="display:none"><div class="adm-tabs" id="adm-tabs"></div><div id="adm-view"></div></div>''', scripts='<script src="admin.js"></script>')


# ---------------- 네이버 EP · 사이트맵 ----------------
def build_feeds(ps):
    cols = ["id", "title", "price_pc", "price_mobile", "normal_price", "link", "mobile_link", "image_link",
            "category_name1", "brand", "maker", "origin", "event_words", "shipping"]
    lines = ["\t".join(cols)]
    clean = lambda s: str(s).replace("\t", " ").replace("\n", " ").strip()
    for p in ps:
        link = f'{BASE}/product/{p["id"]}.html'
        row = [p["id"], p["name"], p["price"], p["price"], p["normal_price"], link, link, abs_img(p),
               p["category_name"], p["brand"], p["maker"], p["origin"],
               "전 상품 무료배송", p["shipping_fee"]]
        lines.append("\t".join(clean(x) for x in row))
    write("naver_ep.txt", "\n".join(lines) + "\n")

    urls = ["", "search.html", "cs.html", "bulk.html"] + [f'category/{c["slug"]}.html' for c in SHOW_CATS] + [f'product/{p["id"]}.html' for p in ps]
    today = datetime.date.today().isoformat()
    write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          "".join(f"<url><loc>{BASE}/{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls) + "</urlset>\n")
    write("robots.txt", f"User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /checkout.html\nDisallow: /cart.html\nDisallow: /orders.html\nDisallow: /login.html\nDisallow: /wish.html\nDisallow: /success.html\nDisallow: /fail.html\nSitemap: {BASE}/sitemap.xml\n")

    pub = [{k: p[k] for k in ("id", "name", "category", "category_name", "price", "normal_price", "shipping_fee",
                              "image", "brand", "badge", "event", "summary", "supplier", "options", "option_name", "soldout")} | ({"qt": p["qt"]} if p.get("qt") else {}) | ({"sm": p["sm"]} if p.get("sm") else {}) for p in ps]
    write("products.json", json.dumps(pub, ensure_ascii=False))


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copytree(ROOT / "static" / "icons", OUT / "icons")
    for f in ("style.css", "app.js", "partner.js", "admin.js", "sw.js"):
        shutil.copy(ROOT / "static" / f, OUT / f)
    if (ROOT / "uploads").exists():
        shutil.copytree(ROOT / "uploads", OUT / "uploads")
    (OUT / ".nojekyll").write_text("")
    tpl = ROOT / "data" / "땡잡았땡_상품등록양식.xlsx"
    if tpl.exists():
        shutil.copy(tpl, OUT / "product_template.xlsx")
    ps = load_products()
    adult_slugs = {c["slug"] for c in CATS if c.get("adult")}
    adult = [p for p in ps if p["category"] in adult_slugs]
    if not CFG.get("adult_verified"):
        ps = [p for p in ps if p["category"] not in adult_slugs]
        if adult:
            print(f"🔞 성인용품 {len(adult)}개는 본인인증 연결 전이라 비공개")
    build_home(ps); build_categories(ps); build_products(ps)
    build_shop_pages(); build_policies(); build_partner_pages(); build_feeds(ps)
    print(f"완료: 상품 {len(ps)}개 → {OUT}")


if __name__ == "__main__":
    main()
