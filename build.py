#!/usr/bin/env python3
"""쇼핑몰 생성기 — data/products.csv + config.json → site/ 폴더에 정적 쇼핑몰 생성
실행: python3 build.py
생성물: 메인·카테고리·상품상세·검색·장바구니·주문결제·완료/실패·약관·공급사·관리자 페이지,
        products.json, naver_ep.txt(네이버쇼핑 EP 3.0), sitemap.xml, robots.txt
"""
import csv, json, html, shutil, datetime, hashlib
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "site"
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
BIZ = CFG["business"]
BASE = CFG["base_url"].rstrip("/")
CATS = CFG["categories"]
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
    rows = list(csv.DictReader((ROOT / "data/products.csv").open(encoding="utf-8-sig")))
    out = []
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    for r in rows:
        if r.get("status", "판매중") not in ("판매중", ""):
            continue
        p = {k: (v or "").strip() for k, v in r.items()}
        p["price"] = int(p["price"] or 0)
        p["normal_price"] = int(p["normal_price"] or 0) or p["price"]
        p["shipping_fee"] = int(p["shipping_fee"] or 0)
        p["category_name"] = CAT_NAME.get(p["category"], "기타")
        p["desc_lines"] = [x for x in p["description"].split("|") if x.strip()]
        if not p["image"]:
            fn = f"img/p{p['id']}.svg"
            (OUT / fn).write_text(placeholder_svg(p), encoding="utf-8")
            p["image"] = fn
        elif p["image"].startswith("http"):
            pass  # 외부 이미지 주소
        out.append(p)
    return out


def abs_img(p):
    return p["image"] if p["image"].startswith("http") else f"{BASE}/{p['image']}"


def rate(p):
    return round((1 - p["price"] / p["normal_price"]) * 100) if p["normal_price"] > p["price"] else 0


# ---------------- 공통 레이아웃 ----------------
def layout(title, body, root="./", desc="", canonical="", extra_head="", scripts="", og_img=""):
    desc = desc or CFG["slogan"]
    verify = ""
    if CFG.get("naver_site_verification"):
        verify += f'<meta name="naver-site-verification" content="{e(CFG["naver_site_verification"])}">'
    if CFG.get("google_site_verification"):
        verify += f'<meta name="google-site-verification" content="{e(CFG["google_site_verification"])}">'
    public_cfg = {k: CFG.get(k) for k in ("toss_client_key", "worker_url", "free_shipping_over", "shop_name")}
    return f'''<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title><meta name="description" content="{e(desc)}">
{f'<link rel="canonical" href="{canonical}">' if canonical else ""}
<meta property="og:type" content="website"><meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}"><meta property="og:site_name" content="{e(CFG["shop_name"])}">
{f'<meta property="og:image" content="{og_img}">' if og_img else ""}
{verify}
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="{root}style.css">{extra_head}
<script>window.SHOP_CFG={json.dumps(public_cfg, ensure_ascii=False)}</script>
</head><body data-root="{root}">
<header class="topbar"><div class="wrap">
<a class="logo" href="{root}index.html"><b>땡</b>{e(CFG["shop_name"])}</a>
<div class="top-icons"><a class="icon-btn" href="{root}search.html" title="전체상품">☰</a>
<a class="icon-btn" href="{root}cart.html" title="장바구니">🛒<span class="cart-count" style="display:none">0</span></a></div>
</div></header>
{body}
<footer><div class="wrap">
<div class="links"><a href="{root}terms.html">이용약관</a><a href="{root}privacy.html"><b>개인정보처리방침</b></a><a href="{root}refund.html">교환·환불 안내</a><a href="{root}seller.html">공급사 입점</a></div>
<p>상호 {e(BIZ["company"])} | 대표 {e(BIZ["ceo"])} | 사업자등록번호 {e(BIZ["biz_no"])} | 통신판매업신고 {e(BIZ["mail_order_no"])}<br>
주소 {e(BIZ["address"])} | 고객센터 {e(BIZ["phone"])} | 이메일 {e(BIZ["email"])} | 개인정보보호책임자 {e(BIZ["privacy_officer"])}<br>
고객님의 안전거래를 위해 결제 시 토스페이먼츠 구매안전(에스크로) 서비스를 이용하실 수 있습니다.<br>
© {datetime.date.today().year} {e(CFG["shop_name"])}. All rights reserved.</p>
</div></footer>
{scripts}<script src="{root}app.js"></script>
</body></html>'''


