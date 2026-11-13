"""간편 로그인 화면 테스트 — python3 -m http.server 8765 --directory site; node tests/mock_api.mjs"""
import asyncio, json, urllib.request, urllib.error, urllib.parse
from playwright.async_api import async_playwright

S = "http://localhost:8765/"
API = json.load(open("config.json"))["worker_url"]
res = []
def ok(name, cond, info=""):
    res.append(cond); print(("✓ " if cond else "✗ ") + name + (f"  ({info})" if info and not cond else ""))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/usr/bin/google-chrome")
        ctx = await b.new_context(viewport={"width": 1280, "height": 900})
        errs = []
        async def route(r):
            req = r.request
            rq = urllib.request.Request("http://localhost:8788" + req.url[len(API):], data=(req.post_data.encode() if req.post_data else None), method=req.method, headers={"content-type": "application/json"})
            try: resp = opener.open(rq); st, body, hd = resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()}
            except urllib.error.HTTPError as e: st, body, hd = e.code, e.read(), {k.lower(): v for k, v in e.headers.items()}
            h = {"content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*"}
            if hd.get("location"): h["location"] = hd["location"]
            await r.fulfill(status=st, body=body, headers=h)
        await ctx.route(API + "/**", route)
        # 네이버 로그인 화면 흉내: 바로 동의하고 돌아감
        async def naver(r):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(r.request.url).query)
            to = q["redirect_uri"][0] + "?code=good&state=" + q["state"][0]
            await r.fulfill(status=200, content_type="text/html", body=f"<script>location.href={json.dumps(to)}</script>")
        await ctx.route("https://nid.naver.com/**", naver)
        pg = await ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
        dialogs = []
        pg.on("dialog", lambda d: (dialogs.append(d.message), asyncio.ensure_future(d.accept())))

        await pg.goto(S + "index.html"); await pg.wait_for_timeout(500)
        ok("헤더에 로그인", (await pg.locator(".login-txt").first.inner_text()) == "로그인·가입")
        await pg.evaluate("localStorage.setItem('wish', JSON.stringify(['W1']))")
        await pg.goto(S + "login.html"); await pg.wait_for_timeout(800)
        ok("로그인 버튼 3개", await pg.locator(".sns-btn").count() == 3)
        ok("구글은 키 없어 준비중 표시", "off" in (await pg.locator(".sns-btn.google").get_attribute("class")))
        await pg.screenshot(path="/tmp/s_login.png")
        await pg.locator(".sns-btn.naver").click(); await pg.wait_for_timeout(2000)
        ok("가입 환영 인사", any("환영" in d for d in dialogs), dialogs)
        ok("로그인 후 내 정보", await pg.locator("#me-box").is_visible() and "홍길동" in await pg.locator("#me-box").inner_text())
        ok("헤더가 내 정보로", (await pg.locator(".login-txt").first.inner_text()) == "내 정보")
        await pg.screenshot(path="/tmp/s_me.png")
        me = json.loads(urllib.request.urlopen(urllib.request.Request("http://localhost:8788/me", data=json.dumps({"token": await pg.evaluate("JSON.parse(localStorage.getItem('tk'))")}).encode(), method="POST")).read())
        ok("기기 찜이 회원에 저장", "W1" in me["user"]["wish"], me)

        prods = json.load(open("site/products.json")); p = next(x for x in prods if not x["options"] and not x.get("soldout"))
        await pg.evaluate(f"localStorage.setItem('cart', JSON.stringify([{{id:'{p['id']}',qty:1}}])); localStorage.removeItem('addr')")
        await pg.goto(S + "checkout.html"); await pg.wait_for_timeout(1200)
        ok("결제화면 이름 자동 입력", await pg.input_value("#name") == "홍길동")
        ok("결제화면 연락처 자동 입력", await pg.input_value("#phone") == "010-1234-5678")

        await pg.locator("#me-box #logout").count()
        await pg.goto(S + "login.html"); await pg.wait_for_timeout(800)
        await pg.locator("#logout").click(); await pg.wait_for_timeout(1200)
        ok("로그아웃", await pg.locator("#login-box").is_visible() and (await pg.locator(".login-txt").first.inner_text()) == "로그인·가입")
        ok("자바스크립트 오류 없음", not errs, errs[:3])
        await b.close()
    print(f"로그인 화면 테스트: {sum(res)} / {len(res)}")
asyncio.run(main())
