"""화면 흐름 테스트 (가짜 API) — python3 tests/ui_test.py"""
import asyncio, json, urllib.request
from playwright.async_api import async_playwright
S = "http://localhost:8765/"
API = "https://ttaengjab.netlify.app/api"
ok_n = fail_n = 0
def ok(name, cond, info=""):
    global ok_n, fail_n
    if cond: ok_n += 1
    else: fail_n += 1; print("❌", name, info)

async def main():
    products = json.load(open("site/products.json"))
    opt = next(p for p in products if p["options"] and not p.get("qt") and not p.get("soldout")); plain = next(p for p in products if not p["options"] and not p.get("qt") and not p.get("soldout"))  # 수량 할인 없는 상품(가격 제안 테스트용)
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome")
        ctx = await b.new_context(viewport={"width": 1280, "height": 900})
        errs = []
        async def route(r):
            req = r.request
            try:
                rq = urllib.request.Request("http://localhost:8788" + req.url[len(API):], data=(req.post_data or "").encode(), method=req.method, headers={k: v for k, v in req.headers.items() if k in ("content-type", "authorization")})
                try: resp = urllib.request.urlopen(rq); st, body = resp.status, resp.read()
                except urllib.error.HTTPError as e: st, body = e.code, e.read()
                await r.fulfill(status=st, body=body, headers={"content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*"})
            except Exception as e: errs.append("route " + str(e)); await r.abort()
        await ctx.route(API + "/**", route)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        dialogs = []
        async def on_dialog(d):
            dialogs.append(d.message)
            if d.type == "prompt": await d.accept("")
            else: await d.accept()
        pg.on("dialog", lambda d: asyncio.ensure_future(on_dialog(d)))

        # 메인
        await pg.goto(S + "index.html"); await pg.wait_for_timeout(600)
        ok("메인 카드", await pg.locator(".p-card").count() >= 20)
        await pg.screenshot(path="/tmp/s_home.png")
        # 카테고리: 정렬·페이지
        await pg.goto(S + "category/living.html"); await pg.wait_for_selector("#pager button")
        ok("목록 40개", await pg.locator("#list-grid .p-card").count() == 40)
        await pg.click('.sort button[data-sort="low"]'); await pg.wait_for_timeout(200)
        prices = [int(t.replace(",", "").replace("원", "")) for t in await pg.locator("#list-grid .p-price > span:not(.rate)").all_inner_texts()]
        ok("낮은 가격순", prices == sorted(prices), prices[:5])
        await pg.click('#pager button[data-p="2"]'); await pg.wait_for_timeout(300)
        ok("2페이지 주소", "page=2" in pg.url and "sort=low" in pg.url, pg.url)
        await pg.screenshot(path="/tmp/s_list.png")
        # 찜
        await pg.locator("#list-grid .wish-btn").first.click(); await pg.wait_for_timeout(150)
        ok("찜 개수", (await pg.locator('.head .count[data-count="wish"]').inner_text()) == "1")
        await pg.goto(S + "wish.html"); await pg.wait_for_timeout(500)
        ok("찜 목록", await pg.locator("#list-grid .p-card").count() == 1)
        # 검색
        await pg.goto(S + "search.html?q=" + plain["name"].split()[0]); await pg.wait_for_timeout(500)
        ok("검색 결과", await pg.locator("#list-grid .p-card").count() >= 1)
        # 상세: 옵션 필수 · 장바구니
        await pg.goto(S + f"product/{opt['id']}.html"); await pg.wait_for_timeout(700)
        await pg.click("#add-cart"); await pg.wait_for_timeout(200)
        ok("옵션 미선택 경고", any("옵션" in d for d in dialogs), dialogs)
        await pg.select_option("#opt", "0"); await pg.click("#plus"); await pg.click("#add-cart"); await pg.wait_for_timeout(600)
        ok("장바구니 이동", "cart.html" in pg.url, pg.url)
        await pg.wait_for_selector("#cart-box .c-row")
        ok("장바구니 합계", (await pg.locator("#cart-sum .total b").inner_text()) == f"{(opt['price'] + opt['options'][0]['add']) * 2:,}원")
        await pg.screenshot(path="/tmp/s_cart.png")
        await pg.goto(S + f"product/{opt['id']}.html"); await pg.wait_for_timeout(800)
        await pg.screenshot(path="/tmp/s_detail.png", full_page=True)
        ok("최근 본 상품 저장", opt["id"] in (await pg.evaluate("localStorage.getItem('recent')")))

        # 주문 만들기(가짜 결제) → 조회·취소
        cust = {"name": "홍길동", "phone": "010-1234-5678", "zip": "16500", "addr": "경기도 수원시 테스트로 1", "memo": "문 앞"}
        def post(path, body, admin=False):
            rq = urllib.request.Request("http://localhost:8788" + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **({"Authorization": "Bearer test1234"} if admin else {})})
            try: return json.load(urllib.request.urlopen(rq))
            except urllib.error.HTTPError as e: return json.load(e)
        amt = opt["price"] + opt["options"][0]["add"] + plain["price"]
        r = post("/confirm", {"paymentKey": "pk", "orderId": "T-UI-1", "amount": amt, "items": [{"id": opt["id"], "qty": 1, "opt": 0}, {"id": plain["id"], "qty": 1}], "customer": cust}); ok("주문 생성", r.get("ok"), r)
        post("/confirm", {"paymentKey": "pk", "orderId": "T-UI-2", "amount": plain["price"], "items": [{"id": plain["id"], "qty": 1}], "customer": cust})
        await pg.goto(S + "orders.html"); await pg.fill("#o-id", "T-UI-2"); await pg.fill("#o-phone", "01012345678"); await pg.click("#o-btn")
        await pg.wait_for_selector("#order-result .track")
        await pg.click('button[data-act="cancel"]'); await pg.fill("#act-reason", "테스트 취소"); await pg.click("#act-send"); await pg.wait_for_timeout(700)
        ok("고객 주문 취소", "취소완료" in await pg.locator("#order-result h2").inner_text())
        # 관리자: 송장 입력
        await pg.goto(S + "admin.html"); await pg.fill("#admin-pw", "test1234"); await pg.click("#admin-enter"); await pg.wait_for_selector("#adm-view .stat")
        await pg.screenshot(path="/tmp/s_admin.png")
        await pg.click('[data-tab="orders"]'); row = pg.locator("tr", has_text="T-UI-1")
        await row.locator('[data-f="status"]').select_option("배송중"); await row.locator('[data-f="courier"]').select_option("CJ대한통운"); await row.locator('[data-f="tracking"]').fill("123456789")
        await row.locator('[data-act="order-save"]').click(); await pg.wait_for_timeout(700)
        await pg.screenshot(path="/tmp/s_admin_orders.png")
        # 고객: 배송 추적 · 리뷰 · 반품
        await pg.goto(S + "orders.html"); await pg.fill("#o-id", "T-UI-1"); await pg.fill("#o-phone", "010-1234-5678"); await pg.click("#o-btn")
        await pg.wait_for_selector("#order-result .track")
        ok("송장 표시", "123456789" in await pg.locator("#order-result").inner_text())
        await pg.screenshot(path="/tmp/s_order.png", full_page=True)
        await pg.goto(S + f"product/{plain['id']}.html?write=1#review"); await pg.wait_for_timeout(800)
        await pg.fill("#rv-order", "T-UI-1"); await pg.fill("#rv-phone", "01012345678"); await pg.fill("#rv-text", "배송 빠르고 좋아요."); await pg.click("#rv-submit"); await pg.wait_for_timeout(900)
        ok("리뷰 표시", await pg.locator(".rv-item").count() == 1 and (await pg.locator(".rv-count").first.inner_text()) == "1")
        await pg.click("#qa-open"); await pg.fill("#qa-name", "김철수"); await pg.fill("#qa-text", "재입고 일정이 궁금합니다."); await pg.click("#qa-submit"); await pg.wait_for_timeout(900)
        ok("문의 표시", await pg.locator(".qa-item").count() == 1)
        await pg.goto(S + "cs.html"); await pg.fill("#inq-name", "홍길동"); await pg.fill("#inq-contact", "010-1234-5678"); await pg.fill("#inq-text", "세금계산서 발행 부탁드립니다."); await pg.check("#inq-agree"); await pg.click("#inq-btn"); await pg.wait_for_timeout(600)
        ok("1:1 문의 접수", any("접수" in d for d in dialogs), dialogs[-2:])
        await pg.screenshot(path="/tmp/s_cs.png", full_page=True)
        await pg.goto(S + "orders.html?id=T-UI-1"); await pg.fill("#o-phone", "01012345678"); await pg.click("#o-btn"); await pg.wait_for_selector('button[data-act="반품"]')
        await pg.click('button[data-act="반품"]'); await pg.fill("#act-reason", "색상이 달라요"); await pg.click("#act-send"); await pg.wait_for_timeout(700)
        ok("반품 요청", "반품요청" in await pg.locator("#order-result h2").inner_text())
        await pg.goto(S + "admin.html"); await pg.wait_for_selector("#adm-view .stat"); await pg.click('[data-tab="claims"]')
        await pg.locator("tr", has_text="T-UI-1").locator('[data-act="order-refund"]').click(); await pg.wait_for_timeout(900)
        r = post("/order/lookup", {"orderId": "T-UI-1", "phone": "01012345678"}); ok("환불 완료", r["order"]["status"] == "반품완료", r["order"]["status"])
        await pg.click('[data-tab="qna"]'); ok("관리자 문의 목록", await pg.locator("#adm-view tr").count() >= 4)
        await pg.click('[data-tab="coupons"]'); await pg.fill("#c-code", "open10"); await pg.fill("#c-value", "1000"); await pg.fill("#c-min", "5000"); await pg.click('[data-act="coupon-save"]'); await pg.wait_for_timeout(700)
        ok("쿠폰 생성", "OPEN10" in await pg.locator("#adm-view").inner_text())
        # 대량 구매 가격 제안: 고객 제안 → 관리자 수락 → 주문조회에서 제안가로 결제 화면
        await pg.goto(S + f"product/{plain['id']}.html"); await pg.wait_for_timeout(500)
        await pg.click("#offer-open"); await pg.wait_for_timeout(200)
        ok("제안 열면 3개로", await pg.input_value("#qty") == "3")
        await pg.fill("#offer-name", "제안고객"); await pg.fill("#offer-phone", "010-2222-3333")
        n0 = len(dialogs); await pg.click("#offer-send"); await pg.wait_for_timeout(800)
        ok("가격 제안 접수", any("제안번호" in d for d in dialogs[n0:]), dialogs[n0:])
        await pg.screenshot(path="/tmp/s_offer.png", full_page=False)
        await pg.goto(S + "admin.html"); await pg.wait_for_selector("#adm-view .stat"); await pg.click('[data-tab="offers"]')
        await pg.locator('[data-act="offer-yes"]').first.click(); await pg.wait_for_timeout(800)
        ok("관리자 제안 수락", "수락" in await pg.locator("#adm-view").inner_text())
        await pg.goto(S + "orders.html"); await pg.wait_for_selector("[data-buy]", timeout=5000)
        await pg.screenshot(path="/tmp/s_offers.png", full_page=True)
        await pg.click("[data-buy]"); await pg.wait_for_timeout(900)
        exp = -(-plain["price"] * 0.97 // 10) * 10 * 3
        ok("제안가 결제 금액", f"{int(exp):,}원" in await pg.locator("#order-sum").inner_text(), (exp, await pg.locator("#order-sum").inner_text()))
        ok("제안 연락처 자동 입력", "".join(c for c in await pg.input_value("#phone") if c.isdigit()) == "01022223333", await pg.input_value("#phone"))
        # 모바일
        m = await ctx.new_page(); await m.set_viewport_size({"width": 390, "height": 844})
        await m.goto(S + "index.html"); await m.wait_for_timeout(600); await m.screenshot(path="/tmp/s_m_home.png")
        await m.goto(S + f"product/{opt['id']}.html"); await m.wait_for_timeout(600); await m.screenshot(path="/tmp/s_m_detail.png")
        ok("모바일 가로 넘침 없음", await m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), await m.evaluate("document.documentElement.scrollWidth"))
        ok("스크립트 오류 없음", not errs, errs[:3])
        await b.close()
    print(f"통과 {ok_n} / 실패 {fail_n}")
asyncio.run(main())
