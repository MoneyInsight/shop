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

// lines: [{ id, name, qty, price(개당 판매가), option }]
export async function check(env, lines, pricing = { card_fee: 0.034, ops_cost_won: 300 }) {
  if (!env.DOMEGGOOK_API_KEY) return { ok: true, skipped: true };
  const dm = lines.filter((l) => String(l.id).startsWith("DM"));
  const res = await Promise.all(dm.map(async (l) => {
    const v = await view(env, String(l.id).slice(2));
    if (!v || !v.basis) return null;  // 조회 실패 → 막지 않음
    const b = v.basis, inv = n(v.qty?.inventory);
    if (b.status !== "판매중" || b.adult === "true") return `${l.name} 상품이 방금 품절되었어요.`;
    if (inv < l.qty) return `${l.name} 상품 재고가 부족해요 (남은 수량 ${inv}개).`;
    let add = 0;
    if (l.option) {
      try {
        const so = typeof v.selectOpt === "string" ? JSON.parse(v.selectOpt) : v.selectOpt;
        const o = Object.values(so?.data || {}).find((x) => String(x.name) === String(l.option));
        if (!o || o.sup !== "1" || n(o.qty) < l.qty || (o.hid && o.hid !== "0")) return `${l.name} [${l.option}] 옵션이 방금 품절되었어요.`;
        add = n(o.supPrice);
      } catch (e) {}
    }
    const sup = v.deli?.supply || v.deli?.dome || {};
    const fee = /무료/.test(sup.type || "") ? 0 : n(sup.fee);
    const boxes = sup.type === "고정배송비" ? 1 : l.qty;
    const cost = (n(v.price?.supply) + add) * l.qty + fee * boxes;
    const rev = l.price * l.qty;
    const net = rev - rev * pricing.card_fee - (rev - cost) / 11 - cost - pricing.ops_cost_won;
    if (net < 0) return `${l.name} 상품 가격이 도매처에서 바뀌어 지금은 주문할 수 없어요. 잠시 후 다시 확인해 주세요.`;
    return null;
  }));
  const why = res.filter(Boolean);
  return why.length ? { ok: false, message: why.join("\n") } : { ok: true };
}
