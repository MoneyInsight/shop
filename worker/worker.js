/**
 * 쇼핑몰 서버 (Cloudflare Workers, 무료)
 *  - POST /confirm                 결제 승인 (금액 위변조 검증 후 토스페이먼츠 승인) + 주문 저장
 *  - POST /seller/apply            공급사 입점 신청
 *  - POST /seller/product          공급사 상품 등록 요청 (입점코드 필요)
 *  - POST /admin/list              관리자: 신청·대기상품·주문 목록
 *  - POST /admin/approve-seller    관리자: 입점 승인 → 입점코드 발급
 *  - POST /admin/approve-product   관리자: 상품 승인 → 깃허브 products.csv에 추가 → 자동 재배포
 *  - POST /admin/reject-product    관리자: 상품 반려
 *  - POST /offer/add · /offer/check            고객: 대량 구매(3개+) 가격 제안(최대 3%) · 결과 확인
 *  - POST /seller/offers · /seller/offer-reply 공급사: 입점코드로 제안 확인·수락/거절
 *  - POST /admin/offer-reply                   관리자: 직영 상품 제안 수락/거절
 *
 * 환경변수(Secrets): TOSS_SECRET_KEY, ADMIN_PASSWORD, GITHUB_TOKEN
 * 환경변수(Vars):    GITHUB_REPO(예: myid/shop), SITE_URL, MARGIN_RATE(0.07), MIN_MARGIN(0)
 * KV 바인딩:         SHOP
 * 공급가는 이 서버(KV)에만 저장되고 공개 사이트에는 나가지 않습니다.
 */
import * as catalog from "./catalog.js";
import * as auth from "./auth.js";
import * as tracking from "./track.js";
import * as stats from "./stats.js";
import { regionFee } from "./region.js";
import { memberDiscount, DEFAULT as MEMBER_DEFAULT } from "./member.js";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", ...extra } });
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
// 판매가 = 오픈마켓 판매가 (일괄 할인 없음 — 대량 구매는 가격 제안으로)
// 플랫폼 몫 = 판매가 × 3%,  카드수수료 = 판매가 × 3.4%
// 공급사 정산금 = 판매가 − 카드수수료 − 플랫폼 몫  (나머지 전부)
const priceFromMarket = (env, market) => Math.ceil(market * (1 - Number(env.CUSTOMER_DISCOUNT || 0)) / 10) * 10;
const settleFromPrice = (env, price) => Math.floor(price * (1 - Number(env.CARD_FEE || 0.034) - Number(env.MARGIN_RATE || 0.03)));
function suggestPrice(env, supply) {
  const rate = Number(env.MARGIN_RATE || 0.07), min = Number(env.MIN_MARGIN || 0);
  const p = Math.max(supply * (1 + rate), supply + min);
  return Math.ceil(p / 10) * 10; // 10원 단위 올림
}

