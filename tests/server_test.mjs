// 서버 로직 테스트 (메모리 KV + 가짜 토스/사이트) — node tests/server_test.mjs
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = {
  get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null),
  put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const products = [{ id: "A1", name: "테스트 상품", price: 10000, shipping_fee: 0, options: [{ v: "빨강", add: 0 }, { v: "파랑", add: 500 }] }, { id: "B1", name: "단품", price: 5000, shipping_fee: 0, options: [] }];
const calls = [];
globalThis.fetch = async (url, o) => {
  calls.push(String(url));
  if (String(url).endsWith("/products.json")) return new Response(JSON.stringify(products));
  if (String(url).includes("tosspayments")) return new Response(JSON.stringify({ method: "카드" }), { status: 200 });
  return new Response("{}");
};
const env = { SHOP, SITE_URL: "https://x.test", TOSS_SECRET_KEY: "k", ADMIN_PASSWORD: "pw", NOTIFY_WEBHOOK: "https://hook.test" };
const call = async (path, body, admin) => {
  const r = await handle(new Request("https://api.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer pw" } : {}) }, body: JSON.stringify(body || {}) }), env, path);
  return { s: r.status, d: await r.json() };
};
let pass = 0, failn = 0;
const ok = (name, cond, info) => { cond ? pass++ : (failn++, console.log("❌", name, JSON.stringify(info))); };
const cust = { name: "홍길동", phone: "010-1234-5678", zip: "12345", addr: "수원시", memo: "" };

