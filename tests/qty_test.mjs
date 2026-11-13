// 수량 할인 결제 금액 검증
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const P = [{ id: "Q1", name: "수량할인 상품", price: 10370, qt: [10370, 7820, 7730, 7730, 7450, 7330, 7330, 7250, 7200, 7180], options: [{ v: "빨강", add: 0 }, { v: "파랑", add: 500 }] },
           { id: "N1", name: "일반 상품", price: 5000, options: [] }];
globalThis.fetch = async (url) => String(url).endsWith("/products.json") ? new Response(JSON.stringify(P)) : new Response(JSON.stringify({ method: "카드" }));
const env = { SHOP, SITE_URL: "https://s.test", TOSS_SECRET_KEY: "test_k" };
let pass = 0, fail = 0, n = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const pay = async (items, amount) => { const r = await handle(new Request("https://x/confirm", { method: "POST", body: JSON.stringify({ paymentKey: "k", orderId: "Q" + ++n, amount, items, customer: { name: "a", phone: "010-1111-2222" } }) }), env, "/confirm"); return [r.status, await r.json()]; };
let [st, d] = await pay([{ id: "Q1", qty: 1, opt: 0 }], 10370); ok(st === 200, "1개 정가");
[st, d] = await pay([{ id: "Q1", qty: 2, opt: 0 }], 7820 * 2); ok(st === 200, "2개 개당 7,820원");
[st, d] = await pay([{ id: "Q1", qty: 2, opt: 0 }], 10370 * 2 - 100); ok(st === 400, "금액 조작 거부");
[st, d] = await pay([{ id: "Q1", qty: 2, opt: 0 }, { id: "Q1", qty: 1, opt: 1 }], 7730 * 2 + (7730 + 500)); ok(st === 200, "옵션 달라도 합산 3개 가격 " + d.message);
[st, d] = await pay([{ id: "Q1", qty: 15, opt: 0 }], 7180 * 15); ok(st === 200, "11개 이상은 10개 가격");
[st, d] = await pay([{ id: "N1", qty: 3 }], 15000); ok(st === 200, "수량할인 없는 상품은 그대로");
console.log(`qty: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
