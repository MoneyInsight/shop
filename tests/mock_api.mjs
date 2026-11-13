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
  // 간편 로그인 가짜 응답
  if (/nid\.naver\.com\/oauth2\.0\/token|kauth\.kakao\.com\/oauth\/token/.test(url)) return new Response(JSON.stringify({ access_token: "AT" }));
  if (String(url).includes("openapi.naver.com")) return new Response(JSON.stringify({ response: { id: "N1", name: "홍길동", email: "a@naver.com", mobile: "010-1234-5678" } }));
  if (String(url).includes("kapi.kakao.com")) return new Response(JSON.stringify({ id: 7, kakao_account: { profile: { nickname: "카톡이" } } }));
  return realFetch(url, o);
};
const env = { SHOP, SITE_URL: "http://localhost:8765", TOSS_SECRET_KEY: "k", ADMIN_PASSWORD: "test1234", API_URL: JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url))).worker_url, NAVER_CLIENT_ID: "nid", NAVER_CLIENT_SECRET: "nsec", KAKAO_REST_KEY: "krest" };
// CATALOG=1 이면 dist/catalog.sqlite 를 상품 DB(D1 흉내)로 연결
if (process.env.CATALOG) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(new URL("../dist/catalog.sqlite", import.meta.url).pathname);
  env.DB = { prepare(sql) { let a = []; const st = db.prepare(sql); const o = { bind: (...x) => ((a = x), o), first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => st.run(...a) }; return o; } };
}
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await handle(new Request("http://x" + req.url, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), env, req.url.split("?")[0]);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(r.status === 302 ? "" : await r.text());
}).listen(8788, () => console.log("mock api :8788"));
