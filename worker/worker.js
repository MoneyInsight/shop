/**
 * 쇼핑몰 서버 (Cloudflare Workers, 무료)
 *  - POST /confirm                 결제 승인 (금액 위변조 검증 후 토스페이먼츠 승인) + 주문 저장
 *  - POST /seller/apply            공급사 입점 신청
 *  - POST /seller/product          공급사 상품 등록 요청 (입점코드 필요)
 *  - POST /admin/list              관리자: 신청·대기상품·주문 목록
 *  - POST /admin/approve-seller    관리자: 입점 승인 → 입점코드 발급
 *  - POST /admin/approve-product   관리자: 상품 승인 → 깃허브 products.csv에 추가 → 자동 재배포
 *  - POST /admin/reject-product    관리자: 상품 반려
 *
 * 환경변수(Secrets): TOSS_SECRET_KEY, ADMIN_PASSWORD, GITHUB_TOKEN
 * 환경변수(Vars):    GITHUB_REPO(예: myid/shop), SITE_URL, MARGIN_RATE(0.07), MIN_MARGIN(0)
 * KV 바인딩:         SHOP
 * 공급가는 이 서버(KV)에만 저장되고 공개 사이트에는 나가지 않습니다.
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
const fail = (message, status = 400) => json({ message }, status);

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const csvCell = (v) => { const s = String(v ?? "").replace(/\r?\n/g, "|"); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const rid = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");

async function kvList(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.SHOP.list({ prefix, cursor });
    for (const k of r.keys) { const v = await env.SHOP.get(k.name, "json"); if (v) out.push(v); }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

// ---------- 깃허브 ----------
async function gh(env, path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "shop-worker", Accept: "application/vnd.github+json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return r.json();
}
async function ghPut(env, path, contentB64, message, sha) {
  return gh(env, `contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: contentB64, ...(sha ? { sha } : {}) }) });
}

// ---------- 가격 ----------
// 판매가 = 원가(상품+배송비) × (1 + 공급사 7% + 플랫폼 3%) = 원가 × 1.10 (10원 단위 올림)
// 공급사 정산금 = 원가 × 1.07 − 카드수수료(판매가 × 3.4%)
const priceFromCost = (env, cost) =>
  Math.ceil(cost * (1 + Number(env.SUPPLIER_MARGIN || 0.07) + Number(env.MARGIN_RATE || 0.03)) / 10) * 10;
const settleFromCost = (env, cost) =>
  Math.floor(cost * (1 + Number(env.SUPPLIER_MARGIN || 0.07)) - priceFromCost(env, cost) * Number(env.CARD_FEE || 0.034));
function supplyFromCost(env, cost) { return settleFromCost(env, cost); }
function suggestPrice(env, supply) {
  const rate = Number(env.MARGIN_RATE || 0.07), min = Number(env.MIN_MARGIN || 0);
  const p = Math.max(supply * (1 + rate), supply + min);
  return Math.ceil(p / 10) * 10; // 10원 단위 올림
}

// ---------- 결제 승인 ----------
async function confirm(req, env) {
  const { paymentKey, orderId, amount, items, customer } = await req.json();
  if (!paymentKey || !orderId || !Array.isArray(items) || !items.length) return fail("잘못된 요청이에요.");
  if (await env.SHOP.get("order:" + orderId)) return fail("이미 처리된 주문이에요.");

  // 사이트의 실제 가격으로 금액 다시 계산 (화면 금액 조작 방지)
  const products = await (await fetch(env.SITE_URL.replace(/\/$/, "") + "/products.json", { cf: { cacheTtl: 0 } })).json();
  const map = Object.fromEntries(products.map((p) => [p.id, p]));
  let subtotal = 0, shipping = 0;
  const lines = [];
  for (const it of items) {
    const p = map[it.id];
    const qty = Math.max(1, Math.min(99, parseInt(it.qty) || 1));
    if (!p) return fail("판매하지 않는 상품이 포함되어 있어요.");
    subtotal += p.price * qty; shipping += p.shipping_fee || 0;
    const sup = (await env.SHOP.get("supply:" + p.id, "json")) || { supplier: p.supplier || "직영", supply_price: 0 };
    lines.push({ id: p.id, name: p.name, qty, price: p.price, supplier: sup.supplier, supply_price: sup.supply_price });
  }
  const free = Number(env.FREE_SHIPPING_OVER || 0);
  if (free && subtotal >= free) shipping = 0;
  if (subtotal + shipping !== Number(amount)) return fail("결제 금액이 상품 금액과 달라요. 다시 주문해 주세요.");

  const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.TOSS_SECRET_KEY + ":"), "Content-Type": "application/json" },
    body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
  });
  const pay = await r.json();
  if (!r.ok) return fail(pay.message || "결제 승인 실패", r.status);

  const order = { orderId, amount: Number(amount), lines, customer, method: pay.method, paymentKey, paidAt: new Date().toISOString(), status: "결제완료" };
  await env.SHOP.put("order:" + orderId, JSON.stringify(order));
  return json({ ok: true, orderId });
}

// ---------- 공급사 ----------
async function sellerApply(req, env) {
  const d = await req.json();
  for (const k of ["company", "biz_no", "manager", "phone"]) if (!d[k]) return fail("회사명·사업자번호·담당자·연락처는 꼭 입력해 주세요.");
  const id = "app_" + Date.now();
  const app = { id, company: d.company, biz_no: d.biz_no, manager: d.manager, phone: d.phone, email: d.email || "", items: d.items || "", code: "", createdAt: new Date().toISOString() };
  await env.SHOP.put("app:" + id, JSON.stringify(app));
  return json({ message: "입점 신청이 접수되었어요. 승인되면 연락드릴게요." });
}

async function sellerProduct(req, env) {
  const d = await req.json();
  const seller = d.code && (await env.SHOP.get("seller:" + d.code.toUpperCase(), "json"));
  if (!seller) return fail("입점코드가 올바르지 않아요.", 403);
  const cost = parseInt(d.cost);
  if (!d.name || !cost) return fail("상품명과 원가는 꼭 입력해 주세요.");
  const supply = supplyFromCost(env, cost);
  if (!d.image) return fail("대표 이미지를 올려 주세요.");
  const id = "req_" + Date.now();
  const item = {
    id, supplier: seller.company, seller_code: seller.code,
    name: d.name.slice(0, 80), category: d.category, cost, supply_price: supply,
    shipping_fee: 0, /* 무조건 무료배송 */ normal_price: parseInt(d.normal_price) || 0,
    brand: d.brand || "", maker: d.maker || "", origin: d.origin || "",
    summary: (d.summary || "").slice(0, 80), description: (d.description || "").slice(0, 3000),
    image: d.image, image_name: d.image_name || "image.jpg",
    suggested_price: priceFromCost(env, cost), createdAt: new Date().toISOString(),
  };
  await env.SHOP.put("pending:" + id, JSON.stringify(item));
  return json({ message: "상품 등록 요청이 접수되었어요. 검수 후 판매가 시작돼요." });
}

