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
import * as live from "./live.js";
import * as catalog from "./catalog.js";
import * as auth from "./auth.js";
import * as tracking from "./track.js";
import * as stats from "./stats.js";
import { donation as donationOf } from "./stats.js";
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

async function imgAlive(u) {  // 사진이 확실히 지워졌을 때(404·410)만 false — 접속 차단·일시 오류는 살아 있는 것으로 (멀쩡한 상품을 내리지 않게)
  let dead = 0, tries = [...new Set([u.replace(/^http:/, "https:"), u])];
  for (const x of tries) {
    try {
      const r = await fetch(x, { headers: { Range: "bytes=0-2047", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36", Referer: "https://damgosago.com/" } });
      if (r.status === 404 || r.status === 410) { dead++; continue; }
      return true;
    } catch (e) { return true; }
  }
  return dead < tries.length;
}

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

// ---------- 주문 차단 연락처 · 관리자 기록 · 주문 검색 · 고객 ----------
async function isBlocked(env, phone) {
  const b = (await env.SHOP.get("blocklist", "json")) || {};
  return !!b[digits(phone)];
}
async function adminLog(env, path, ip, note) {
  const log = (await env.SHOP.get("adminlog", "json")) || [];
  log.unshift({ at: new Date().toISOString(), path, ip, note: String(note || "").slice(0, 120) });
  await env.SHOP.put("adminlog", JSON.stringify(log.slice(0, 300)));
}
async function adminOrderSearch(req, env) {
  const { q } = await req.json().catch(() => ({}));
  const v = String(q || "").trim().toLowerCase(), dv = digits(v);
  if (v.length < 2) return fail("두 글자 이상 입력해 주세요.");
  const hit = (o) => {
    const c = o.customer || {};
    if (String(o.orderId).toLowerCase().includes(v)) return true;
    if (dv.length >= 4 && digits(c.phone).includes(dv)) return true;
    if (String(c.name || "").toLowerCase().includes(v)) return true;
    if (String(o.tracking || "").includes(v)) return true;
    return (o.lines || []).some((l) => String(l.id).toLowerCase().includes(v) || String(l.source_no || "").includes(v) || String(l.name).toLowerCase().includes(v));
  };
  const list = (await kvList(env, "order:")).filter(hit).sort((a, b) => b.paidAt.localeCompare(a.paidAt)).slice(0, 100);
  return json({ orders: list });
}
async function adminCustomers(env) {
  const by = {};
  for (const o of await kvList(env, "order:")) {
    const ph = digits(o.customer?.phone); if (!ph) continue;
    const c = by[ph] || (by[ph] = { phone: ph, name: o.customer?.name || "", orders: 0, total: 0, cancels: 0, claims: 0, last: "" });
    c.orders++; if (!["취소완료", "반품완료"].includes(o.status)) c.total += o.amount || 0;
    if (/취소/.test(o.status)) c.cancels++; if (/반품|교환/.test(o.status)) c.claims++;
    if (o.paidAt > c.last) { c.last = o.paidAt; c.name = o.customer?.name || c.name; }
  }
  const blocked = (await env.SHOP.get("blocklist", "json")) || {};
  // 가입 회원 (네이버·카카오·구글 간편가입) — 가입 때 이메일·연락처를 못 받았으면 저장한 배송지·주문서에 적은 값으로 채움
  const byUid = {};
  for (const o of await kvList(env, "order:")) if (o.uid && (!byUid[o.uid] || o.paidAt > byUid[o.uid].paidAt)) byUid[o.uid] = o;
  const members = (await kvList(env, "user:")).map((u) => ({ uid: u.uid, provider: u.provider || String(u.uid || "").split(":")[0], name: u.name || "",
    email: u.email || u.addr?.email || byUid[u.uid]?.customer?.email || "", phone: u.phone || u.addr?.phone || byUid[u.uid]?.customer?.phone || "",
    joinedAt: u.joinedAt || "", lastLogin: u.lastLogin || "", orders: (u.orders || []).length })).sort((a, b) => String(b.joinedAt).localeCompare(String(a.joinedAt)));
  return json({ customers: Object.values(by).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 1000), blocked, members });
}
async function adminBlock(req, env) {
  const d = await req.json().catch(() => ({}));
  const ph = digits(d.phone); if (ph.length < 10) return fail("연락처를 정확히 입력해 주세요.");
  const b = (await env.SHOP.get("blocklist", "json")) || {};
  if (d.block) b[ph] = { reason: clip(d.reason, 100), at: new Date().toISOString() }; else delete b[ph];
  await env.SHOP.put("blocklist", JSON.stringify(b));
  return json({ ok: true, message: d.block ? "이 연락처의 주문을 막았어요." : "차단을 풀었어요." });
}
async function adminSiteSave(req, env) {  // 사이트 공지 띠 문구 (빌드 때 반영)
  const d = await req.json().catch(() => ({}));
  const all = (await env.SHOP.get("product_edits", "json")) || { ver: 0, items: {} };
  all.site = { notice: clip(d.notice, 120), notice_link: /^https?:\/\/|^[a-z0-9_\-./]+$/i.test(d.notice_link || "") ? String(d.notice_link).slice(0, 200) : "" };
  all.ver = Date.now();
  await env.SHOP.put("product_edits", JSON.stringify(all));
  return json({ ok: true, message: "저장했어요. 30분 안에 사이트에 반영돼요." });
}

// ---------- SEO 일괄 수정 (상품명·검색 키워드·요약 설명) ----------
// 상품이 많아(150만) 한 값에 다 못 넣음 → 상품코드로 64칸에 나눠 KV "seo:<칸>"에 저장. 사이트 빌드·상품 DB 반영 때 읽어 감
const SEO_B = 64;
const seoBucket = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % SEO_B; };
async function seoUpload(req, env) {
  const d = await req.json().catch(() => ({}));
  const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 5000);
  const by = {};
  let n = 0;
  for (const r of rows) {
    const id = String(r.id || "").replace(/[^0-9A-Za-z_-]/g, "");
    if (!id) continue;
    const e = {};
    if (r.name) e.name = String(r.name).replace(/\s+/g, " ").trim().slice(0, 100);
    if (r.kw) e.kw = String(r.kw).replace(/\s+/g, " ").trim().slice(0, 300);
    if (r.summary) e.summary = String(r.summary).replace(/\s+/g, " ").trim().slice(0, 160);
    if (d.auto && Object.keys(e).length) e.auto = String(r.auto || new Date().toISOString().slice(0, 10)).slice(0, 10);  // 자동 최적화 표시 (손으로 고친 것과 구분)
    (by[seoBucket(id)] ||= {})[id] = Object.keys(e).length ? e : null;
    n++;
  }
  const run = d.auto ? String(d.run || "").replace(/[^0-9a-z]/gi, "").slice(0, 20) : "";
  let skipped = 0;
  for (const [b, items] of Object.entries(by)) {
    const cur = (await env.SHOP.get("seo:" + b, "json")) || {};
    const bak = run ? ((await env.SHOP.get(`seo_bak:${run}:${b}`, "json")) || {}) : null;
    for (const [id, e] of Object.entries(items)) {
      if (d.auto && cur[id] && !cur[id].auto) { skipped++; n--; continue; }  // 관리자가 손으로 고친 건 자동으로 덮지 않음
      if (bak && !(id in bak)) bak[id] = cur[id] || null;  // 되돌리기용 (이번 실행 전 값)
      if (e) cur[id] = e; else delete cur[id];
    }
    await env.SHOP.put("seo:" + b, JSON.stringify(cur));
    if (bak) await env.SHOP.put(`seo_bak:${run}:${b}`, JSON.stringify(bak), { expirationTtl: 60 * 86400 });
  }
  if (run) { const runs = (await env.SHOP.get("seo_runs", "json")) || []; if (!runs.includes(run)) { runs.push(run); await env.SHOP.put("seo_runs", JSON.stringify(runs.slice(-30))); } }
  await env.SHOP.put("seo_ver", String(Date.now()));
  return json({ ok: true, saved: n, skipped, message: `${n.toLocaleString()}개 상품을 저장했어요.` });
}
// ---------- SEO 자동 최적화 (깃허브에서 실행: tools/seo_auto.py) ----------
async function seoAutoReq(req, env) {  // 관리자 → 실행 요청 (30분 안에 깃허브가 가져가 실행)
  const d = await req.json().catch(() => ({}));
  if (d.daily !== undefined) { await env.SHOP.put("seo_auto_daily", d.daily ? "1" : "0"); return json({ ok: true, message: d.daily ? "매일 새벽 자동 최적화를 켰어요." : "매일 자동 최적화를 껐어요." }); }
  const mode = d.mode === "apply" ? "apply" : "preview";
  let scope = String(d.scope || "site");
  if (!/^(site|db|cat:[a-z_]{2,20}|ids:[0-9A-Za-z_,-]{2,4000})$/.test(scope)) return fail("범위가 올바르지 않아요.");
  const limit = Math.min(200000, Math.max(1, parseInt(d.limit) || 20000));
  const r = { id: Date.now().toString(36), mode, scope, limit, at: new Date().toISOString() };
  await env.SHOP.put("seo_auto_req", JSON.stringify(r));
  return json({ ok: true, req: r, message: (mode === "apply" ? "적용" : "미리보기") + " 요청을 받았어요. 30분 안에 시작하고, 끝나면 결과가 여기에 보여요." });
}
async function seoAutoReport(req, env) {  // 깃허브 → 결과 저장
  const d = await req.json().catch(() => ({}));
  const r = { ...d, samples: (d.samples || []).slice(0, 300) };
  await env.SHOP.put("seo_auto_report", JSON.stringify(r));
  const cur = await env.SHOP.get("seo_auto_req", "json");
  if (cur && cur.taken) await env.SHOP.delete("seo_auto_req");
  if (d.mode === "apply" && d.applied) await env.SHOP.put("seo_ver", String(Date.now()));
  return json({ ok: true });
}
async function seoRestore(req, env) {  // 자동 최적화 한 번을 통째로 되돌리기
  const d = await req.json().catch(() => ({}));
  const run = String(d.run || "").replace(/[^0-9a-z]/gi, "");
  if (!run) return fail("되돌릴 실행이 없어요.");
  let n = 0;
  for (let b = 0; b < SEO_B; b++) {
    const bak = await env.SHOP.get(`seo_bak:${run}:${b}`, "json"); if (!bak) continue;
    const cur = (await env.SHOP.get("seo:" + b, "json")) || {};
    for (const [id, old] of Object.entries(bak)) {
      if (cur[id] && !cur[id].auto) continue;  // 그사이 손으로 고친 건 그대로
      if (old) cur[id] = old; else delete cur[id]; n++;
    }
    await env.SHOP.put("seo:" + b, JSON.stringify(cur));
    await env.SHOP.delete(`seo_bak:${run}:${b}`);
  }
  await env.SHOP.put("seo_ver", String(Date.now()));
  const runs = ((await env.SHOP.get("seo_runs", "json")) || []).filter((x) => x !== run); await env.SHOP.put("seo_runs", JSON.stringify(runs));
  return json({ ok: true, message: `${n.toLocaleString()}개 상품의 SEO를 자동 최적화 전으로 되돌렸어요. 30분 안에 사이트에 반영돼요.` });
}
async function catalogExport(req, env) {  // 상품 목록 내려받기 (상품코드 순서로 나눠서)
  if (!env.DB) return fail("상품 DB가 없어요.", 500);
  const d = await req.json().catch(() => ({}));
  const lim = Math.min(20000, Math.max(1, parseInt(d.limit) || 20000)), after = String(d.after || ""), cat = String(d.cat || "");
  const where = ["id > ?"], args = [after];
  if (cat === "winter") where.push("(w = 1 OR category = 'winter')"); else if (cat) { where.push("category = ?"); args.push(cat); }
  const rs = await env.DB.prepare(`SELECT id, name, category, brand, price FROM products WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${lim}`).bind(...args).all().catch(async () =>
    env.DB.prepare(`SELECT id, name, category, brand, price FROM products WHERE ${where.filter((w) => !w.includes("w = 1")).join(" AND ")} ORDER BY id LIMIT ${lim}`).bind(...args).all());
  const rows = rs.results || [];
  const need = new Set(rows.map((r) => seoBucket(r.id))), seo = {};
  await Promise.all([...need].map(async (b) => { seo[b] = (await env.SHOP.get("seo:" + b, "json")) || {}; }));
  return json({ rows: rows.map((r) => { const e = seo[seoBucket(r.id)][r.id] || {}; return [r.id, e.name || r.name, e.kw || "", e.summary || "", r.category, r.price]; }), next: rows.length === lim ? rows[rows.length - 1].id : null });
}

