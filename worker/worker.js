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
// 기준: 공급사가 입력한 "오픈마켓 판매가"(무료배송 기준)
// 판매가 = 오픈마켓 판매가 × (1 − 고객할인 5%)  (10원 단위 올림)
// 플랫폼 몫 = 판매가 × 3%,  카드수수료 = 판매가 × 3.4%
// 공급사 정산금 = 판매가 − 카드수수료 − 플랫폼 몫  (나머지 전부)
const priceFromMarket = (env, market) => Math.ceil(market * (1 - Number(env.CUSTOMER_DISCOUNT || 0.05)) / 10) * 10;
const settleFromPrice = (env, price) => Math.floor(price * (1 - Number(env.CARD_FEE || 0.034) - Number(env.MARGIN_RATE || 0.03)));
function suggestPrice(env, supply) {
  const rate = Number(env.MARGIN_RATE || 0.07), min = Number(env.MIN_MARGIN || 0);
  const p = Math.max(supply * (1 + rate), supply + min);
  return Math.ceil(p / 10) * 10; // 10원 단위 올림
}

// ---------- 결제 승인 ----------
async function confirm(req, env) {
  const { paymentKey, orderId, amount, items, customer, coupon } = await req.json();
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
    let unit = p.price, optName = "";
    if (it.opt != null && it.opt !== "") {
      const o = (p.options || [])[Number(it.opt)];
      if (!o) return fail("선택한 옵션을 찾을 수 없어요. 다시 주문해 주세요.");
      unit += o.add; optName = o.v;
    } else if ((p.options || []).length) return fail("옵션이 선택되지 않은 상품이 있어요.");
    subtotal += unit * qty; shipping += p.shipping_fee || 0;
    const sup = (await env.SHOP.get("supply:" + p.id, "json")) || { supplier: p.supplier || "직영", supply_price: 0 };
    lines.push({ id: p.id, name: p.name + (optName ? ` [${optName}]` : ""), option: optName, qty, price: unit, supplier: sup.supplier, supply_price: sup.supply_price });
  }
  const free = Number(env.FREE_SHIPPING_OVER || 0);
  if (free && subtotal >= free) shipping = 0;
  let discount = 0, couponCode = "";
  if (coupon) {
    const c = await checkCoupon(env, coupon, subtotal);
    if (!c.ok) return fail(c.message);
    discount = c.discount; couponCode = c.code;
  }
  if (subtotal - discount + shipping !== Number(amount)) return fail("결제 금액이 상품 금액과 달라요. 다시 주문해 주세요.");

  const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.TOSS_SECRET_KEY + ":"), "Content-Type": "application/json" },
    body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
  });
  const pay = await r.json();
  if (!r.ok) return fail(pay.message || "결제 승인 실패", r.status);

  const now = new Date().toISOString();
  const order = { orderId, amount: Number(amount), subtotal, discount, coupon: couponCode, shipping, lines, customer, method: pay.method, paymentKey,
    paidAt: now, status: "결제완료", history: [{ status: "결제완료", at: now }] };
  await env.SHOP.put("order:" + orderId, JSON.stringify(order));
  if (couponCode) {
    const c = await env.SHOP.get("coupon:" + couponCode, "json");
    if (c) { c.used = (c.used || 0) + 1; await env.SHOP.put("coupon:" + couponCode, JSON.stringify(c)); }
  }
  await notify(env, `🛒 새 주문 ${orderId}\n${lines.map((l) => `- ${l.name} × ${l.qty}`).join("\n")}\n결제 ${Number(amount).toLocaleString()}원 / ${customer?.name || ""}`);
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
  const market = parseInt(d.market_price);
  if (!d.name || !market) return fail("상품명과 오픈마켓 판매가는 꼭 입력해 주세요.");
  const price = priceFromMarket(env, market), supply = settleFromPrice(env, price);
  const naverLow = parseInt(d.naver_low);
  if (naverLow && price >= naverLow) return fail(`판매가 ${price.toLocaleString()}원이 네이버 최저가 ${naverLow.toLocaleString()}원보다 비싸서 등록할 수 없어요. 오픈마켓 판매가를 낮춰 주세요.`);
  if (!d.image) return fail("대표 이미지를 올려 주세요.");
  if (!/^data:image\/|^https?:\/\//.test(d.image)) return fail("대표 이미지는 파일 또는 https:// 주소여야 해요.");
  const id = "req_" + Date.now();
  const item = {
    id, supplier: seller.company, seller_code: seller.code,
    name: d.name.slice(0, 80), category: d.category, market_price: market, naver_low: naverLow, supply_price: supply,
    shipping_fee: 0, /* 무조건 무료배송 */ normal_price: parseInt(d.normal_price) || 0,
    brand: d.brand || "", maker: d.maker || "", origin: d.origin || "",
    summary: (d.summary || "").slice(0, 80), description: String(d.description || "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").slice(0, 3000),
    image: d.image, image_name: d.image_name || "image.jpg",
    suggested_price: price, createdAt: new Date().toISOString(),
  };
  await env.SHOP.put("pending:" + id, JSON.stringify(item));
  return json({ message: "상품 등록 요청이 접수되었어요. 검수 후 판매가 시작돼요." });
}