// ---------- 결제 승인 ----------
async function confirm(req, env) {
  const { paymentKey, orderId, amount, items, customer, coupon, token, src } = await req.json();
  if (!paymentKey || !orderId || !Array.isArray(items) || !items.length) return fail("잘못된 요청이에요.");
  if (await env.SHOP.get("order:" + orderId)) return fail("이미 처리된 주문이에요.");

  // 사이트의 실제 가격으로 금액 다시 계산 (화면 금액 조작 방지)
  const map = await productMap(env, items.map((x) => x.id));
  let subtotal = 0, shipping = 0;
  const lines = [], usedOffers = [];
  const qn = {};  // 수량 할인: 같은 상품 수량 합계 (가격 제안 줄 제외)
  for (const it of items) if (!it.offer) qn[it.id] = (qn[it.id] || 0) + Math.max(1, Math.min(99, parseInt(it.qty) || 1));
  for (const it of items) {
    const p = map[it.id];
    const qty = Math.max(1, Math.min(99, parseInt(it.qty) || 1));
    if (!p) return fail("판매하지 않는 상품이 포함되어 있어요.");
    if (p.soldout) return fail(`일시품절된 상품이 있어요: ${p.name}`);
    const qt = Array.isArray(p.qt) ? p.qt : typeof p.qt === "string" ? JSON.parse(p.qt || "[]") : [];
    let unit = qt.length ? Number(qt[Math.min(qn[it.id] || qty, qt.length) - 1]) : Number(p.price), optName = "";
    if (it.opt != null && it.opt !== "") {
      const o = (p.options || [])[Number(it.opt)];
      if (!o) return fail("선택한 옵션을 찾을 수 없어요. 다시 주문해 주세요.");
      if (o.so) return fail(`품절된 옵션이 있어요: ${p.name} [${o.v}]`);
      unit += o.add; optName = o.v;
    } else if ((p.options || []).length) return fail("옵션이 선택되지 않은 상품이 있어요.");
    let offerId = "";
    if (it.offer) {  // 수락된 가격 제안: 제안 내용과 똑같을 때만 제안가 적용
      const of = await env.SHOP.get("offer:" + it.offer, "json");
      const why = offerUsable(of, p.id, it.opt, qty, customer?.phone);
      if (why) return fail(why);
      unit = of.price; offerId = of.id; usedOffers.push(of);
    }
    const listUnit = (qt.length ? Number(qt[0]) : Number(p.price)) + (optName ? p.options[Number(it.opt)].add : 0);
    subtotal += unit * qty; shipping += p.shipping_fee || 0;
    const sup = (await env.SHOP.get("supply:" + p.id, "json")) || { supplier: p.supplier || "직영", supply_price: 0 };
    lines.push({ id: p.id, name: p.name + (optName ? ` [${optName}]` : ""), option: optName, qty, price: unit, list_unit: listUnit, supplier: sup.supplier, supply_price: sup.supply_price, cost: Number(p.cost) || stats.costFromPrice(p.price + (optName ? p.options[Number(it.opt)].add : 0), PRICING(env)), ship_mode: p.sm || "",
      source: p.source || (String(p.id).startsWith("DM") ? "domeme" : /^W/.test(p.id) ? "ownerclan" : ""), source_no: p.source_no || String(p.id).replace(/^DM/, ""), ...(offerId ? { offer: offerId, list_price: p.price + (optName ? (p.options[Number(it.opt)].add) : 0) } : {}) });
  }
  const free = Number(env.FREE_SHIPPING_OVER || 0);
  if (free && subtotal >= free) shipping = 0;
  const remote = regionFee(customer?.zip, customer?.addr);  // 제주·도서산간 추가 배송비
  shipping += remote.fee;
  let discount = 0, couponCode = "";
  if (coupon) {
    const c = await checkCoupon(env, coupon, subtotal);
    if (!c.ok) return fail(c.message);
    discount = c.discount; couponCode = c.code;
  }
  let memberDisc = 0;  // 로그인 회원 추가 즉시 할인
  if (token && (await auth.userFromToken(env, token))) {
    memberDisc = memberDiscount(lines.map((l) => ({ unit: l.price, list: l.list_unit, qty: l.qty })), { ...MEMBER_DEFAULT, rate: +(env.MEMBER_DISCOUNT ?? MEMBER_DEFAULT.rate) });
    discount += memberDisc;
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
  const order = { orderId, amount: Number(amount), subtotal, discount, coupon: couponCode, shipping, remote: remote.label || undefined, member_discount: memberDisc || undefined, lines, customer, method: pay.method, paymentKey, receipt: pay.receipt?.url || "",
    paidAt: now, status: "결제완료", history: [{ status: "결제완료", at: now }] };
  if (src) order.src = stats.sourceOf(src.ref, src.utm);  // 유입경로 (네이버·인스타 등)
  if (token) order.uid = await auth.linkOrder(env, token, orderId);  // 로그인 회원이면 내 주문에 연결
  await env.SHOP.put("order:" + orderId, JSON.stringify(order));
  for (const uo of usedOffers) { uo.status = "주문완료"; uo.orderId = orderId; await env.SHOP.put("offer:" + uo.id, JSON.stringify(uo)); }
  if (couponCode) {
    const c = await env.SHOP.get("coupon:" + couponCode, "json");
    if (c) { c.used = (c.used || 0) + 1; await env.SHOP.put("coupon:" + couponCode, JSON.stringify(c)); }
  }
  const itemName = lines[0].name.slice(0, 40) + (lines.length > 1 ? ` 외 ${lines.length - 1}건` : "");
  await alertCustomer(env, "ORDER_DONE", { phone: customer?.phone, email: customer?.email }, { 고객명: customer?.name, 주문번호: orderId, 상품명: itemName, 결제금액: won0(amount), 링크: siteLink(env, "orders.html?id=" + orderId) });
  await kakao(env, "ADMIN_ORDER", env.ADMIN_PHONE, { 주문번호: orderId, 상품명: itemName, 결제금액: won0(amount), 고객명: customer?.name, 링크: siteLink(env, "admin.html") });
  await notify(env, `🛒 새 주문 ${Number(amount).toLocaleString()}원\n${orderId}\n${lines.map((l) => `- ${l.name.slice(0, 30)} × ${l.qty}`).join("\n")}\n받는 분 ${customer?.name || ""}`);
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


// ---------- 대량 구매 가격 제안 (3개 이상, 최대 3% 할인) ----------
const OFFER_MIN_QTY = 3, OFFER_MAX_RATE = 0.03;
const HOUR = 3600 * 1000;
const offerFloor = (unit) => Math.ceil((unit * (1 - OFFER_MAX_RATE)) / 10) * 10;
const isPast = (iso) => iso && Date.parse(iso) < Date.now();

async function siteProducts(env) {
  return (await fetch(env.SITE_URL.replace(/\/$/, "") + "/products.json", { cf: { cacheTtl: 0 } })).json();
}
// 상품 찾기: 상품 DB(env.DB)가 있으면 DB에서, 없으면 사이트의 products.json에서
async function productMap(env, ids) {
  if (env.DB) {
    const m = await catalog.itemsForOrder(env.DB, ids);
    if (Object.keys(m).length === new Set(ids.map(String)).size) return m;
    const rest = Object.fromEntries((await siteProducts(env)).map((p) => [p.id, p]));  // 아직 DB로 안 옮긴 상품
    return { ...rest, ...m };
  }
  // 상품별 작은 파일(p/상품번호.json)로 확인, 없으면 전체 파일로
  const base = String(env.SITE_URL || "").replace(/\/$/, ""), out = {};
  const uniq = [...new Set(ids.map(String))];
  await Promise.all(uniq.map(async (id) => {
    try { const r = await fetch(`${base}/p/${encodeURIComponent(id)}.json`, { cf: { cacheTtl: 0 } }); if (r.ok) { const p = await r.json(); if (p && p.id) out[p.id] = p; } } catch (e) {}
  }));
  if (Object.keys(out).length === uniq.length) return out;
  return { ...Object.fromEntries((await siteProducts(env)).map((p) => [p.id, p])), ...out };
}

// 만료 처리 반영: 응답 대기 48시간, 수락 후 결제 72시간
function offerState(of) {
  if (of.status === "대기" && isPast(of.expiresAt)) of.status = "기간만료";
  if (of.status === "수락" && isPast(of.payBy)) of.status = "기간만료";
  return of;
}
function offerUsable(of, pid, opt, qty, phone) {
  if (!of) return "가격 제안을 찾을 수 없어요.";
  offerState(of);
  if (of.status === "주문완료") return "이미 주문에 사용한 가격 제안이에요.";
  if (of.status !== "수락") return "아직 수락되지 않았거나 기간이 지난 가격 제안이에요.";
  const o = opt == null || opt === "" ? null : Number(opt);
  if (String(of.product_id) !== String(pid) || (of.opt ?? null) !== o || of.qty !== qty) return "가격 제안과 상품·옵션·수량이 달라요. 제안 내역에서 다시 주문해 주세요.";
  if (digits(phone) !== of.phone) return "가격 제안을 보낸 연락처로 주문해 주세요.";
  return "";
}
const publicOffer = (of) => ({
  id: of.id, product_id: of.product_id, product_name: of.product_name, opt: of.opt ?? null, opt_name: of.opt_name || "", qty: of.qty,
  unit: of.unit, price: of.price, status: of.status, note: of.note || "", createdAt: of.createdAt, expiresAt: of.expiresAt, payBy: of.payBy || "", orderId: of.orderId || "",
});

async function offerAdd(req, env) {
  const d = await req.json();
  const p = (await productMap(env, [d.product_id]))[String(d.product_id)];
  if (!p) return fail("판매하지 않는 상품이에요.");
  if (p.soldout) return fail("일시품절된 상품이라 지금은 제안할 수 없어요.");
  let unit = p.price, optName = "", opt = null;
  if ((p.options || []).length) {
    if (d.opt == null || d.opt === "") return fail("옵션을 선택해 주세요.");
    const o = p.options[Number(d.opt)];
    if (!o) return fail("옵션을 찾을 수 없어요.");
    opt = Number(d.opt); unit += o.add; optName = o.v;
  }
  const qty = parseInt(d.qty) || 0;
  if (qty < OFFER_MIN_QTY || qty > 999) return fail(`가격 제안은 ${OFFER_MIN_QTY}개 이상 구매할 때 할 수 있어요.`);
  const price = parseInt(d.price) || 0, floor = offerFloor(unit);
  if (price >= unit) return fail("제안 가격은 판매가보다 낮아야 해요.");
  if (price < floor) return fail(`개당 ${floor.toLocaleString()}원(최대 3% 할인)까지 제안할 수 있어요.`);
  const name = clip(d.name, 20), phone = digits(d.phone);
  if (!name || phone.length < 10) return fail("이름과 연락처를 정확히 입력해 주세요.");
  // 같은 연락처로 같은 상품에 대기 중인 제안이 있으면 막기
  const mine = (await kvList(env, "offer:")).filter((x) => x.phone === phone && offerState(x).status === "대기");
  if (mine.some((x) => String(x.product_id) === String(p.id))) return fail("이 상품에 이미 답변을 기다리는 제안이 있어요.");
  if (mine.length >= 5) return fail("답변 대기 중인 제안이 너무 많아요. 답변을 받은 뒤 다시 제안해 주세요.");
  const sup = (await env.SHOP.get("supply:" + p.id, "json")) || {};
  const now = Date.now(), id = "OF" + rid(7);
  const of = { id, key: "offer:" + id, product_id: String(p.id), product_name: p.name, opt, opt_name: optName, qty, unit, price,
    name, phone, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || "") ? String(d.email).slice(0, 80) : "", memo: clip(d.memo, 200), supplier: sup.supplier || p.supplier || "직영", seller_code: sup.seller_code || "",
    status: "대기", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 48 * HOUR).toISOString() };
  await env.SHOP.put(of.key, JSON.stringify(of));
  const sellerRec = of.seller_code ? await env.SHOP.get("seller:" + of.seller_code, "json") : null;
  await kakao(env, "OFFER_NEW", sellerRec ? sellerRec.phone : env.ADMIN_PHONE, { 상품명: (p.name + (optName ? ` [${optName}]` : "")).slice(0, 60), 수량: qty,
    판매가: won0(unit), 제안가: won0(price), 제안번호: id, 기한: kst(of.expiresAt), 링크: siteLink(env, sellerRec ? "seller.html#offer-seller" : "admin.html") });
  await notify(env, `🤝 가격 제안 ${id} [${of.supplier}]\n${p.name}${optName ? ` [${optName}]` : ""} × ${qty}\n개당 ${unit.toLocaleString()}원 → ${price.toLocaleString()}원 제안`);
  return json({ ok: true, offer: publicOffer(of), message: "가격 제안을 보냈어요. 판매자가 수락하면 제안 가격으로 주문할 수 있어요. (답변 대기 48시간)" });
}

