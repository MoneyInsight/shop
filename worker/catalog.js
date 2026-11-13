/**
 * 땡잡았땡 상품 DB (Cloudflare D1 = SQLite) — 수십만~100만 개 상품용
 *  - 상품은 DB에 두고, 목록·검색·상세를 서버가 그때그때 꺼내 줌 (정적 페이지를 미리 만들지 않음)
 *  - 상세페이지는 도매처 이미지 주소만 저장 (이미지를 복사하지 않아 용량이 거의 안 듦)
 *  - 한글 검색: 상품명을 2글자 단위(바이그램)로 쪼개 FTS 색인 → '선반'처럼 붙여 쓴 단어 속 검색도 됨
 *  env.DB 가 없으면(아직 서버 미연결) 기존 products.json 방식으로 동작
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',        -- domeme / ownerclan / 직영 ...
  source_no TEXT NOT NULL DEFAULT '',     -- 도매처 상품번호 (발주용)
  supplier TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  normal_price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,        -- 배송비 포함 원가 (고객에게 절대 내보내지 않음)
  image TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',      -- JSON 배열
  detail_html TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',     -- JSON [{v, add, so}]
  qt TEXT NOT NULL DEFAULT '[]',          -- 수량 할인 개당 가격 [1개,2개,…10개]
  option_name TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  soldout INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,        -- 추천순 (작을수록 위)
  updated TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cat ON products(category, soldout, rank);
CREATE INDEX IF NOT EXISTS idx_price ON products(category, price);
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(id UNINDEXED, terms, tokenize = 'unicode61');
`;

// 검색어/상품명 → 검색용 토큰 (영문·숫자 단어 + 한글 2글자 조각)
export function terms(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^0-9a-z가-힣]+/).filter(Boolean)) {
    if (/[가-힣]/.test(w)) {
      if (w.length === 1) out.add(w);
      for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    } else out.add(w);
  }
  return [...out];
}

const CARD_COLS = "id, name, category, price, normal_price, image, brand, soldout, options, option_name, qt";
const SORTS = { rec: "soldout, rank, id", low: "soldout, price", high: "soldout, price DESC", new: "soldout, updated DESC", name: "soldout, name" };

function card(r) {
  return { id: r.id, name: r.name, category: r.category, price: r.price, normal_price: r.normal_price || r.price, shipping_fee: 0,
    image: r.image, brand: r.brand, soldout: !!r.soldout, options: JSON.parse(r.options || "[]"), option_name: r.option_name, qt: JSON.parse(r.qt || "[]") };
}

// 목록·검색 (페이지 단위)
export async function list(db, { q = "", cat = "", sort = "rec", page = 1, size = 40 } = {}) {
  size = Math.min(100, Math.max(1, +size || 40));
  page = Math.max(1, +page || 1);
  const where = [], args = [];
  let from = "products p";
  const t = terms(q).filter((x) => x.length > 1 || /[0-9a-z]/.test(x)).slice(0, 12);
  if (q && !t.length) return { total: 0, items: [], page, size };
  if (t.length) {
    from = "products_fts f JOIN products p ON p.id = f.id";
    where.push("products_fts MATCH ?");
    args.push(t.map((x) => `"${x.replace(/"/g, "")}"`).join(" AND "));
  }
  if (cat) { where.push("p.category = ?"); args.push(cat); }
  const w = where.length ? " WHERE " + where.join(" AND ") : "";
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM ${from}${w}`).bind(...args).first())?.n || 0;
  const order = (SORTS[sort] || SORTS.rec).replace(/(^|, )(?=\w)/g, "$1p.");
  const rows = (await db.prepare(`SELECT ${CARD_COLS.split(", ").map((c) => "p." + c).join(", ")} FROM ${from}${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...args, size, (page - 1) * size).all()).results || [];
  return { total, items: rows.map(card), page, size };
}

// 상품 하나 (상세용, 원가 제외)
export async function item(db, id) {
  const r = await db.prepare("SELECT * FROM products WHERE id = ?").bind(String(id)).first();
  if (!r) return null;
  const { cost, ...pub } = r;
  return { ...card(r), images: JSON.parse(r.images || "[]"), detail_html: r.detail_html, origin: r.origin, supplier: r.supplier, source: r.source, source_no: r.source_no };
}

// 결제 검증용 (원가 포함, 서버 내부 전용)
export async function itemsForOrder(db, ids) {
  const out = {};
  for (const id of [...new Set(ids.map(String))]) {
    const r = await db.prepare("SELECT id, name, price, options, qt, soldout, source, source_no, supplier, cost FROM products WHERE id = ?").bind(id).first();
    if (r) out[r.id] = { ...r, soldout: !!r.soldout, options: JSON.parse(r.options || "[]"), qt: JSON.parse(r.qt || "[]") };
  }
  return out;
}

export async function counts(db) {
  const rows = (await db.prepare("SELECT category, COUNT(*) AS n FROM products WHERE soldout = 0 GROUP BY category").all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

// 상품 넣기/갱신 (도매처 동기화가 사용). 검색 색인도 함께 갱신
export async function upsert(db, p) {
  await db.prepare(`INSERT INTO products (id, source, source_no, supplier, name, category, price, normal_price, cost, image, images, detail_html, options, qt, option_name, brand, origin, soldout, rank, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source, source_no=excluded.source_no, supplier=excluded.supplier, name=excluded.name, category=excluded.category,
      price=excluded.price, normal_price=excluded.normal_price, cost=excluded.cost, image=excluded.image, images=excluded.images, detail_html=excluded.detail_html,
      options=excluded.options, qt=excluded.qt, option_name=excluded.option_name, brand=excluded.brand, origin=excluded.origin, soldout=excluded.soldout, rank=excluded.rank, updated=excluded.updated`)
    .bind(p.id, p.source || "", p.source_no || "", p.supplier || "", p.name, p.category || "", p.price, p.normal_price || p.price, p.cost || 0,
      p.image || "", JSON.stringify(p.images || []), p.detail_html || "", JSON.stringify(p.options || []), JSON.stringify(p.qt || []), p.option_name || "",
      p.brand || "", p.origin || "", p.soldout ? 1 : 0, p.rank || 0, p.updated || new Date().toISOString()).run();
  await db.prepare("DELETE FROM products_fts WHERE id = ?").bind(p.id).run();
  await db.prepare("INSERT INTO products_fts (id, terms) VALUES (?, ?)").bind(p.id, terms(`${p.name} ${p.brand || ""}`).join(" ")).run();
}

export async function setStock(db, id, { soldout, price, cost } = {}) {
  const sets = [], args = [];
  if (soldout != null) { sets.push("soldout = ?"); args.push(soldout ? 1 : 0); }
  if (price) { sets.push("price = ?", "normal_price = ?", "qt = ?"); args.push(price, price, "[]"); }
  if (cost) { sets.push("cost = ?"); args.push(cost); }
  if (!sets.length) return;
  sets.push("updated = ?"); args.push(new Date().toISOString());
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...args, String(id)).run();
}