// ---------- 최저가 보상제: 더 싼 곳 신고 ----------
async function reportPrice(req, env) {
  const d = await req.json();
  if (!d.product_id || !d.url || !/^https?:\/\//.test(d.url)) return fail("더 싸게 파는 곳의 주소(https://…)를 넣어 주세요.");
  const price = parseInt(d.price);
  if (!price) return fail("그곳의 가격(무료배송 기준)을 입력해 주세요.");
  const id = "rep_" + Date.now();
  await env.SHOP.put("report:" + id, JSON.stringify({ id, product_id: String(d.product_id).slice(0, 40), product_name: String(d.product_name || "").slice(0, 100),
    our_price: parseInt(d.our_price) || 0, price, url: d.url.slice(0, 500), contact: String(d.contact || "").slice(0, 60), createdAt: new Date().toISOString(), status: "확인 전" }));
  return json({ message: "신고해 주셔서 감사해요! 확인 후 더 싼 게 맞으면 차액을 적립금으로 돌려드릴게요." });
}

async function closeReport(req, env) {
  const { id, status } = await req.json();
  const r = await env.SHOP.get("report:" + id, "json");
  if (!r) return fail("신고를 찾을 수 없어요.");
  r.status = status || "처리완료";
  await env.SHOP.put("report:" + id, JSON.stringify(r));
  return json({ ok: true });
}


// ---------- 공통 도우미 ----------
const digits = (s) => String(s || "").replace(/\D/g, "");
const maskName = (s) => { s = String(s || "고객"); return s.length <= 1 ? s + "*" : s[0] + "*".repeat(Math.min(s.length - 1, 2)); };
const clip = (s, n) => String(s || "").replace(/<[^>]*>/g, "").trim().slice(0, n);

async function notify(env, text) {
  if (!env.NOTIFY_WEBHOOK) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) });
  } catch (e) { /* 알림 실패는 주문에 영향 없음 */ }
}

async function tossCancel(env, paymentKey, reason, amount) {
  const r = await fetch(`https://api.tosspayments.com/v1/payments/${paymentKey}/cancel`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.TOSS_SECRET_KEY + ":"), "Content-Type": "application/json" },
    body: JSON.stringify({ cancelReason: reason || "고객 요청", ...(amount ? { cancelAmount: amount } : {}) }),
  });
  const d = await r.json();
  return r.ok ? { ok: true } : { ok: false, message: d.message || "결제 취소 실패" };
}

function setStatus(order, status, extra) {
  order.status = status;
  order.history = order.history || [];
  order.history.push({ status, at: new Date().toISOString(), ...(extra || {}) });
}

// 고객에게 보여줄 주문 정보 (결제키·공급가 등 내부 정보 제외)
const publicOrder = (o) => ({
  orderId: o.orderId, status: o.status, paidAt: o.paidAt, amount: o.amount, subtotal: o.subtotal, discount: o.discount || 0, shipping: o.shipping || 0, method: o.method,
  lines: o.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })),
  receiver: { name: o.customer?.name, zip: o.customer?.zip, addr: o.customer?.addr, memo: o.customer?.memo },
  courier: o.courier || "", tracking: o.tracking || "", history: o.history || [], claim: o.claim || null,
});

async function findOrder(env, orderId, phone) {
  const o = orderId && (await env.SHOP.get("order:" + String(orderId).trim(), "json"));
  if (!o || !digits(phone) || digits(o.customer?.phone) !== digits(phone)) return null;
  return o;
}