let r = await call("/admin/coupon-save", { code: "welcome", type: "amount", value: 1000, min_order: 10000 }, true); ok("쿠폰 생성", r.s === 200, r);
r = await call("/coupon/check", { code: "WELCOME", subtotal: 5000 }); ok("쿠폰 최소금액 거절", r.s === 400, r);
r = await call("/coupon/check", { code: "welcome", subtotal: 20500 }); ok("쿠폰 확인", r.d.discount === 1000, r);
r = await call("/confirm", { paymentKey: "pk", orderId: "ORD1", amount: 99, items: [{ id: "A1", qty: 1, opt: 1 }], customer: cust }); ok("금액 조작 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk", orderId: "ORD1", amount: 20000, items: [{ id: "A1", qty: 1, opt: 1 }, { id: "B1", qty: 2 }], customer: cust, coupon: "WELCOME" }); ok("쿠폰 미반영 금액 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk", orderId: "ORD1", amount: 19500, items: [{ id: "A1", qty: 1, opt: 1 }, { id: "B1", qty: 2 }], customer: cust, coupon: "WELCOME" }); ok("결제 승인", r.s === 200, r);
r = await call("/confirm", { paymentKey: "pk", orderId: "ORD1", amount: 19500, items: [{ id: "B1", qty: 1 }], customer: cust }); ok("중복 주문 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk", orderId: "ORD9", amount: 10000, items: [{ id: "A1", qty: 1 }], customer: cust }); ok("옵션 미선택 거절", r.s === 400, r);
ok("주문 알림 발송", calls.includes("https://hook.test"));
r = await call("/order/lookup", { orderId: "ORD1", phone: "01000000000" }); ok("연락처 불일치 거절", r.s === 404, r);
r = await call("/order/lookup", { orderId: "ORD1", phone: "01012345678" }); ok("주문 조회", r.d.order?.status === "결제완료" && !("paymentKey" in r.d.order) && !JSON.stringify(r.d).includes("supply_price"), r);
r = await call("/review/add", { orderId: "ORD1", phone: "01012345678", product_id: "A1", rating: 5, text: "좋아요 좋아요" }); ok("발송 전 리뷰 거절", r.s === 400, r);
r = await call("/order/claim", { orderId: "ORD1", phone: "01012345678", type: "반품", reason: "변심" }); ok("발송 전 반품 거절", r.s === 400, r);
r = await call("/admin/order-update", { orderId: "ORD1", status: "배송중" }); ok("관리자 인증 필요", r.s === 401, r);
r = await call("/admin/order-update", { orderId: "ORD1", status: "배송중", courier: "CJ대한통운", tracking: "1234" }, true); ok("송장 입력", r.s === 200, r);
r = await call("/order/lookup", { orderId: "ORD1", phone: "010-1234-5678" }); ok("송장 조회", r.d.order.tracking === "1234" && r.d.order.status === "배송중", r);
r = await call("/order/cancel", { orderId: "ORD1", phone: "01012345678" }); ok("배송중 취소 거절", r.s === 400, r);
r = await call("/review/add", { orderId: "ORD1", phone: "01012345678", product_id: "ZZ", rating: 5, text: "좋아요 좋아요" }); ok("미구매 상품 리뷰 거절", r.s === 400, r);
r = await call("/review/add", { orderId: "ORD1", phone: "01012345678", product_id: "A1", rating: 9, text: "<b>좋아요</b> 잘 받았어요" }); ok("리뷰 등록", r.s === 200, r);
r = await call("/review/add", { orderId: "ORD1", phone: "01012345678", product_id: "A1", rating: 5, text: "또 씁니다 또" }); ok("리뷰 중복 거절", r.s === 400, r);
r = await call("/review/list", { product_id: "A1" }); ok("리뷰 목록", r.d.count === 1 && r.d.avg === 5 && r.d.reviews[0].name === "홍**" && !r.d.reviews[0].text.includes("<"), r);
r = await call("/qna/add", { product_id: "A1", product_name: "테스트", name: "김철수", text: "재입고 언제 되나요?", secret: true }); ok("문의 등록", r.s === 200, r);
r = await call("/qna/list", { product_id: "A1" }); ok("비밀 문의 숨김", r.d.list[0].text === "" && r.d.list[0].secret, r);
r = await call("/inquiry/add", { name: "김", contact: "010", type: "배송", text: "언제 오나요??" }); ok("1:1 문의", r.s === 200, r);
r = await call("/order/claim", { orderId: "ORD1", phone: "01012345678", type: "반품", reason: "단순 변심" }); ok("반품 신청", r.d.order?.status === "반품요청", r);
r = await call("/admin/list", {}, true); ok("관리자 목록", r.d.orders.length === 1 && r.d.stats.claims === 1 && r.d.qnas.length === 1 && r.d.inquiries.length === 1 && r.d.reviews.length === 1 && r.d.coupons[0].used === 1, r.d.stats);
r = await call("/admin/answer", { key: r.d.qnas[0].key, answer: "다음 주예요" }, true); ok("문의 답변", r.s === 200, r);
r = await call("/admin/order-cancel", { orderId: "ORD1", reason: "반품 환불" }, true); ok("환불", r.s === 200, r);
r = await call("/order/lookup", { orderId: "ORD1", phone: "01012345678" }); ok("환불 후 상태", r.d.order.status === "반품완료", r.d.order?.status);
r = await call("/confirm", { paymentKey: "pk2", orderId: "ORD2", amount: 5000, items: [{ id: "B1", qty: 1 }], customer: cust }); 
r = await call("/order/cancel", { orderId: "ORD2", phone: "01012345678", reason: "실수" }); ok("결제완료 즉시 취소", r.d.order?.status === "취소완료", r);
{ const q = async (h, e2) => (await handle(new Request("https://api.test/admin/list", { method: "POST", headers: { Authorization: h }, body: "{}" }), e2 || env, "/admin/list")).status;
  ok("비번 인코딩 허용", (await q("Bearer " + encodeURIComponent("pw"))) === 200);
  ok("한글 비번", (await q("Bearer " + encodeURIComponent("비번1!"), { ...env, ADMIN_PASSWORD: " 비번1! " })) === 200);
  ok("틀린 비번", (await q("Bearer nope")) === 401);
  ok("비번 미설정", (await q("Bearer x", { ...env, ADMIN_PASSWORD: "" })) === 401); }
