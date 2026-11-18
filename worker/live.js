// 결제 직전 실시간 재고·가격 확인 (도매매 상품: 도매꾹 Open API)
// - 판매중지·재고 부족·옵션 품절·도매가 인상으로 손해가 나면 결제를 막고 손님에게 알려줌
// - API 키가 없거나 응답이 늦으면(4초) 막지 않고 통과 (매일 자동 점검으로 보완)
const API = "https://domeggook.com/ssl/api/";

async function view(env, no) {
  const q = new URLSearchParams({ ver: "4.5", mode: "getItemView", no, aid: env.DOMEGGOOK_API_KEY, om: "json" });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
  try { const r = await fetch(API + "?" + q, { signal: ctl.signal }); return (await r.json()).domeggook || null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}

const n = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;

// 도매가: "1+258|10+198|50+158" 처럼 수량 구간 가격이면 주문 수량에 맞는 구간
function supPrice(p, units) {
  const s = String(p ?? "");
  if (!s.includes("+")) return n(s);
  let best = 0;
  for (const seg of s.split("|")) { const [q, v] = seg.split("+"); if (units >= n(q) || !best) best = n(v) || best; }
  return best;
}

// 도매매 배송비 규칙 (tools/dm_ship.py 와 같음): [배송비, N개마다(0 = 주문당 1번)]
function dmShip(sup, fallback) {
  const t = String(sup.type || "");
  if (/무료/.test(t)) return [0, 0];
  if (t === "고정배송비") return [n(sup.fee || fallback), 0];
  const tiers = String(sup.tbl || "").split("|").filter((x) => x.includes("+")).map((x) => x.split("+").map(n)).sort((a, b) => a[0] - b[0]);
  if (t === "수량별비례" && tiers.length) return [Math.max(...tiers.map((x) => x[1])), Math.max(1, Math.min(...tiers.map((x) => x[0])))];
  if (t === "수량별차등" && tiers.length) { const nx = tiers.find((x) => x[0] > tiers[0][0]); return [tiers[0][1] || Math.max(...tiers.map((x) => x[1])), nx ? Math.max(1, nx[0] - 1) : 0]; }
  return [n(sup.fee || fallback), 1];
}

// 오너클랜 (판매사 API) — 여러 상품을 한 번에
async function ocItems(env, keys) {
  if (!keys.length || !env.OWNERCLAN_ID) return {};
  try {
    const tok = await env.__ocToken?.();
    if (!tok) return {};
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch("https://api.ownerclan.com/v1/graphql", { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
      body: JSON.stringify({ query: `query{itemsByKeys(keys:${JSON.stringify(keys)}){key status price shippingFee shippingType boxQuantity options{quantity status price optionAttributes{name value}}}}` }) });
    clearTimeout(t);
    const d = await r.json();
    return Object.fromEntries(((d.data || {}).itemsByKeys || []).filter(Boolean).map((x) => [x.key, x]));
  } catch (e) { return {}; }
}

// lines: [{ id, name, qty, price(개당 판매가), option }]
export async function check(env, lines, pricing = { card_fee: 0.034, ops_cost_won: 300 }) {
  const ocKeys = [...new Set(lines.filter((l) => /^W[0-9A-Z]{6}$/.test(String(l.id))).map((l) => String(l.id)))];
  const oc = await ocItems(env, ocKeys);
  const ocWhy = lines.filter((l) => oc[String(l.id)]).map((l) => {
    const it = oc[String(l.id)];
    if (it.status !== "available") return `${l.name} 상품이 방금 품절되었어요.`;
    let add = 0;
    if (l.option && (it.options || []).length) {
      const want = String(l.option).replace(/\s+/g, "");
      const o = it.options.find((x) => ["_", "/", "", "-", ","].some((j) => (x.optionAttributes || []).map((a) => String(a.value).replace(/\s+/g, "")).join(j) === want));
      if (!o || o.status !== "available" || n(o.quantity) < l.qty * (l.pk || 1)) return `${l.name} [${l.option}] 옵션이 방금 품절되었어요.`;  // 도매처에 없는 옵션도 주문 막음
      if (o) add = Math.max(0, n(o.price) - n(it.price));
    }
    const units = l.qty * (l.pk || 1);
    const fee = it.shippingType === "free" ? 0 : n(it.shippingFee);
    const bq = n(it.boxQuantity), boxes = fee ? (bq > 1 ? Math.ceil(units / bq) : 1) : 0;  // 오너클랜: 묶음 수량 있으면 N개마다, 없으면 주문당 1번 (사이트와 같은 규칙)
    const cost = (n(it.price) + add) * units + fee * boxes;
    const rev = l.price * l.qty + (l.ship || 0);
    const net = rev - rev * pricing.card_fee - (rev - cost) / 11 - cost - pricing.ops_cost_won;
    if (net < 0) return `${l.name} 상품 가격이 도매처에서 바뀌어 지금은 주문할 수 없어요. 잠시 후 다시 확인해 주세요.`;
    return null;
  }).filter(Boolean);
  if (!env.DOMEGGOOK_API_KEY) return ocWhy.length ? { ok: false, message: ocWhy.join("\n") } : { ok: true, skipped: true };
  const dm = lines.filter((l) => String(l.id).startsWith("DM"));
  const res = await Promise.all(dm.map(async (l) => {
    const v = await view(env, String(l.id).slice(2));
    if (!v || !v.basis) return null;  // 조회 실패 → 막지 않음
    const b = v.basis, inv = n(v.qty?.inventory);
    if (b.status !== "판매중" || b.adult === "true") return `${l.name} 상품이 방금 품절되었어요.`;
    if (inv < l.qty * (l.pk || 1)) return `${l.name} 상품 재고가 부족해요 (남은 수량 ${inv}개).`;
    let add = 0;
    if (l.option) {
      try {
        const so = typeof v.selectOpt === "string" ? JSON.parse(v.selectOpt) : v.selectOpt;
        const o = Object.values(so?.data || {}).find((x) => String(x.name) === String(l.option));
        if (!o || o.sup !== "1" || n(o.qty) < l.qty || (o.hid && o.hid !== "0")) return `${l.name} [${l.option}] 옵션이 방금 품절되었어요.`;
        add = n(o.supPrice);
      } catch (e) {}
    }
    const sup = v.deli?.supply || {};  // 도매매(위탁) 배송정보만 — 도매꾹 도매 배송정보로 대신하지 않음
    const units = l.qty * (l.pk || 1);
    let [fee, every] = dmShip(sup, l.ship_fee);
    if (fee && ["n", "c"].includes(String(v.deli?.merge?.enable || "").toLowerCase())) every = 1;  // 묶음배송 불가 → 1개마다 택배비
    const boxes = fee ? (every ? Math.ceil(units / every) : 1) : 0;
    const cost = (supPrice(v.price?.supply, units) + add) * units + fee * boxes;
    const rev = l.price * l.qty + (l.ship || 0);  // 손님이 낸 상품값 + 배송비
    const net = rev - rev * pricing.card_fee - (rev - cost) / 11 - cost - pricing.ops_cost_won;
    if (net < 0) return `${l.name} 상품 가격이 도매처에서 바뀌어 지금은 주문할 수 없어요. 잠시 후 다시 확인해 주세요.`;
    return null;
  }));
  const why = [...ocWhy, ...res.filter(Boolean)];
  return why.length ? { ok: false, message: why.join("\n") } : { ok: true };
}