// ---------- 주문 조회 · 취소 · 반품/교환 ----------
async function orderLookup(req, env) {
  const { orderId, phone } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  return json({ order: publicOrder(o) });
}

async function orderCancel(req, env) {
  const { orderId, phone, reason } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  if (o.status === "결제완료") {  // 출고 준비 전: 즉시 자동 취소·환불
    const c = await tossCancel(env, o.paymentKey, clip(reason, 100) || "고객 주문 취소");
    if (!c.ok) return fail(c.message);
    setStatus(o, "취소완료", { reason: clip(reason, 200) });
    await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
    await notify(env, `↩️ 주문 취소(자동 환불) ${o.orderId}`);
    return json({ message: "주문이 취소되었어요. 결제수단에 따라 환불까지 3~7영업일이 걸릴 수 있어요.", order: publicOrder(o) });
  }
  if (o.status === "상품준비중") {
    setStatus(o, "취소요청", { reason: clip(reason, 200) });
    await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
    await notify(env, `⚠️ 취소 요청 ${o.orderId} (상품 준비 중)`);
    return json({ message: "취소 요청이 접수되었어요. 이미 출고된 경우 반품으로 진행될 수 있어요.", order: publicOrder(o) });
  }
  return fail("지금 상태에서는 취소할 수 없어요. 반품/교환 신청을 이용해 주세요.");
}

async function orderClaim(req, env) {
  const { orderId, phone, type, reason } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  if (!["반품", "교환"].includes(type)) return fail("신청 종류를 선택해 주세요.");
  if (!["배송중", "배송완료"].includes(o.status)) return fail("배송이 시작된 주문만 반품/교환을 신청할 수 있어요.");
  if (!clip(reason, 500)) return fail("사유를 입력해 주세요.");
  o.claim = { type, reason: clip(reason, 500), at: new Date().toISOString(), status: "접수" };
  setStatus(o, type + "요청");
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  await notify(env, `📦 ${type} 요청 ${o.orderId}\n${o.claim.reason}`);
  return json({ message: `${type} 신청이 접수되었어요. 확인 후 연락드릴게요.`, order: publicOrder(o) });
}

async function orderConfirmReceipt(req, env) {
  const { orderId, phone } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  if (!["배송중", "배송완료"].includes(o.status)) return fail("배송이 시작된 주문만 구매확정할 수 있어요.");
  setStatus(o, "구매확정");
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  return json({ message: "구매확정 되었어요. 리뷰를 남겨 주시면 큰 도움이 돼요!", order: publicOrder(o) });
}

// ---------- 리뷰 (실제 구매자만) ----------
async function reviewList(req, env) {
  const { product_id } = await req.json();
  const list = (await kvList(env, "review:" + String(product_id) + ":")).sort((a, b) => b.at.localeCompare(a.at));
  const avg = list.length ? Math.round((list.reduce((a, r) => a + r.rating, 0) / list.length) * 10) / 10 : 0;
  return json({ avg, count: list.length, reviews: list.map((r) => ({ name: r.name, rating: r.rating, text: r.text, at: r.at, option: r.option || "" })) });
}

async function reviewAdd(req, env) {
  const { orderId, phone, product_id, rating, text } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요. 구매하신 분만 리뷰를 쓸 수 있어요.", 404);
  const line = o.lines.find((l) => String(l.id) === String(product_id));
  if (!line) return fail("이 주문에는 해당 상품이 없어요.");
  if (!["배송중", "배송완료", "구매확정"].includes(o.status)) return fail("상품이 발송된 뒤에 리뷰를 쓸 수 있어요.");
  const star = Math.max(1, Math.min(5, parseInt(rating) || 0));
  const body = clip(text, 1000);
  if (body.length < 5) return fail("리뷰를 5자 이상 적어 주세요.");
  const key = `review:${product_id}:${o.orderId}`;
  if (await env.SHOP.get(key)) return fail("이미 이 상품의 리뷰를 작성하셨어요.");
  await env.SHOP.put(key, JSON.stringify({ key, product_id: String(product_id), product_name: line.name, orderId: o.orderId, name: maskName(o.customer?.name), rating: star, text: body, option: line.option || "", at: new Date().toISOString() }));
  return json({ message: "리뷰가 등록되었어요. 감사합니다!" });
}