// ---------- 관리자 상품 수정 (이름·가격·카테고리·숨김·품절·소개·표시) ----------
// KV "product_edits"에 저장 → 사이트 빌드 때 반영 (30분마다 확인, 깃허브 토큰이 있으면 바로 다시 배포)
const EDIT_FIELDS = { name: 100, price: 0, category: 30, hidden: 0, soldout: 0, summary: 80, badge: 10 };
async function adminProductBulk(req, env) {  // 상품코드 여러 개 한 번에: 숨김·품절·되돌리기
  const d = await req.json().catch(() => ({}));
  const ids = [...new Set(String(d.ids || "").split(/[\s,]+/).map((x) => x.replace(/[^0-9A-Za-z_-]/g, "")).filter(Boolean))].slice(0, 2000);
  if (!ids.length) return fail("상품코드를 넣어 주세요.");
  const all = (await env.SHOP.get("product_edits", "json")) || { ver: 0, items: {} };
  for (let id of ids) {
    if (/^\d+$/.test(id)) id = "DM" + id;  // 도매매 숫자 번호만 넣어도 됨
    const e = all.items[id] || {};
    if (d.action === "reset") { delete all.items[id]; continue; }
    if (d.action === "hide") e.hidden = true;
    if (d.action === "soldout") e.soldout = true;
    if (d.action === "show") { delete e.hidden; delete e.soldout; }
    e.at = new Date().toISOString();
    if (Object.keys(e).filter((k) => k !== "at").length) all.items[id] = e; else delete all.items[id];
  }
  all.ver = Date.now();
  await env.SHOP.put("product_edits", JSON.stringify(all));
  return json({ ok: true, message: `${ids.length}개 상품에 적용했어요. 30분 안에 사이트에 반영돼요.` });
}
async function adminProductSave(req, env) {
  const d = await req.json().catch(() => ({}));
  const id = String(d.id || "").replace(/[^0-9A-Za-z_-]/g, "");
  if (!id) return fail("상품코드가 없어요.");
  const all = (await env.SHOP.get("product_edits", "json")) || { ver: 0, items: {} };
  const row = env.DB ? await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first().catch(() => null) : null;
  if (d.reset) {
    const e0 = all.items[id] || {};
    delete all.items[id];
    const orig = await env.SHOP.get("porig:" + id, "json");
    await env.SHOP.delete("pedit:" + id);
    if (row && orig) await d1Apply(env, id, null, { ...orig, images: [orig.image, ...(orig.images || [])].filter(Boolean) }, row).catch(() => {});
    if (e0.hidden) { const rm = (await env.SHOP.get("db_removed", "json")) || {}; delete rm[id]; await env.SHOP.put("db_removed", JSON.stringify(rm)); }  // 숨김을 풀면 다음 채우기 때 다시 올라감
  }
  else {
    const e = {};
    for (const [k, max] of Object.entries(EDIT_FIELDS)) {
      const v = (d.fields || {})[k];
      if (v === undefined || v === null || v === "") continue;
      if (k === "price") { const n = parseInt(v); if (n > 0) e.price = n; }
      else if (k === "hidden" || k === "soldout") { if (v === true) e[k] = true; }
      else e[k] = String(v).slice(0, max);
    }
    const big = await saveBig(env, id, d.big || {}, row);
    const hasBig = big || (await env.SHOP.get("pedit:" + id));
    if (Object.keys(e).length || hasBig) all.items[id] = { ...e, ...(hasBig ? { big: true } : {}), at: new Date().toISOString() }; else delete all.items[id];
    await d1Apply(env, id, e, big, row).catch(() => {});
  }
  all.ver = Date.now();
  await env.SHOP.put("product_edits", JSON.stringify(all));
  if (typeof caches !== "undefined") await caches.default.delete(new Request("https://catalog-cache/catalog/item?id=" + encodeURIComponent(id))).catch(() => {});  // 상품 캐시 바로 지움
  let deploy = "상품 페이지에 바로 반영돼요. (목록·검색 화면은 5분 안에)";
  if (env.GITHUB_TOKEN) {
    try { await gh(env, "actions/workflows/deploy.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main" }) }); deploy = "상품 페이지에 바로 반영돼요. (사이트 전체 갱신은 2~3분 뒤)"; } catch (e) { /* 다음 정기 반영 때 */ }
  }
  return json({ ok: true, message: (d.reset ? "원래대로 되돌렸어요. " : "저장했어요. ") + deploy, item: all.items[id] || null });
}

