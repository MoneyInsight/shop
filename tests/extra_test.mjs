// 비회원 주문 찾기·회원 탈퇴·영수증
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
globalThis.fetch = async (u) => String(u).endsWith("/products.json") ? new Response(JSON.stringify([{ id: "A", name: "a", price: 10000, options: [] }])) : String(u).includes("tosspayments") ? new Response(JSON.stringify({ method: "카드", receipt: { url: "https://receipt.test/1" } })) : new Response("", { status: 404 });
const env = { SHOP, SITE_URL: "https://s", TOSS_SECRET_KEY: "test_k" };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const post = async (p, b) => { const r = await handle(new Request("https://x" + p, { method: "POST", body: JSON.stringify(b) }), env, p); return [r.status, await r.json()]; };
const tk = "c".repeat(48); mem.set("sess:" + tk, "kakao:9"); mem.set("user:kakao:9", JSON.stringify({ uid: "kakao:9", orders: [] }));
let [st, d] = await post("/confirm", { paymentKey: "k", orderId: "E1", amount: 9900, items: [{ id: "A", qty: 1 }], customer: { name: "김손님", phone: "010-7777-8888", zip: "16200", addr: "수원" }, token: tk });
ok(st === 200, "회원 주문 " + JSON.stringify(d));
[st, d] = await post("/order/find", { name: "김손님", phone: "01077778888" });
ok(st === 200 && d.orders[0].orderId === "E1" && d.orders[0].receipt === "https://receipt.test/1", "이름+연락처로 주문 찾기, 영수증 주소");
[st] = await post("/order/find", { name: "다른사람", phone: "01077778888" }); ok(st === 404, "이름 틀리면 못 찾음");
[st, d] = await post("/me/delete", { token: tk });
ok(st === 200 && !mem.has("user:kakao:9") && !JSON.parse(mem.get("order:E1")).uid && mem.has("order:E1"), "탈퇴: 회원 삭제, 주문 기록은 보관");
[st] = await post("/me", { token: tk }); ok(st === 401, "탈퇴 후 로그인 끊김");
console.log(`extra: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
