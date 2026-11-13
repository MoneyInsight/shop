// 상품 DB 테스트: node:sqlite 위에 D1과 같은 모양의 어댑터를 얹어 worker/catalog.js 와 서버 경로를 검사
import { DatabaseSync } from "node:sqlite";
import * as catalog from "../worker/catalog.js";
import { handle } from "../worker/worker.js";

function d1(path) {
  const db = new DatabaseSync(path);
  return {
    prepare(sql) {
      let args = [];
      const st = db.prepare(sql);
      const o = {
        bind: (...a) => { args = a; return o; },
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
        run: async () => st.run(...args),
      };
      return o;
    },
  };
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("✗", m)); };
const DB = d1("dist/catalog.sqlite");

const all = await catalog.list(DB, { size: 10 });
ok(all.total > 1000, "전체 상품 수 " + all.total);
ok(all.items.length === 10 && all.items.every((p) => p.cost === undefined), "목록 10개, 원가 없음");

const s = await catalog.list(DB, { q: "선반" });
ok(s.total > 0 && s.items.every((p) => p.name.includes("선반")), "'선반' 검색 " + s.total);
const s2 = await catalog.list(DB, { q: "메탈 선반" });
ok(s2.items.every((p) => p.name.includes("메탈") && p.name.includes("선반")), "두 단어 검색");
ok((await catalog.list(DB, { q: "zzzqqq없는말" })).total === 0, "없는 검색어 0건");

const cats = await catalog.counts(DB);
const cat = Object.keys(cats)[0];
const c = await catalog.list(DB, { cat, sort: "low", size: 20 });
ok(c.items.every((p) => p.category === cat), "카테고리 필터");
ok(c.items.every((p, i, a) => !i || a[i - 1].soldout || a[i - 1].price <= p.price), "낮은가격순");

const id = all.items[0].id;
const it = await catalog.item(DB, id);
ok(it && it.id === id && it.cost === undefined && "detail_html" in it, "상세: 원가 숨김, 상세페이지 포함");
const ord = await catalog.itemsForOrder(DB, [id]);
ok(ord[id] && typeof ord[id].cost === "number", "주문 검증용은 원가 포함");

// 새 상품 넣기 → 검색되기 → 품절 처리
await catalog.upsert(DB, { id: "TEST1", source: "domeme", source_no: "1", name: "테스트용 접이식 캠핑의자", category: cat, price: 12340, cost: 9000 });
ok((await catalog.list(DB, { q: "캠핑의자" })).items.some((p) => p.id === "TEST1"), "새 상품 바로 검색됨");
await catalog.setStock(DB, "TEST1", { soldout: true });
ok((await catalog.item(DB, "TEST1")).soldout === true, "품절 반영");
const r = await catalog.list(DB, { cat, sort: "rec", size: 100 });
ok(r.items.findIndex((p) => p.soldout) === -1 || r.items.slice(r.items.findIndex((p) => p.soldout)).every((p) => p.soldout), "품절은 뒤로");
await DB.prepare("DELETE FROM products WHERE id = 'TEST1'").run();
await DB.prepare("DELETE FROM products_fts WHERE id = 'TEST1'").run();

// 서버 경로
const env = { DB, SHOP: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }), delete: async () => {} } };
const call = async (p) => { const res = await handle(new Request("https://x" + p), env, p.split("?")[0]); return [res.status, await res.json()]; };
let [st, body] = await call("/catalog/list?q=" + encodeURIComponent("선반") + "&size=5");
ok(st === 200 && body.items.length > 0, "GET /catalog/list");
[st, body] = await call("/catalog/item?id=" + encodeURIComponent(id));
ok(st === 200 && body.id === id && body.cost === undefined, "GET /catalog/item 원가 없음");
[st, body] = await call("/catalog/counts");
ok(st === 200 && Object.keys(body).length > 0, "GET /catalog/counts");
[st] = await (async () => { const p = "/catalog/list"; const res = await handle(new Request("https://x" + p), { SHOP: env.SHOP }, p); return [res.status]; })();
ok(st === 503, "DB 없으면 503");

console.log(`catalog: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