def card(p, root):
    r = rate(p)
    img = p["image"] if p["image"].startswith("http") else root + p["image"]
    return f'''<a class="p-card" data-cat="{p["category"]}" href="{root}product/{p["id"]}.html">
<div class="p-thumb"><img src="{e(img)}" alt="{e(p["name"])}" loading="lazy">{f'<span class="badge {e(p["badge"])}">{e(p["badge"])}</span>' if p["badge"] else ""}</div>
{f'<div class="p-event">{e(p["event"])}</div>' if p["event"] else ""}
<div class="p-name">{e(p["name"])}</div>
<div class="p-price">{f'<span class="rate">{r}%</span>' if r else ""}{won(p["price"])}{f"<del>{won(p['normal_price'])}</del>" if r else ""}</div>
<div class="p-ship">{"배송비 " + won(p["shipping_fee"]) if p["shipping_fee"] else "무료배송"}</div></a>'''


def search_box(root, value=""):
    return f'''<section class="hero"><div class="wrap">
<form class="search" action="{root}search.html"><span class="s-logo">땡</span>
<input name="q" value="{e(value)}" placeholder="찾으시는 상품을 검색해 보세요" aria-label="상품 검색"><button aria-label="검색">🔍</button></form>
<nav class="quick">{"".join(f'<a href="{root}category/{c["slug"]}.html"><span>{c["emoji"]}</span>{e(c["name"])}</a>' for c in CATS)}
<a href="{root}search.html"><span>⋯</span>전체</a></nav></div></section>'''


def side(root):
    return f'''<aside class="side">
<div class="card login-box"><div class="hello">반가워요 👋</div><p>회원가입 없이 바로 주문할 수 있어요.</p>
<div id="mini-cart"></div></div>
<div class="card why"><h2>왜 {e(CFG["shop_name"])}인가요?</h2><ul>
<li>💸 오픈마켓 수수료가 없어 같은 상품도 더 저렴해요</li><li>🚚 전 상품 무료배송</li>
<li>🔒 토스페이먼츠 안전결제</li><li>📦 공급사 직배송으로 빠른 처리</li></ul></div>
<div class="card cs-box"><h2>고객센터</h2><div class="tel">{e(BIZ["phone"])}</div><p>{e(BIZ["cs_hours"])}</p><p>{e(BIZ["email"])}</p></div>
<div class="card"><h2>공급사 입점 모집</h2><p style="color:#666;font-size:14px;margin-bottom:12px">좋은 상품을 가진 공급사라면 누구나 상품을 올릴 수 있어요.</p>
<a class="btn btn-line" href="{root}seller.html">입점 신청하기</a></div>
</aside>'''


def write(path, text):
    f = OUT / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text, encoding="utf-8")