// ---------- 관리자 ----------
async function adminList(env) {
  const apps = (await kvList(env, "app:")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = (await kvList(env, "pending:")).map((p) => ({ ...p, image_url: p.image, image: undefined }));
  const orders = (await kvList(env, "order:")).sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 200);
  return json({ apps, pending, orders });
}

async function approveSeller(req, env) {
  const { id } = await req.json();
  const app = await env.SHOP.get("app:" + id, "json");
  if (!app) return fail("신청을 찾을 수 없어요.");
  app.code = rid(8);
  await env.SHOP.put("seller:" + app.code, JSON.stringify({ code: app.code, company: app.company, phone: app.phone, email: app.email }));
  await env.SHOP.put("app:" + id, JSON.stringify(app));
  return json({ ok: true, code: app.code });
}

async function approveProduct(req, env) {
  const { id, price } = await req.json();
  const p = await env.SHOP.get("pending:" + id, "json");
  if (!p) return fail("요청을 찾을 수 없어요.");
  const salePrice = parseInt(price) || p.suggested_price;
  if (salePrice <= p.supply_price) return fail("판매가가 공급사 정산금보다 낮아요.");

  const nextId = String(parseInt((await env.SHOP.get("next_id")) || "2001"));
  await env.SHOP.put("next_id", String(+nextId + 1));

  // 1) 이미지 업로드
  const m = p.image.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return fail("이미지 형식이 올바르지 않아요.");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const imgPath = `uploads/p${nextId}.${ext}`;
  await ghPut(env, imgPath, m[2], `상품 이미지 추가 ${nextId}`);

  // 2) products.csv에 한 줄 추가
  const file = await gh(env, "contents/data/products.csv");
  let csv = b64decode(file.content);
  if (!csv.endsWith("\n")) csv += "\n";
  const normal = Math.max(p.normal_price, salePrice);
  const row = [nextId, p.name, p.category, salePrice, normal, p.shipping_fee, imgPath, p.brand, p.maker, p.origin, "", "NEW",
    p.summary, p.description.split(/\r?\n/).filter(Boolean).join("|"), p.supplier, "판매중"].map(csvCell).join(",");
  await ghPut(env, "data/products.csv", b64encode(csv + row + "\n"), `상품 승인: ${p.name}`, file.sha);

  await env.SHOP.put("supply:" + nextId, JSON.stringify({ supplier: p.supplier, seller_code: p.seller_code, supply_price: p.supply_price }));
  await env.SHOP.delete("pending:" + id);
  return json({ ok: true, id: nextId });
}

async function rejectProduct(req, env) {
  const { id } = await req.json();
  await env.SHOP.delete("pending:" + id);
  return json({ ok: true });
}

/** 공통 처리기: Cloudflare·Netlify 둘 다 사용 */
export async function handle(req, env, path) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("Not found", 404);
  path = path || new URL(req.url).pathname;
  try {
    if (path === "/confirm") return await confirm(req, env);
    if (path === "/seller/apply") return await sellerApply(req, env);
    if (path === "/seller/product") return await sellerProduct(req, env);
    if (path.startsWith("/admin/")) {
      if (!env.ADMIN_PASSWORD || (req.headers.get("Authorization") || "") !== "Bearer " + env.ADMIN_PASSWORD) return fail("비밀번호가 틀렸어요.", 401);
      if (path === "/admin/list") return await adminList(env);
      if (path === "/admin/approve-seller") return await approveSeller(req, env);
      if (path === "/admin/approve-product") return await approveProduct(req, env);
      if (path === "/admin/reject-product") return await rejectProduct(req, env);
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail("서버 오류: " + e.message, 500);
  }
}

export default { fetch: (req, env) => handle(req, env) };
