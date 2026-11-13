// 품절 취소·사진 신고·백업
import { handle } from "../worker/worker.js";
const mem = new Map(), mails = [];
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
globalThis.fetch = async (u, o = {}) => { u = String(u); if (u.includes("brevo")) { mails.push(JSON.parse(o.body)); return new Response("{}", { status: 201 }); } if (u.includes("/cancel")) return new Response(JSON.stringify({ status: "CANCELED" })); return new Response("{}", { status: 404 }); };
const env = { SHOP, SITE_URL: "https://s", ADMIN_PASSWORD: "pw", TOSS_SECRET_KEY: "test_k", BREVO_API_KEY: "b", MAIL_FROM: "a@b.c" };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const post = async (p, b, admin) => { const r = await handle(new Request("https://x" + p, { method: "POST", headers: admin ? { Authorization: "Bearer pw" } : {}, body: JSON.stringify(b) }), env, p); return [r.status, await r.json()]; };
mem.set("order:S1", JSON.stringify({ orderId: "S1", status: "상품준비중", amount: 12000, paymentKey: "pk", lines: [{ id: "A", name: "선반 3단", qty: 1, price: 12000 }], customer: { name: "홍", phone: "010-1-2", email: "c@d.e" }, history: [] }));
let [st, d] = await post("/admin/soldout-cancel", { orderId: "S1" }, true);
const o = JSON.parse(mem.get("order:S1"));
ok(st === 200 && o.status === "취소완료" && o.refunded === 12000, "품절 취소 → 전액 환불 " + JSON.stringify(d));
ok(mails.some((m) => JSON.stringify(m).includes("품절")), "손님 사과 안내 메일");
[st] = await post("/admin/soldout-cancel", { orderId: "S1" }, true); ok(st === 400, "이미 취소된 주문은 다시 안 됨");
await post("/track/broken", { id: "DM123" }); await post("/track/broken", { id: "DM123" });
[st, d] = await post("/admin/list", {}, true);
ok(Object.keys(d.broken).length === 1 && d.broken.DM123, "사진 깨진 상품 신고 모음");
const r = await handle(new Request("https://x/admin/export", { method: "POST", headers: { Authorization: "Bearer pw" } }), env, "/admin/export");
const bk = await r.json();
ok(r.status === 200 && bk.order.length === 1 && Array.isArray(bk.user), "백업 파일");
ok(!JSON.stringify(bk).includes("sess:"), "로그인 세션은 백업에 안 들어감");
[st, d] = await post("/admin/list", {}, true); ok(!!d.lastBackup, "마지막 백업 시각");
// 비밀번호 무작위 대입 막기
let locked = false;
for (let i = 0; i < 7; i++) { const r = await handle(new Request("https://x/admin/list", { method: "POST", headers: { Authorization: "Bearer wrong", "cf-connecting-ip": "1.2.3.4" }, body: "{}" }), env, "/admin/list"); if (r.status === 429) locked = true; }
ok(locked, "비밀번호 5번 틀리면 15분 잠금");
const okOther = await handle(new Request("https://x/admin/list", { method: "POST", headers: { Authorization: "Bearer pw", "cf-connecting-ip": "5.6.7.8" }, body: "{}" }), env, "/admin/list");
ok(okOther.status === 200, "다른 곳의 정상 로그인은 그대로");
let spam = 0;
for (let i = 0; i < 25; i++) { const r = await handle(new Request("https://x/inquiry/add", { method: "POST", headers: { "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify({ name: "a", contact: "010", text: "문의합니다 내용" }) }), env, "/inquiry/add"); if (r.status === 429) spam++; }
ok(spam === 5, "문의 도배 막기 (1시간 20건) " + spam);
console.log(`safety: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