// ---------- 상품 상세 수정 (상세페이지 본문·사진·옵션) ----------
// 크기가 커서 KV "pedit:<id>"에 따로 저장, product_edits.items[id].big = true 로 표시 → 빌드·상품 DB 채우기가 읽어 반영
// 저장하는 순간 상품 DB(D1)에도 바로 반영 (손님 화면에 즉시)
const cleanHtml = (h) => String(h || "").slice(0, 300000)
  .replace(/<(script|style|iframe|object|textarea)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<\/?(script|iframe|object|embed|style|form|input|button|link|meta|textarea|base)\b[^>]*>/gi, "")
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, "");
const cleanUrl = (u) => { u = String(u || "").trim(); return /^https:\/\/[^\s"'<>]{4,600}$/.test(u) ? u : ""; };
function priceFloor(row, env) {  // 손해 방지 바닥값 (회원 할인과 같은 기준: 순마진 8%, 공급사 최저가)
  const P = { ...MEMBER_DEFAULT, ...PRICING(env) }, cost = Number(row.cost) || 0;
  return Math.ceil(Math.max(cost > 0 ? (cost * 10 / 11 + cost * P.min_net_margin) / (1 - P.card_fee - 1 / 11) : 0, Number(row.mp) || 0) / 10) * 10;
}
async function adminProductGet(req, env) {
  const d = await req.json().catch(() => ({}));
  let id = String(d.id || "").replace(/[^0-9A-Za-z_-]/g, ""); if (/^\d+$/.test(id)) id = "DM" + id;
  const row = env.DB ? await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first().catch(() => null) : null;
  const all = (await env.SHOP.get("product_edits", "json")) || { items: {} };
  const big = (await env.SHOP.get("pedit:" + id, "json")) || null;
  const orig = (await env.SHOP.get("porig:" + id, "json")) || null;
  if (!row && !all.items[id]) return fail("상품을 찾을 수 없어요. 상품코드를 확인해 주세요.", 404);
  const r = row ? { ...row, images: JSON.parse(row.images || "[]"), options: JSON.parse(row.options || "[]"), qt: JSON.parse(row.qt || "[]") } : { id };
  if (row) r.floor = priceFloor(row, env);
  return json({ row: r, edit: all.items[id] || null, big, orig });
}
async function adminProductImg(req, env) {  // 관리자가 올린 사진 (상세·대표 사진용)
  const d = await req.json().catch(() => ({}));
  const m = String(d.data || "").match(/^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return fail("사진 파일만 올릴 수 있어요.");
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bin.length > 3 * 1024 * 1024) return fail("사진이 너무 커요 (3MB 이하).");
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  await env.SHOP.put("pimg:" + key, bin, { metadata: { type: "image/" + m[1] } });
  return json({ ok: true, url: new URL(req.url).origin + "/pimg/" + key });
}
async function saveBig(env, id, d, row) {  // 상세·사진·옵션 저장 + D1 즉시 반영
  const big = {};
  if (typeof d.detail_html === "string") big.detail_html = cleanHtml(d.detail_html);
  if (Array.isArray(d.images)) big.images = d.images.map(cleanUrl).filter(Boolean).slice(0, 20);
  if (Array.isArray(d.options)) big.options = d.options.slice(0, 200).map((o) => ({ v: String(o.v || "").replace(/\s+/g, " ").trim().slice(0, 80), add: Math.round((parseInt(o.add) || 0) / 10) * 10, so: !!o.so })).filter((o) => o.v);
  if (typeof d.option_name === "string") big.option_name = d.option_name.trim().slice(0, 30);
  if (!Object.keys(big).length) return null;
  if (row && !(await env.SHOP.get("porig:" + id))) {  // 도매처 원본 (되돌리기용) — 처음 고칠 때 한 번만
    await env.SHOP.put("porig:" + id, JSON.stringify({ detail_html: row.detail_html, images: JSON.parse(row.images || "[]"), image: row.image, options: JSON.parse(row.options || "[]"), option_name: row.option_name }));
  }
  if (row && big.options) {  // 옵션 추가금이 손해 바닥 아래로 못 가게
    const fl = priceFloor(row, env);
    big.options.forEach((o) => { if (row.price + o.add < fl) o.add = fl - row.price; });
  }
  await env.SHOP.put("pedit:" + id, JSON.stringify(big));
  return big;
}
async function d1Apply(env, id, e, big, row) {  // 고친 내용을 상품 DB에 바로
  if (!env.DB || !row) return;
  const set = [], args = [];
  const put = (k, v) => { set.push(k + " = ?"); args.push(v); };
  if (e) {
    if (e.name) put("name", e.name);
    if (e.category) put("category", e.category);
    if (e.price) put("price", Math.max(parseInt(e.price), priceFloor(row, env)));
    put("soldout", e.soldout ? 1 : 0);
  }
  if (big) {
    if (big.detail_html !== undefined) put("detail_html", big.detail_html);
    if (big.images) { put("images", JSON.stringify(big.images.slice(1))); if (big.images[0]) put("image", big.images[0]); }
    if (big.options) put("options", JSON.stringify(big.options));
    if (big.option_name !== undefined) put("option_name", big.option_name);
  }
  if (e && e.hidden) { await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run(); return; }
  if (set.length) await env.DB.prepare(`UPDATE products SET ${set.join(", ")}, h = 'edited' WHERE id = ?`).bind(...args, id).run();
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
// 결제 승인: 토스(paymentKey) 또는 포트원(pg:"portone", paymentId=orderId)
// 포트원은 결제창에서 돈이 먼저 빠져나가므로, 확인에 실패하면 바로 자동 취소(환불)
async function confirm(req, env) {
  const body = await req.json().catch(() => ({}));
  const r = await confirmCore(body, env);
  // 자동 취소는 이 사이트 결제창에서 시작된 결제(사전 확인 기록 있음)만 — 남의 결제번호로 취소시키는 악용 차단
  if (body.pg === "portone" && !body.dry && body.paymentId && body.paymentId === body.orderId && r.status !== 200 && (await env.SHOP.get("po_pre:" + body.orderId))) {
    const done = await env.SHOP.get("order:" + body.orderId, "json");
    if (!done || done.paymentKey !== body.paymentId) {
      const c = await portoneCancel(env, body.paymentId, "주문 확인 실패로 자동 취소").catch(() => ({ ok: false }));
      await notify(env, `↩️ 포트원 결제 자동 취소 ${body.orderId} (${c.ok ? "환불됨" : "취소 실패 — 직접 확인 필요"})`).catch(() => {});
    }
  }
  return r;
}

async function confirmCore(body, env) {
  // 포트원: 휴대폰에서 네이버·카카오 앱을 거쳐 다른 브라우저로 돌아오면 주문서(로컬 저장)가 없음 → 결제창 열기 전 서버에 맡겨 둔 주문서로 처리
  if (body.pg === "portone" && !body.dry && body.paymentId && !Array.isArray(body.items)) {
    const pre = await env.SHOP.get("po_pre:" + body.paymentId, "json").catch(() => null);
    if (pre && typeof pre === "object") body = { ...pre, ...body, items: pre.items, customer: pre.customer, coupon: pre.coupon, amount: pre.amount, token: pre.token, src: pre.src, fromCart: pre.fromCart, orderId: body.paymentId };
  }
  const { orderId, amount, items, customer, coupon, token, src, pg, paymentId, dry } = body;
  let { paymentKey } = body;
  if (pg === "portone" && !dry && paymentId !== orderId) return fail("잘못된 요청이에요.");
  if (!(paymentKey || paymentId || dry) || !orderId || !Array.isArray(items) || !items.length) return fail("잘못된 요청이에요.");
  if (await env.SHOP.get("order:" + orderId)) return fail("이미 처리된 주문이에요.");
  if (customer?.phone && (await isBlocked(env, customer.phone))) {  // 차단된 연락처: 결제 승인 안 함 (돈이 빠져나가지 않음)
    return fail("주문이 제한된 연락처예요. 고객센터로 문의해 주세요.");
  }

  // 사이트의 실제 가격으로 금액 다시 계산 (화면 금액 조작 방지)
  const map = await productMap(env, items.map((x) => x.id));
  let subtotal = 0, shipping = 0;
  const shipUnits = {}, shipProd = {};  // 같은 상품은 수량·옵션을 합쳐 배송비 계산
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
    subtotal += unit * qty;
    shipUnits[p.id] = (shipUnits[p.id] || 0) + qty * (Number(p.pk) || 1); shipProd[p.id] = p;
    const sup = (await env.SHOP.get("supply:" + p.id, "json")) || { supplier: p.supplier || "직영", supply_price: 0 };
    lines.push({ sn: Number(p.sn) || 0, ship_fee: Number(p.shipping_fee) || 0, opt_add: optName ? Number(p.options[Number(it.opt)].add) || 0 : 0, id: p.id, name: p.name + (optName ? ` [${optName}]` : ""), option: optName, qty, pk: Number(p.pk) || 1, price: unit, list_unit: listUnit, mp: Number(p.mp) || 0, supplier: sup.supplier, supply_price: sup.supply_price, cost: Number(p.cost) || stats.costFromPrice(p.price + (optName ? p.options[Number(it.opt)].add : 0), PRICING(env)), ship_mode: p.sm || "",
      source: p.source || (String(p.id).startsWith("DM") ? "domeme" : /^W/.test(p.id) ? "ownerclan" : /^CH\d/.test(p.id) ? "onchannel" : ""), source_no: p.source_no || String(p.id).replace(/^DM/, ""), ...(offerId ? { offer: offerId, list_price: p.price + (optName ? (p.options[Number(it.opt)].add) : 0) } : {}) });
  }
  const shipBy = {};
  for (const [pid, u] of Object.entries(shipUnits)) {  // 'N개부터 구매' 상품은 최소 수량 확인
    const mq = Number(shipProd[pid]?.mq) || 1;
    if (u < mq * (Number(shipProd[pid]?.pk) || 1)) return fail(`${shipProd[pid].name} 상품은 ${mq}개부터 주문할 수 있어요.`);
  }
  for (const [pid, u] of Object.entries(shipUnits)) { shipBy[pid] = shipFor(shipProd[pid], u); shipping += shipBy[pid]; }
  // 결제 확정 전 도매처 실시간 재고·가격 확인 (품절·손해 주문 차단 — 확정 전이라 손님 돈은 빠져나가지 않음)
  const firstLine = {};
  const lv = await live.check({ ...env, __ocToken: () => ocToken(env) }, lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, pk: l.pk, price: l.price, option: l.option,
    ship: firstLine[l.id] ? 0 : ((firstLine[l.id] = 1), shipBy[l.id] || 0), ship_fee: Number(shipProd[l.id]?.shipping_fee) || 0 })), PRICING(env));
  if (!lv.ok) return fail(lv.message);
  const free = Number(env.FREE_SHIPPING_OVER || 0);
  if (free && subtotal >= free) shipping = 0;
  const remote = regionFee(customer?.zip, customer?.addr);  // 제주·도서산간 추가 배송비
  shipping += remote.fee;
  let discount = 0, couponCode = "";
  if (coupon) {
    if (lines.some((l) => l.mp)) return fail("공급사가 최저 판매가를 정한 상품이 있어 쿠폰을 쓸 수 없어요. 쿠폰을 빼고 다시 주문해 주세요.");
    const c = await checkCoupon(env, coupon, subtotal);
    if (!c.ok) return fail(c.message);
    discount = c.discount; couponCode = c.code;
  }
  let memberDisc = 0;  // 로그인 회원 추가 즉시 할인
  if (token && (await auth.userFromToken(env, token))) {
    memberDisc = memberDiscount(lines.map((l) => ({ unit: l.price, list: l.list_unit, qty: l.qty, mp: l.mp })), { ...MEMBER_DEFAULT, rate: +(env.MEMBER_DISCOUNT ?? MEMBER_DEFAULT.rate) });
    discount += memberDisc;
  }
  if (subtotal - discount + shipping !== Number(amount)) return fail("결제 금액이 상품 금액과 달라요. 다시 주문해 주세요.");
  // 최종 적자 방지: 모든 도매처 공통, 주문 전체로 원가+배송비+카드수수료+부가세+운영비를 빼고 0원 미만이면 결제 승인 전에 막음
  {
    const pr = PRICING(env), paid = subtotal - discount + shipping;
    let supCost = 0;
    for (const l of lines) supCost += ((Number(l.cost) || 0) * (l.pk || 1) + (l.opt_add || 0)) * l.qty;  // 옵션 추가금은 전부 원가로 (보수적)
    const supShip = Object.values(shipBy).reduce((a, b) => a + b, 0) + remote.fee;  // 도매처에 내는 배송비 = 손님에게 받는 배송비 규칙과 같음
    const net = paid - paid * pr.card_fee - Math.max(0, paid - supCost - supShip) / 11 - supCost - supShip - pr.ops_cost_won;
    const fakePrice = lines.some((l) => (Number(l.cost) || 0) < 1000 && !(Number(shipProd[l.id]?.shipping_fee) || 0));  // 1천원 미만 무료배송 = 도매처 표시용 가격
    if (!(supCost > 0) || net < 0 || fakePrice) {
      await notify(env, `⚠️ 적자 주문 차단: ${lines.map((l) => l.name + "×" + l.qty).join(", ")} · 결제 ${paid}원 · 원가 ${supCost}원 · 배송비 ${supShip}원 · 순이익 ${Math.round(net)}원`).catch(() => {});
      return fail("지금은 이 상품을 주문할 수 없어요. 가격을 확인한 뒤 다시 열어 드릴게요.");
    }
  }

  if (dry) { await env.SHOP.put("po_pre:" + orderId, JSON.stringify({ orderId, amount: Number(amount), items, customer, coupon, token, src, fromCart: !!body.fromCart }), { expirationTtl: 3 * 86400 }); return json({ ok: true }); }  // 결제창 열기 전 사전 확인 (돈 안 빠짐)
  let pay;
  if (pg === "portone") {
    if (!env.PORTONE_API_SECRET) return fail("결제 서버 설정이 아직 안 됐어요.", 500);
    const H = { headers: { Authorization: "PortOne " + String(env.PORTONE_API_SECRET).trim() } };
    let r = await fetch("https://api.portone.io/payments/" + encodeURIComponent(paymentId) + poStore(env), H);
    if (r.status === 401 || r.status === 403) r = await fetch("https://api.portone.io/payments/" + encodeURIComponent(paymentId), H);  // 상점 지정 없이 한 번 더
    const p = await r.json().catch(() => ({}));
    if (!r.ok) return fail(`결제 정보를 확인하지 못했어요. (${p.type || r.status}${p.message ? ": " + p.message : ""})`, 502);
    if (p.status !== "PAID") return fail("결제가 완료되지 않았어요.");
    if (Number(p.amount?.total) !== Number(amount)) return fail("결제 금액이 주문 금액과 달라요.");
    if (env.PORTONE_STORE_ID && p.storeId && p.storeId !== env.PORTONE_STORE_ID) return fail("잘못된 결제예요.");
    const m = p.method || {};
    const METHOD = { PaymentMethodCard: "카드", PaymentMethodEasyPay: "간편결제", PaymentMethodTransfer: "계좌이체", PaymentMethodVirtualAccount: "가상계좌", PaymentMethodMobile: "휴대폰" };
    pay = { method: (m.provider ? m.provider + " " : "") + (METHOD[m.type] || "결제"), receipt: { url: p.receiptUrl || "" } };
    paymentKey = paymentId;
  } else {
    const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(env.TOSS_SECRET_KEY + ":"), "Content-Type": "application/json" },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    pay = await r.json();
    if (!r.ok) return fail(pay.message || "결제 승인 실패", r.status);
  }

  const now = new Date().toISOString();
  const order = { orderId, amount: Number(amount), subtotal, discount, coupon: couponCode, shipping, ship_by: shipBy, remote: remote.label || undefined, remote_fee: remote.fee || undefined, member_discount: memberDisc || undefined, lines, customer, method: pay.method, paymentKey, pg: pg === "portone" ? "portone" : "toss", receipt: pay.receipt?.url || "",
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
  return json({ ok: true, orderId, amount: Number(amount), name: customer?.name || "", addr: customer?.addr || "", phone: customer?.phone || "", orderName: itemName, items: items.map((x) => x.id), fromCart: !!body.fromCart });
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

// 배송비: 상품별 (sn=0 → 주문당 1번, sn=N → N개마다), 단위는 낱개(묶음 상품은 묶음 수×개수)
function shipFor(p, units) {
  const fee = Number(p?.shipping_fee) || 0, sn = Number(p?.sn) || 0, pk = Number(p?.pk) || 1;
  if (!fee || units <= 0) return 0;
  return sn ? fee * Math.ceil(units / sn) : fee;
}
async function siteProducts(env) {
  return (await fetch(env.SITE_URL.replace(/\/$/, "") + "/products.json", { cf: { cacheTtl: 0 } })).json();
}
// 상품 찾기: 사이트의 상품 파일(p/상품번호.json — 가격·품절이 가장 먼저 갱신됨)을 먼저, 없는 상품(상품 DB에만 있는 것)은 상품 DB에서
async function productMap(env, ids) {
  const base = String(env.SITE_URL || "").replace(/\/$/, ""), out = {};
  const uniq = [...new Set(ids.map(String))];
  await Promise.all(uniq.map(async (id) => {
    try { const r = await fetch(`${base}/p/${encodeURIComponent(id)}.json`, { cf: { cacheTtl: 0 } }); if (r.ok) { const p = await r.json(); if (p && p.id) out[p.id] = p; } } catch (e) {}
  }));
  const miss = uniq.filter((id) => !out[id]);
  if (miss.length && env.DB) Object.assign(out, await catalog.itemsForOrder(env.DB, miss));
  if (uniq.every((id) => out[id])) return out;
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
  if (Number(p.mp) && price < Number(p.mp)) return fail(`이 상품은 공급사가 정한 최저 판매가(개당 ${Number(p.mp).toLocaleString()}원)가 있어 더 낮게 제안할 수 없어요.`);
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
`[담Go사Go] 새 가격 제안이 도착했습니다.

상품: #{상품명}
수량: #{수량}개
판매가: 개당 #{판매가}원
제안가: 개당 #{제안가}원
제안번호: #{제안번호}

#{기한}까지 수락 또는 거절해 주세요. 기한이 지나면 자동으로 만료됩니다.

응답하기: #{링크}` },
  OFFER_ACCEPT: { to: "고객", when: "가격 제안이 수락됐을 때", text:
`[담Go사Go] #{고객명}님, 가격 제안이 수락되었습니다.

상품: #{상품명}
수량: #{수량}개
제안가: 개당 #{제안가}원 (합계 #{합계}원)
제안번호: #{제안번호}

#{기한}까지 아래 링크에서 주문하시면 제안 가격이 적용됩니다.

주문하기: #{링크}` },
  OFFER_REJECT: { to: "고객", when: "가격 제안이 거절됐을 때", text:
`[담Go사Go] #{고객명}님, 보내주신 가격 제안이 이번에는 수락되지 않았습니다.

상품: #{상품명}
제안번호: #{제안번호}
판매자 메시지: #{사유}

판매가로는 언제든 바로 주문하실 수 있습니다.

상품 보기: #{링크}` },
  SOLDOUT_CANCEL: { to: "고객", when: "도매처 품절로 주문을 취소했을 때", text:
`[담Go사Go] #{고객명}님, 죄송합니다.

주문하신 상품이 공급처에서 갑자기 품절되어 주문을 취소하고 결제 금액 전액을 환불해 드렸습니다.

주문번호: #{주문번호}
상품: #{상품명}
환불금액: #{결제금액}원

카드사에 따라 환불까지 3~7영업일이 걸릴 수 있습니다. 불편을 드려 정말 죄송합니다.

비슷한 상품 보기: #{링크}` },
  ORDER_DONE: { to: "고객", when: "결제가 완료됐을 때", text:
`[담Go사Go] #{고객명}님, 주문이 완료되었습니다.

주문번호: #{주문번호}
상품: #{상품명}
결제금액: #{결제금액}원

영업일 기준 1~3일 안에 출고되며, 출고되면 다시 알려드립니다.

주문 조회: #{링크}` },
  SHIPPED: { to: "고객", when: "송장번호를 넣고 배송중으로 바꿨을 때", text:
`[담Go사Go] #{고객명}님, 주문하신 상품이 출고되었습니다.

주문번호: #{주문번호}
택배사: #{택배사}
송장번호: #{송장번호}

배송 조회: #{링크}` },
  REVIEW_ASK: { to: "고객", when: "배송완료로 바꿨을 때 (리뷰 요청)", text:
`[담Go사Go] #{고객명}님, 상품은 잘 받으셨나요?

주문번호: #{주문번호}
상품: #{상품명}

사용해 보신 느낌을 리뷰로 남겨 주시면 다른 고객님께 큰 도움이 됩니다.

리뷰 쓰기: #{링크}` },
  ADMIN_ORDER: { to: "대표", when: "새 주문이 들어왔을 때", text:
`[담Go사Go] 새 주문이 들어왔습니다.

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
  await pushTo(env, "admin", { title: "담Go사Go 관리자", body: text.slice(0, 180), url: siteLink(env, "admin.html") });
  await email(env, env.ADMIN_EMAIL, "[담Go사Go 관리자] " + text.split("\n")[0].slice(0, 60), text, siteLink(env, "admin.html"));
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
    <div style="font-size:22px;font-weight:700;margin-bottom:18px">담<span style="color:#FF5A1F;font-style:italic">Go</span>사<span style="color:#FF5A1F;font-style:italic">Go</span></div>${body}
    ${url ? `<p style="margin-top:24px"><a href="${esc(url)}" style="display:inline-block;background:#9a7b4f;color:#fff;text-decoration:none;padding:12px 26px;border-radius:24px;font-weight:600">바로 확인하기</a></p>` : ""}
    <p style="margin-top:28px;color:#868a91;font-size:12px">이 메일은 발신 전용입니다. 문의는 쇼핑몰 고객센터를 이용해 주세요.</p></div>`;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: env.MAIL_FROM_NAME || "담Go사Go", email: env.MAIL_FROM }, to: [{ email: to }], ...(env.MAIL_REPLY_TO ? { replyTo: { email: env.MAIL_REPLY_TO, name: env.MAIL_FROM_NAME || "담Go사Go" } } : {}), subject, htmlContent: html, textContent: text + (url ? "\n\n" + url : "") }) });
    return r.ok;
  } catch (e) { return false; }
}