async function offerCheck(req, env) {
  const { ids, phone } = await req.json();
  const p = digits(phone), out = [];
  for (const id of (Array.isArray(ids) ? ids : [ids]).slice(0, 30)) {
    const of = await env.SHOP.get("offer:" + String(id).trim().toUpperCase(), "json");
    if (of && of.phone === p) out.push(publicOffer(offerState(of)));
  }
  return json({ offers: out });
}

async function replyOffer(env, of, accept, note) {
  offerState(of);
  if (of.status !== "대기") return fail(`이미 처리된 제안이에요. (${of.status})`);
  of.status = accept ? "수락" : "거절";
  of.note = clip(note, 200);
  of.respondedAt = new Date().toISOString();
  if (accept) of.payBy = new Date(Date.now() + 72 * HOUR).toISOString();
  await env.SHOP.put("offer:" + of.id, JSON.stringify(of));
  const nm = (of.product_name + (of.opt_name ? ` [${of.opt_name}]` : "")).slice(0, 60);
  if (accept) await alertCustomer(env, "OFFER_ACCEPT", { phone: of.phone, email: of.email }, { 고객명: of.name, 상품명: nm, 수량: of.qty, 제안가: won0(of.price), 합계: won0(of.price * of.qty), 제안번호: of.id, 기한: kst(of.payBy), 링크: siteLink(env, "orders.html#offers") });
  else await alertCustomer(env, "OFFER_REJECT", { phone: of.phone, email: of.email }, { 고객명: of.name, 상품명: nm, 제안번호: of.id, 사유: of.note || "-", 링크: siteLink(env, "product/" + encodeURIComponent(of.product_id) + ".html") });
  return json({ ok: true, message: accept ? "수락했어요. 고객이 72시간 안에 제안가로 주문할 수 있어요." : "거절했어요." });
}

// 공급사: 입점코드로 자기 상품에 들어온 제안만 보기·답변
async function sellerOffers(req, env) {
  const { code } = await req.json();
  const seller = code && (await env.SHOP.get("seller:" + String(code).toUpperCase(), "json"));
  if (!seller) return fail("입점코드가 올바르지 않아요.", 403);
  const list = (await kvList(env, "offer:")).filter((x) => x.seller_code === seller.code).map(offerState)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  return json({ company: seller.company, offers: list.map((x) => ({ ...publicOffer(x), name: maskName(x.name), memo: x.memo || "" })) });
}
async function sellerOfferReply(req, env) {
  const { code, id, accept, note } = await req.json();
  const seller = code && (await env.SHOP.get("seller:" + String(code).toUpperCase(), "json"));
  if (!seller) return fail("입점코드가 올바르지 않아요.", 403);
  const of = await env.SHOP.get("offer:" + id, "json");
  if (!of || of.seller_code !== seller.code) return fail("제안을 찾을 수 없어요.");
  return replyOffer(env, of, !!accept, note);
}
async function adminOfferReply(req, env) {
  const { id, accept, note } = await req.json();
  const of = await env.SHOP.get("offer:" + id, "json");
  if (!of) return fail("제안을 찾을 수 없어요.");
  return replyOffer(env, of, !!accept, note);
}

// ---------- 카카오 알림톡 (솔라피) ----------
// 키가 없으면 아무것도 보내지 않음 → 지금은 꺼진 상태로 대기, 나중에 환경변수만 넣으면 작동
// 필요한 환경변수: SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_PFID(카카오 채널 ID), SOLAPI_SENDER(등록한 발신번호),
//                ADMIN_PHONE(대표 알림 받을 번호), KAKAO_TPL_<템플릿키>(카카오 승인된 템플릿 ID)
// 템플릿 문구는 아래 TEMPLATES와 카카오에 등록한 문구가 글자 하나까지 같아야 함 (docs/알림톡_템플릿.md)
export const TEMPLATES = {
  OFFER_NEW: { to: "공급사(직영은 대표)", when: "고객이 가격 제안을 보냈을 때", text:
`[땡잡았땡] 새 가격 제안이 도착했습니다.

상품: #{상품명}
수량: #{수량}개
판매가: 개당 #{판매가}원
제안가: 개당 #{제안가}원
제안번호: #{제안번호}

#{기한}까지 수락 또는 거절해 주세요. 기한이 지나면 자동으로 만료됩니다.

응답하기: #{링크}` },
  OFFER_ACCEPT: { to: "고객", when: "가격 제안이 수락됐을 때", text:
`[땡잡았땡] #{고객명}님, 가격 제안이 수락되었습니다.

상품: #{상품명}
수량: #{수량}개
제안가: 개당 #{제안가}원 (합계 #{합계}원)
제안번호: #{제안번호}

#{기한}까지 아래 링크에서 주문하시면 제안 가격이 적용됩니다.

주문하기: #{링크}` },
  OFFER_REJECT: { to: "고객", when: "가격 제안이 거절됐을 때", text:
`[땡잡았땡] #{고객명}님, 보내주신 가격 제안이 이번에는 수락되지 않았습니다.

상품: #{상품명}
제안번호: #{제안번호}
판매자 메시지: #{사유}

판매가로는 언제든 바로 주문하실 수 있습니다.

상품 보기: #{링크}` },
  SOLDOUT_CANCEL: { to: "고객", when: "도매처 품절로 주문을 취소했을 때", text:
`[땡잡았땡] #{고객명}님, 죄송합니다.

주문하신 상품이 공급처에서 갑자기 품절되어 주문을 취소하고 결제 금액 전액을 환불해 드렸습니다.

주문번호: #{주문번호}
상품: #{상품명}
환불금액: #{결제금액}원

카드사에 따라 환불까지 3~7영업일이 걸릴 수 있습니다. 불편을 드려 정말 죄송합니다.

비슷한 상품 보기: #{링크}` },
  ORDER_DONE: { to: "고객", when: "결제가 완료됐을 때", text:
`[땡잡았땡] #{고객명}님, 주문이 완료되었습니다.

주문번호: #{주문번호}
상품: #{상품명}
결제금액: #{결제금액}원

영업일 기준 1~3일 안에 출고되며, 출고되면 다시 알려드립니다.

주문 조회: #{링크}` },
  SHIPPED: { to: "고객", when: "송장번호를 넣고 배송중으로 바꿨을 때", text:
`[땡잡았땡] #{고객명}님, 주문하신 상품이 출고되었습니다.

주문번호: #{주문번호}
택배사: #{택배사}
송장번호: #{송장번호}

배송 조회: #{링크}` },
  REVIEW_ASK: { to: "고객", when: "배송완료로 바꿨을 때 (리뷰 요청)", text:
`[땡잡았땡] #{고객명}님, 상품은 잘 받으셨나요?

주문번호: #{주문번호}
상품: #{상품명}

사용해 보신 느낌을 리뷰로 남겨 주시면 다른 고객님께 큰 도움이 됩니다.

리뷰 쓰기: #{링크}` },
  ADMIN_ORDER: { to: "대표", when: "새 주문이 들어왔을 때", text:
`[땡잡았땡] 새 주문이 들어왔습니다.

주문번호: #{주문번호}
상품: #{상품명}
결제금액: #{결제금액}원
받는 분: #{고객명}

발주와 송장 입력을 진행해 주세요.

관리자: #{링크}` },
};
const kakaoReady = (env) => !!(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && env.SOLAPI_PFID && env.SOLAPI_SENDER);
const siteLink = (env, path) => String(env.SITE_URL || "").replace(/\/$/, "") + "/" + path;

