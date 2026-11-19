/**
 * 담Go사Go 상품 DB (Cloudflare D1 = SQLite) — 수십만~100만 개 상품용
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
  updated TEXT NOT NULL DEFAULT '',
  shipping_fee INTEGER NOT NULL DEFAULT 0, -- 손님이 내는 배송비 (0 = 무료)
  sn INTEGER NOT NULL DEFAULT 0,          -- 배송비 단위: 0 = 같은 상품 주문당 1번, N = N개마다
  mq INTEGER NOT NULL DEFAULT 1,          -- 최소 구매 수량
  pk INTEGER NOT NULL DEFAULT 1,          -- 1개 = 도매처 상품 pk개
  w INTEGER NOT NULL DEFAULT 0,           -- 1 = 겨울용품 카테고리에도 보임 (원래 카테고리는 category)
  h TEXT NOT NULL DEFAULT ''              -- 내용 지문 (바뀐 상품만 다시 올리려고)
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

const CARD_COLS = "id, name, category, price, normal_price, image, brand, soldout, options, option_name, qt, shipping_fee, sn, mq, pk";
const SORTS = { rec: "soldout, rank, id", low: "soldout, price", high: "soldout, price DESC", new: "soldout, updated DESC", name: "soldout, name" };

function card(r) {
  return { id: r.id, name: r.name, category: r.category, price: r.price, normal_price: r.normal_price || r.price, shipping_fee: r.shipping_fee || 0, sn: r.sn || 0, mq: r.mq || 1, pk: r.pk || 1,
    image: r.image, brand: r.brand, soldout: !!r.soldout, options: JSON.parse(r.options || "[]"), option_name: r.option_name, qt: JSON.parse(r.qt || "[]") };
}

// 목록·검색 (페이지 단위)
export async function list(db, o = {}) {
  try { return await list0(db, o); }
  catch (e) { if (o.cat === "winter" && /no such column/i.test(String(e))) return list0(db, { ...o, noW: 1 }); throw e; }  // DB에 w 열이 아직 없을 때
}

async function list0(db, { q = "", cat = "", sort = "rec", page = 1, size = 40, free = 0, noW = 0 } = {}) {
  size = Math.min(100, Math.max(1, +size || 40));
  page = Math.max(1, +page || 1);
  const where = ["p.price < 1000000"], args = [];  // 100만원 이상은 판매 안 함 (대표님 2026-11-19)
  let from = "products p";
  const t = terms(q).filter((x) => x.length > 1 || /[0-9a-z]/.test(x)).slice(0, 12);
  if (q && !t.length) return { total: 0, items: [], page, size };
  if (t.length) {  // 검색 색인에 같은 상품이 두 줄 있어도(이름 변경) 한 번만 — IN 으로 중복 제거
    where.push("p.id IN (SELECT id FROM products_fts WHERE products_fts MATCH ?)");
    args.push(t.map((x) => `"${x.replace(/"/g, "")}"`).join(" AND "));
  }
  if (cat === "winter" && !noW) where.push("(p.w = 1 OR p.category = 'winter')");  // 겨울용품: 원래 카테고리 + 겨울용품 양쪽
  else if (cat) { where.push("p.category = ?"); args.push(cat); }
  if (+free) where.push(FREE_WHERE);
  const w = where.length ? " WHERE " + where.join(" AND ") : "";
  // 전체 개수: 무료 DB 하루 읽기 한도를 아끼려고 최대 2,000개까지만 셈 (2,000 이상이면 "2,000+")
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from}${w} LIMIT 2000)`).bind(...args).first())?.n || 0;
  const order = (SORTS[sort] || SORTS.rec).replace(/(^|, )(?=\w)/g, "$1p.");
  const rows = (await db.prepare(`SELECT ${CARD_COLS.split(", ").map((c) => "p." + c).join(", ")} FROM ${from}${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...args, size, (page - 1) * size).all()).results || [];
  return { total, items: rows.map(card), page, size };
}

// 인기 순위 TOP N: 최근 7일 많이 본 상품 먼저, 모자라면 카테고리별 추천 1위로 채움 (한 종류만 몰리지 않게)
export async function popular(db, views = {}, n = 10, pin = []) {
  const out = [], seen = new Set();
  for (const id of pin) {  // 관리자가 고정한 상품 (맨 앞)
    const r = await db.prepare(`SELECT ${CARD_COLS} FROM products WHERE id = ? AND soldout = 0 AND price < 1000000`).bind(id).first().catch(() => null);
    if (r && r.image && !seen.has(r.id)) { out.push({ ...card(r), pinned: true }); seen.add(r.id); }
  }
  const ids = Object.entries(views).sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => !seen.has(id)).slice(0, 40);
  for (const id of ids) {
    if (out.length >= n) break;
    const r = await db.prepare(`SELECT ${CARD_COLS} FROM products WHERE id = ? AND soldout = 0 AND price < 1000000`).bind(id).first();
    if (r && r.image) { out.push({ ...card(r), views: views[id] }); seen.add(r.id); }
  }
  const cats = ["winter", "living", "kitchen", "fashion", "digital", "bath", "office", "season", "sleep", "beauty", "furniture", "leisure", "car", "pet", "tools", "kids"];
  for (let round = 0; out.length < n && round < 3; round++) {
    for (const c of cats) {
      if (out.length >= n) break;
      const w = c === "winter" ? "(w = 1 OR category = 'winter')" : "category = ?";
      const st = db.prepare(`SELECT ${CARD_COLS} FROM products WHERE ${w} AND soldout = 0 AND price < 1000000 AND image LIKE 'http%' ORDER BY rank LIMIT 1 OFFSET ${round * 7}`);
      const r = await (c === "winter" ? st : st.bind(c)).first().catch(() => null);
      if (r && !seen.has(r.id)) { out.push(card(r)); seen.add(r.id); }
    }
  }
  return out.map((x, i) => ({ ...x, rank: i + 1 }));
}

// 상품 하나 (상세용, 원가 제외)
export async function item(db, id) {
  const r = await db.prepare("SELECT * FROM products WHERE id = ?").bind(String(id)).first();
  if (!r || Number(r.price) >= 1000000) return null;
  const { cost, ...pub } = r;
  return { ...card(r), images: JSON.parse(r.images || "[]"), detail_html: r.detail_html, origin: r.origin, supplier: r.supplier, source: r.source, source_no: r.source_no };
}

// 결제 검증용 (원가 포함, 서버 내부 전용)
export async function itemsForOrder(db, ids) {
  const out = {};
  for (const id of [...new Set(ids.map(String))]) {
    const r = await db.prepare("SELECT id, name, price, options, qt, soldout, source, source_no, supplier, cost, shipping_fee, sn, mq, pk FROM products WHERE id = ?").bind(id).first();
    if (r && Number(r.price) < 1000000) out[r.id] = { ...r, soldout: !!r.soldout, options: JSON.parse(r.options || "[]"), qt: JSON.parse(r.qt || "[]") };
  }
  return out;
}

// 무료배송만 보기 등에 쓰는 목록 조건
export const FREE_WHERE = "p.shipping_fee = 0";

export async function counts(db) {
  const rows = (await db.prepare("SELECT category, COUNT(*) AS n FROM products WHERE soldout = 0 GROUP BY category").all()).results || [];
  const free = await db.prepare("SELECT COUNT(*) AS n FROM products WHERE soldout = 0 AND shipping_fee = 0").first();
  const out = { ...Object.fromEntries(rows.map((r) => [r.category, r.n])), _free: (free && free.n) || 0 };
  try { const w = await db.prepare("SELECT COUNT(*) AS n FROM products WHERE soldout = 0 AND (w = 1 OR category = 'winter')").first(); out.winter = (w && w.n) || 0; } catch (e) {}
  return out;
}

// 상품 넣기/갱신 (도매처 동기화가 사용). 검색 색인도 함께 갱신
export async function upsert(db, p) {
  await db.prepare(`INSERT INTO products (id, source, source_no, supplier, name, category, price, normal_price, cost, image, images, detail_html, options, qt, option_name, brand, origin, soldout, rank, updated, shipping_fee, sn, mq, pk)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source, source_no=excluded.source_no, supplier=excluded.supplier, name=excluded.name, category=excluded.category,
      price=excluded.price, normal_price=excluded.normal_price, cost=excluded.cost, image=excluded.image, images=excluded.images, detail_html=excluded.detail_html,
      options=excluded.options, qt=excluded.qt, option_name=excluded.option_name, brand=excluded.brand, origin=excluded.origin, soldout=excluded.soldout, rank=excluded.rank, updated=excluded.updated,
      shipping_fee=excluded.shipping_fee, sn=excluded.sn, mq=excluded.mq, pk=excluded.pk`)
    .bind(p.id, p.source || "", p.source_no || "", p.supplier || "", p.name, p.category || "", p.price, p.normal_price || p.price, p.cost || 0,
      p.image || "", JSON.stringify(p.images || []), p.detail_html || "", JSON.stringify(p.options || []), JSON.stringify(p.qt || []), p.option_name || "",
      p.brand || "", p.origin || "", p.soldout ? 1 : 0, p.rank || 0, p.updated || new Date().toISOString(),
      +p.shipping_fee || 0, +p.sn || 0, +p.mq || 1, +p.pk || 1).run();
  // 검색 색인은 id로 지우면 색인 전체를 훑어(읽기 한도 소모) 지우지 않고 추가만 — 목록은 IN 으로 중복 제거
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