// ---------- 상품 문의 ----------
async function qnaList(req, env) {
  const { product_id } = await req.json();
  const list = (await kvList(env, "qna:" + String(product_id) + ":")).sort((a, b) => b.at.localeCompare(a.at));
  return json({ list: list.map((q) => ({ name: q.name, at: q.at, secret: !!q.secret, text: q.secret ? "" : q.text, answer: q.secret ? (q.answer ? "답변 완료 (비밀글)" : "") : q.answer || "", answered: !!q.answer })) });
}

async function qnaAdd(req, env) {
  const d = await req.json();
  const text = clip(d.text, 1000);
  if (!d.product_id || text.length < 5) return fail("문의 내용을 5자 이상 적어 주세요.");
  const key = `qna:${d.product_id}:${Date.now()}`;
  await env.SHOP.put(key, JSON.stringify({ key, product_id: String(d.product_id), product_name: clip(d.product_name, 100), name: maskName(clip(d.name, 20)), contact: clip(d.contact, 60), text, secret: !!d.secret, answer: "", at: new Date().toISOString() }));
  await notify(env, `❓ 상품 문의: ${clip(d.product_name, 60)}\n${text}`);
  return json({ message: "문의가 등록되었어요. 빠르게 답변드릴게요." });
}

// ---------- 1:1 문의 ----------
async function inquiryAdd(req, env) {
  const d = await req.json();
  const text = clip(d.text, 2000);
  if (!clip(d.name, 20) || !clip(d.contact, 60) || text.length < 5) return fail("이름, 연락처, 문의 내용을 입력해 주세요.");
  const id = "inq_" + Date.now();
  await env.SHOP.put("inquiry:" + id, JSON.stringify({ id, name: clip(d.name, 20), contact: clip(d.contact, 60), type: clip(d.type, 20), orderId: clip(d.orderId, 40), text, answer: "", status: "접수", at: new Date().toISOString() }));
  await notify(env, `💬 1:1 문의 (${clip(d.type, 20)}) ${clip(d.name, 20)} ${clip(d.contact, 60)}\n${text}`);
  return json({ message: "문의가 접수되었어요. 남겨주신 연락처로 답변드릴게요." });
}

// ---------- 쿠폰 ----------
async function checkCoupon(env, code, subtotal) {
  code = String(code || "").trim().toUpperCase();
  const c = code && (await env.SHOP.get("coupon:" + code, "json"));
  if (!c) return { ok: false, message: "사용할 수 없는 쿠폰 코드예요." };
  if (c.expires && new Date(c.expires + "T23:59:59+09:00") < new Date()) return { ok: false, message: "기간이 지난 쿠폰이에요." };
  if (c.max_uses && (c.used || 0) >= c.max_uses) return { ok: false, message: "선착순이 마감된 쿠폰이에요." };
  if (subtotal < (c.min_order || 0)) return { ok: false, message: `${Number(c.min_order).toLocaleString()}원 이상 주문할 때 쓸 수 있어요.` };
  let discount = c.type === "percent" ? Math.floor((subtotal * c.value) / 100 / 10) * 10 : c.value;
  if (c.max_discount) discount = Math.min(discount, c.max_discount);
  discount = Math.min(discount, subtotal - 100 > 0 ? subtotal - 100 : 0);
  return { ok: true, code, discount, name: c.name || code };
}

async function couponCheck(req, env) {
  const { code, subtotal } = await req.json();
  const c = await checkCoupon(env, code, parseInt(subtotal) || 0);
  return c.ok ? json(c) : fail(c.message);
}

// ---------- 관리자: 주문·문의·리뷰·쿠폰 ----------
const ORDER_STATUS = ["결제완료", "상품준비중", "배송중", "배송완료", "구매확정", "취소요청", "취소완료", "반품요청", "반품완료", "교환요청", "교환완료"];