async function kakao(env, key, to, vars) {
  const tpl = TEMPLATES[key], templateId = env["KAKAO_TPL_" + key], phone = digits(to);
  if (!tpl || !templateId || !kakaoReady(env) || phone.length < 10) return false;  // 설정 전에는 조용히 건너뜀
  const variables = Object.fromEntries(Object.entries(vars).map(([k, v]) => ["#{" + k + "}", String(v ?? "-").slice(0, 200) || "-"]));
  const date = new Date().toISOString(), salt = rid(16);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SOLAPI_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(date + salt)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    const r = await fetch("https://api.solapi.com/messages/v4/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${sig}` },
      body: JSON.stringify({ message: { to: phone, from: digits(env.SOLAPI_SENDER), kakaoOptions: { pfId: env.SOLAPI_PFID, templateId, variables, disableSms: env.KAKAO_SMS_FALLBACK !== "1" } } }),
    });
    return r.ok;
  } catch (e) { return false; }  // 알림 실패는 주문·제안 처리에 영향 없음
}
const won0 = (n) => Number(n || 0).toLocaleString("ko-KR");
const kst = (iso) => new Date(new Date(iso).getTime() + 9 * HOUR).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

// ---------- 공통 도우미 ----------
const digits = (s) => String(s || "").replace(/\D/g, "");
const maskName = (s) => { s = String(s || "고객"); return s.length <= 1 ? s + "*" : s[0] + "*".repeat(Math.min(s.length - 1, 2)); };
const clip = (s, n) => String(s || "").replace(/<[^>]*>/g, "").trim().slice(0, n);

// 대표님 알림: 카카오톡 "나와의 채팅"(무료) + 웹훅(선택)
async function notify(env, text) {
  await kakaoMemo(env, text);
  await pushTo(env, "admin", { title: "땡잡았땡 관리자", body: text.slice(0, 180), url: siteLink(env, "admin.html") });
  await email(env, env.ADMIN_EMAIL, "[땡잡았땡 관리자] " + text.split("\n")[0].slice(0, 60), text, siteLink(env, "admin.html"));
  if (!env.NOTIFY_WEBHOOK) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) });
  } catch (e) { /* 알림 실패는 주문에 영향 없음 */ }
}

// ---------- 무료 알림: 웹 푸시 + 이메일 ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async (s) => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 32);
const fill = (text, vars) => text.replace(/#\{([^}]+)\}/g, (_, k) => String(vars[k] ?? "-"));

// VAPID 키: 처음 쓸 때 서버가 스스로 만들어 저장 (사람이 키를 다룰 필요 없음)
async function vapid(env) {
  let v = await env.SHOP.get("vapid:keys", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
    await env.SHOP.put("vapid:keys", JSON.stringify(v));
  }
  return v;
}
async function pushTickle(env, endpoint) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:" + (env.ADMIN_EMAIL || "noreply@example.com") });
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  return fetch(endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", "Content-Length": "0", Authorization: `vapid t=${unsigned}.${sig}, k=${v.pub}` } });
}
// 내용은 서버에 보관하고 빈 푸시만 보냄 → 기기의 서비스워커가 /push/pull 로 내용을 가져와 표시
async function pushTo(env, target, msg) {
  if (!target) return 0;
  const subs = (await kvList(env, "push:")).filter((x) => x.target === target);
  let n = 0;
  for (const sub of subs) {
    await env.SHOP.put(`pmsg:${sub.id}:${Date.now()}${rid(3)}`, JSON.stringify({ ...msg, at: new Date().toISOString() }));
    try {
      const r = await pushTickle(env, sub.endpoint);
      if (r.status === 404 || r.status === 410) await env.SHOP.delete("push:" + sub.id);  // 알림 끈 기기
      else if (r.ok) n++;
    } catch (e) { /* 다음 기기 */ }
  }
  return n;
}
async function pushSubscribe(env, sub, target) {
  const endpoint = sub && sub.endpoint;
  if (!/^https:\/\//.test(endpoint || "")) return fail("알림 구독 정보가 올바르지 않아요.");
  const id = await sha(endpoint);
  await env.SHOP.put("push:" + id, JSON.stringify({ id, endpoint, target, at: new Date().toISOString() }));
  return json({ ok: true, message: "알림이 켜졌어요. 이 기기로 알려드릴게요." });
}
async function pushPull(req, env) {
  const { endpoint } = await req.json();
  if (!endpoint) return json({ messages: [] });
  const id = await sha(endpoint), keys = (await env.SHOP.list({ prefix: `pmsg:${id}:` })).keys;
  const messages = [];
  for (const k of keys.slice(0, 10)) { const m = await env.SHOP.get(k.name, "json"); if (m) messages.push(m); await env.SHOP.delete(k.name); }
  return json({ messages });
}

// 이메일 (Brevo 무료: 하루 300통) — BREVO_API_KEY, MAIL_FROM(인증한 보내는 주소) 있을 때만
async function email(env, to, subject, text, url) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || "")) return false;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const body = esc(text).replace(/\n/g, "<br>");
  const html = `<div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#16171a;line-height:1.7;font-size:15px">
    <div style="font-size:22px;font-weight:700;margin-bottom:18px">땡잡았땡<span style="color:#9a7b4f">.</span></div>${body}
    ${url ? `<p style="margin-top:24px"><a href="${esc(url)}" style="display:inline-block;background:#9a7b4f;color:#fff;text-decoration:none;padding:12px 26px;border-radius:24px;font-weight:600">바로 확인하기</a></p>` : ""}
    <p style="margin-top:28px;color:#868a91;font-size:12px">이 메일은 발신 전용입니다. 문의는 쇼핑몰 고객센터를 이용해 주세요.</p></div>`;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: env.MAIL_FROM_NAME || "땡잡았땡", email: env.MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html, textContent: text + (url ? "\n\n" + url : "") }) });
    return r.ok;
  } catch (e) { return false; }
}

