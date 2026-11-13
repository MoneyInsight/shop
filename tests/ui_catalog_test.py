"""상품 DB 모드 화면 테스트 (catalog_api=true 로 빌드한 site/ + CATALOG=1 mock_api)
준비: python3 tools/catalog_build.py; CATALOG_API=1 python3 build.py; python3 -m http.server 8765 --directory site; CATALOG=1 node tests/mock_api.mjs
"""
import asyncio, json, urllib.request, urllib.error
from playwright.async_api import async_playwright

S = "http://localhost:8765/"
API = json.load(open("config.json"))["worker_url"]
res = []
def ok(name, cond, info=""):
    res.append(cond); print(("✓ " if cond else "✗ ") + name + (f"  ({info})" if info and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome")
        ctx = await b.new_context(viewport={"width": 1280, "height": 900})
        errs, calls = [], []
        async def route(r):
            req = r.request; calls.append(req.url[len(API):])
            rq = urllib.request.Request("http://localhost:8788" + req.url[len(API):], data=(req.post_data.encode() if req.post_data else None), method=req.method, headers={"content-type": "application/json"})
            try: resp = urllib.request.urlopen(rq); st, body = resp.status, resp.read()
            except urllib.error.HTTPError as e: st, body = e.code, e.read()
            await r.fulfill(status=st, body=body, headers={"content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*"})
        await ctx.route(API + "/**", route)
        # products.json 을 못 쓰게 막아서 정말 DB로만 동작하는지 확인
        await ctx.route("**/products.json", lambda r: r.abort())
        pg = await ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
        dialogs = []
        pg.on("dialog", lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.accept())))

        await pg.goto(S + "search.html?q=" + "선반"); await pg.wait_for_timeout(1200)
        n = await pg.locator("#list-grid .p-card").count()
        ok("검색 '선반' 결과 (DB)", n > 0, n)
        ok("카드 링크가 item.html", "item.html?id=" in (await pg.locator("#list-grid .p-card").first.get_attribute("href")))
        names = await pg.locator("#list-grid .p-name").all_inner_texts()
        ok("결과 모두 선반 포함", all("선반" in x for x in names))
        await pg.locator(".sort button[data-sort=low]").click(); await pg.wait_for_timeout(800)
        ok("정렬 요청이 서버로", any("sort=low" in c for c in calls))

        cat = json.load(open("config.json"))["categories"][0]["slug"]
        await pg.goto(S + f"category/{cat}.html"); await pg.wait_for_timeout(1200)
        ok("카테고리 목록 (DB)", await pg.locator("#list-grid .p-card").count() > 0)
        if await pg.locator("#pager button").count():
            await pg.locator("#pager button[data-p='2']").first.click(); await pg.wait_for_timeout(800)
            ok("2페이지", "page=2" in pg.url)

        await pg.goto(S + "search.html?q=선반"); await pg.wait_for_timeout(1200)
        href = await pg.locator("#list-grid .p-card").first.get_attribute("href")
        await pg.goto(S + href.replace("./", "").lstrip("/")); await pg.wait_for_timeout(1500)
        name = await pg.locator(".d-name").inner_text()
        ok("상세: 이름 채워짐", "선반" in name, name)
        ok("상세: 가격 채워짐", "원" in await pg.locator(".d-price").inner_text() and "0원" != (await pg.locator(".d-price").inner_text()).strip())
        ok("상세: 상세페이지 채워짐", await pg.locator(".detail-body img").count() > 0)
        if await pg.locator("#opt").count():
            v = await pg.locator("#opt option:not([disabled])").nth(1).get_attribute("value")
            await pg.select_option("#opt", v)
        await pg.locator("#add-cart").click(); await pg.wait_for_timeout(800)
        ok("장바구니 담기", any("장바구니" in d for d in dialogs))
        await pg.wait_for_timeout(800)
        if "cart.html" not in pg.url: await pg.goto(S + "cart.html")
        await pg.wait_for_timeout(1200)
        ok("장바구니에 DB 상품 표시", await pg.locator("[data-k]").count() > 0)

        await pg.goto(S + "product/item.html?id=없는상품"); await pg.wait_for_timeout(1000)
        ok("없는 상품 안내", "찾을 수 없어요" in await pg.locator("main, body").first.inner_text())
        ok("자바스크립트 오류 없음", not errs, errs[:3])
        await b.close()
    print(f"DB 화면 테스트: {sum(res)} / {len(res)}")

asyncio.run(main())