// ── 대량 구매 가격 제안 ──
mem.set("seller:SELL1", JSON.stringify({ code: "SELL1", company: "공급사A", phone: "010-7777-1111" }));
mem.set("supply:B1", JSON.stringify({ supplier: "공급사A", seller_code: "SELL1", supply_price: 4000 }));
const c2 = { ...cust, phone: "010-5555-6666" };
r = await call("/offer/add", { product_id: "B1", qty: 2, price: 4900, name: "김", phone: c2.phone }); ok("제안 2개 거절", r.s === 400, r);
r = await call("/offer/add", { product_id: "B1", qty: 3, price: 4800, name: "김", phone: c2.phone }); ok("제안 3% 초과 거절", r.s === 400, r);
r = await call("/offer/add", { product_id: "B1", qty: 3, price: 5000, name: "김", phone: c2.phone }); ok("판매가 이상 거절", r.s === 400, r);
r = await call("/offer/add", { product_id: "A1", qty: 3, price: 9700, name: "김", phone: c2.phone }); ok("옵션 없이 제안 거절", r.s === 400, r);
r = await call("/offer/add", { product_id: "B1", qty: 3, price: 4850, name: "김철수", phone: c2.phone, memo: "빨리요" }); ok("제안 등록", r.s === 200 && r.d.offer.status === "대기", r);
const OFID = r.d.offer?.id;
r = await call("/offer/add", { product_id: "B1", qty: 4, price: 4900, name: "김철수", phone: c2.phone }); ok("같은 상품 중복 제안 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk3", orderId: "ORD3", amount: 14550, items: [{ id: "B1", qty: 3, offer: OFID }], customer: c2 }); ok("수락 전 제안가 결제 거절", r.s === 400, r);
r = await call("/seller/offers", { code: "WRONG" }); ok("공급사 코드 틀림", r.s === 403, r);
r = await call("/seller/offers", { code: "sell1" }); ok("공급사 제안 목록", r.d.offers.length === 1 && r.d.offers[0].name === "김**" && !JSON.stringify(r.d).includes("55556666"), r);
r = await call("/seller/offer-reply", { code: "SELL1", id: OFID, accept: true }); ok("공급사 수락", r.s === 200, r);
r = await call("/seller/offer-reply", { code: "SELL1", id: OFID, accept: false }); ok("중복 응답 거절", r.s === 400, r);
r = await call("/offer/check", { ids: [OFID], phone: "01000000000" }); ok("다른 연락처 조회 안 됨", r.d.offers.length === 0, r);
r = await call("/offer/check", { ids: [OFID], phone: c2.phone }); ok("제안 조회", r.d.offers[0]?.status === "수락" && r.d.offers[0].payBy, r);
r = await call("/confirm", { paymentKey: "pk3", orderId: "ORD3", amount: 14550, items: [{ id: "B1", qty: 3, offer: OFID }], customer: cust }); ok("다른 연락처로 제안가 결제 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk3", orderId: "ORD3", amount: 19400, items: [{ id: "B1", qty: 4, offer: OFID }], customer: c2 }); ok("수량 바꿔 결제 거절", r.s === 400, r);
r = await call("/confirm", { paymentKey: "pk3", orderId: "ORD3", amount: 14550, items: [{ id: "B1", qty: 3, offer: OFID }], customer: c2 }); ok("제안가 결제", r.s === 200, r);
r = await call("/confirm", { paymentKey: "pk4", orderId: "ORD4", amount: 14550, items: [{ id: "B1", qty: 3, offer: OFID }], customer: c2 }); ok("제안 재사용 거절", r.s === 400, r);
r = await call("/offer/add", { product_id: "A1", opt: 1, qty: 5, price: 10190, name: "이", phone: "01077778888" }); ok("직영 옵션 제안", r.s === 200 && r.d.offer.unit === 10500, r);
r = await call("/admin/offer-reply", { id: r.d.offer.id, accept: false, note: "재고 부족" }, true); ok("관리자 거절", r.s === 200, r);
r = await call("/admin/list", {}, true); ok("관리자 제안 목록", r.d.offers.length === 2 && r.d.offers.some((o) => o.status === "주문완료" && o.orderId === "ORD3"), r.d.offers);
{ const o = JSON.parse(mem.get("offer:" + OFID)); ok("주문에 제안 기록", JSON.parse(mem.get("order:ORD3")).lines[0].offer === OFID && o.status === "주문완료"); }
{ const k = [...mem.keys()].find((x) => x.startsWith("offer:") && x !== "offer:" + OFID); const o = JSON.parse(mem.get(k)); o.status = "대기"; o.expiresAt = "2000-01-01T00:00:00Z"; mem.set(k, JSON.stringify(o));
  r = await call("/admin/offer-reply", { id: o.id, accept: true }, true); ok("만료 제안 수락 거절", r.s === 400, r); }
// ── 알림톡: 키 없으면 안 보냄, 키 있으면 솔라피 호출 ──
ok("키 없을 때 알림톡 미발송", !calls.some((u) => u.includes("solapi")));
Object.assign(env, { SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SOLAPI_PFID: "pf", SOLAPI_SENDER: "031-291-1004", ADMIN_PHONE: "01099998888",
  KAKAO_TPL_OFFER_NEW: "t1", KAKAO_TPL_OFFER_ACCEPT: "t2", KAKAO_TPL_ORDER_DONE: "t3", KAKAO_TPL_ADMIN_ORDER: "t4", KAKAO_TPL_SHIPPED: "t5" });