// 고객 알림 한 번에: 웹 푸시(무료) + 이메일(무료) + 알림톡(유료, 키 있을 때만)
const ALERT_TITLE = { OFFER_ACCEPT: "가격 제안이 수락됐어요", OFFER_REJECT: "가격 제안 결과를 알려드려요", ORDER_DONE: "주문이 완료됐어요", SHIPPED: "상품이 출고됐어요", REVIEW_ASK: "상품은 잘 받으셨나요?" };
async function alertCustomer(env, key, who, vars) {
  const text = fill(TEMPLATES[key].text, vars), url = vars.링크;
  await pushTo(env, "p:" + digits(who.phone), { title: ALERT_TITLE[key] || "땡잡았땡", body: text.replace(/^\[땡잡았땡\]\s*/, "").split("\n\n").slice(0, 2).join("\n").slice(0, 180), url });
  const noLink = fill(TEMPLATES[key].text.split("\n\n").slice(0, -1).join("\n\n"), vars);  // 마지막 줄(링크)은 메일 버튼으로
  await email(env, who.email, "[땡잡았땡] " + (ALERT_TITLE[key] || "알림"), noLink, url);
  await kakao(env, key, who.phone, vars);
}

// ---------- 카카오톡 나에게 보내기 (무료) ----------
// 카카오 디벨로퍼스 앱의 REST API 키(KAKAO_REST_KEY, 선택: KAKAO_CLIENT_SECRET)만 있으면,
// 관리자 페이지에서 [카카오톡 연결]을 한 번 눌러 로그인하면 이후 알림이 대표님 카톡 "나와의 채팅"으로 옴
const form = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v))).toString();
async function kakaoToken(env, params) {
  const r = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: form({ client_id: env.KAKAO_REST_KEY, client_secret: env.KAKAO_CLIENT_SECRET, ...params }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.msg || "카카오 인증 실패");
  const old = (await env.SHOP.get("kakao:me", "json")) || {};
  const t = { access: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 - 60000, refresh: d.refresh_token || old.refresh, connectedAt: old.connectedAt || new Date().toISOString() };
  await env.SHOP.put("kakao:me", JSON.stringify(t));
  return t;
}
async function kakaoMemo(env, text, path) {
  if (!env.KAKAO_REST_KEY || !env.SHOP) return false;
  try {
    let t = await env.SHOP.get("kakao:me", "json");
    if (!t || !t.refresh) return false;  // 아직 연결 안 함
    if (!t.access || Date.now() > t.exp) t = await kakaoToken(env, { grant_type: "refresh_token", refresh_token: t.refresh });
    const url = siteLink(env, path || "admin.html");
    const tpl = { object_type: "text", text: String(text).slice(0, 200), link: { web_url: url, mobile_web_url: url }, button_title: "확인하기" };
    const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", { method: "POST",
      headers: { Authorization: "Bearer " + t.access, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body: form({ template_object: JSON.stringify(tpl) }) });
    return r.ok;
  } catch (e) { return false; }
}
async function adminKakaoConnect(req, env) {
  const { code, redirect_uri } = await req.json();
  if (!env.KAKAO_REST_KEY) return fail("서버에 KAKAO_REST_KEY가 아직 없어요.");
  if (!code) return fail("카카오 인증 코드가 없어요.");
  try { await kakaoToken(env, { grant_type: "authorization_code", redirect_uri, code }); }
  catch (e) { return fail("카카오 연결 실패: " + e.message); }
  const sent = await kakaoMemo(env, "✅ 땡잡았땡 알림이 연결되었습니다. 이제 주문·가격 제안·문의가 들어오면 이 채팅으로 알려드려요.");
  return json({ ok: true, message: sent ? "연결됐어요. 카카오톡 ‘나와의 채팅’에 테스트 알림을 보냈어요." : "연결은 됐는데 테스트 알림을 못 보냈어요. 동의항목 ‘카카오톡 메시지 전송’을 확인해 주세요." });
}
async function adminKakaoTest(env) {
  const sent = await kakaoMemo(env, "🔔 땡잡았땡 테스트 알림입니다.");
  return sent ? json({ ok: true, message: "카카오톡 ‘나와의 채팅’으로 보냈어요." }) : fail("보내지 못했어요. 카카오톡 연결을 다시 해 주세요.");
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
  receipt: o.receipt || "", courier: o.courier || "", tracking: o.tracking || "", track: o.track || null, history: o.history || [], claim: o.claim || null,
});

async function findOrder(env, orderId, phone) {
  const o = orderId && (await env.SHOP.get("order:" + String(orderId).trim(), "json"));
  if (!o || !digits(phone) || digits(o.customer?.phone) !== digits(phone)) return null;
  return o;
}

// ---------- 주문 조회 · 취소 · 반품/교환 ----------
// 주문번호를 잊은 비회원: 받는 분 이름 + 연락처로 최근 6개월 주문 찾기
async function orderFind(req, env) {
  const { name, phone } = await req.json();
  if (!clip(name, 20) || digits(phone).length < 10) return fail("받는 분 이름과 연락처를 정확히 입력해 주세요.");
  const since = new Date(Date.now() - 183 * 86400e3).toISOString();
  const list = (await kvList(env, "order:")).filter((o) => o.paidAt >= since && digits(o.customer?.phone) === digits(phone) && String(o.customer?.name || "").trim() === String(name).trim())
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 20);
  if (!list.length) return fail("일치하는 주문이 없어요. 주문할 때 입력한 받는 분 이름과 연락처를 확인해 주세요.", 404);
  return json({ orders: list.map((o) => ({ ...publicOrder(o), phone: o.customer?.phone || "" })) });
}

async function orderLookup(req, env) {
  const { orderId, phone } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  await refreshTracking(env, o);
  return json({ order: publicOrder(o) });
}

