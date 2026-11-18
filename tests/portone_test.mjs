// 포트원 결제 확인·자동취소 테스트 — node tests/portone_test.mjs
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const products = [{ id: "B1", name: "단품", price: 5000, shipping_fee: 0, options: [] }];
let pay = {}; const cancels = [];
globalThis.fetch = async (url, o) => {
  const u = String(url);
  if (u.endsWith("/products.json")) return new Response(JSON.stringify(products));
  if (u.includes("api.portone.io") && u.endsWith("/cancel")) { cancels.push(u); return new Response("{}"); }
  if (u.includes("api.portone.io/payments/")) return new Response(JSON.stringify(pay), { status: pay.status ? 200 : 404 });
  return new Response("{}");
};
const env = { SHOP, SITE_URL: "https://x.test", TOSS_SECRET_KEY: "k", PORTONE_API_SECRET: "s", ADMIN_PASSWORD: "pw" };
const call = async (path, body, admin) => { const r = await handle(new Request("https://api.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer pw" } : {}) }, body: JSON.stringify(body) }), env, path); return { s: r.status, d: await r.json() }; };
let pass = 0, failn = 0; const ok = (n, c, i) => (c ? pass++ : (failn++, console.log("❌", n, JSON.stringify(i))));
const cust = { name: "홍길동", phone: "010-1234-5678", zip: "12345", addr: "수원시", memo: "" };
const base = { pg: "portone", items: [{ id: "B1", qty: 2 }], customer: cust };
let r = await call("/confirm", { ...base, dry: true, orderId: "P1", amount: 10000 }); ok("사전 확인 통과", r.s === 200, r);
r = await call("/confirm", { ...base, dry: true, orderId: "P1", amount: 100 }); ok("사전 확인 금액 조작 거절", r.s === 400, r);
ok("사전 확인은 취소 호출 없음", cancels.length === 0, cancels);
await call("/confirm", { ...base, dry: true, orderId: "P2", amount: 10000 });
pay = { status: "PAID", amount: { total: 9000 } };
r = await call("/confirm", { ...base, orderId: "P2", paymentId: "P2", amount: 10000 }); ok("결제 금액 불일치 거절", r.s === 400, r);
ok("불일치 → 자동 취소", cancels.length === 1, cancels);
pay = { status: "READY", amount: { total: 10000 } };
r = await call("/confirm", { ...base, orderId: "P3", paymentId: "P3", amount: 10000 }); ok("미결제 거절", r.s === 400, r);
pay = { status: "PAID", amount: { total: 10000 }, method: { type: "PaymentMethodCard" }, receiptUrl: "https://r" };
r = await call("/confirm", { ...base, orderId: "P4", paymentId: "P4", amount: 10000 }); ok("결제 승인", r.s === 200, r);
const o = JSON.parse(mem.get("order:P4")); ok("주문 저장 pg=portone", o.pg === "portone" && o.paymentKey === "P4" && o.method === "카드", o);
const n = cancels.length;
r = await call("/confirm", { ...base, orderId: "P4", paymentId: "P4", amount: 10000 }); ok("중복 거절", r.s === 400, r);
ok("중복이어도 정상 주문은 취소 안 함", cancels.length === n, cancels);
r = await call("/confirm", { ...base, orderId: "P5", paymentId: "OTHER", amount: 10000 }); ok("주문번호·결제번호 불일치 거절", r.s === 400, r);
const n2 = cancels.length;
r = await call("/confirm", { ...base, items: [{ id: "ZZ", qty: 1 }], orderId: "X9", paymentId: "X9", amount: 10000 }); ok("사전 확인 없는 결제는 자동 취소 안 함", r.s === 400 && cancels.length === n2, cancels);
r = await call("/order/cancel", { orderId: "P4", phone: cust.phone, reason: "변심" }); ok("고객 취소 → 포트원 환불", r.s === 200 && cancels.some((u) => u.includes("/payments/P4/cancel")), { r, cancels });
console.log(`portone: ${pass} pass, ${failn} fail`); if (failn) process.exit(1);
