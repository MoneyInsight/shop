// 회원 추가 할인: 서버·사이트 계산 일치, 마진 8% 하한
import { memberDiscount } from "../worker/member.js";
import { handle } from "../worker/worker.js";
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
ok(memberDiscount([{ unit: 12450, list: 12450, qty: 1 }]) === 120, "정가 1% " + memberDiscount([{ unit: 12450, list: 12450, qty: 1 }]));
const big = memberDiscount([{ unit: 56790, list: 59150, qty: 3 }]);  // 원가 5만, 3개 4% 할인가 → 1%면 마진 8% 아래 → 줄어듦
ok(big < 56790 * 0.01 * 3 && big >= 0, "수량 할인과 겹치면 8% 하한까지만 " + big);
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async () => {}, list: async () => ({ keys: [] }) };
globalThis.fetch = async (u) => String(u).endsWith("/products.json") ? new Response(JSON.stringify([{ id: "A", name: "a", price: 12450, options: [] }])) : new Response(JSON.stringify({ method: "카드" }));
const env = { SHOP, SITE_URL: "https://s", TOSS_SECRET_KEY: "test_k" };
const tk = "a".repeat(48); mem.set("sess:" + tk, "naver:1"); mem.set("user:naver:1", JSON.stringify({ uid: "naver:1" }));
const pay = async (id, amount, token) => (await handle(new Request("https://x/confirm", { method: "POST", body: JSON.stringify({ paymentKey: "k", orderId: id, amount, items: [{ id: "A", qty: 1 }], customer: { name: "a", phone: "010-1-1", zip: "16200", addr: "수원" }, token }) }), env, "/confirm")).status;
ok(await pay("M1", 12450, tk) === 400, "회원인데 할인 없이 → 거부");
ok(await pay("M2", 12330, tk) === 200 && JSON.parse(mem.get("order:M2")).member_discount === 120, "회원 1% 할인 결제");
ok(await pay("M3", 12450) === 200, "비회원 정가");
const q = await (await handle(new Request("https://x/member/quote", { method: "POST", body: JSON.stringify({ token: tk, items: [{ id: "A", qty: 1 }] }) }), env, "/member/quote")).json();
ok(q.discount === 120, "결제 화면 회원 할인 금액 = 결제 확인과 같음 " + q.discount);
const q2 = await (await handle(new Request("https://x/member/quote", { method: "POST", body: JSON.stringify({ token: "b".repeat(48), items: [{ id: "A", qty: 1 }] }) }), env, "/member/quote")).json();
ok(q2.discount === 0, "비회원은 0");
console.log(`member: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