// 고객 알림 한 번에: 웹 푸시(무료) + 이메일(무료) + 알림톡(유료, 키 있을 때만)
const ALERT_TITLE = { OFFER_ACCEPT: "가격 제안이 수락됐어요", OFFER_REJECT: "가격 제안 결과를 알려드려요", ORDER_DONE: "주문이 완료됐어요", SHIPPED: "상품이 출고됐어요", REVIEW_ASK: "상품은 잘 받으셨나요?" };
async function alertCustomer(env, key, who, vars) {
  const text = fill(TEMPLATES[key].text, vars), url = vars.링크;
  await pushTo(env, "p:" + digits(who.phone), { title: ALERT_TITLE[key] || "담Go사Go", body: text.replace(/^\[담Go사Go\]\s*/, "").split("\n\n").slice(0, 2).join("\n").slice(0, 180), url });
  const noLink = fill(TEMPLATES[key].text.split("\n\n").slice(0, -1).join("\n\n"), vars);  // 마지막 줄(링크)은 메일 버튼으로
  await email(env, who.email, "[담Go사Go] " + (ALERT_TITLE[key] || "알림"), noLink, url);
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
  const sent = await kakaoMemo(env, "✅ 담Go사Go 알림이 연결되었습니다. 이제 주문·가격 제안·문의가 들어오면 이 채팅으로 알려드려요.");
  return json({ ok: true, message: sent ? "연결됐어요. 카카오톡 ‘나와의 채팅’에 테스트 알림을 보냈어요." : "연결은 됐는데 테스트 알림을 못 보냈어요. 동의항목 ‘카카오톡 메시지 전송’을 확인해 주세요." });
}
async function adminKakaoTest(env) {
  const sent = await kakaoMemo(env, "🔔 담Go사Go 테스트 알림입니다.");
  return sent ? json({ ok: true, message: "카카오톡 ‘나와의 채팅’으로 보냈어요." }) : fail("보내지 못했어요. 카카오톡 연결을 다시 해 주세요.");
}

