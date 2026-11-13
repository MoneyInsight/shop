// 네이버·카카오·구글 로그인 서버 테스트 (각 회사 응답은 가짜)
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const SITE = "https://moneyinsight.github.io/shop", API = "https://api.test/api";
const env = { SHOP, SITE_URL: SITE, NAVER_CLIENT_ID: "nid", NAVER_CLIENT_SECRET: "nsec", KAKAO_REST_KEY: "krest", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", TOSS_SECRET_KEY: "test_k" };
const seen = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url); seen.push({ url, body: String(o.body || "") });
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (url.includes("nid.naver.com/oauth2.0/token") || url.includes("kauth.kakao.com/oauth/token") || url.includes("oauth2.googleapis.com/token"))
    return String(o.body).includes("code=bad") ? J({ error: "invalid_grant" }, 400) : J({ access_token: "AT" });
  if (url.includes("openapi.naver.com")) return J({ response: { id: "N1", name: "홍길동", email: "a@naver.com", mobile: "010-1234-5678" } });
  if (url.includes("kapi.kakao.com")) return J({ id: 777, kakao_account: { email: "k@kakao.com", phone_number: "+82 10-9999-8888", profile: { nickname: "카톡이" } } });
  if (url.includes("openidconnect.googleapis.com")) return J({ sub: "G1", name: "Google User", email: "g@gmail.com" });
  if (url.endsWith("/products.json")) return J([{ id: "P1", name: "테스트 상품", price: 10000, options: [] }]);
  if (url.includes("tosspayments")) return J({ method: "카드" });
  return J({}, 404);
};
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const get = async (p) => handle(new Request(API + p, { redirect: "manual" }), env, p.split("?")[0]);
const post = async (p, b) => { const r = await handle(new Request(API + p, { method: "POST", body: JSON.stringify(b) }), env, p); return [r.status, await r.json()]; };

async function login(provider, code = "good") {
  const r = await get(`/auth/start?provider=${provider}&return=${encodeURIComponent(SITE + "/login.html")}`);
  const loc = new URL(r.headers.get("Location"));
  const state = loc.searchParams.get("state");
  const cb = await get(`/auth/callback/${provider}?code=${code}&state=${state}`);
  return { start: r, loc, cb: cb.headers.get("Location") };
}

for (const [prov, host, expectName, expectPhone] of [["naver", "nid.naver.com", "홍길동", "010-1234-5678"], ["kakao", "kauth.kakao.com", "카톡이", "010-9999-8888"], ["google", "accounts.google.com", "Google User", ""]]) {
  const { start, loc, cb } = await login(prov);
  ok(start.status === 302 && loc.host === host, `${prov}: 로그인 화면으로 이동`);
  ok(loc.searchParams.get("redirect_uri") === `${API}/auth/callback/${prov}`, `${prov}: 돌아올 주소 ${loc.searchParams.get("redirect_uri")}`);
  ok(cb.startsWith(SITE + "/login.html#login="), `${prov}: 사이트로 세션 전달 ${cb}`);
  const token = cb.split("login=")[1].split("&")[0];
  ok(cb.includes("&new=1"), `${prov}: 첫 가입 표시`);
  const [st, d] = await post("/me", { token });
  ok(st === 200 && d.user.name === expectName && d.user.phone === expectPhone && d.user.provider === prov, `${prov}: 내 정보 ${JSON.stringify(d.user)}`);
  const again = await login(prov);
  ok(!again.cb.includes("new=1"), `${prov}: 두 번째는 기존 회원`);
}

// 세션으로 배송지·찜 저장
const { cb } = await login("naver");
const token = cb.split("login=")[1].split("&")[0];
let [st, d] = await post("/me/save", { token, addr: { name: "홍길동", phone: "010-1234-5678", zip: "12345", addr1: "수원시", addr2: "101호" }, wish: ["P1", "P1", "P2"] });
ok(st === 200 && d.user.addr.addr1 === "수원시" && d.user.wish.length === 2, "배송지·찜 저장");

// 로그인 상태로 결제 → 내 주문에 연결
[st] = await post("/confirm", { paymentKey: "pk", orderId: "ORD-AUTH-1", amount: 9900, items: [{ id: "P1", qty: 1 }], customer: { name: "홍길동", phone: "010-1234-5678" }, token });
ok(st === 200, "로그인 결제 성공 (회원 1% 할인 9,900원)");
[st, d] = await post("/me/orders", { token });
ok(st === 200 && d.orders.length === 1 && d.orders[0].orderId === "ORD-AUTH-1", "내 주문 목록");
ok(JSON.parse(mem.get("order:ORD-AUTH-1")).uid === "naver:N1", "주문에 회원 연결");
[st] = await post("/confirm", { paymentKey: "pk2", orderId: "ORD-GUEST", amount: 10000, items: [{ id: "P1", qty: 1 }], customer: { name: "손님", phone: "010-0000-0000" } });
ok(st === 200 && !JSON.parse(mem.get("order:ORD-GUEST")).uid, "비회원 주문도 그대로");

// 보안
[st] = await post("/me", { token: "x".repeat(48) }); ok(st === 401, "가짜 세션 거부");
const evil = await get(`/auth/start?provider=kakao&return=${encodeURIComponent("https://evil.com/x")}`);
const st2 = new URL(evil.headers.get("Location")).searchParams.get("state");
const evilCb = (await get(`/auth/callback/kakao?code=good&state=${st2}`)).headers.get("Location");
ok(evilCb.startsWith(SITE + "/"), "다른 사이트로는 안 돌려보냄 " + evilCb);
const bad = (await get(`/auth/callback/naver?code=good&state=nope`)).headers.get("Location");
ok(bad.includes("login_error="), "잘못된 state 거부");
const usedState = (await login("google")).loc.searchParams.get("state");
ok((await get(`/auth/callback/google?code=good&state=${usedState}`)).headers.get("Location").includes("login_error"), "state 재사용 거부");
ok((await login("naver", "bad")).cb.includes("login_error"), "토큰 실패 시 안내");
const env2 = { ...env, GOOGLE_CLIENT_ID: "" };
const nr = await handle(new Request(API + "/auth/start?provider=google&return=" + encodeURIComponent(SITE + "/login.html")), env2, "/auth/start");
ok(decodeURIComponent(nr.headers.get("Location")).includes("준비 중"), "키 없으면 준비 중 안내");
[st] = await post("/auth/logout", { token }); [st, d] = await post("/me", { token });
ok(st === 401, "로그아웃 후 세션 끝");
const h = await (await get("/health")).json();
ok(h.login.naver && h.login.kakao && h.login.google, "health에 로그인 상태");
console.log(`auth: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
