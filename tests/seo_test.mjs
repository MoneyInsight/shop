// SEO 일괄 수정 테스트 — node tests/seo_test.mjs
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = { get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const rowsDB = [{ id: "A1", name: "사과", category: "food", brand: "", price: 1000 }, { id: "B2", name: "배", category: "living", brand: "", price: 2000 }];
const DB = { prepare: (sql) => ({ bind: (...a) => ({ all: async () => ({ results: rowsDB.filter((r) => r.id > a[0] && (a.length < 2 || r.category === a[1])) }) }) }) };
const env = { SHOP, DB, ADMIN_PASSWORD: "pw" };
const call = async (path, body, method = "POST") => { const r = await handle(new Request("https://api.test" + path, method === "GET" ? {} : { method, headers: { "Content-Type": "application/json", Authorization: "Bearer pw" }, body: JSON.stringify(body) }), env, path.split("?")[0]); return { s: r.status, d: await r.json() }; };
let pass = 0, failn = 0; const ok = (n, c, i) => (c ? pass++ : (failn++, console.log("❌", n, JSON.stringify(i))));
let r = await call("/admin/seo-upload", { rows: [{ id: "A1", name: "꿀사과 5kg", kw: "사과,꿀사과", summary: "아삭한 사과" }] }); ok("업로드", r.s === 200 && r.d.saved === 1, r);
r = await call("/admin/catalog-export", { cat: "", after: "" }); ok("내려받기에 수정본 반영", r.d.rows[0][1] === "꿀사과 5kg" && r.d.rows[0][2] === "사과,꿀사과" && r.d.rows.length === 2, r.d);
r = await call("/admin/catalog-export", { cat: "living", after: "" }); ok("카테고리 필터", r.d.rows.length === 1 && r.d.rows[0][0] === "B2", r.d);
r = await call("/edits/seo", null, "GET"); ok("칸 수", r.d.n === 64, r.d);
let found = false; for (let b = 0; b < 64; b++) { const x = await call("/edits/seo?b=" + b, null, "GET"); if (x.d.A1) found = x.d.A1.kw === "사과,꿀사과"; } ok("칸에서 읽기", found);
r = await call("/edits", null, "GET"); ok("ver 합침", String(r.d.ver).includes("-"), r.d);
console.log(`seo: ${pass} pass, ${failn} fail`); if (failn) process.exit(1);
