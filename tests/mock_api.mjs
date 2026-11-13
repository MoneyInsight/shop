// 화면 테스트용 가짜 API 서버 (메모리 저장, 토스·사이트 호출은 가짜) — node tests/mock_api.mjs
import http from "node:http";
import fs from "node:fs";
import { handle } from "../worker/worker.js";
const mem = new Map();
const SHOP = {
  get: async (k, t) => (mem.has(k) ? (t === "json" ? JSON.parse(mem.get(k)) : mem.get(k)) : null),
  put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k),
  list: async ({ prefix }) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, o) => {
  if (String(url).endsWith("/products.json")) return new Response(fs.readFileSync(new URL("../site/products.json", import.meta.url)));
  if (String(url).includes("tosspayments")) return new Response(JSON.stringify({ method: "카드" }));
  return realFetch(url, o);
};
const env = { SHOP, SITE_URL: "http://local", TOSS_SECRET_KEY: "k", ADMIN_PASSWORD: "test1234" };
// CATALOG=1 이면 dist/catalog.sqlite 를 상품 DB(D1 흉내)로 연결
if (process.env.CATALOG) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(new URL("../dist/catalog.sqlite", import.meta.url).pathname);
  env.DB = { prepare(sql) { let a = []; const st = db.prepare(sql); const o = { bind: (...x) => ((a = x), o), first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => st.run(...a) }; return o; } };
}
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await handle(new Request("http://x" + req.url, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), env, req.url.split("?")[0]);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
}).listen(8788, () => console.log("mock api :8788"));