// 포트원 결제 맞추기 (10분마다): 결제는 됐는데 주문이 없는 건 → 맡겨 둔 주문서가 있으면 주문 저장, 없으면 자동 환불
const poStore = (env, more) => { const id = env.PORTONE_STORE_ID || "store-cb55780c-ba44-43ef-afa5-98e8ac79216b"; return (more ? "&" : "?") + "storeId=" + encodeURIComponent(id); };
async function portoneSync(env) {
  if (!env.PORTONE_API_SECRET) return { checked: 0 };
  const now = Date.now();
  const q = { page: { number: 0, size: 100 }, filter: { from: new Date(now - 3 * 86400e3).toISOString(), until: new Date(now).toISOString(), status: ["PAID"] } };
  const r = await fetch("https://api.portone.io/payments?requestBody=" + encodeURIComponent(JSON.stringify(q)) + poStore(env, true), { headers: { Authorization: "PortOne " + String(env.PORTONE_API_SECRET).trim() } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.message || r.status };
  const out = { checked: 0, saved: [], refunded: [] };
  for (const p of d.items || []) {
    if (p.status !== "PAID" || !p.id) continue;
    out.checked++;
    const at = Date.parse(p.paidAt || p.requestedAt || p.updatedAt || 0);
    if (at && now - at < 5 * 60e3) continue;  // 방금 결제는 손님 화면이 처리 중일 수 있어 다음 차례에
    if (await env.SHOP.get("order:" + p.id)) continue;
    const pre = await env.SHOP.get("po_pre:" + p.id, "json").catch(() => null);
    if (pre && typeof pre === "object" && Array.isArray(pre.items)) {
      const res = await confirm(new Request("https://x/confirm", { method: "POST", body: JSON.stringify({ pg: "portone", paymentId: p.id, orderId: p.id }) }), env);
      (res.status === 200 ? out.saved : out.refunded).push(p.id);  // 실패하면 confirm이 자동 환불
    } else {
      const c = await portoneCancel(env, p.id, "주문 정보 없음 — 자동 환불");
      out.refunded.push(p.id + (c.ok ? "" : " (실패: " + c.message + ")"));
      await notify(env, `↩️ 포트원 결제 자동 환불 ${p.id} ${p.amount?.total || ""}원 — 주문 정보 없음${c.ok ? "" : " · 취소 실패, 직접 확인 필요"}`).catch(() => {});
    }
  }
  return out;
}

async function portoneCancel(env, paymentId, reason, amount) {
  const r = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}/cancel`, {
    method: "POST",
    headers: { Authorization: "PortOne " + String(env.PORTONE_API_SECRET).trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ reason: reason || "고객 요청", ...(amount ? { amount } : {}), storeId: env.PORTONE_STORE_ID || "store-cb55780c-ba44-43ef-afa5-98e8ac79216b" }),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? { ok: true } : { ok: false, message: (d.type ? d.type + " " : "") + (d.message || "결제 취소 실패") };
}
// 주문의 결제사에 맞게 취소 (예전 주문은 토스)
const payCancel = (env, o, reason, amount) => o.pg === "portone" ? portoneCancel(env, o.paymentKey, reason, amount) : tossCancel(env, o.paymentKey, reason, amount);

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
  orderId: o.orderId, status: o.status, ordered: o.status === "상품준비중" || o.lines.some((l) => l.po), paidAt: o.paidAt, amount: o.amount, subtotal: o.subtotal, discount: o.discount || 0, shipping: o.shipping || 0, method: o.method,
  lines: o.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })),
  receiver: { name: o.customer?.name, zip: o.customer?.zip, addr: o.customer?.addr, memo: o.customer?.memo },
  receipt: o.receipt || "", courier: o.courier || "", tracking: o.tracking || "", track: o.track || null, history: o.history || [], claim: o.claim || null,
});

async function findOrder(env, orderId, phone) {
  const id = String(orderId || "").trim();
  const o = id && (await env.SHOP.get("order:" + id, "json"));
  if (!o) return null;
  // 한 주문번호에 틀린 연락처를 1시간에 10번 넣으면 그 주문만 1시간 잠금 (다른 손님은 영향 없음, 맞게 넣은 조회는 횟수에 안 셈)
  if (await overLimit(env, "badphone:" + id, 10, 3600, false)) return null;
  if (!digits(phone) || digits(o.customer?.phone) !== digits(phone)) { await overLimit(env, "badphone:" + id, 10, 3600); return null; }
  return o;
}

// ---------- 주문 조회 · 취소 · 반품/교환 ----------
// 주문번호를 잊은 비회원: 받는 분 이름 + 연락처로 최근 6개월 주문 찾기
async function orderFind(req, env) {
  const { name, phone } = await req.json();
  if (!clip(name, 20) || digits(phone).length < 10) return fail("받는 분 이름과 연락처를 정확히 입력해 주세요.");
  const since = new Date(Date.now() - 183 * 86400e3).toISOString();
  const list = (await kvList(env, "order:")).filter((o) => o.paidAt >= since && digits(o.customer?.phone) === digits(phone) && String(o.customer?.name || "").replace(/\s/g, "") === String(name).replace(/\s/g, ""))
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
    if (o?.status === "배송완료" && !o.claim) {  // 받은 뒤 8일 지나면 자동 구매확정 (단순 변심 반품 기간 7일 끝)
      const h = (o.history || []).filter((x) => x.status === "배송완료").pop();
      if (h && Date.now() - Date.parse(h.at) > 8 * 864e5) { setStatus(o, "구매확정", { by: "자동(수령 8일)" }); await env.SHOP.put(name, JSON.stringify(o)); }
      continue;
    }
    if (o?.status !== "배송중" || !o.tracking) continue;
    if (await refreshTracking(env, o)) { n++; if (o.status === "배송완료") done++; }
  }
  return { checked: n, delivered: done };
}

async function orderCancel(req, env) {
  const { orderId, phone, reason } = await req.json();
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  if (o.status === "결제완료" && !o.poSheetAt) {  // 출고 준비 전(도매처 주문서도 안 받음): 즉시 자동 취소·환불
    const c = await payCancel(env, o, clip(reason, 100) || "고객 주문 취소");
    if (!c.ok) return fail(c.message);
    setStatus(o, "취소완료", { reason: clip(reason, 200) });
    await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
    await notify(env, `↩️ 주문 취소(자동 환불) ${o.orderId}`);
    return json({ message: "주문이 취소되었어요. 결제수단에 따라 환불까지 3~7영업일이 걸릴 수 있어요.", order: publicOrder(o) });
  }
  if (o.status === "상품준비중" || o.lines.some((l) => l.po)) {  // 이미 도매처에 발주함 → 취소 불가 (받은 뒤 반품으로)
    return fail("이미 상품 준비(발주)가 시작돼서 주문을 취소할 수 없어요. 상품을 받으신 뒤 7일 안에 [반품 신청]을 해 주세요.");
  }
  if (o.status === "결제완료" && o.poSheetAt) {  // 주문서만 받은 상태 (발주했을 수 있음) → 관리자 확인 후 처리
    setStatus(o, "취소요청", { reason: clip(reason, 200) });
    await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
    await notify(env, `⚠️ 취소 요청 ${o.orderId} (상품 준비 중)`);
    return json({ message: "취소 요청이 접수되었어요. 이미 출고된 경우 반품으로 진행될 수 있어요.", order: publicOrder(o) });
  }
  return fail("지금 상태에서는 취소할 수 없어요. 반품/교환 신청을 이용해 주세요.");
}

// 단순 변심 반품·교환 편도 배송비: 상품에 정해진 반품 배송비 중 가장 큰 값, 없으면 기본값(사이트 배송비 3,000원)
const claimShipFee = (env, o) => Math.max(Number(env.RETURN_FEE_DEFAULT) || 3000, ...o.lines.map((l) => Number(l.return_fee) || 0));

async function orderClaim(req, env) {
  const body = await req.json().catch(() => ({}));
  const { orderId, phone, type, reason, kind } = body;
  let { photos } = body;
  const o = await findOrder(env, orderId, phone);
  if (!o) return fail("주문번호 또는 연락처가 일치하지 않아요.", 404);
  if (!["반품", "교환"].includes(type)) return fail("신청 종류를 선택해 주세요.");
  if (!["배송중", "배송완료"].includes(o.status)) return fail("배송이 시작된 주문만 반품/교환을 신청할 수 있어요.");
  if (!clip(reason, 500)) return fail("사유를 입력해 주세요.");
  {  // 신청 기한: 단순 변심은 받은 날(배송완료)부터 7일, 불량·오배송 등은 90일 (전자상거래법)
    const h = (o.history || []).filter((x) => x.status === "배송완료").pop() || (o.history || []).filter((x) => x.status === "배송중").pop();
    const days = h ? (Date.now() - Date.parse(h.at)) / 864e5 : 0;
    if (/변심/.test(String(kind || "")) && days > 7) return fail("단순 변심 반품·교환은 상품을 받은 날부터 7일 안에만 신청할 수 있어요. 상품에 문제가 있다면 사유를 '불량·파손' 등으로 골라 사진과 함께 신청해 주세요.");
    if (days > 90) return fail("상품을 받은 지 3개월이 지나 반품·교환을 신청할 수 없어요. 고객센터로 문의해 주세요.");
  }
  // 사진: 불량·파손·오배송·누락은 필수 (최대 3장, 장당 1.5MB 이하 이미지)
  photos = (Array.isArray(photos) ? photos : []).filter((p) => typeof p === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(p)).slice(0, 3);
  if (photos.some((p) => p.length > 2_000_000)) return fail("사진 용량이 너무 커요. 다시 골라 주세요.");
  if (/불량|파손|오배송|누락/.test(String(kind || "")) && !photos.length) return fail("불량·파손·오배송·누락은 사진을 꼭 첨부해 주세요.");
  for (let i = 0; i < photos.length; i++) await env.SHOP.put(`claimimg:${o.orderId}:${i}`, photos[i]);
  o.claim = { type, kind: clip(kind, 30), reason: clip(reason, 500), photos: photos.length, at: new Date().toISOString(), status: "접수" };
  // 단순 변심: 배송비는 고객 부담 → 반품은 (처음 배송비 + 반품 회수비)를 빼고 환불, 교환은 왕복 배송비를 따로 받음
  if (/변심/.test(String(kind || ""))) {
    const one = claimShipFee(env, o);
    const left = Math.max(0, (o.amount || 0) - (o.refunded || 0));
    if (type === "반품") { o.claim.deduct = Math.min(left, (o.shipping > 0 ? o.shipping : one) + one); o.claim.refund = left - o.claim.deduct; }
    else o.claim.deduct = one * 2;
  }
  setStatus(o, type + "요청");
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  await notify(env, `📦 ${type} 요청 ${o.orderId}\n[${o.claim.kind || "-"}] ${o.claim.reason}${photos.length ? `\n사진 ${photos.length}장 (관리자 › 취소·반품·교환)` : ""}`);
  const won_ = (n) => Number(n).toLocaleString() + "원";
  const extra = o.claim.deduct == null ? "" : type === "반품" ? `\n단순 변심 반품은 배송비 ${won_(o.claim.deduct)}을 뺀 ${won_(o.claim.refund)}이 환불돼요.` : `\n단순 변심 교환은 왕복 배송비 ${won_(o.claim.deduct)}을 고객님이 부담하세요. 입금 방법은 따로 안내드릴게요.`;
  return json({ message: `${type} 신청이 접수되었어요. 확인 후 연락드릴게요.${extra}`, order: publicOrder(o) });
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
const SOURCE_NAME = { domeme: "도매매", ownerclan: "오너클랜", onchannel: "온채널", ggsan: "건강산", cmtstory: "화장품스토리", own: "자체상품(직접 발송)" };
// 도매처 대량주문 양식 열 (관리자에게만 보냄)
const ORDER_SHEETS = {"domeme": ["상품번호", "옵션", "수량", "수령자명", "휴대전화", "추가연락처", "우편번호", "배송지주소", "배송상세주소", "쇼핑몰명", "전달사항", "배송요청사항"], "ownerclan": ["오너클랜 상품코드", "수량", "배송방식", "받는사람 이름", "받는사람 전화번호", "받는사람 휴대폰", "우편번호", "받는사람 주소", "옵션1", "옵션2", "배송시 요청사항", "판매사 주문관리 메모", "원장주문코드", "개인통관부호", "구매자 생년월일", "마켓 정산가(배송비 포함)"], "onchannel": ["온채널 상품코드", "주문코드", "주문 옵션", "옵션 주문 수량", "배송비 결제 유형", "받는사람", "전화번호", "비상연락처", "우편번호", "주소", "배송 메시지", "통관고유부호", "(국제)배송방식"]};
// 상품코드 앞글자 → 도매처: DM 도매매 · W(7자리) 오너클랜 · CH 온채널 · GS 건강산 · CM 화장품스토리 · OWN 자체상품
const srcOf = (l) => { const id = String(l.id); return /^DM/.test(id) ? "domeme" : /^W[0-9A-Z]{3,}$/.test(id) ? "ownerclan" : /^CH\d/.test(id) ? "onchannel" : /^GS\d/.test(id) ? "ggsan" : /^CM\d/.test(id) ? "cmtstory" : /^OWN/.test(id) ? "own" : (l.source && SOURCE_NAME[l.source] ? l.source : ""); };
// 주문 줄마다 돈 계산 (발주 화면 표시용): 손님 결제·도매 원가·카드수수료·부가세·운영비·순수마진
function lineMoney(o, l, i, P) {
  const goods = l.price * l.qty, sub = o.subtotal || o.lines.reduce((a, x) => a + x.price * x.qty, 0) || 1;
  const disc = Math.round(((o.discount || 0) + (o.member_discount || 0)) * goods / sub);
  const firstIdx = o.lines.findIndex((x) => x.id === l.id);
  const pids = [...new Set(o.lines.map((x) => x.id))];
  let ship = 0;
  if (firstIdx === i) ship = o.ship_by ? Number(o.ship_by[l.id]) || 0 : Math.round(((o.shipping || 0) - (o.remote_fee || 0)) / pids.length);
  if (i === 0) ship += Number(o.remote_fee) || 0;  // 제주·도서산간 추가 배송비
  const rev = goods - disc + ship;
  const cost = ((Number(l.cost) || 0) * (Number(l.pk) || 1) + (Number(l.opt_add) || 0)) * l.qty;
  const card = Math.round(rev * P.card_fee), vat = Math.round(Math.max(0, rev - cost - ship) / 11);
  const ops = Math.round(P.ops_cost_won * goods / sub);
  const net = rev - card - vat - cost - ship - ops;
  return { unit: l.price, goods, disc, ship, rev, cost, card, vat, ops, net, rate: rev ? Math.round(net / rev * 1000) / 10 : 0 };
}
async function adminPo(env) {
  const groups = {}, P = PRICING(env);
  for (const o of await kvList(env, "order:")) {
    if (o.status !== "결제완료") continue;
    o.lines.forEach((l, i) => {
      if (l.po) return;
      const src = srcOf(l) || "direct";
      (groups[src] = groups[src] || { source: src, name: SOURCE_NAME[src] || (src === "direct" ? "직영·공급사" : src), lines: [] }).lines.push({
        orderId: o.orderId, idx: i, paidAt: o.paidAt, product_no: l.source_no || String(l.id).replace(/^DM/, ""), id: l.id, name: l.name, option: l.option || "", qty: l.qty * (Number(l.pk) || 1), pk: Number(l.pk) || 1,
        cost: l.cost || 0, amount: l.price * l.qty, ship_mode: l.ship_mode || "", receiver: o.customer?.name || "", phone: o.customer?.phone || "", zip: o.customer?.zip || "",
        addr: o.customer?.addr || "", addr1: o.customer?.addr1 || o.customer?.addr || "", addr2: o.customer?.addr2 || "", memo: o.customer?.memo || "", lv: l.lv || null, m: lineMoney(o, l, i, P), sn: l.sn ?? null, ship_fee: l.ship_fee ?? null });
    });
  }
  return { groups: Object.values(groups), sheets: ORDER_SHEETS, mysheets: (await env.SHOP.get("order_sheets", "json")) || {} };
}
// ---------- 발주 전 도매처 가격·재고 확인 (도매매·오너클랜 실시간) ----------
// 결과는 주문 줄(l.lv)에 저장 → 발주 화면에 빨강/초록 표시. 10분마다 새 결제 주문을 자동 확인하고 문제가 있으면 관리자에게 알림
async function poCheckOrders(env, { force = false, notifyBad = false } = {}) {
  const res = {}, bad = [];
  const env2 = { ...env, __ocToken: () => ocToken(env) };
  for (const o of await kvList(env, "order:")) {
    if (o.status !== "결제완료") continue;
    const pids = [...new Set(o.lines.map((l) => l.id))], shipEach = Math.floor((Number(o.shipping) || 0) / Math.max(1, pids.length));
    const seen = {};
    let changed = false;
    for (const [i, l] of o.lines.entries()) {
      if (l.po) continue;
      const src = srcOf(l);
      if (src !== "domeme" && src !== "ownerclan") {
        if (!l.lv && src === "onchannel") { l.lv = { ok: null, msg: "온채널은 자동 확인이 안 돼요 (발주 때 금액 확인)", at: new Date().toISOString() }; changed = true; }
        res[`${o.orderId}:${i}`] = l.lv || { ok: null, msg: "" }; continue;
      }
      if (!force && l.lv && Date.now() - Date.parse(l.lv.at) < 30 * 60e3) { res[`${o.orderId}:${i}`] = l.lv; continue; }
      let r;
      try {
        r = await live.check(env2, [{ id: l.id, name: l.name, qty: l.qty, pk: Number(l.pk) || 1, price: l.price, option: l.option || "", ship: seen[l.id] ? 0 : ((seen[l.id] = 1), shipEach), ship_fee: shipEach }], PRICING(env));
      } catch (e) { r = { ok: true, skipped: true }; }
      const lv = { ok: r.skipped ? null : !!r.ok, msg: r.ok ? (r.skipped ? "확인 못 함 (발주 때 금액 확인)" : "도매처 가격·재고 정상") : String(r.message || "").slice(0, 200), at: new Date().toISOString() };
      const wasBad = l.lv && l.lv.ok === false;
      l.lv = lv; changed = true; res[`${o.orderId}:${i}`] = lv;
      if (lv.ok === false && !wasBad) bad.push(`${o.orderId} ${l.name}: ${lv.msg}`);
    }
    if (changed) await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
  }
  if (notifyBad && bad.length) await notify(env, `⚠️ 발주 전 확인 — 도매처 품절·가격 변동 ${bad.length}건\n${bad.slice(0, 10).join("\n")}\n관리자 > 발주에서 품절 취소 여부를 정해 주세요.`).catch(() => {});
  return { results: res, bad: bad.length };
}

// ---------- 오너클랜 송장 자동 수집 ----------
// 오너클랜 주문의 메모(원장주문코드·전달사항)에서 우리 주문번호(T…)를 찾아 송장 입력 → 배송중 + 손님에게 출고 알림
async function ocTrackingSync(env) {
  const tok = await ocToken(env).catch(() => "");
  if (!tok) return { ok: false, message: "오너클랜 로그인 정보가 없어요." };
  const want = {};  // 우리 주문번호 → 주문 (오너클랜 상품을 발주했고 송장이 아직 없는 것)
  for (const o of await kvList(env, "order:")) {
    if (o.tracking || !["상품준비중", "결제완료"].includes(o.status)) continue;
    if (o.lines.some((l) => srcOf(l) === "ownerclan" && l.po)) want[o.orderId] = o;
  }
  if (!Object.keys(want).length) return { ok: true, updated: 0, message: "송장을 기다리는 오너클랜 주문이 없어요." };
  let after = null, updated = 0, seen = 0;
  for (let page = 0; page < 5; page++) {
    const q = `query{allOrders(first:100${after ? `,after:${JSON.stringify(after)}` : ""}){pageInfo{hasNextPage endCursor} edges{node{key note ordererNote sellerNote products{itemKey trackingNumber shippingCompanyName}}}}}`;
    const r = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ query: q }) });
    const d = await r.json().catch(() => ({}));
    if (d.errors || !d.data) return { ok: false, updated, message: "오너클랜 주문 조회 실패: " + JSON.stringify(d.errors || d).slice(0, 200) };
    const con = d.data.allOrders;
    for (const { node } of con.edges || []) {
      seen++;
      const m = [node.note, node.ordererNote, node.sellerNote].join(" ").match(/T\d{6}[0-9A-Z]{6}/);
      const o = m && want[m[0]];
      const pr = (node.products || []).find((x) => x.trackingNumber);
      if (!o || !pr) continue;
      const fake = new Request("https://x", { method: "POST", body: JSON.stringify({ orderId: o.orderId, courier: pr.shippingCompanyName || "", tracking: pr.trackingNumber }) });
      const out = await (await adminOrderUpdate(fake, env)).json().catch(() => ({}));
      if (out.ok) { updated++; delete want[o.orderId]; }
    }
    if (!con.pageInfo?.hasNextPage || !Object.keys(want).length) break;
    after = con.pageInfo.endCursor;
  }
  return { ok: true, updated, message: `오너클랜 주문 ${seen}건 확인 → 송장 ${updated}건 자동 입력했어요.${Object.keys(want).length ? ` (아직 송장 없음 ${Object.keys(want).length}건)` : ""}` };
}
async function opsAlert(env) {  // 놓치면 손해·클레임이 되는 일 모아서 알림 (6시간마다)
  const now = Date.now(), h = (t) => (now - Date.parse(t || 0)) / 36e5, L = { po: [], trk: [], claim: [], cancel: [] };
  for (const o of await kvList(env, "order:")) {
    if (o.status === "결제완료" && o.lines.some((l) => !l.po) && h(o.paidAt) > 24) L.po.push(o.orderId);
    if (o.status === "상품준비중" && !o.tracking && h((o.history || []).filter((x) => x.status === "상품준비중").pop()?.at || o.paidAt) > 72) L.trk.push(o.orderId);
    if (/^(반품|교환)요청$/.test(o.status) && h(o.claim?.at) > 48) L.claim.push(o.orderId);
    if (o.status === "취소요청") L.cancel.push(o.orderId);
  }
  const t = [L.cancel.length && `🛑 취소 요청 ${L.cancel.length}건 — 도매처 취소 후 환불: ${L.cancel.slice(0, 5).join(", ")}`,
    L.po.length && `⏰ 결제 후 24시간 넘게 발주 안 한 주문 ${L.po.length}건: ${L.po.slice(0, 5).join(", ")}`,
    L.trk.length && `🚚 발주 후 3일 넘게 송장 없는 주문 ${L.trk.length}건 (도매처 출고 확인): ${L.trk.slice(0, 5).join(", ")}`,
    L.claim.length && `📦 2일 넘게 처리 안 된 반품·교환 ${L.claim.length}건: ${L.claim.slice(0, 5).join(", ")}`].filter(Boolean);
  if (t.length) await notify(env, "📋 담Go사Go 할 일\n" + t.join("\n") + "\n관리자 화면에서 처리해 주세요.").catch(() => {});
}
async function poCron(env) {  // 10분마다: 새 결제 주문 도매처 확인, 1시간마다: 오너클랜 송장 수집, 6시간마다: 할 일 알림
  await poCheckOrders(env, { notifyBad: true }).catch(() => {});
  const lastOps = Number(await env.SHOP.get("ops_at")) || 0;
  if (Date.now() - lastOps > 6 * 36e5) { await env.SHOP.put("ops_at", String(Date.now())); await opsAlert(env).catch(() => {}); }
  const last = Number(await env.SHOP.get("oc_trk_at")) || 0;
  if (Date.now() - last > 55 * 60e3) { await env.SHOP.put("oc_trk_at", String(Date.now())); await ocTrackingSync(env).catch(() => {}); }
}
async function adminOrderBulk(req, env) {  // 주문 여러 건 상태 한 번에 (돈이 오가는 상태는 안 됨)
  const d = await req.json().catch(() => ({}));
  const OK = { 상품준비중: ["결제완료"], 배송완료: ["배송중"], 구매확정: ["배송중", "배송완료"], 교환완료: ["교환요청"] };
  if (!OK[d.status]) return fail("일괄로 바꿀 수 없는 상태예요. (취소·환불·반품은 각 주문에서 처리)");
  const ids = [...new Set((Array.isArray(d.ids) ? d.ids : []).map((x) => String(x).replace(/[^0-9A-Za-z_-]/g, "")))].slice(0, 500);
  let n = 0; const skip = [];
  for (const id of ids) {
    const o = await env.SHOP.get("order:" + id, "json");
    if (!o) { skip.push(id + "(없음)"); continue; }
    if (!OK[d.status].includes(o.status)) { skip.push(`${id}(${o.status})`); continue; }
    const fake = new Request("https://x", { method: "POST", body: JSON.stringify({ orderId: id, status: d.status }) });
    const out = await (await adminOrderUpdate(fake, env)).json().catch(() => ({}));
    if (out.ok) {
      if (d.status === "상품준비중") { const o2 = await env.SHOP.get("order:" + id, "json"); if (o2) { o2.lines.forEach((l) => { l.po ||= new Date().toISOString(); }); await env.SHOP.put("order:" + id, JSON.stringify(o2)); } }  // 상품준비중 = 발주함
      n++;
    } else skip.push(id);
  }
  return json({ ok: true, message: `${n}건을 ‘${d.status}’(으)로 바꿨어요.` + (skip.length ? `\n바꾸지 않은 주문 ${skip.length}건 (지금 상태에서 바꿀 수 없음): ${skip.slice(0, 10).join(", ")}` : "") });
}
async function adminSheetSave(req, env) {  // 관리자가 올린 도매처 공식 대량주문 양식 (열 이름·순서)
  const d = await req.json().catch(() => ({}));
  if (!SOURCE_NAME[d.src]) return fail("도매처가 올바르지 않아요.");
  const all = (await env.SHOP.get("order_sheets", "json")) || {};
  if (d.reset) delete all[d.src];
  else {
    const cols = (Array.isArray(d.cols) ? d.cols : []).map((c) => String(c).trim().slice(0, 60)).filter(Boolean).slice(0, 80);
    if (cols.length < 3) return fail("열 이름을 3개 이상 찾지 못했어요.");
    all[d.src] = { cols, ext: d.ext === "csv" ? "csv" : "xlsx", name: String(d.name || "").slice(0, 80), at: new Date().toISOString() };
  }
  await env.SHOP.put("order_sheets", JSON.stringify(all));
  return json({ ok: true, message: d.reset ? "기본 양식으로 돌렸어요." : `${SOURCE_NAME[d.src]} 양식을 저장했어요. 이제 [대량주문 엑셀 받기]가 이 양식으로 만들어져요.` });
}
async function adminPoDone(req, env) {
  const { items } = await req.json();  // [{orderId, idx}]
  const by = {};
  for (const it of items || []) (by[it.orderId] = by[it.orderId] || []).push(+it.idx);
  let n = 0, skipped = null, cancelReq = null;
  for (const [id, idxs] of Object.entries(by)) {
    const o = await env.SHOP.get("order:" + id, "json");
    if (!o) continue;
    if (!["결제완료", "상품준비중", "취소요청"].includes(o.status)) { (skipped ||= []).push(`${id}(${o.status})`); continue; }
    // 이미 도매처에 발주했으면 취소 요청 중이어도 '발주함'으로 꼭 기록 → 환불 때 "도매처 취소 먼저" 확인이 걸려 손해를 막음
    idxs.forEach((i) => { if (o.lines[i] && !o.lines[i].po) { o.lines[i].po = new Date().toISOString(); n++; } });
    if (o.status === "취소요청") (cancelReq ||= []).push(id);
    if (o.status === "결제완료" && o.lines.every((l) => l.po)) setStatus(o, "상품준비중", { by: "발주" });
    await env.SHOP.put("order:" + id, JSON.stringify(o));
  }
  return json({ ok: true, message: `${n}건 발주 완료로 표시했어요.` + (cancelReq ? `\n⚠️ 발주한 뒤 손님이 취소를 요청한 주문: ${cancelReq.join(", ")}\n발주 기록은 남겨 뒀어요. 도매처에 주문 취소를 요청하고, 이미 출고됐으면 반품으로 처리하세요. (도매처 취소 확인 전에는 환불되지 않게 막아 뒀어요)` : "")
    + (skipped ? `\n건너뛴 주문(이미 취소·환불됨): ${skipped.join(", ")}` : "") });
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
// 환불 전 안전 확인: 손해 날 수 있는 경우 관리자에게 한 번 더 묻기 (409 + need). 확인한 항목은 ok 목록으로 다시 보냄
const SRC_KO = SOURCE_NAME;
function refundRisk(o, d, amt) {
  const ok = Array.isArray(d.ok) ? d.ok : [];
  const ordered = o.lines.some((l) => l.po) || o.status === "상품준비중";
  const srcs = [...new Set(o.lines.filter((l) => l.po).map((l) => SRC_KO[srcOf(l)] || "공급사"))].join("·") || "도매처";
  if (ordered && ["결제완료", "상품준비중", "취소요청"].includes(o.status) && !ok.includes("ws_cancel"))
    return { need: "ws_cancel", message: `이 주문은 이미 ${srcs}에 발주했어요.\n${srcs}에서 주문 취소가 완료됐나요?\n(취소 안 하고 환불하면 상품이 그대로 나가서 상품값만큼 손해예요)` };
  if (["배송중", "배송완료", "구매확정"].includes(o.status) && !ok.includes("shipped"))
    return { need: "shipped", message: "이미 출고된 주문이에요. 반품 회수 없이 환불하면 상품값만큼 손해예요.\n그래도 환불할까요?" };
  if (o.status === "반품요청" && !ok.includes("retrieved"))
    return { need: "retrieved", message: `${srcs}에서 반품 상품 회수(도착)가 확인됐나요?\n(회수 전에 환불하면 상품을 못 돌려받을 수 있어요)` };
  const left = o.amount - (o.refunded || 0), want = amt || left;
  if (o.claim && o.claim.refund != null && want > o.claim.refund && !ok.includes("over"))
    return { need: "over", message: `단순 변심 반품이라 배송비 ${won0(o.claim.deduct)}원을 뺀 ${won0(o.claim.refund)}원만 환불하는 게 맞아요.\n그래도 ${won0(want)}원을 환불할까요?` };
  return null;
}
async function adminSoldoutCancel(req, env) {
  const d = await req.json();
  const { orderId } = d;
  const o = await env.SHOP.get("order:" + orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (!["결제완료", "상품준비중", "취소요청"].includes(o.status)) return fail("출고 전 주문만 품절 취소할 수 있어요.");
  const risk = refundRisk(o, d, 0); if (risk) return json(risk, 409);
  const left = o.amount - (o.refunded || 0);
  const c = await payCancel(env, o, "상품 품절로 인한 주문 취소");
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
  const d = await req.json();
  const { orderId, reason, amount } = d;
  const o = await env.SHOP.get("order:" + orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (o.status === "취소완료" || o.status === "반품완료") return fail("이미 환불된 주문이에요.");
  const amt = parseInt(amount) || 0;
  if (amt && amt > o.amount - (o.refunded || 0)) return fail("환불 금액이 결제 금액보다 커요.");
  if (!(o.amount - (o.refunded || 0) > 0)) return fail("더 환불할 금액이 없어요.");
  const risk = refundRisk(o, d, amt); if (risk) return json(risk, 409);
  if (o.claim) { o.claim.steps = o.claim.steps || {}; for (const k of (d.ok || [])) if (k === "retrieved" || k === "ws_cancel") o.claim.steps[k === "retrieved" ? "retrieved" : "ws"] ||= new Date().toISOString(); }
  const c = await payCancel(env, o, clip(reason, 100) || "판매자 취소", amt || undefined);
  if (!c.ok) return fail(c.message);
  o.refunded = (o.refunded || 0) + (amt || o.amount - (o.refunded || 0));
  setStatus(o, amt && o.refunded < o.amount ? o.status : (o.status.startsWith("반품") ? "반품완료" : "취소완료"), { refund: amt || "전액", reason: clip(reason, 200) });
  if (o.claim) o.claim.status = "완료";
  await env.SHOP.put("order:" + orderId, JSON.stringify(o));
  return json({ ok: true });
}

async function adminClaimStep(req, env) {  // 취소·반품·교환 진행 단계 표시 (도매처 신청 → 회수 확인 → 환불/교환 발송)
  const d = await req.json().catch(() => ({}));
  const o = await env.SHOP.get("order:" + d.orderId, "json");
  if (!o) return fail("주문을 찾을 수 없어요.");
  if (!["ws", "retrieved", "resent"].includes(d.step)) return fail("단계가 올바르지 않아요.");
  o.claim = o.claim || { type: o.status.replace(/요청$/, ""), at: new Date().toISOString(), status: "접수" };
  o.claim.steps = o.claim.steps || {};
  if (d.undo) delete o.claim.steps[d.step]; else o.claim.steps[d.step] = new Date().toISOString();
  if (d.step === "resent" && !d.undo && o.status === "교환요청") { o.claim.status = "완료"; setStatus(o, "교환완료"); }
  await env.SHOP.put("order:" + o.orderId, JSON.stringify(o));
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
    donation: donationOf(all, PRICING(env), Number(env.DONATION_RATE ?? 0.005)),
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

// 사진 대신 받아주기: 도매처 사진 중 http 전용이거나 다른 사이트에서 못 보게 막아둔 것(이미지 점검이 고른 것만)을 서버가 받아서 보여줌
async function imgProxy(req) {
  const u = new URL(req.url).searchParams.get("u") || "";
  let t;
  try { t = new URL(u); } catch (e) { return new Response("bad", { status: 400 }); }
  if (!/^https?:$/.test(t.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(t.hostname)) return new Response("bad", { status: 400 });
  const cache = caches.default, key = new Request("https://img-cache/" + encodeURIComponent(u));
  const hit = await cache.match(key);
  if (hit) return hit;
  let r;
  try { r = await fetch(t.toString(), { headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" }, cf: { cacheTtl: 604800, cacheEverything: true } }); } catch (e) { return new Response("fail", { status: 502 }); }
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !ct.startsWith("image/")) return new Response("fail", { status: 502 });
  const out = new Response(r.body, { headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*" } });
  try { await cache.put(key, out.clone()); } catch (e) {}
  return out;
}

/** 공통 처리기: Cloudflare·Netlify 둘 다 사용 */
export async function handle(req, env, path) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  path = path || new URL(req.url).pathname;
  if (path === "/img") return imgProxy(req);
  if (path === "/health") {  // 상태 점검 (비밀값은 노출하지 않고 설정 여부만)
    const pw = String(env.ADMIN_PASSWORD || "").trim();
    return json({ ok: true, version: "2026-11-13d", login: auth.loginStatus(env), tracking: tracking.trackReady(env) ? "켜짐" : "꺼짐 (택배사 바로가기만)", adminPassword: pw ? `설정됨 (${[...pw].length}자)` : "없음",
      kv: !!env.SHOP, catalog: env.DB ? "상품 DB 연결됨" : "없음 (products.json 사용)", email: env.BREVO_API_KEY && env.MAIL_FROM ? "켜짐" : "꺼짐", kakao: kakaoReady(env) ? `켜짐 (템플릿 ${Object.keys(TEMPLATES).filter((k) => env["KAKAO_TPL_" + k]).length}/${Object.keys(TEMPLATES).length})` : "꺼짐 (키 없음)", toss: env.TOSS_SECRET_KEY ? (String(env.TOSS_SECRET_KEY).startsWith("test_") ? "테스트 키" : "실제 키") : "없음", portone: env.PORTONE_API_SECRET ? `켜짐 (${String(env.PORTONE_API_SECRET).trim().length}자)` : "없음" });
  }
  if (req.method === "POST" && path === "/oc/scan") {  // 오너클랜 상품 목록 한 쪽 (깃허브 대량 수집용, 관리자 비밀번호 필요)
    const pw = String(env.ADMIN_PASSWORD || "").trim(), got = String(req.headers.get("x-admin-pass") || "").trim();
    if (!pw || got.length !== pw.length || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(got), new TextEncoder().encode(pw))) return fail("권한 없음", 403);
    const d = await req.json().catch(() => ({}));
    const tok = await ocToken(env);
    if (!tok) return fail("오너클랜 로그인 실패", 502);
    const first = Math.min(1000, Math.max(1, +d.first || 100));
    const args = [`first:${first}`, "status:available"];
    if (d.after) args.push(`after:${JSON.stringify(String(d.after))}`);
    if (d.category) args.push(`category:${JSON.stringify(String(d.category))}`);
    if (d.sortBy) args.push(`sortBy:${String(d.sortBy).replace(/[^a-zA-Z]/g, "")}`);
    const fields = d.full ? "key name price fixedPrice shippingFee shippingType status adultOnly openmarketSellable boxQuantity origin model production taxFree images options{quantity status price optionAttributes{name value}} metadata content"
      : "key name price shippingFee shippingType status adultOnly openmarketSellable boxQuantity metadata";
    const t0 = Date.now();
    const r = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: `query{allItems(${args.join(",")}){pageInfo{hasNextPage endCursor} edges{node{${fields}}}}}` }) });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (e) {}
    const c = (j.data || {}).allItems || {};
    return json({ ms: Date.now() - t0, status: r.status, page: c.pageInfo || null, items: (c.edges || []).map((e) => e.node), errors: (j.errors || []).map((e) => String(e.message).slice(0, 200)), raw: j.data ? undefined : txt.slice(0, 300) });
  }
  if (req.method === "POST" && path === "/oc/items") {  // 오너클랜 재고·가격 조회 (깃허브 매일 점검용 — 깃허브는 오너클랜이 막아서 서버가 대신 조회)
    const pw = String(env.ADMIN_PASSWORD || "").trim(), got = String(req.headers.get("x-admin-pass") || "").trim();
    if (!pw || got.length !== pw.length || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(got), new TextEncoder().encode(pw))) return fail("권한 없음", 403);
    const d = await req.json().catch(() => ({}));
    const keys = (Array.isArray(d.keys) ? d.keys : []).map(String).filter((k) => /^W[0-9A-Z]{6}$/.test(k)).slice(0, 100);
    const tok = await ocToken(env);
    if (!tok) return fail("오너클랜 로그인 실패", 502);
    const r = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: `query{itemsByKeys(keys:${JSON.stringify(keys)}){key status price shippingFee shippingType boxQuantity options{quantity status price optionAttributes{name value}}}}` }) });
    const j = await r.json().catch(() => ({}));
    return json({ items: ((j.data || {}).itemsByKeys || []).filter(Boolean), errors: (j.errors || []).map((e) => String(e.message).slice(0, 120)) });
  }
  if (req.method === "GET" && path === "/oc/schema") {  // 오너클랜 API 구조 (상품·주문 형식) — 1분 1회, 토큰 노출 없음
    if (await env.SHOP.get("ocschema")) return json({ message: "1분 뒤에 다시 시도해 주세요." });
    await env.SHOP.put("ocschema", "1", { expirationTtl: 60 });
    const tok = await ocToken(env);
    if (!tok) return json({ auth: "실패" });
    const g = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: "query{__schema{queryType{fields{name args{name type{name kind ofType{name kind}}} type{name kind ofType{name}}}} types{name kind fields{name args{name} type{name kind ofType{name kind ofType{name}}}} inputFields{name type{name kind ofType{name}}} enumValues{name}}}}" }) });
    const d = await g.json().catch(() => ({}));
    const sc = (d.data || {}).__schema || {};
    const types = (sc.types || []).filter((t) => /^(Item|Order|Shipping|Product|Option)/.test(t.name || ""));
    const sample = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: "query{allItems(first:1){edges{node{key}}}}" }) }).then((r) => r.json()).catch(() => ({}));
    return json({ query: ((sc.queryType || {}).fields || []).map((f) => ({ n: f.name, a: (f.args || []).map((x) => x.name + ":" + ((x.type || {}).name || ((x.type || {}).ofType || {}).name)) })), types, sample });
  }
  if (req.method === "GET" && path === "/oc/ping") {  // 오너클랜 API가 우리 서버에서 열리는지 확인 (아이디·토큰은 보여주지 않음, 1분 1회)
    if (await env.SHOP.get("ocping")) return json({ message: "1분 뒤에 다시 시도해 주세요." });
    await env.SHOP.put("ocping", "1", { expirationTtl: 60 });
    if (!env.OWNERCLAN_ID || !env.OWNERCLAN_PW) return json({ auth: "아이디·비밀번호 없음" });
    const a = await fetch("https://auth.ownerclan.com/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "ownerclan", userType: "seller", username: env.OWNERCLAN_ID, password: env.OWNERCLAN_PW }) });
    const at = await a.text();
    if (!a.ok) return json({ auth: a.status, body: at.slice(0, 160).replace(/[A-Za-z0-9_-]{30,}/g, "…") });
    let tok = at.trim().replace(/^"|"$/g, ""); try { if (tok.startsWith("{")) tok = JSON.parse(tok).token || tok; } catch (e) {}
    const q = async (query) => { const g = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ query }) }); return g.status + " " + (await g.text()).slice(0, 300); };
    return json({ auth: a.status,
      fields: await q("query{__schema{queryType{fields{name}}}}"),
      item: await q('query{item(key:"W000000"){key name}}'),
      orders: await q("query{allOrders(first:1){edges{node{key}}}}"),
      items: await q("query{allItems(first:1){edges{node{key}}}}") });
  }
  if (path === "/onch/files") {  // 온채널 매일 점검: 브라우저가 만든 엑셀 파일 이름을 받아 두면 깃허브가 가져가 반영
    if (req.method === "GET") return json((await env.SHOP.get(new URL(req.url).searchParams.get("bulk") ? "onch_bulk" : "onch_files", "json")) || {});
    if (req.method === "POST") {
      const d = await req.json().catch(() => ({}));
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(d.key || ""))))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== "f2855deba60152be96a93c35e81902bd8a5f36e3cf79ce13a91ed659d4b54ed8") return fail("권한 없음", 403);
      const ok = (arr) => (Array.isArray(arr) ? arr : []).map((f) => String(f).split("/").pop()).filter((f) => /^product_smartstore_\d{14}_[0-9a-f]{10,20}\.xlsx$/.test(f));
      const groups = {};
      for (const [g, v] of Object.entries(d.groups || { office: { files: d.files, expected: d.expected } })) {
        if (!/^[a-z]{2,12}$/.test(g)) continue;
        groups[g] = { files: ok(v && v.files), expected: Number(v && v.expected) || 0 };
      }
      const files = Object.values(groups).flatMap((g) => g.files);
      const bulk = !!d.bulk;  // 대량 수집(상품 창고용)은 매일 점검과 따로 보관
      if (!files.length || files.length > (bulk ? 3000 : 400)) return fail("파일 목록이 이상해요.");
      await env.SHOP.put(bulk ? "onch_bulk" : "onch_files", JSON.stringify({ at: Date.now(), groups }));
      return json({ ok: true, n: files.length });
    }
  }
  if (req.method === "GET" && path === "/db_removed") {  // 사진이 없어 서버가 바로 내린 상품 번호 (상품 DB 채우기·사이트 빌드가 참고)
    const rm = (await env.SHOP.get("db_removed", "json")) || {};
    const b = (await env.SHOP.get("broken", "json")) || {};  // 이 기록을 남기기 전(11/17 저녁)에 신고로 내린 상품도 다시 확인하게 포함
    for (const [id, at] of Object.entries(b)) if (at >= "2026-11-17T10:00" && at < "2026-11-17T14:00" && !rm[id]) rm[id] = new Date().toISOString().slice(0, 10) + "T00:00:00+00:00";
    return json(rm);
  }
  if (req.method === "GET" && path.startsWith("/pimg/")) {  // 관리자가 올린 상품 사진
    const k = path.slice(6).replace(/[^0-9a-z.]/g, "");
    const { value, metadata } = await env.SHOP.getWithMetadata("pimg:" + k, "arrayBuffer");
    if (!value) return new Response("not found", { status: 404 });
    return new Response(value, { headers: { "Content-Type": (metadata && metadata.type) || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" } });
  }
  if (req.method === "GET" && path === "/seo-auto/req") {  // 깃허브가 30분마다 확인: 실행할 요청이 있는지 (가져가면 taken 표시)
    let r = await env.SHOP.get("seo_auto_req", "json");
    if (r && r.taken && Date.now() - Date.parse(r.taken) > 7 * 3600e3) { await env.SHOP.delete("seo_auto_req"); r = null; }  // 실행이 중간에 끊긴 요청 정리
    const daily = (await env.SHOP.get("seo_auto_daily")) === "1";
    if (r && !r.taken && new URL(req.url).searchParams.get("take") === "1") { r.taken = new Date().toISOString(); await env.SHOP.put("seo_auto_req", JSON.stringify(r)); return json({ req: { ...r, taken: undefined }, daily }); }
    return json({ req: r && !r.taken ? r : null, running: !!(r && r.taken), daily });
  }
  if (req.method === "GET" && path === "/edits/one") {  // 이 상품을 관리자가 마지막으로 고친 시각 (상품 페이지가 최신인지 확인)
    const id = String(new URL(req.url).searchParams.get("id") || "");
    const e = (((await env.SHOP.get("product_edits", "json")) || {}).items || {})[id];
    return json({ at: e ? e.at : null }, 200, { "Cache-Control": "public, max-age=20" });
  }
  if (req.method === "GET" && path === "/edits/big") {  // 상세·사진·옵션 수정본 (사이트 빌드·상품 DB 채우기용) ?ids=a,b,c
    const ids = String(new URL(req.url).searchParams.get("ids") || "").split(",").map((x) => x.replace(/[^0-9A-Za-z_-]/g, "")).filter(Boolean).slice(0, 100);
    const out = {};
    await Promise.all(ids.map(async (i) => { const v = await env.SHOP.get("pedit:" + i, "json"); if (v) out[i] = v; }));
    return json(out);
  }
  if (req.method === "GET" && path === "/edits/seo") {  // SEO 수정본 한 칸 (사이트 빌드·상품 DB 반영용)
    const b = parseInt(new URL(req.url).searchParams.get("b"));
    if (!(b >= 0 && b < SEO_B)) return json({ n: SEO_B, ver: (await env.SHOP.get("seo_ver")) || "0" });
    return new Response((await env.SHOP.get("seo:" + b)) || "{}", { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  if (req.method === "GET" && path === "/edits") {  // 관리자 상품 수정 내역 (사이트 빌드 때 반영) — ver에 SEO 수정 시각도 합쳐서, SEO만 바뀌어도 다시 배포
    const ed = (await env.SHOP.get("product_edits", "json")) || { ver: 0, items: {} };
    const sv = await env.SHOP.get("seo_ver");
    return json(sv ? { ...ed, ver: `${ed.ver}-${sv}` } : ed);
  }
  if (req.method === "GET" && path.startsWith("/catalog/")) {  // 상품 DB 조회 (공개, 1분 캐시)
    if (!env.DB) return fail("상품 DB가 아직 연결되지 않았어요.", 503);
    const u = new URL(req.url).searchParams, cache = { "Cache-Control": "public, max-age=60" };
    // 무료 DB 하루 읽기 한도(500만 줄)를 아끼려고 같은 요청은 서버 캐시에서 (목록 5분, 개수 1시간, 상품 2분)
    const ttl = path === "/catalog/counts" || path === "/catalog/popular" ? 3600 : path === "/catalog/list" ? 300 : 120;
    const ck = new Request("https://catalog-cache" + path + "?" + [...u.entries()].filter(([k]) => k !== "x").sort().map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&"));
    const hit = await caches.default.match(ck).catch(() => null);
    if (hit) { const r = new Response(hit.body, hit); for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; }
    const keep = async (res) => {
      if (res.status === 200) { const c = res.clone(); const h = new Headers(c.headers); h.set("Cache-Control", "public, max-age=" + ttl); await caches.default.put(ck, new Response(c.body, { status: 200, headers: h })).catch(() => {}); }
      return res;
    };
    try {
      if (path === "/catalog/list") return keep(json(await catalog.list(env.DB, { q: u.get("q") || "", cat: u.get("cat") || "", sort: u.get("sort") || "rec", page: u.get("page"), size: u.get("size"), free: u.get("free") || 0 }), 200, cache));
      if (path === "/catalog/item") { const it = await catalog.item(env.DB, u.get("id")); return it ? keep(json(it, 200, cache)) : fail("상품을 찾을 수 없어요.", 404); }
      if (path === "/catalog/counts") return keep(json(await catalog.counts(env.DB), 200, cache));
      if (path === "/catalog/popular") {  // 인기 순위: 최근 7일 상품 페이지 조회수 (사이트 분석 기록) + 추천순
        const views = {};
        for (let i = 0; i < 7 && env.SHOP; i++) {
          const s = await env.SHOP.get("stat:" + stats.dayKey(Date.now() - i * 864e5), "json").catch(() => null);
          for (const [pth, n] of Object.entries((s && s.pages) || {})) { const m = pth.match(/\/product\/([^/]+)\.html$/); if (m) views[m[1]] = (views[m[1]] || 0) + n; }
        }
        const pin = String(env.POPULAR_PIN || "").split(",").map((x) => x.trim()).filter(Boolean);
        return keep(json({ items: await catalog.popular(env.DB, views, 10, pin) }, 200, cache));
      }
    } catch (e) { return fail("상품 조회 중 오류가 났어요. (" + String(e && e.message || e).slice(0, 160) + ")", 500); }
    return fail("Not found", 404);
  }
  if (req.method === "GET" && path.startsWith("/auth/")) {  // 네이버·카카오·구글 로그인
    if (!env.SHOP) return fail("서버 저장소가 없어요.", 503);
    const base = env.API_URL ? String(env.API_URL).replace(/\/$/, "") : req.url.split("?")[0].slice(0, -path.length);  // API_URL: 서버 공개 주소(선택)
    if (path === "/auth/start") return await auth.start(req, env, base);
    const m = path.match(/^\/auth\/callback\/(naver|kakao|google)$/);
    // 관리자 카카오톡 알림 연결: 이미 등록된 카카오 로그인 주소로 돌아옴 (주소를 따로 등록하지 않아도 되게)
    const st0 = new URL(req.url).searchParams.get("state") || "";
    if (m && m[1] === "kakao" && st0.startsWith("adm_")) {
      const site = (env.SITE_URL || "https://damgosago.com").replace(/\/$/, "");
      const ok = await env.SHOP.get("kadm:" + st0);
      const code = new URL(req.url).searchParams.get("code");
      if (!ok || !code) return Response.redirect(site + "/admin.html?kakao=" + encodeURIComponent(ok ? "취소했어요." : "시간이 지났어요. 다시 눌러 주세요."), 302);
      await env.SHOP.delete("kadm:" + st0);
      let msg = "ok";
      try {
        await kakaoToken(env, { grant_type: "authorization_code", redirect_uri: `${base}/auth/callback/kakao`, code });
        if (!(await kakaoMemo(env, "✅ 담Go사Go 알림이 연결되었습니다. 이제 주문·가격 제안·문의가 들어오면 이 채팅으로 알려드려요."))) msg = "연결은 됐는데 테스트 알림을 못 보냈어요. 동의항목 ‘카카오톡 메시지 전송’을 확인해 주세요.";
      } catch (e) { msg = "카카오 연결 실패: " + e.message; }
      return Response.redirect(site + "/admin.html?kakao=" + encodeURIComponent(msg), 302);
    }
    if (m) return await auth.callback(req, env, base, m[1]);
    return fail("Not found", 404);
  }
  if (req.method !== "POST") return fail("Not found", 404);
  try {
    if (["/inquiry/add", "/qna/add", "/review/add", "/seller/apply", "/seller/product", "/report-price"].includes(path) && (await overLimit(env, "w:" + ipOf(req), 20, 3600)))
      return fail("잠시 후 다시 시도해 주세요. (짧은 시간에 너무 많이 보냈어요)", 429);
    // 장난 막기: 휴대폰 통신사·회사처럼 여러 사람이 같은 IP를 쓰므로 IP 제한은 넉넉하게, 쿠폰 번호 맞히기·제안 도배만 막음
    // (주문 조회·취소의 연락처 맞히기는 주문번호별 '틀린 횟수'로 막음 → findOrder)
    const RL = { "/coupon/check": 200, "/offer/add": 60 };
    if (RL[path] && (await overLimit(env, "rl2:" + path + ":" + ipOf(req), RL[path], 3600)))
      return fail("짧은 시간에 너무 많이 시도했어요. 잠시 후 다시 시도해 주세요.", 429);
    if (path === "/confirm") return await confirm(req, env);
    if (path === "/portone/webhook") {  // 포트원 결제 알림: 손님이 결제 후 사이트로 안 돌아와도 주문 저장(결제 상태는 포트원 API로 다시 확인)
      const b = await req.json().catch(() => ({}));
      const pid = b?.data?.paymentId || b?.payment_id || b?.paymentId;
      if (pid && /Paid|paid/.test(String(b.type || b.status || "Paid")) && !(await env.SHOP.get("order:" + pid)) && (await env.SHOP.get("po_pre:" + pid))) {
        await confirm(new Request("https://x/confirm", { method: "POST", body: JSON.stringify({ pg: "portone", paymentId: pid, orderId: pid }) }), env);
      }
      return json({ ok: true });
    }
    if (path === "/stock/check") {  // 결제창 열기 전 재고 확인 (손님 화면용)
      const d = await req.json().catch(() => ({}));
      if (d.phone && (await isBlocked(env, d.phone))) return fail("주문이 제한된 연락처예요. 고객센터로 문의해 주세요.");
      const its = Array.isArray(d.items) ? d.items.slice(0, 50) : [];
      const map = await productMap(env, its.map((x) => x.id));
      const lines = [];
      for (const it of its) {
        const p = map[it.id]; if (!p) continue;
        if (p.soldout) return fail(`일시품절된 상품이 있어요: ${p.name}`);
        const o = it.opt != null && it.opt !== "" ? (p.options || [])[Number(it.opt)] : null;
        const qt = Array.isArray(p.qt) ? p.qt : JSON.parse(p.qt || "[]");
        const qty = Math.max(1, Math.min(99, parseInt(it.qty) || 1));
        lines.push({ id: p.id, name: p.name, qty, option: o ? o.v : "", price: (qt.length ? Number(qt[Math.min(qty, qt.length) - 1]) : Number(p.price)) + (o ? o.add : 0) });
      }
      const r = await live.check({ ...env, __ocToken: () => ocToken(env) }, lines, PRICING(env));
      return r.ok ? json({ ok: true }) : fail(r.message);
    }
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
        lines.push({ unit: (qt.length ? Number(qt[Math.min(qn[it.id], qt.length) - 1]) : Number(p.price)) + add, list: (qt.length ? Number(qt[0]) : Number(p.price)) + add, qty, mp: Number(p.mp) || 0 });
      }
      return json({ discount: memberDiscount(lines, { ...MEMBER_DEFAULT, rate: +(env.MEMBER_DISCOUNT ?? MEMBER_DEFAULT.rate) }) });
    }
    if (path === "/track/broken") {  // 사진이 안 뜨는 상품 신고 (손님 브라우저가 자동으로)
      const d = await req.json().catch(() => ({}));
      const id = String(d.id || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 30);
      if (id) { const b = (await env.SHOP.get("broken", "json")) || {}; if (!b[id]) { b[id] = new Date().toISOString(); await env.SHOP.put("broken", JSON.stringify(b)); } }
      // 서버가 직접 사진을 받아보고 정말 없으면 상품 DB에서 바로 내림 (거짓 신고로 내려가지 않게 확인 후)
      if (id && env.DB) {
        const r = await env.DB.prepare("SELECT image FROM products WHERE id = ?").bind(id).first().catch(() => null);
        if (r && r.image && /^https?:\/\//.test(r.image) && !(await imgAlive(r.image))) {
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run().catch(() => {});
          const rm = (await env.SHOP.get("db_removed", "json")) || {}; rm[id] = new Date().toISOString();  // 상품 DB 채우기가 이 목록을 보고 상태를 맞춤
          await env.SHOP.put("db_removed", JSON.stringify(Object.fromEntries(Object.entries(rm).slice(-5000))));
          return json({ ok: true, removed: true });
        }
      }
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
    if (path === "/order/find") { if (await overLimit(env, "find:" + ipOf(req), 30, 3600)) return fail("잠시 후 다시 시도해 주세요.", 429); return await orderFind(req, env); }
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
      const READ_ONLY = ["/admin/seo-auto-status", "/admin/product-get", "/admin/catalog-export", "/admin/list", "/admin/po", "/admin/analytics", "/admin/product-edits", "/admin/order-search", "/admin/customers", "/admin/log", "/admin/export"];
      if (!READ_ONLY.includes(path)) await adminLog(env, path, ip, "").catch(() => {});
      if (path === "/admin/list") return await adminList(env);
      if (path === "/admin/kakao-connect") return await adminKakaoConnect(req, env);
      if (path === "/admin/kakao-start") {  // 카카오톡 알림 연결 시작 주소 (로그인용으로 이미 등록된 돌아올 주소 사용)
        if (!env.KAKAO_REST_KEY) return fail("서버에 KAKAO_REST_KEY가 아직 없어요.");
        const st = "adm_" + crypto.randomUUID().replace(/-/g, "");
        await env.SHOP.put("kadm:" + st, "1", { expirationTtl: 600 });
        const base = env.API_URL ? String(env.API_URL).replace(/\/$/, "") : new URL(req.url).origin;
        return json({ url: "https://kauth.kakao.com/oauth/authorize?" + new URLSearchParams({ client_id: env.KAKAO_REST_KEY, redirect_uri: `${base}/auth/callback/kakao`, response_type: "code", scope: "talk_message", state: st }) });
      }
      if (path === "/admin/kakao-test") return await adminKakaoTest(env);
      if (path === "/admin/push-subscribe") return await pushSubscribe(env, (await req.json()).sub, "admin");
      if (path === "/admin/push-test") { const n = await pushTo(env, "admin", { title: "담Go사Go 관리자", body: "🔔 테스트 알림입니다.", url: siteLink(env, "admin.html") }); return n ? json({ ok: true, message: `${n}대 기기로 보냈어요.` }) : fail("알림을 켠 기기가 없어요."); }
      if (path === "/admin/approve-seller") return await approveSeller(req, env);
      if (path === "/admin/approve-product") return await approveProduct(req, env);
      if (path === "/admin/reject-product") return await rejectProduct(req, env);
      if (path === "/admin/close-report") return await closeReport(req, env);
      if (path === "/admin/order-update") return await adminOrderUpdate(req, env);
      if (path === "/admin/order-cancel") return await adminOrderCancel(req, env);
      if (path === "/admin/claim-step") return await adminClaimStep(req, env);
      if (path === "/admin/sheet-save") return await adminSheetSave(req, env);
      if (path === "/admin/order-bulk") return await adminOrderBulk(req, env);
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
      if (path === "/admin/portone-sync") return json(await portoneSync(env));
      if (path === "/admin/claim-photo") { const b = await req.json().catch(() => ({})); const d = await env.SHOP.get(`claimimg:${b.orderId}:${parseInt(b.i) || 0}`); return d ? json({ data: d }) : fail("사진이 없어요.", 404); }
      if (path === "/admin/offer-reply") return await adminOfferReply(req, env);
      if (path === "/admin/catalog-export") return await catalogExport(req, env);
      if (path === "/admin/seo-upload") return await seoUpload(req, env);
      if (path === "/admin/seo-auto-req") return await seoAutoReq(req, env);
      if (path === "/admin/seo-auto-report") return await seoAutoReport(req, env);
      if (path === "/admin/seo-restore") return await seoRestore(req, env);
      if (path === "/admin/seo-auto-status") return json({ req: await env.SHOP.get("seo_auto_req", "json"), report: await env.SHOP.get("seo_auto_report", "json"), runs: (await env.SHOP.get("seo_runs", "json")) || [], daily: (await env.SHOP.get("seo_auto_daily")) === "1" });
      if (path === "/admin/product-edits") return json((await env.SHOP.get("product_edits", "json")) || { ver: 0, items: {} });
      if (path === "/admin/product-save") return await adminProductSave(req, env);
      if (path === "/admin/product-get") return await adminProductGet(req, env);
      if (path === "/admin/po-check") return json(await poCheckOrders(env, { force: true }));
      if (path === "/admin/oc-tracking-sync") return json(await ocTrackingSync(env));
      if (path === "/admin/product-img") return await adminProductImg(req, env);
      if (path === "/admin/product-bulk") return await adminProductBulk(req, env);
      if (path === "/admin/order-search") return await adminOrderSearch(req, env);
      if (path === "/admin/customers") return await adminCustomers(env);
      if (path === "/admin/block") return await adminBlock(req, env);
      if (path === "/admin/site-save") return await adminSiteSave(req, env);
      if (path === "/admin/po-mark") { const d = await req.json().catch(() => ({})); let n = 0; for (const id of (d.ids || []).slice(0, 500)) { const o = await env.SHOP.get("order:" + id, "json"); if (o && !o.poSheetAt) { o.poSheetAt = new Date().toISOString(); await env.SHOP.put("order:" + id, JSON.stringify(o)); n++; } } return json({ ok: true, marked: n }); }
      if (path === "/admin/log") return json({ log: (await env.SHOP.get("adminlog", "json")) || [] });
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail("서버 오류: " + e.message, 500);
  }
}

// 오너클랜 판매사 API 토큰 (서버에서만, 50분 보관)
async function ocToken(env) {
  if (!env.OWNERCLAN_ID || !env.OWNERCLAN_PW) return "";
  const c = await env.SHOP.get("oc_tok");
  if (c) return c;
  const a = await fetch("https://auth.ownerclan.com/auth", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service: "ownerclan", userType: "seller", username: env.OWNERCLAN_ID, password: env.OWNERCLAN_PW }) });
  if (!a.ok) return "";
  let tok = (await a.text()).trim().replace(/^"|"$/g, "");
  try { if (tok.startsWith("{")) tok = JSON.parse(tok).token || tok; } catch (e) {}
  await env.SHOP.put("oc_tok", tok, { expirationTtl: 3000 });
  return tok;
}

// 상품 DB가 대량 반영 중이라 잠깐 바쁠 때(일시 오류) 0.2·0.6초 쉬고 다시 시도 — 손님 화면에 오류가 안 뜨게
function retryDB(db) {
  if (!db || db.__retry) return db;
  const again = async (fn) => { let e; for (const w of [0, 200, 600]) { if (w) await new Promise((r) => setTimeout(r, w)); try { return await fn(); } catch (x) { e = x; if (/no such|syntax|constraint/i.test(String(x))) break; } } throw e; };
  const wrap = (st) => ({ bind: (...a) => wrap(st.bind(...a)), first: (...a) => again(() => st.first(...a)), all: () => again(() => st.all()), run: () => again(() => st.run()), raw: (...a) => again(() => st.raw(...a)), __st: st });
  return { __retry: true, prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => again(() => db.batch(list.map((x) => x.__st || x))), exec: (q) => db.exec(q), dump: () => db.dump() };
}
export default { fetch: (req, env) => handle(req, env.DB ? { ...env, DB: retryDB(env.DB) } : env), scheduled: (ev, env, ctx) => ctx.waitUntil(ev.cron === "*/10 * * * *" ? Promise.all([portoneSync(env), poCron(env)]) : trackSweep(env)) };  // 정기 실행: 배송 단계 확인
