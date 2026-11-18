// 반품 사진 첨부 테스트 — node tests/claim_photo_test.mjs
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
globalThis.fetch = async () => new Response("{}");
const env = { SHOP, ADMIN_PASSWORD: "pw" };
const call = async (path, body, admin) => { const r = await handle(new Request("https://api.test" + path, { method: "POST", headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer pw" } : {}) }, body: JSON.stringify(body) }), env, path); return { s: r.status, d: await r.json() }; };
let pass = 0, failn = 0; const ok = (n, c, i) => (c ? pass++ : (failn++, console.log("❌", n, JSON.stringify(i))));
mem.set("order:C1", JSON.stringify({ orderId: "C1", status: "배송완료", customer: { name: "홍", phone: "010-1111-2222" }, lines: [{ id: "A", name: "a", qty: 1, price: 1000 }], amount: 4000, paidAt: new Date().toISOString(), receiver: {} }));
const img = "data:image/jpeg;base64," + "A".repeat(1000);
let r = await call("/order/claim", { orderId: "C1", phone: "01011112222", type: "반품", kind: "상품 불량·파손", reason: "깨짐" }); ok("불량인데 사진 없으면 거절", r.s === 400, r);
r = await call("/order/claim", { orderId: "C1", phone: "01011112222", type: "반품", kind: "상품 불량·파손", reason: "깨짐", photos: [img, img] }); ok("사진 2장 접수", r.s === 200 && mem.has("claimimg:C1:1"), r);
ok("주문에 사진 수", JSON.parse(mem.get("order:C1")).claim.photos === 2);
r = await call("/admin/claim-photo", { orderId: "C1", i: 1 }, true); ok("관리자 사진 보기", r.d.data === img, r.s);
r = await call("/admin/claim-photo", { orderId: "C1", i: 1 }); ok("관리자 아니면 거절", r.s === 401 || r.s === 403, r.s);
mem.set("order:C2", JSON.stringify({ orderId: "C2", status: "배송완료", customer: { name: "홍", phone: "010-1111-2222" }, lines: [{ id: "A", name: "a", qty: 1, price: 1000 }], amount: 4000, paidAt: new Date().toISOString(), receiver: {} }));
r = await call("/order/claim", { orderId: "C2", phone: "01011112222", type: "반품", kind: "단순 변심", reason: "마음 바뀜" }); ok("단순 변심은 사진 없이", r.s === 200, r);
console.log(`claim: ${pass} pass, ${failn} fail`); if (failn) process.exit(1);