const bodies = [];
const f0 = globalThis.fetch;
globalThis.fetch = async (u, o) => { if (String(u).includes("solapi")) { bodies.push(JSON.parse(o.body)); return new Response("{}"); } return f0(u, o); };
r = await call("/offer/add", { product_id: "B1", qty: 3, price: 4900, name: "박영희", phone: "010-3333-4444" });
ok("제안 알림톡 → 공급사", bodies.some((b) => b.message.kakaoOptions.templateId === "t1" && b.message.to === "01077771111"), bodies);
const of3 = r.d.offer.id;
r = await call("/seller/offer-reply", { code: "SELL1", id: of3, accept: true });
ok("수락 알림톡 → 고객", bodies.some((b) => b.message.kakaoOptions.templateId === "t2" && b.message.to === "01033334444" && b.message.kakaoOptions.variables["#{제안가}"] === "4,900"), bodies.at(-1));
r = await call("/confirm", { paymentKey: "pk5", orderId: "ORD5", amount: 14700, items: [{ id: "B1", qty: 3, offer: of3 }], customer: { ...cust, phone: "010-3333-4444" } });
ok("주문 알림톡 고객·대표", r.s === 200 && bodies.some((b) => b.message.kakaoOptions.templateId === "t3") && bodies.some((b) => b.message.kakaoOptions.templateId === "t4" && b.message.to === "01099998888"), bodies.slice(-2));
r = await call("/admin/order-update", { orderId: "ORD5", status: "배송중", courier: "CJ대한통운", tracking: "999" }, true);
ok("출고 알림톡", bodies.some((b) => b.message.kakaoOptions.templateId === "t5" && b.message.kakaoOptions.variables["#{송장번호}"] === "999"), bodies.at(-1));
r = await call("/health"); 
// ── 카카오톡 나에게 보내기 (무료) ──
{ const memo = [], f1 = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes("kauth.kakao.com")) { const p = new URLSearchParams(o.body); return new Response(JSON.stringify(p.get("code") === "bad" ? { error_description: "invalid code" } : { access_token: "AT" + p.get("grant_type"), refresh_token: "RT", expires_in: 3600 }), { status: p.get("code") === "bad" ? 400 : 200 }); }
    if (String(u).includes("kapi.kakao.com")) { memo.push(JSON.parse(new URLSearchParams(o.body).get("template_object"))); return new Response("{}"); }
    return f1(u, o); };
  r = await call("/admin/kakao-connect", { code: "x", redirect_uri: "https://s/admin.html" }, true); ok("REST 키 없으면 안내", r.s === 400, r);
  env.KAKAO_REST_KEY = "rest";
  r = await call("/admin/list", {}, true); ok("연결 전 상태", r.d.kakaoMe.clientId === "rest" && !r.d.kakaoMe.connected, r.d.kakaoMe);
  r = await call("/admin/kakao-connect", { code: "bad", redirect_uri: "https://s/admin.html" }, true); ok("잘못된 코드 거절", r.s === 400, r);
  r = await call("/admin/kakao-connect", { code: "good", redirect_uri: "https://s/admin.html" }, true); ok("카카오 연결 + 테스트 알림", r.s === 200 && memo.length === 1, [r, memo]);
  r = await call("/confirm", { paymentKey: "pk6", orderId: "ORD6", amount: 5000, items: [{ id: "B1", qty: 1 }], customer: cust });
  ok("주문 시 대표 카톡 알림", memo.some((m) => m.text.includes("새 주문") && m.text.includes("ORD6") && m.text.length <= 200), memo.at(-1));
  const t0 = JSON.parse(mem.get("kakao:me")); t0.exp = 0; mem.set("kakao:me", JSON.stringify(t0));
  r = await call("/inquiry/add", { name: "김", contact: "010", type: "배송", text: "언제 오나요??" });
  ok("토큰 만료 시 자동 갱신 후 알림", JSON.parse(mem.get("kakao:me")).access === "ATrefresh_token" && memo.some((m) => m.text.includes("1:1 문의")), JSON.parse(mem.get("kakao:me")));
  r = await call("/admin/list", {}, true); ok("연결 후 상태", r.d.kakaoMe.connected, r.d.kakaoMe); }