# ---------------- 페이지 ----------------
def build_home(ps):
    chips = '<button class="chip on" data-cat="">전체</button>' + "".join(
        f'<button class="chip" data-cat="{c["slug"]}">{e(c["name"])}</button>' for c in CATS)
    best = [p for p in ps if p["badge"] == "BEST"] or ps[:4]
    ld = {"@context": "https://schema.org", "@type": "WebSite", "name": CFG["shop_name"], "url": BASE + "/",
          "potentialAction": {"@type": "SearchAction", "target": BASE + "/search.html?q={q}", "query-input": "required name=q"}}
    body = search_box("./") + f'''<div class="wrap main"><div>
<div class="card banner"><div class="b-img">🛍️</div><div class="b-txt"><strong>{e(CFG["slogan"])}</strong>
<p>오픈마켓 수수료 13% 대신 딱 7%만. 같은 상품을 더 싸게, 전 상품 무료배송이에요.</p></div><a class="b-btn" href="search.html">전체 상품 보기 ›</a></div>
<div class="card"><h2>🔥 지금 많이 찾는 상품</h2><div class="grid">{"".join(card(p, "./") for p in best[:4])}</div></div>
<div class="card"><h2>카테고리별 상품 <small>{len(ps)}개</small></h2><div class="chips">{chips}</div>
<div class="grid" id="home-grid">{"".join(card(p, "./") for p in ps)}</div></div>
</div>{side("./")}</div>'''
    write("index.html", layout(f'{CFG["shop_name"]} - {CFG["slogan"]}', body, "./", canonical=BASE + "/",
          extra_head=f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'))


def build_categories(ps):
    for c in CATS:
        items = [p for p in ps if p["category"] == c["slug"]]
        grid = "".join(card(p, "../") for p in items) or '<div class="empty">상품 준비중이에요.</div>'
        body = search_box("../") + f'''<div class="wrap main"><div><div class="card">
<div class="crumb"><a href="../index.html">홈</a> › {e(c["name"])}</div>
<h2>{c["emoji"]} {e(c["name"])} <small>{len(items)}개</small></h2><div class="grid">{grid}</div></div></div>{side("../")}</div>'''
        write(f'category/{c["slug"]}.html', layout(f'{c["name"]} - {CFG["shop_name"]}', body, "../",
              desc=f'{CFG["shop_name"]} {c["name"]} 상품 모음', canonical=f'{BASE}/category/{c["slug"]}.html'))


def build_products(ps):
    for p in ps:
        r = rate(p)
        img = p["image"] if p["image"].startswith("http") else "../" + p["image"]
        url = f'{BASE}/product/{p["id"]}.html'
        ld = {"@context": "https://schema.org", "@type": "Product", "name": p["name"], "image": [abs_img(p)],
              "description": p["summary"] or p["name"], "sku": p["id"], "brand": {"@type": "Brand", "name": p["brand"] or CFG["shop_name"]},
              "offers": {"@type": "Offer", "url": url, "priceCurrency": "KRW", "price": p["price"],
                         "availability": "https://schema.org/InStock", "itemCondition": "https://schema.org/NewCondition"}}
        desc_html = "".join(f"<p>✔ {e(x)}</p>" for x in p["desc_lines"])
        body = f'''<div class="wrap page"><div class="crumb"><a href="../index.html">홈</a> › <a href="../category/{p["category"]}.html">{e(p["category_name"])}</a></div>
<div class="card"><div class="detail">
<div class="p-thumb"><img src="{e(img)}" alt="{e(p["name"])}">{f'<span class="badge {e(p["badge"])}">{e(p["badge"])}</span>' if p["badge"] else ""}</div>
<div><div class="d-brand">{e(p["brand"])}</div><h1 class="d-name">{e(p["name"])}</h1><p class="d-summary">{e(p["summary"])}</p>
<div class="d-price">{f'<span class="rate">{r}%</span>' if r else ""}<span class="now">{won(p["price"])}</span>{f"<del>{won(p['normal_price'])}</del>" if r else ""}
{f'<div><span class="d-save">🎁 {e(p["event"])}</span></div>' if p["event"] else ""}</div>
<dl class="d-info"><dt>배송비</dt><dd>{"무료배송" if not p["shipping_fee"] else won(p["shipping_fee"])}</dd>
<dt>배송</dt><dd>영업일 1~3일 내 출발</dd><dt>원산지</dt><dd>{e(p["origin"] or "상세설명 참조")}</dd></dl>
<div class="qty"><button id="minus" aria-label="빼기">−</button><input id="qty" value="1" inputmode="numeric"><button id="plus" aria-label="더하기">+</button></div>
<div class="d-total"><span>총 상품금액</span><strong id="d-total">{won(p["price"])}</strong></div>
<div class="d-btns" id="buy" data-id="{p["id"]}" data-price="{p["price"]}">
<button class="btn btn-line" id="add-cart">장바구니</button><button class="btn btn-green" id="buy-now">바로 구매</button></div>
</div></div></div>
<div class="d-desc"><div class="card"><h2>상품 상세정보</h2>{desc_html}</div>
<div class="card"><h2>상품정보 제공고시</h2><table class="notice-table">
<tr><th>상품명</th><td>{e(p["name"])}</td></tr><tr><th>브랜드</th><td>{e(p["brand"] or "-")}</td></tr>
<tr><th>제조자/수입자</th><td>{e(p["maker"] or "상세설명 참조")}</td></tr><tr><th>원산지</th><td>{e(p["origin"] or "상세설명 참조")}</td></tr>
<tr><th>A/S 책임자와 전화번호</th><td>{e(BIZ["company"])} {e(BIZ["phone"])}</td></tr></table></div>
<div class="card"><h2>배송·교환·환불</h2><p style="font-size:15px;color:#444">단순 변심 교환·반품은 상품 수령 후 7일 이내 가능하며 왕복 배송비는 고객님 부담입니다. 상품 불량·오배송은 무료로 처리해 드립니다. <a href="../refund.html" style="text-decoration:underline">자세히 보기</a></p></div>
</div></div>'''
        write(f'product/{p["id"]}.html', layout(f'{p["name"]} - {CFG["shop_name"]}', body, "../",
              desc=f'{p["name"]} {won(p["price"])} {p["summary"]}', canonical=url, og_img=abs_img(p),
              extra_head=f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'))


def simple(path, title, inner, scripts="", root="./"):
    write(path, layout(f'{title} - {CFG["shop_name"]}', f'<div class="wrap page">{inner}</div>', root, scripts=scripts))


def build_shop_pages():
    write("search.html", layout(f'상품 검색 - {CFG["shop_name"]}', search_box("./") +
          '<div class="wrap page"><div class="card"><h2 id="search-title">검색 중…</h2><div class="grid" id="search-result"></div></div></div>', "./"))
    simple("cart.html", "장바구니", '''<div class="main" style="padding:0"><div class="card"><h2>🛒 장바구니</h2><div id="cart-box"></div></div>
<div><div class="card" id="cart-sum"></div></div></div>''')
    test = "" if not CFG["toss_client_key"].startswith("test_") else \
        '<div class="test-note">⚠️ 지금은 <b>테스트 결제</b> 모드예요. 실제로 돈이 빠져나가지 않아요. (PG 계약 후 실제 키로 바꾸면 정식 결제가 돼요)</div>'
    simple("checkout.html", "주문/결제", f'''{test}<div class="main" style="padding:0"><div>
<div class="card"><h2>주문 상품</h2><div id="order-items"></div></div>
<div class="card form"><h2>배송지 정보</h2>
<label for="name">받는 분</label><input id="name" autocomplete="name">
<label for="phone">연락처</label><input id="phone" inputmode="tel" placeholder="010-0000-0000" autocomplete="tel">
<label for="email">이메일 (선택)</label><input id="email" type="email" autocomplete="email">
<label>주소</label><div class="row"><input id="zip" placeholder="우편번호" readonly><button type="button" id="find-addr">주소 찾기</button></div>
<input id="addr1" placeholder="기본주소" readonly style="margin-top:8px"><input id="addr2" placeholder="상세주소" style="margin-top:8px">
<label for="memo">배송 메모 (선택)</label><textarea id="memo" placeholder="예) 문 앞에 놓아주세요"></textarea></div>
<div class="card"><h2>결제 수단</h2><div id="payment-method"></div><div id="agreement"></div></div></div>
<div><div class="card"><h2>결제 금액</h2><div id="order-sum"></div>
<label style="display:flex;gap:8px;margin:16px 0;font-size:14px"><input type="checkbox" id="agree">주문 내용을 확인했으며 결제에 동의합니다.</label>
<button class="btn btn-green" id="pay-btn">결제하기</button></div></div></div>''',
           scripts='<script src="https://js.tosspayments.com/v2/standard"></script><script src="https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"></script><script>/* checkout은 app.js가 SDK 로드 후 실행 */</script>')
    simple("success.html", "주문 완료", '<div class="card" id="success" style="text-align:center;padding:40px 20px">결제를 확인하고 있어요…</div>')
    simple("fail.html", "결제 실패", '<div class="card" id="fail" style="text-align:center;padding:40px 20px"><div style="font-size:48px">😥</div><h2>결제가 완료되지 않았어요</h2><p id="fail-msg"></p><a class="btn btn-dark" style="max-width:260px;margin:20px auto 0" href="cart.html">장바구니로</a></div>')


def build_policies():
    c, s = BIZ["company"], CFG["shop_name"]
    simple("terms.html", "이용약관", f'''<div class="card policy"><h1>이용약관</h1>
<h3>제1조 (목적)</h3><p>이 약관은 {e(c)}(이하 "회사")가 운영하는 {e(s)}(이하 "몰")에서 제공하는 전자상거래 서비스의 이용 조건과 절차, 회사와 이용자의 권리·의무를 정합니다.</p>
<h3>제2조 (구매 신청)</h3><p>이용자는 몰에서 상품을 선택하고 배송지 정보를 입력한 뒤 결제하는 방법으로 구매를 신청합니다. 회원가입 없이 비회원으로 구매할 수 있습니다.</p>
<h3>제3조 (계약의 성립)</h3><p>회사가 결제 승인을 확인하면 구매 계약이 성립합니다. 재고 부족 등으로 공급이 어려운 경우 지체 없이 알리고 결제를 취소합니다.</p>
<h3>제4조 (배송)</h3><p>결제 확인 후 영업일 기준 1~3일 안에 출고합니다. 일부 상품은 공급사에서 직접 발송됩니다.</p>
<h3>제5조 (청약철회)</h3><p>이용자는 「전자상거래 등에서의 소비자보호에 관한 법률」에 따라 상품을 받은 날부터 7일 이내에 청약을 철회할 수 있습니다. 자세한 사항은 교환·환불 안내를 따릅니다.</p>
<h3>제6조 (분쟁 해결)</h3><p>분쟁이 생기면 고객센터({e(BIZ["phone"])})로 접수해 주시면 성실히 처리합니다. 해결되지 않으면 공정거래위원회 또는 시·도지사가 의뢰하는 분쟁조정기관의 조정을 따를 수 있습니다.</p>
<p style="margin-top:20px;color:#888">시행일: {datetime.date.today():%Y-%m-%d}</p></div>''')
    simple("privacy.html", "개인정보처리방침", f'''<div class="card policy"><h1>개인정보처리방침</h1>
<h3>1. 수집 항목</h3><p>주문 시: 받는 분 이름, 연락처, 주소, 이메일(선택), 배송 메모. 결제 정보는 토스페이먼츠가 직접 처리하며 회사는 카드번호를 저장하지 않습니다.</p>
<h3>2. 이용 목적</h3><p>주문 처리, 상품 배송, 고객 문의 응대, 교환·환불 처리.</p>
<h3>3. 보유 기간</h3><p>「전자상거래법」에 따라 계약·청약철회 기록 5년, 대금결제·재화 공급 기록 5년, 소비자 불만·분쟁처리 기록 3년 보관 후 파기합니다.</p>
<h3>4. 제3자 제공 및 위탁</h3><p>결제 처리: (주)토스페이먼츠 / 배송: 택배사 및 상품 공급사(배송에 필요한 이름·연락처·주소에 한함).</p>
<h3>5. 이용자의 권리</h3><p>이용자는 언제든 개인정보 열람·정정·삭제·처리정지를 요청할 수 있습니다.</p>
<h3>6. 개인정보 보호책임자</h3><p>{e(BIZ["privacy_officer"])} / {e(BIZ["phone"])} / {e(BIZ["email"])}</p>
<p style="margin-top:20px;color:#888">시행일: {datetime.date.today():%Y-%m-%d}</p></div>''')
    simple("refund.html", "교환·환불 안내", f'''<div class="card policy"><h1>교환·환불 안내</h1>
<h3>신청 기간</h3><p>단순 변심: 상품 수령 후 7일 이내 / 상품 불량·오배송: 수령 후 3개월 이내 또는 사실을 안 날부터 30일 이내</p>
<h3>배송비</h3><p>단순 변심은 왕복 배송비를 고객님이 부담하며, 불량·오배송은 회사가 부담합니다.</p>
<h3>교환·반품이 어려운 경우</h3><ul style="padding-left:18px"><li>고객님의 책임으로 상품이 훼손된 경우</li><li>사용 또는 일부 소비로 상품 가치가 크게 떨어진 경우 (식품 개봉 등)</li><li>시간이 지나 재판매가 어려울 만큼 가치가 떨어진 경우</li></ul>
<h3>환불</h3><p>반품 상품 확인 후 3영업일 안에 결제수단으로 환불합니다.</p>
<h3>신청 방법</h3><p>고객센터 {e(BIZ["phone"])} 또는 {e(BIZ["email"])}로 주문번호와 함께 연락 주세요.</p></div>''')


def build_partner_pages():
    cats = "".join(f'<option value="{c["slug"]}">{e(c["name"])}</option>' for c in CATS)
    simple("seller.html", "공급사 입점", f'''<div class="main" style="padding:0"><div>
<div class="card"><h2>🤝 공급사 입점 안내</h2><p style="color:#555">{e(CFG["shop_name"])}에 상품을 공급해 주실 도매·제조 공급사를 모집해요.
상품을 올려주시면 검수 후 쇼핑몰과 네이버 가격비교에 노출하고, 주문이 들어오면 발주서를 보내드려요. 공급사는 고객에게 직접 배송만 해주시면 돼요.</p>
<ol style="padding-left:20px;margin-top:10px;color:#333"><li>아래에서 입점 신청 → 승인되면 <b>입점코드</b>를 받아요</li><li>입점코드로 상품 등록 (공급가·배송비·사진·설명)</li><li>검수 후 판매 시작, 주문 시 발주 안내</li></ol></div>
<div class="card form" id="apply-form"><h2>1. 입점 신청</h2>
<label>회사명</label><input name="company"><label>사업자등록번호</label><input name="biz_no" placeholder="000-00-00000">
<label>담당자</label><input name="manager"><label>연락처</label><input name="phone"><label>이메일</label><input name="email" type="email">
<label>주요 취급 상품</label><textarea name="items"></textarea>
<button class="btn btn-dark" style="margin-top:14px" data-api="/seller/apply">입점 신청하기</button></div>
<div class="card form" id="product-form"><h2>2. 상품 등록 (입점코드 필요)</h2>
<label>입점코드</label><input name="code" placeholder="승인 시 받은 코드">
<label>상품명</label><input name="name"><label>카테고리</label><select name="category" style="width:100%;height:48px;border:1px solid #cfd4d9;border-radius:10px;padding:0 10px;font-size:16px">{cats}</select>
<label>공급가 (원, 부가세·배송비 포함 — 전 상품 무료배송)</label><input name="supply_price" inputmode="numeric">
<p style="font-size:13px;color:#e5322d;margin-top:6px">판매가는 공급가 + 7%로 자동 설정돼요. 배송비는 별도로 받지 않아요.</p>
<label>권장 소비자가 (선택)</label><input name="normal_price" inputmode="numeric">
<label>브랜드 / 제조사 / 원산지</label><div class="row"><input name="brand" placeholder="브랜드"><input name="maker" placeholder="제조사"><input name="origin" placeholder="원산지"></div>
<label>대표 이미지 (정사각형 권장, 2MB 이하)</label><input name="image" type="file" accept="image/*" style="padding-top:10px">
<label>한 줄 소개</label><input name="summary">
<label>상세 설명 (줄마다 한 가지 특징)</label><textarea name="description" style="height:120px"></textarea>
<button class="btn btn-green" style="margin-top:14px" data-api="/seller/product">상품 등록 요청</button></div>
</div><div><div class="card"><h2>공급사 혜택</h2><ul class="why" style="padding:0"><li>✅ 입점비·월 이용료 없음</li><li>✅ 네이버 가격비교 노출</li><li>✅ 주문 즉시 발주 안내</li></ul></div></div></div>''',
           scripts='<script src="partner.js"></script>')
    simple("admin.html", "관리자", '''<div class="card form" id="admin-login"><h2>🔐 관리자</h2><label>관리자 비밀번호</label><input id="admin-pw" type="password">
<button class="btn btn-dark" style="margin-top:12px" id="admin-enter">들어가기</button></div>
<div id="admin-body" style="display:none">
<div class="card"><h2>입점 신청</h2><div id="apps"></div></div>
<div class="card"><h2>상품 등록 요청</h2><div id="pending"></div></div>
<div class="card"><h2>주문 / 발주</h2><div id="orders"></div></div></div>''', scripts='<script src="partner.js"></script>')


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
               p["event"] or "오픈마켓 수수료 없는 직판가", p["shipping_fee"]]
        lines.append("\t".join(clean(x) for x in row))
    write("naver_ep.txt", "\n".join(lines) + "\n")

    urls = ["", "search.html"] + [f'category/{c["slug"]}.html' for c in CATS] + [f'product/{p["id"]}.html' for p in ps]
    today = datetime.date.today().isoformat()
    write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          "".join(f"<url><loc>{BASE}/{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls) + "</urlset>\n")
    write("robots.txt", f"User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /checkout.html\nSitemap: {BASE}/sitemap.xml\n")

    pub = [{k: p[k] for k in ("id", "name", "category", "category_name", "price", "normal_price", "shipping_fee",
                              "image", "brand", "badge", "event", "summary", "supplier")} for p in ps]
    write("products.json", json.dumps(pub, ensure_ascii=False))


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for f in ("style.css", "app.js", "partner.js"):
        shutil.copy(ROOT / "static" / f, OUT / f)
    if (ROOT / "uploads").exists():
        shutil.copytree(ROOT / "uploads", OUT / "uploads")
    (OUT / ".nojekyll").write_text("")
    ps = load_products()
    build_home(ps); build_categories(ps); build_products(ps)
    build_shop_pages(); build_policies(); build_partner_pages(); build_feeds(ps)
    print(f"완료: 상품 {len(ps)}개 → {OUT}")


if __name__ == "__main__":
    main()