// 송장 단계 확인 → 주문에 저장, 배송완료면 상태 자동 변경 + 리뷰 요청
async function refreshTracking(env, o) {
  if (!o.tracking || !["배송중", "배송완료"].includes(o.status)) return false;
  const t = await tracking.track(env, o.courier, o.tracking);
  if (!t) return false;
  o.track = { stage: t.stage, events: t.events, at: new Date(t.at).toISOString() };
  if (t.stage === "배송완료" && o.status === "배송중") { setStatus(o, "배송완료"); await reviewAsk(env, o); }
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  return true;
}
async function reviewAsk(env, o) {
  if (o.reviewAsked || !o.lines?.length) return;
  o.reviewAsked = true;
  const l = o.lines[0];
  await alertCustomer(env, "REVIEW_ASK", { phone: o.customer?.phone, email: o.customer?.email }, { 고객명: o.customer?.name, 주문번호: o.orderId, 상품명: l.name.slice(0, 40) + (o.lines.length > 1 ? ` 외 ${o.lines.length - 1}건` : ""), 링크: siteLink(env, `product/${encodeURIComponent(l.id)}.html?write=1&order=${encodeURIComponent(o.orderId)}#review`) });
}
// 배송중 주문 전체 확인 (관리자 버튼 / 정기 실행)
export async function trackSweep(env) {
  let n = 0, done = 0;
  for (const { name } of (await env.SHOP.list({ prefix: "order:" })).keys) {
    const o = await env.SHOP.get(name, "json");
    if (o?.status !== "배송중" || !o.tracking) continue;
    if (await refreshTracking(env, o)) { n++; if (o.status === "배송완료") done++; }
  }
  return { checked: n, delivered: done };
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
  let st2 = status;
  if (o.tracking && ["결제완료", "상품준비중"].includes(o.status) && (!status || status === o.status)) st2 = "배송중";  // 송장 넣으면 자동으로 배송중
  if (memo != null) o.adminMemo = clip(memo, 500);
  if (st2 && st2 !== o.status) {
    const status = st2;
    if (!ORDER_STATUS.includes(status)) return fail("알 수 없는 상태예요.");
    setStatus(o, status);
    if (status === "배송중" && o.tracking && !o.shipNotified) {
      o.shipNotified = true;
      await alertCustomer(env, "SHIPPED", { phone: o.customer?.phone, email: o.customer?.email }, { 고객명: o.customer?.name, 주문번호: o.orderId, 택배사: o.courier || "-", 송장번호: o.tracking, 링크: siteLink(env, "orders.html?id=" + o.orderId) });
    }
    if (status === "배송완료") await reviewAsk(env, o);  // 리뷰 요청 (웹푸시·메일 무료, 알림톡은 템플릿 있을 때)
    if (o.claim && /완료$/.test(status)) o.claim.status = "완료";
  }
  await env.SHOP.put("order:" + orderId, JSON.stringify(o));
  if (o.status === "배송중") await refreshTracking(env, o);
  return json({ ok: true, status: o.status, track: o.track || null });
}

// 가격 공식 값 (원가 추정용, 서버 설정값으로 바꿀 수 있음)
const PRICING = (env) => ({ net_margin: +(env.NET_MARGIN || 0.12), min_margin_won: +(env.MIN_MARGIN_WON || 1500), card_fee: +(env.CARD_FEE || 0.034), ops_cost_won: +(env.OPS_COST_WON || 300) });

// ---------- 발주 (도매매·오너클랜 등에 주문 넣기) ----------
// 결제완료 주문을 도매처별로 모아 주문서로 만들고, '발주 완료'를 누르면 상품준비중으로. 도매처 송장 파일을 올리면 송장 자동 입력
const SOURCE_NAME = { domeme: "도매매", ownerclan: "오너클랜" };
// 도매처 대량주문 양식 열 (관리자에게만 보냄)
const ORDER_SHEETS = {"domeme": ["상품번호", "옵션", "수량", "수령자명", "휴대전화", "추가연락처", "우편번호", "배송지주소", "배송상세주소", "쇼핑몰명", "전달사항", "배송요청사항"], "ownerclan": ["오너클랜 상품코드", "수량", "배송방식", "받는사람 이름", "받는사람 전화번호", "받는사람 휴대폰", "우편번호", "받는사람 주소", "옵션1", "옵션2", "배송시 요청사항", "판매사 주문관리 메모", "원장주문코드", "개인통관부호", "구매자 생년월일", "마켓 정산가(배송비 포함)"]};
const srcOf = (l) => l.source || (String(l.id).startsWith("DM") ? "domeme" : /^W/.test(l.id) ? "ownerclan" : "");
async function adminPo(env) {
  const groups = {};
  for (const o of await kvList(env, "order:")) {
    if (o.status !== "결제완료") continue;
    o.lines.forEach((l, i) => {
      if (l.po) return;
      const src = srcOf(l) || "direct";
      (groups[src] = groups[src] || { source: src, name: SOURCE_NAME[src] || (src === "direct" ? "직영·공급사" : src), lines: [] }).lines.push({
        orderId: o.orderId, idx: i, paidAt: o.paidAt, product_no: l.source_no || String(l.id).replace(/^DM/, ""), id: l.id, name: l.name, option: l.option || "", qty: l.qty,
        cost: l.cost || 0, amount: l.price * l.qty, ship_mode: l.ship_mode || "", receiver: o.customer?.name || "", phone: o.customer?.phone || "", zip: o.customer?.zip || "",
        addr: o.customer?.addr || "", addr1: o.customer?.addr1 || o.customer?.addr || "", addr2: o.customer?.addr2 || "", memo: o.customer?.memo || "" });
    });
  }
  return { groups: Object.values(groups), sheets: ORDER_SHEETS };
}
async function adminPoDone(req, env) {
  const { items } = await req.json();  // [{orderId, idx}]
  const by = {};
  for (const it of items || []) (by[it.orderId] = by[it.orderId] || []).push(+it.idx);
  let n = 0;
  for (const [id, idxs] of Object.entries(by)) {
    const o = await env.SHOP.get("order:" + id, "json");
    if (!o) continue;
    idxs.forEach((i) => { if (o.lines[i] && !o.lines[i].po) { o.lines[i].po = new Date().toISOString(); n++; } });
    if (o.status === "결제완료" && o.lines.every((l) => l.po)) setStatus(o, "상품준비중", { by: "발주" });
    await env.SHOP.put("order:" + id, JSON.stringify(o));
  }
  return json({ ok: true, message: `${n}건 발주 완료로 표시했어요.` });
}
// 도매처에서 받은 송장 목록(행마다 우리 주문번호·택배사·송장번호) → 주문에 입력, 배송중 + 출고 알림
async function adminTrackingImport(req, env) {
  const { rows } = await req.json();
  const res = { ok: 0, skip: [] };
  for (const r of (rows || []).slice(0, 500)) {
    const o = r.orderId && (await env.SHOP.get("order:" + r.orderId, "json"));
    if (!o || !r.tracking) { res.skip.push(r.orderId || "?"); continue; }
    if (o.tracking && o.tracking.replace(/\D/g, "") === String(r.tracking).replace(/\D/g, "")) continue;
    const fake = new Request("https://x", { method: "POST", body: JSON.stringify({ orderId: o.orderId, courier: r.courier || o.courier || "", tracking: r.tracking }) });
    const out = await (await adminOrderUpdate(fake, env)).json();
    out.ok ? res.ok++ : res.skip.push(o.orderId);
  }
  return json({ ...res, message: `송장 ${res.ok}건 입력${res.skip.length ? `, 못 찾은 주문 ${res.skip.length}건` : ""}` });
}