// ── 무료 알림: 웹 푸시 + 이메일 ──
{ const sent = [], mails = [], f2 = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).startsWith("https://push.test/")) { sent.push({ u: String(u), auth: o.headers.Authorization }); return new Response("", { status: String(u).endsWith("gone") ? 410 : 201 }); }
    if (String(u).includes("api.brevo.com")) { mails.push(JSON.parse(o.body)); return new Response("{}"); }
    return f2(u, o); };
  r = await call("/push/key"); ok("푸시 키 자동 생성", r.d.key && r.d.key.length > 80, r);
  const k1 = r.d.key; r = await call("/push/key"); ok("푸시 키 재사용", r.d.key === k1);
  r = await call("/push/subscribe", { sub: { endpoint: "http://bad" }, phone: "010-3333-4444" }); ok("잘못된 구독 거절", r.s === 400, r);
  r = await call("/push/subscribe", { sub: { endpoint: "https://push.test/c1" }, phone: "010-3333-4444" }); ok("고객 구독", r.s === 200, r);
  r = await call("/push/subscribe", { sub: { endpoint: "https://push.test/gone" }, phone: "010-3333-4444" });
  r = await call("/admin/push-subscribe", { sub: { endpoint: "https://push.test/a1" } }); ok("관리자 구독 인증 필요", r.s === 401, r);
  r = await call("/admin/push-subscribe", { sub: { endpoint: "https://push.test/a1" } }, true); ok("관리자 구독", r.s === 200, r);
  Object.assign(env, { BREVO_API_KEY: "bk", MAIL_FROM: "shop@test.kr", ADMIN_EMAIL: "boss@test.kr" });
  r = await call("/admin/order-update", { orderId: "ORD6", status: "상품준비중" }, true);
  mem.set("order:ORD7", JSON.stringify({ orderId: "ORD7", amount: 5000, lines: [{ id: "B1", name: "단품", qty: 1, price: 5000 }], customer: { name: "박영희", phone: "010-3333-4444", email: "young@test.kr" }, status: "상품준비중", paidAt: new Date().toISOString(), history: [] }));
  r = await call("/admin/order-update", { orderId: "ORD7", status: "배송중", courier: "한진택배", tracking: "777" }, true);
  ok("출고 → 고객 푸시", sent.some((x) => x.u.endsWith("/c1") && /^vapid t=.+\..+\..+, k=/.test(x.auth)), sent);
  ok("만료 구독 자동 삭제", ![...mem.values()].some((v) => v.includes("push.test/gone")));
  ok("출고 → 고객 메일", mails.some((m) => m.to[0].email === "young@test.kr" && m.htmlContent.includes("777") && !m.textContent.includes("배송 조회:")), mails.at(-1));
  const id = (await import("node:crypto")).createHash("sha256").update("https://push.test/c1").digest("base64url").slice(0, 32);
  r = await call("/push/pull", { endpoint: "https://push.test/c1" }); ok("푸시 내용 가져오기", r.d.messages.length === 1 && r.d.messages[0].title === "상품이 출고됐어요" && r.d.messages[0].body.includes("박영희"), r.d);
  r = await call("/push/pull", { endpoint: "https://push.test/c1" }); ok("가져간 내용 삭제", r.d.messages.length === 0, r.d);
  r = await call("/inquiry/add", { name: "김", contact: "010", type: "배송", text: "문의 드립니다" });
  ok("관리자 푸시·메일", sent.some((x) => x.u.endsWith("/a1")) && mails.some((m) => m.to[0].email === "boss@test.kr"), [sent.length, mails.length]);
  r = await call("/offer/add", { product_id: "B1", qty: 3, price: 4900, name: "최", phone: "010-1212-3434", email: "choi@test.kr" });
  r = await call("/admin/offer-reply", { id: r.d.offer.id, accept: false, note: "재고 부족" }, true);
  ok("제안 거절 메일", mails.some((m) => m.to[0].email === "choi@test.kr" && m.htmlContent.includes("재고 부족")), mails.at(-1));
  r = await call("/health"); ok("상태: 메일 켜짐", r.d.email === "켜짐", r.d); }
console.log(`통과 ${pass} / 실패 ${failn}`); process.exit(failn ? 1 : 0);
