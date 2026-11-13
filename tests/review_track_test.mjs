// 배송완료 → 리뷰 요청 알림, 리뷰 작성 조건 테스트
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const mails = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url);
  if (url.includes("brevo")) { mails.push(JSON.parse(o.body)); return new Response("{}", { status: 201 }); }
  return new Response("{}", { status: 404 });
};
const env = { SHOP, SITE_URL: "https://s.test", ADMIN_PASSWORD: "pw", BREVO_API_KEY: "b", MAIL_FROM: "a@b.c" };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const post = async (p, b, admin) => { const r = await handle(new Request("https://x" + p, { method: "POST", headers: admin ? { Authorization: "Bearer pw" } : {}, body: JSON.stringify(b) }), env, p); return [r.status, await r.json()]; };
mem.set("order:O1", JSON.stringify({ orderId: "O1", status: "결제완료", lines: [{ id: "P1", name: "메탈 선반", qty: 1, price: 10000 }], customer: { name: "홍길동", phone: "010-1111-2222", email: "c@d.e" }, history: [] }));
let [st, d] = await post("/review/add", { orderId: "O1", phone: "010-1111-2222", product_id: "P1", rating: 5, text: "아주 좋아요 튼튼" });
ok(st === 400, "발송 전 리뷰 불가");
[st] = await post("/admin/order-update", { orderId: "O1", status: "배송중", courier: "CJ대한통운", tracking: "1234-5678-9012" }, true);
ok(st === 200 && mails.some((m) => m.subject.includes("출고")), "출고 메일 " + JSON.stringify(mails.map((m) => m.subject)));
[st] = await post("/admin/order-update", { orderId: "O1", status: "배송완료" }, true);
const rv = mails.find((m) => m.subject.includes("잘 받으셨나요"));
ok(st === 200 && rv && JSON.stringify(rv).includes("product/P1.html?write=1&order=O1#review"), "배송완료 → 리뷰 요청 메일(리뷰 쓰기 링크)");
await post("/admin/order-update", { orderId: "O1", status: "구매확정" }, true);
await post("/admin/order-update", { orderId: "O1", status: "배송완료" }, true);
ok(mails.filter((m) => m.subject.includes("잘 받으셨나요")).length === 1, "리뷰 요청은 한 번만");
[st, d] = await post("/review/add", { orderId: "O1", phone: "010-1111-2222", product_id: "P1", rating: 5, text: "아주 좋아요 튼튼" });
ok(st === 200, "배송 후 리뷰 등록");
[st] = await post("/review/add", { orderId: "O1", phone: "010-1111-2222", product_id: "P1", rating: 4, text: "두번째 리뷰 시도" });
ok(st === 400, "같은 주문 중복 리뷰 불가");
[st, d] = await post("/order/lookup", { orderId: "O1", phone: "01011112222" });
ok(d.order.courier === "CJ대한통운" && d.order.tracking === "1234-5678-9012", "주문조회에 택배사·송장");
console.log(`review/track: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
