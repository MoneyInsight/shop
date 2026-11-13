// 로그인 회원 추가 즉시 할인 (사이트 app.js 와 같은 계산)
// 상품마다: 할인 = min(판매가×비율, 판매가 − 순마진 8% 가격) × 수량  → 합계를 10원 단위로 내림
export const DEFAULT = { rate: 0.01, min_net_margin: 0.08, net_margin: 0.12, min_margin_won: 1500, card_fee: 0.034, ops_cost_won: 300 };
function costFromPrice(price, P) {
  const k = 1 - P.card_fee - 1 / 11;
  let c = (price * k - P.ops_cost_won) / (10 / 11 + P.net_margin);
  if (c * P.net_margin < P.min_margin_won) c = (price * k - P.ops_cost_won - P.min_margin_won) * 11 / 10;
  return Math.max(0, c);
}
// lines: [{ unit: 실제 개당 결제가, list: 1개 기준 정가(옵션 포함), qty }]
export function memberDiscount(lines, P = DEFAULT) {
  if (!P || !P.rate) return 0;
  let d = 0;
  for (const l of lines) {
    const cost = costFromPrice(l.list, P);
    const floor = (cost * 10 / 11 + cost * P.min_net_margin) / (1 - P.card_fee - 1 / 11);
    d += Math.max(0, Math.min(l.unit * P.rate, l.unit - floor)) * l.qty;
  }
  return Math.floor(d / 10) * 10;
}
