/**
 * 사이트 분석 (무료, 자체 집계)
 *  - 방문 기록: POST /track/visit {vid, path, src} → 하루 단위 집계 stat:YYYY-MM-DD (방문자 수·페이지뷰·유입경로·많이 본 페이지)
 *  - 관리자 분석: 기간별 방문·주문·매출·추정 원가·순이익·가입·리뷰·반품·발주, 인기 상품, 유입경로별 매출, 세금(부가세·종소세) 예상
 * 원가: 주문 줄에 cost가 있으면 그 값, 없으면 판매가에서 가격 공식(순마진 12%·최소 1,500원·카드 3.4%·운영비 300원)을 거꾸로 풀어 추정
 */
const KST = (d = new Date()) => new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString();
export const dayKey = (d) => KST(d).slice(0, 10);

// 유입경로 이름 정리
export function sourceOf(ref, utm) {
  if (utm) return String(utm).toLowerCase().slice(0, 30);
  if (!ref) return "직접 방문";
  let h = "";
  try { h = new URL(ref).hostname.replace(/^www\./, ""); } catch (e) { return "기타"; }
  const map = [[/naver\.com|naver\.me/, "네이버"], [/google\./, "구글"], [/daum\.net|kakao\.com/, "다음·카카오"], [/instagram\.com/, "인스타그램"], [/facebook\.com|fb\.me/, "페이스북"],
    [/youtube\.com|youtu\.be/, "유튜브"], [/threads\.net/, "스레드"], [/tistory\.com/, "티스토리"], [/blogger|blogspot/, "블로거"], [/bing\.com/, "빙"], [/coupang\.com/, "쿠팡"]];
  for (const [re, n] of map) if (re.test(h)) return n;
  return h.slice(0, 40);
}

export async function visit(env, d) {
  if (!env.SHOP) return;
  const key = "stat:" + dayKey();
  const s = (await env.SHOP.get(key, "json")) || { pv: 0, uv: 0, vids: [], src: {}, pages: {} };
  s.pv++;
  const vid = String(d.vid || "").slice(0, 24);
  if (vid && !s.vids.includes(vid)) {
    s.vids.push(vid); s.uv++;
    if (s.vids.length > 20000) s.vids = s.vids.slice(-20000);
    const src = sourceOf(d.ref, d.utm);
    s.src[src] = (s.src[src] || 0) + 1;  // 유입경로는 그날 처음 온 방문자 기준
  }
  const path = String(d.path || "/").replace(/\?.*$/, "").slice(0, 80);
  s.pages[path] = (s.pages[path] || 0) + 1;
  if (Object.keys(s.pages).length > 400) s.pages = Object.fromEntries(Object.entries(s.pages).sort((a, b) => b[1] - a[1]).slice(0, 300));
  await env.SHOP.put(key, JSON.stringify(s), { expirationTtl: 60 * 60 * 24 * 800 });
}

// 판매가 → 원가 추정 (가격 공식을 거꾸로)
export function costFromPrice(price, P = {}) {
  const net = P.net_margin ?? 0.12, minM = P.min_margin_won ?? 1500, card = P.card_fee ?? 0.034, ops = P.ops_cost_won ?? 300;
  const k = 1 - card - 1 / 11;
  let c = (price * k - ops) / (10 / 11 + net);       // 순마진 비율 구간
  if (c * net < minM) c = (price * k - ops - minM) * 11 / 10;  // 최소마진 구간
  return Math.max(0, Math.round(c));
}

// 종합소득세 (2023년 이후 세율) + 지방소득세 10%
export function incomeTax(base) {
  const B = [[14e6, 0.06, 0], [50e6, 0.15, 1.26e6], [88e6, 0.24, 5.76e6], [150e6, 0.35, 15.44e6], [300e6, 0.38, 19.94e6], [500e6, 0.40, 25.94e6], [1e9, 0.42, 35.94e6], [Infinity, 0.45, 65.94e6]];
  if (base <= 0) return 0;
  const [, r, d] = B.find(([lim]) => base <= lim);
  return Math.round((base * r - d) * 1.1);
}

