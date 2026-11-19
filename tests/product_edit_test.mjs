// 상품 상세 수정 테스트 — node tests/product_edit_test.mjs
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  getWithMetadata: async (k) => ({ value: mem.get(k) || null, metadata: { type: "image/jpeg" } }) };
const row = { id: "DM1", name: "컵", category: "kitchen", price: 5000, cost: 3000, image: "https://a/1.jpg", images: '["https://a/2.jpg"]', detail_html: "<p>원본</p>", options: '[{"v":"빨강","add":0}]', option_name: "색상", qt: "[]", soldout: 0 };
const upd = [];
const DB = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => (a[0] === "DM1" || a.at(-1) === "DM1") && /SELECT/.test(sql) ? { ...row } : null, run: async () => { upd.push([sql, a]); if (/UPDATE/.test(sql)) { const ks = sql.match(/SET (.*), h =/)[1].split(", ").map((x) => x.split(" ")[0]); ks.forEach((k, i) => (row[k] = a[i])); } return {}; } }) }) };
const env = { SHOP, DB, ADMIN_PASSWORD: "pw" };
const call = async (path, body, method = "POST") => { const r = await handle(new Request("https://api.test" + path, method === "GET" ? {} : { method, headers: { "Content-Type": "application/json", Authorization: "Bearer pw" }, body: JSON.stringify(body) }), env, path.split("?")[0]); return { s: r.status, d: r.headers.get("content-type")?.includes("json") ? await r.json() : null }; };
let pass = 0, failn = 0; const ok = (n, c, i) => (c ? pass++ : (failn++, console.log("❌", n, JSON.stringify(i))));
let r = await call("/admin/product-get", { id: "DM1" }); ok("불러오기", r.d.row.name === "컵" && r.d.row.options.length === 1 && r.d.row.floor > 3000, r.d);
const floor = r.d.row.floor;
r = await call("/admin/product-save", { id: "DM1", fields: { price: 100 }, big: { detail_html: '<p>새 설명<img src="x" onerror="alert(1)"><script>bad()</script></p>', images: ["https://b/1.jpg", "http://bad", "https://b/2.jpg"], options: [{ v: "파랑", add: -99999 }, { v: "", add: 0 }], option_name: "컬러" } });
ok("저장", r.s === 200, r.d);
ok("D1 즉시 반영 상세", row.detail_html === '<p>새 설명<img src="x"></p>', row.detail_html);
ok("D1 사진", row.image === "https://b/1.jpg" && row.images === '["https://b/2.jpg"]', row);
ok("가격 바닥", row.price === floor, [row.price, floor]);
ok("옵션 바닥", JSON.parse(row.options)[0].add === floor - 5000 && JSON.parse(row.options).length === 1, row.options);
r = await call("/edits", null, "GET"); ok("big 표시", r.d.items.DM1.big === true, r.d);
r = await call("/edits/big?ids=DM1,ZZ", null, "GET"); ok("big 읽기", r.d.DM1.option_name === "컬러" && !r.d.ZZ, r.d);
r = await call("/admin/product-get", { id: "DM1" }); ok("원본 보관", r.d.orig.detail_html === "<p>원본</p>" && r.d.big.images.length === 2, r.d.orig);
r = await call("/admin/product-save", { id: "DM1", reset: true }); ok("되돌리기", r.s === 200 && row.detail_html === "<p>원본</p>" && row.image === "https://a/1.jpg", row);
r = await call("/edits", null, "GET"); ok("수정 내역 지움", !r.d.items.DM1, r.d);
r = await call("/admin/product-img", { data: "data:image/jpeg;base64,/9j/4AAQ" }); ok("사진 올리기", r.d.url && r.d.url.includes("/pimg/"), r.d);
const key = r.d.url.split("/pimg/")[1]; const g = await handle(new Request("https://api.test/pimg/" + key), env, "/pimg/" + key); ok("사진 보기", g.status === 200, g.status);
console.log(`product_edit: ${pass} pass, ${failn} fail`); if (failn) process.exit(1);