// 도매처 품절 → 전액 환불 + 손님에게 사과 안내 (웹푸시·메일, 알림톡은 템플릿 있을 때)
async function adminSoldoutCancel(req, env) {
  const { orderId } = await req.json();
  const o = await env.SHOP.get("order:" + orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (!["결제완료", "상품준비중"].includes(o.status)) return fail("출고 전 주문만 품절 취소할 수 있어요.");
  const left = o.amount - (o.refunded || 0);
  const c = await tossCancel(env, o.paymentKey, "상품 품절로 인한 주문 취소");
  if (!c.ok) return fail(c.message);
  o.refunded = (o.refunded || 0) + left;
  setStatus(o, "취소완료", { reason: "도매처 품절" });
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  const l = o.lines[0];
  await alertCustomer(env, "SOLDOUT_CANCEL", { phone: o.customer?.phone, email: o.customer?.email }, { 고객명: o.customer?.name, 주문번호: o.orderId, 상품명: l.name.slice(0, 40) + (o.lines.length > 1 ? ` 외 ${o.lines.length - 1}건` : ""), 결제금액: won0(left), 링크: siteLink(env, "search.html?q=" + encodeURIComponent(l.name.split(" ").slice(0, 2).join(" "))) });
  return json({ ok: true, message: `${won0(left)}원 환불하고 손님께 안내를 보냈어요. 도매처 상품도 품절 처리해 주세요.` });
}

// 백업: 주문·회원·리뷰·문의·쿠폰 전체를 파일로 (관리자가 내려받아 보관)
async function adminExport(env) {
  const data = { exportedAt: new Date().toISOString() };
  for (const k of ["order", "user", "review", "inquiry", "qna", "coupon", "app", "seller"]) data[k] = await kvList(env, k + ":");
  await env.SHOP.put("backup:last", data.exportedAt);
  return new Response(JSON.stringify(data), { headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
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
  const offers = (await kvList(env, "offer:")).map(offerState).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  stats.offers = offers.filter((o) => o.status === "대기").length;
  const km = await env.SHOP.get("kakao:me", "json");
  const kakaoMe = { clientId: env.KAKAO_REST_KEY || "", connected: !!(km && km.refresh), connectedAt: km?.connectedAt || "" };
  const broken = (await env.SHOP.get("broken", "json")) || {};
  const lastBackup = await env.SHOP.get("backup:last");
  return json({ apps, pending, orders, reports, stats, qnas, inquiries, reviews, coupons, offers, kakaoMe, statuses: ORDER_STATUS, broken, lastBackup });
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

// 같은 곳에서 너무 많이 보내면 막기 (스팸·비밀번호 무작위 대입 방지)
const ipOf = (req) => req.headers.get("cf-connecting-ip") || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
async function overLimit(env, key, max, windowSec, bump = true) {
  if (!env.SHOP) return false;
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = parseInt((await env.SHOP.get(k)) || "0");
  if (n >= max) return true;
  if (bump) await env.SHOP.put(k, String(n + 1), { expirationTtl: windowSec * 2 + 60 });
  return false;
}

/** 공통 처리기: Cloudflare·Netlify 둘 다 사용 */
export async function handle(req, env, path) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  path = path || new URL(req.url).pathname;
  if (path === "/health") {  // 상태 점검 (비밀값은 노출하지 않고 설정 여부만)
    const pw = String(env.ADMIN_PASSWORD || "").trim();
    return json({ ok: true, version: "2026-11-13d", login: auth.loginStatus(env), tracking: tracking.trackReady(env) ? "켜짐" : "꺼짐 (택배사 바로가기만)", adminPassword: pw ? `설정됨 (${[...pw].length}자)` : "없음",
      kv: !!env.SHOP, catalog: env.DB ? "상품 DB 연결됨" : "없음 (products.json 사용)", email: env.BREVO_API_KEY && env.MAIL_FROM ? "켜짐" : "꺼짐", kakao: kakaoReady(env) ? `켜짐 (템플릿 ${Object.keys(TEMPLATES).filter((k) => env["KAKAO_TPL_" + k]).length}/${Object.keys(TEMPLATES).length})` : "꺼짐 (키 없음)", toss: env.TOSS_SECRET_KEY ? (String(env.TOSS_SECRET_KEY).startsWith("test_") ? "테스트 키" : "실제 키") : "없음" });
  }
  if (req.method === "GET" && path.startsWith("/catalog/")) {  // 상품 DB 조회 (공개, 1분 캐시)
    if (!env.DB) return fail("상품 DB가 아직 연결되지 않았어요.", 503);
    const u = new URL(req.url).searchParams, cache = { "Cache-Control": "public, max-age=60" };
    try {
      if (path === "/catalog/list") return json(await catalog.list(env.DB, { q: u.get("q") || "", cat: u.get("cat") || "", sort: u.get("sort") || "rec", page: u.get("page"), size: u.get("size") }), 200, cache);
      if (path === "/catalog/item") { const it = await catalog.item(env.DB, u.get("id")); return it ? json(it, 200, cache) : fail("상품을 찾을 수 없어요.", 404); }
      if (path === "/catalog/counts") return json(await catalog.counts(env.DB), 200, cache);
    } catch (e) { return fail("상품 조회 중 오류가 났어요.", 500); }
    return fail("Not found", 404);
  }
  if (req.method === "GET" && path.startsWith("/auth/")) {  // 네이버·카카오·구글 로그인
    if (!env.SHOP) return fail("서버 저장소가 없어요.", 503);
    const base = env.API_URL ? String(env.API_URL).replace(/\/$/, "") : req.url.split("?")[0].slice(0, -path.length);  // API_URL: 서버 공개 주소(선택)
    if (path === "/auth/start") return await auth.start(req, env, base);
    const m = path.match(/^\/auth\/callback\/(naver|kakao|google)$/);
    if (m) return await auth.callback(req, env, base, m[1]);
    return fail("Not found", 404);
  }
  if (req.method !== "POST") return fail("Not found", 404);
  try {
    if (["/inquiry/add", "/qna/add", "/review/add", "/seller/apply", "/seller/product", "/report-price"].includes(path) && (await overLimit(env, "w:" + ipOf(req), 20, 3600)))
      return fail("잠시 후 다시 시도해 주세요. (짧은 시간에 너무 많이 보냈어요)", 429);
    if (path === "/confirm") return await confirm(req, env);
    if (path === "/member/quote") {  // 로그인 회원 추가 할인 금액 (결제 화면 표시용, 계산은 결제 확인과 같음)
      const d = await req.json().catch(() => ({}));
      if (!(await auth.userFromToken(env, d.token))) return json({ discount: 0 });
      const map = await productMap(env, (d.items || []).map((x) => x.id));
      const qn = {};
      for (const it of d.items || []) qn[it.id] = (qn[it.id] || 0) + Math.max(1, Math.min(99, parseInt(it.qty) || 1));
      const lines = [];
      for (const it of d.items || []) {
        const p = map[it.id]; if (!p || p.soldout) continue;
        const qt = Array.isArray(p.qt) ? p.qt : typeof p.qt === "string" ? JSON.parse(p.qt || "[]") : [];
        const add = it.opt != null && it.opt !== "" ? (p.options?.[Number(it.opt)]?.add || 0) : 0;
        const qty = Math.max(1, Math.min(99, parseInt(it.qty) || 1));
        lines.push({ unit: (qt.length ? Number(qt[Math.min(qn[it.id], qt.length) - 1]) : Number(p.price)) + add, list: (qt.length ? Number(qt[0]) : Number(p.price)) + add, qty });
      }
      return json({ discount: memberDiscount(lines, { ...MEMBER_DEFAULT, rate: +(env.MEMBER_DISCOUNT ?? MEMBER_DEFAULT.rate) }) });
    }
    if (path === "/track/broken") {  // 사진이 안 뜨는 상품 신고 (손님 브라우저가 자동으로)
      const d = await req.json().catch(() => ({}));
      const id = String(d.id || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 30);
      if (id) { const b = (await env.SHOP.get("broken", "json")) || {}; if (!b[id]) { b[id] = new Date().toISOString(); await env.SHOP.put("broken", JSON.stringify(b)); } }
      return json({ ok: true });
    }
    if (path === "/track/visit") { await stats.visit(env, await req.json().catch(() => ({}))); return json({ ok: true }); }
    if (path === "/me" || path === "/me/save" || path === "/me/orders" || path === "/auth/logout" || path === "/me/delete") {
      const d = await req.json().catch(() => ({}));
      if (path === "/me/delete") {  // 회원 탈퇴: 회원 정보 삭제 (주문 기록은 전자상거래법상 5년 보관, 회원 연결만 끊음)
        const u = await auth.userFromToken(env, d.token);
        if (!u) return fail("다시 로그인해 주세요.", 401);
        for (const id of u.orders || []) { const o = await env.SHOP.get("order:" + id, "json"); if (o && o.uid) { delete o.uid; await env.SHOP.put("order:" + id, JSON.stringify(o)); } }
        await env.SHOP.delete("user:" + u.uid);
        await auth.logout(env, d);
        return json({ ok: true, message: "탈퇴가 완료됐어요. 회원 정보는 바로 삭제했고, 주문 기록은 법에 따라 5년 보관 후 삭제돼요." });
      }
      if (path === "/auth/logout") return json(await auth.logout(env, d));
      if (path === "/me/orders") {
        const u = await auth.userFromToken(env, d.token);
        if (!u) return fail("다시 로그인해 주세요.", 401);
        const list = [];
        for (const id of (u.orders || []).slice(0, 50)) { const o = await env.SHOP.get("order:" + id, "json"); if (o) list.push({ ...publicOrder(o), phone: o.customer?.phone || "" }); }
        return json({ orders: list });
      }
      const r = path === "/me" ? await auth.me(env, d) : await auth.save(env, d);
      return r ? json(r) : fail("다시 로그인해 주세요.", 401);
    }
    if (path === "/seller/apply") return await sellerApply(req, env);
    if (path === "/seller/product") return await sellerProduct(req, env);
    if (path === "/report-price") return await reportPrice(req, env);
    if (path === "/order/lookup") return await orderLookup(req, env);
    if (path === "/order/find") { if (await overLimit(env, "find:" + ipOf(req), 10, 3600)) return fail("잠시 후 다시 시도해 주세요.", 429); return await orderFind(req, env); }
    if (path === "/order/cancel") return await orderCancel(req, env);
    if (path === "/order/claim") return await orderClaim(req, env);
    if (path === "/order/confirm-receipt") return await orderConfirmReceipt(req, env);
    if (path === "/review/list") return await reviewList(req, env);
    if (path === "/review/add") return await reviewAdd(req, env);
    if (path === "/qna/list") return await qnaList(req, env);
    if (path === "/qna/add") return await qnaAdd(req, env);
    if (path === "/inquiry/add") return await inquiryAdd(req, env);
    if (path === "/coupon/check") return await couponCheck(req, env);
    if (path === "/offer/add") return await offerAdd(req, env);
    if (path === "/push/key") return json({ key: (await vapid(env)).pub });
    if (path === "/push/subscribe") { const d = await req.json(); if (digits(d.phone).length < 10) return fail("연락처를 확인해 주세요."); return await pushSubscribe(env, d.sub, "p:" + digits(d.phone)); }
    if (path === "/push/pull") return await pushPull(req, env);
    if (path === "/offer/check") return await offerCheck(req, env);
    if (path === "/seller/offers") return await sellerOffers(req, env);
    if (path === "/seller/offer-reply") return await sellerOfferReply(req, env);
    if (path.startsWith("/admin/")) {
      const want = String(env.ADMIN_PASSWORD || "").trim();
      if (!want) return fail("서버에 관리자 비밀번호(ADMIN_PASSWORD)가 아직 적용되지 않았어요. Netlify에서 값을 확인하고 다시 배포해 주세요.", 401);
      let got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "").trim();
      try { got = decodeURIComponent(got); } catch (e) { /* 그대로 비교 */ }
      const ip = ipOf(req);
      if (await overLimit(env, "adminfail:" + ip, 5, 900, false)) return fail("비밀번호를 여러 번 틀려서 15분 동안 막았어요. 잠시 후 다시 시도해 주세요.", 429);
      if (got.trim() !== want) { await overLimit(env, "adminfail:" + ip, 5, 900); return fail("비밀번호가 틀렸어요.", 401); }
      if (path === "/admin/list") return await adminList(env);
      if (path === "/admin/kakao-connect") return await adminKakaoConnect(req, env);
      if (path === "/admin/kakao-test") return await adminKakaoTest(env);
      if (path === "/admin/push-subscribe") return await pushSubscribe(env, (await req.json()).sub, "admin");
      if (path === "/admin/push-test") { const n = await pushTo(env, "admin", { title: "땡잡았땡 관리자", body: "🔔 테스트 알림입니다.", url: siteLink(env, "admin.html") }); return n ? json({ ok: true, message: `${n}대 기기로 보냈어요.` }) : fail("알림을 켠 기기가 없어요."); }
      if (path === "/admin/approve-seller") return await approveSeller(req, env);
      if (path === "/admin/approve-product") return await approveProduct(req, env);
      if (path === "/admin/reject-product") return await rejectProduct(req, env);
      if (path === "/admin/close-report") return await closeReport(req, env);
      if (path === "/admin/order-update") return await adminOrderUpdate(req, env);
      if (path === "/admin/order-cancel") return await adminOrderCancel(req, env);
      if (path === "/admin/soldout-cancel") return await adminSoldoutCancel(req, env);
      if (path === "/admin/export") return await adminExport(env);
      if (path === "/admin/track-sweep") return json(await trackSweep(env));
      if (path === "/admin/po") return json(await adminPo(env));
      if (path === "/admin/analytics") { const d = await req.json(); const td = stats.dayKey(); return json(await stats.analytics(env, kvList, { from: d.from || td, to: d.to || td }, PRICING(env))); }
      if (path === "/admin/po-done") return await adminPoDone(req, env);
      if (path === "/admin/tracking-import") return await adminTrackingImport(req, env);
      if (path === "/admin/answer") return await adminAnswer(req, env);
      if (path === "/admin/delete") return await adminDelete(req, env);
      if (path === "/admin/coupon-save") return await adminCouponSave(req, env);
      if (path === "/admin/offer-reply") return await adminOfferReply(req, env);
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail("서버 오류: " + e.message, 500);
  }
}

export default { fetch: (req, env) => handle(req, env), scheduled: (ev, env, ctx) => ctx.waitUntil(trackSweep(env)) };  // 정기 실행: 배송 단계 확인