export async function analytics(env, kvList, { from, to }, P) {
  const card = P?.card_fee ?? 0.034, ops = P?.ops_cost_won ?? 300;
  const inRange = (iso) => { const d = dayKey(iso); return d >= from && d <= to; };
  const orders = (await kvList(env, "order:"));
  const users = await kvList(env, "user:");
  const reviews = await kvList(env, "review:");
  const days = {};
  for (let t = new Date(from + "T00:00:00Z"); dayKey(new Date(t.getTime() - 9 * 3600e3)) <= to; t = new Date(t.getTime() + 86400e3)) {
    const k = t.toISOString().slice(0, 10);
    days[k] = { day: k, uv: 0, pv: 0, orders: 0, sales: 0, cost: 0, profit: 0, signups: 0, reviews: 0 };
    if (Object.keys(days).length > 400) break;
  }
  const src = {}, pages = {};
  for (const k of Object.keys(days)) {
    const s = await env.SHOP.get("stat:" + k, "json");
    if (!s) continue;
    days[k].uv = s.uv; days[k].pv = s.pv;
    for (const [n, v] of Object.entries(s.src || {})) (src[n] = src[n] || { visits: 0, orders: 0, sales: 0 }).visits += v;
    for (const [n, v] of Object.entries(s.pages || {})) pages[n] = (pages[n] || 0) + v;
  }
  const prod = {}, T = { orders: 0, sales: 0, supply: 0, cost: 0, cardFee: 0, ops: 0, profit: 0, refunds: 0, canceled: 0, returned: 0, exchanged: 0, poLines: 0, poWait: 0, discount: 0, units: 0, costEstimated: false };
  for (const o of orders) {
    if (!inRange(o.paidAt)) continue;
    const dead = ["취소완료", "반품완료"].includes(o.status);
    if (o.status === "취소완료") T.canceled++;
    if (o.status === "반품완료" || o.status === "반품요청") T.returned++;
    if (/교환/.test(o.status)) T.exchanged++;
    T.refunds += o.refunded || 0;
    o.lines.forEach((l) => { if (l.po) T.poLines++; else if (o.status === "결제완료") T.poWait++; });
    if (dead) continue;
    const day = days[dayKey(o.paidAt)];
    let cost = 0;
    for (const l of o.lines) {
      const unitCost = l.cost || costFromPrice(l.list_price || l.price, P);
      if (!l.cost) T.costEstimated = true;
      cost += unitCost * l.qty;
      const p = (prod[l.id] = prod[l.id] || { id: l.id, name: l.name.replace(/ \[.*\]$/, ""), qty: 0, sales: 0, orders: 0 });
      p.qty += l.qty; p.sales += l.price * l.qty; p.orders++; T.units += l.qty;
    }
    const amt = o.amount - (o.refunded || 0);
    const fee = Math.round(amt * card), vat = Math.round((amt - cost) / 11);
    const profit = amt - fee - vat - cost - ops;
    T.orders++; T.sales += amt; T.cost += cost; T.cardFee += fee; T.ops += ops; T.profit += profit; T.discount += o.discount || 0;
    if (day) { day.orders++; day.sales += amt; day.cost += cost; day.profit += profit; }
    const s = (src[o.src || "알 수 없음"] = src[o.src || "알 수 없음"] || { visits: 0, orders: 0, sales: 0 });
    s.orders++; s.sales += amt;
  }
  for (const u of users) if (u.joinedAt && days[dayKey(u.joinedAt)]) days[dayKey(u.joinedAt)].signups++;
  const rvIn = reviews.filter((r) => inRange(r.at));
  for (const r of rvIn) if (days[dayKey(r.at)]) days[dayKey(r.at)].reviews++;
  const rvByProd = {};
  for (const r of reviews) { const x = (rvByProd[r.product_id] = rvByProd[r.product_id] || { id: r.product_id, name: r.product_name, count: 0, sum: 0 }); x.count++; x.sum += r.rating; }
  const D = Object.values(days);
  T.uv = D.reduce((a, d) => a + d.uv, 0); T.pv = D.reduce((a, d) => a + d.pv, 0);
  T.signups = D.reduce((a, d) => a + d.signups, 0); T.members = users.length;
  T.reviews = rvIn.length; T.reviewsAll = reviews.length; T.reviewAvg = reviews.length ? +(reviews.reduce((a, r) => a + r.rating, 0) / reviews.length).toFixed(2) : 0;
  T.conv = T.uv ? +(T.orders / T.uv * 100).toFixed(2) : 0;
  T.aov = T.orders ? Math.round(T.sales / T.orders) : 0;

  // 세금 예상 (올해 기준, 부가세는 반기별)
  const y = to.slice(0, 4), tax = { year: y, vat: [], income: null };
  const ySum = { sales: 0, cost: 0, fee: 0, ops: 0 }, half = [{ sales: 0, cost: 0 }, { sales: 0, cost: 0 }];
  for (const o of orders) {
    const d = dayKey(o.paidAt);
    if (d.slice(0, 4) !== y || ["취소완료", "반품완료"].includes(o.status)) continue;
    const amt = o.amount - (o.refunded || 0), cost = o.lines.reduce((a, l) => a + (l.cost || costFromPrice(l.list_price || l.price, P)) * l.qty, 0);
    const h = half[+d.slice(5, 7) > 6 ? 1 : 0]; h.sales += amt; h.cost += cost;
    ySum.sales += amt; ySum.cost += cost; ySum.fee += Math.round(amt * card); ySum.ops += ops;
  }
  half.forEach((h, i) => tax.vat.push({ period: `${y}년 ${i ? "2기 (7~12월) · 다음해 1월 25일까지 신고" : "1기 (1~6월) · 7월 25일까지 신고"}`, sales: h.sales, salesVat: Math.round(h.sales / 11), buyVat: Math.round(h.cost / 11), pay: Math.round(h.sales / 11) - Math.round(h.cost / 11) }));
  const income = Math.round(ySum.sales / 1.1 - ySum.cost / 1.1 - ySum.fee - ySum.ops);  // 부가세 뺀 매출 − 매입 − 카드수수료 − 운영비
  const now = new Date(KST()), doy = Math.max(1, Math.floor((now - new Date(`${y}-01-01T00:00:00Z`)) / 86400e3) + 1), full = y === KST().slice(0, 4) ? Math.round(income * 365 / doy) : income;
  tax.income = { profit: income, yearEstimate: full, tax: incomeTax(income), taxYear: incomeTax(full), due: `${+y + 1}년 5월 31일까지 신고` };

  return {
    from, to, totals: T, days: D, tax,
    products: Object.values(prod).sort((a, b) => b.sales - a.sales).slice(0, 30),
    sources: Object.entries(src).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.visits - a.visits || b.sales - a.sales),
    pages: Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([path, pv]) => ({ path, pv })),
    reviewTop: Object.values(rvByProd).map((x) => ({ ...x, avg: +(x.sum / x.count).toFixed(1) })).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}