async function adminOrderUpdate(req, env) {
  const { orderId, status, courier, tracking, memo } = await req.json();
  const o = await env.SHOP.get("order:" + orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (courier != null) o.courier = clip(courier, 20);
  if (tracking != null) o.tracking = clip(tracking, 40);
  if (memo != null) o.adminMemo = clip(memo, 500);
  if (status && status !== o.status) {
    if (!ORDER_STATUS.includes(status)) return fail("알 수 없는 상태예요.");
    setStatus(o, status);
    if (o.claim && /완료$/.test(status)) o.claim.status = "완료";
  }
  await env.SHOP.put("order:" + orderId, JSON.stringify(o));
  return json({ ok: true });
}

async function adminOrderCancel(req, env) {
  const { orderId, reason, amount } = await req.json();
  const o = await env.SHOP.get("order:" + orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (o.status === "취소완료" || o.status === "반품완료") return fail("이미 환불된 주문이에요.");
  const amt = parseInt(amount) || 0;
  if (amt && amt > o.amount - (o.refunded || 0)) return fail("환불 금액이 결제 금액보다 커요.");
  const c = await tossCancel(env, o.paymentKey, clip(reason, 100) || "판매자 취소", amt || undefined);
  if (!c.ok) return fail(c.message);
  o.refunded = (o.refunded || 0) + (amt || o.amount - (o.refunded || 0));
  setStatus(o, amt && o.refunded < o.amount ? o.status : (o.status.startsWith("반품") ? "반품완료" : "취소완료"), { refund: amt || "전액", reason: clip(reason, 200) });
  if (o.claim) o.claim.status = "완료";
  await env.SHOP.put("order:" + orderId, JSON.stringify(o));
  return json({ ok: true });
}

async function adminAnswer(req, env) {
  const { key, answer } = await req.json();
  if (!/^(qna|inquiry):/.test(key || "")) return fail("잘못된 요청이에요.");
  const q = await env.SHOP.get(key, "json");
  if (!q) return fail("문의를 찾을 수 없어요.");
  q.answer = clip(answer, 2000); q.answeredAt = new Date().toISOString(); q.status = "답변완료";
  await env.SHOP.put(key, JSON.stringify(q));
  return json({ ok: true });
}

async function adminDelete(req, env) {
  const { key } = await req.json();
  if (!/^(qna|inquiry|review|coupon):/.test(key || "")) return fail("잘못된 요청이에요.");
  await env.SHOP.delete(key);
  return json({ ok: true });
}

async function adminCouponSave(req, env) {
  const d = await req.json();
  const code = String(d.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const value = parseInt(d.value);
  if (code.length < 3 || !value) return fail("쿠폰 코드(영문·숫자 3자 이상)와 할인 값을 입력해 주세요.");
  const type = d.type === "percent" ? "percent" : "amount";
  if (type === "percent" && value > 50) return fail("할인율은 50% 이하로 설정해 주세요.");
  const old = (await env.SHOP.get("coupon:" + code, "json")) || {};
  await env.SHOP.put("coupon:" + code, JSON.stringify({ key: "coupon:" + code, code, name: clip(d.name, 40) || code, type, value, min_order: parseInt(d.min_order) || 0,
    max_discount: parseInt(d.max_discount) || 0, max_uses: parseInt(d.max_uses) || 0, expires: /^\d{4}-\d{2}-\d{2}$/.test(d.expires || "") ? d.expires : "", used: old.used || 0 }));
  return json({ ok: true });
}

// ---------- 관리자 ----------
async function adminList(env) {
  const apps = (await kvList(env, "app:")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = (await kvList(env, "pending:")).map((p) => ({ ...p, image_url: p.image, image: undefined }));
  const orders = (await kvList(env, "order:")).sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 200);
  const reports = (await kvList(env, "report:")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  const all = await kvList(env, "order:");
  const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const today = kst(new Date().toISOString());
  const paid = all.filter((o) => !["취소완료", "반품완료"].includes(o.status));
  const stats = {
    todayOrders: paid.filter((o) => kst(o.paidAt) === today).length,
    todaySales: paid.filter((o) => kst(o.paidAt) === today).reduce((a, o) => a + o.amount, 0),
    monthSales: paid.filter((o) => kst(o.paidAt).slice(0, 7) === today.slice(0, 7)).reduce((a, o) => a + o.amount, 0),
    toShip: all.filter((o) => ["결제완료", "상품준비중"].includes(o.status)).length,
    claims: all.filter((o) => /요청$/.test(o.status)).length,
  };
  const byAt = (a, b) => b.at.localeCompare(a.at);
  const qnas = (await kvList(env, "qna:")).sort(byAt).slice(0, 200);
  const inquiries = (await kvList(env, "inquiry:")).sort(byAt).slice(0, 200).map((q) => ({ ...q, key: "inquiry:" + q.id }));
  const reviews = (await kvList(env, "review:")).sort(byAt).slice(0, 200);
  const coupons = await kvList(env, "coupon:");
  return json({ apps, pending, orders, reports, stats, qnas, inquiries, reviews, coupons, statuses: ORDER_STATUS });
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
  if (p.naver_low && salePrice >= p.naver_low) return fail("판매가가 네이버 최저가보다 비싸요. 더 낮게 설정해 주세요.");
  p.supply_price = settleFromPrice(env, salePrice); // 판매가를 바꿨으면 정산금도 다시 계산

  const nextId = String(parseInt((await env.SHOP.get("next_id")) || "2001"));
  await env.SHOP.put("next_id", String(+nextId + 1));

  // 1) 이미지: 주소면 그대로 쓰고, 파일이면 깃허브에 업로드
  let imgPath = p.image;
  if (!/^https?:\/\//.test(p.image)) {
    const m = p.image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return fail("이미지 형식이 올바르지 않아요.");
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    imgPath = `uploads/p${nextId}.${ext}`;
    await ghPut(env, imgPath, m[2], `상품 이미지 추가 ${nextId}`);
  }

  // 2) products.csv에 한 줄 추가
  const file = await gh(env, "contents/data/products.csv");
  let csv = b64decode(file.content);
  if (!csv.endsWith("\n")) csv += "\n";
  const normal = Math.max(p.normal_price, p.market_price || 0, salePrice);
  const row = [nextId, p.name, p.category, salePrice, normal, p.shipping_fee, imgPath, p.brand, p.maker, p.origin, "", "NEW",
    p.summary, p.description.split(/\r?\n/).filter(Boolean).join("|"), p.supplier, "판매중", p.naver_low || ""].map(csvCell).join(",");
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
  path = path || new URL(req.url).pathname;
  if (path === "/health") {  // 상태 점검 (비밀값은 노출하지 않고 설정 여부만)
    const pw = String(env.ADMIN_PASSWORD || "").trim();
    return json({ ok: true, version: "2026-11-12b", adminPassword: pw ? `설정됨 (${[...pw].length}자)` : "없음",
      kv: !!env.SHOP, toss: env.TOSS_SECRET_KEY ? (String(env.TOSS_SECRET_KEY).startsWith("test_") ? "테스트 키" : "실제 키") : "없음" });
  }
  if (req.method !== "POST") return fail("Not found", 404);
  try {
    if (path === "/confirm") return await confirm(req, env);
    if (path === "/seller/apply") return await sellerApply(req, env);
    if (path === "/seller/product") return await sellerProduct(req, env);
    if (path === "/report-price") return await reportPrice(req, env);
    if (path === "/order/lookup") return await orderLookup(req, env);
    if (path === "/order/cancel") return await orderCancel(req, env);
    if (path === "/order/claim") return await orderClaim(req, env);
    if (path === "/order/confirm-receipt") return await orderConfirmReceipt(req, env);
    if (path === "/review/list") return await reviewList(req, env);
    if (path === "/review/add") return await reviewAdd(req, env);
    if (path === "/qna/list") return await qnaList(req, env);
    if (path === "/qna/add") return await qnaAdd(req, env);
    if (path === "/inquiry/add") return await inquiryAdd(req, env);
    if (path === "/coupon/check") return await couponCheck(req, env);
    if (path.startsWith("/admin/")) {
      const want = String(env.ADMIN_PASSWORD || "").trim();
      if (!want) return fail("서버에 관리자 비밀번호(ADMIN_PASSWORD)가 아직 적용되지 않았어요. Netlify에서 값을 확인하고 다시 배포해 주세요.", 401);
      let got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "").trim();
      try { got = decodeURIComponent(got); } catch (e) { /* 그대로 비교 */ }
      if (got.trim() !== want) return fail("비밀번호가 틀렸어요.", 401);
      if (path === "/admin/list") return await adminList(env);
      if (path === "/admin/approve-seller") return await approveSeller(req, env);
      if (path === "/admin/approve-product") return await approveProduct(req, env);
      if (path === "/admin/reject-product") return await rejectProduct(req, env);
      if (path === "/admin/close-report") return await closeReport(req, env);
      if (path === "/admin/order-update") return await adminOrderUpdate(req, env);
      if (path === "/admin/order-cancel") return await adminOrderCancel(req, env);
      if (path === "/admin/answer") return await adminAnswer(req, env);
      if (path === "/admin/delete") return await adminDelete(req, env);
      if (path === "/admin/coupon-save") return await adminCouponSave(req, env);
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail("서버 오류: " + e.message, 500);
  }
}

export default { fetch: (req, env) => handle(req, env) };
