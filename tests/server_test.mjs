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
console.log(`통과 ${pass} / 실패 ${failn}`); process.exit(failn ? 1 : 0);
