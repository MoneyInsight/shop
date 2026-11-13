/**
 * 배송 단계 조회 — 송장번호만 넣으면 지금 어디쯤인지(집하·이동중·배송출발·배송완료) 자동 확인
 *  - tracker.delivery (택배 조회 서비스) 사용: 서버 설정값 TRACKER_CLIENT_ID / TRACKER_CLIENT_SECRET
 *    (tracker.delivery 콘솔에서 무료 플랜으로 발급, 키가 없으면 택배사 사이트 바로가기만 보임)
 *  - 결과는 30분 동안 저장해서 같은 송장을 여러 번 조회해도 한 번만 물어봄
 *  - '배송완료'가 확인되면 주문 상태를 자동으로 배송완료로 바꿈 (→ 리뷰 요청 알림)
 */
export const CARRIERS = {
  "CJ대한통운": "kr.cjlogistics", "한진택배": "kr.hanjin", "롯데택배": "kr.lotte", "우체국택배": "kr.epost",
  "로젠택배": "kr.logen", "경동택배": "kr.kdexp", "대신택배": "kr.daesin", "일양로지스": "kr.ilyanglogis", "합동택배": "kr.hdexp", "천일택배": "kr.chunilps", "건영택배": "kr.kunyoung",
};
// 손님에게 보여줄 4단계
export const STAGES = ["접수", "집하", "이동중", "배송출발", "배송완료"];
const STAGE_OF = { INFORMATION_RECEIVED: "접수", AT_PICKUP: "집하", IN_TRANSIT: "이동중", OUT_FOR_DELIVERY: "배송출발", ATTEMPT_FAIL: "배송출발", AVAILABLE_FOR_PICKUP: "배송출발", DELIVERED: "배송완료", EXCEPTION: "이동중" };

export const trackReady = (env) => !!(env.TRACKER_CLIENT_ID && env.TRACKER_CLIENT_SECRET);

const QUERY = `query Track($carrierId: ID!, $trackingNumber: String!) {
  track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
    lastEvent { time status { code name } description }
    events(last: 20) { edges { node { time status { code name } description location { name } } } }
  }
}`;

export async function track(env, courier, number) {
  const carrierId = CARRIERS[courier], no = String(number || "").replace(/\D/g, "");
  if (!carrierId || !no || !trackReady(env)) return null;
  const key = `track:${carrierId}:${no}`;
  const cached = env.SHOP && (await env.SHOP.get(key, "json"));
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached;
  try {
    const r = await fetch("https://apis.tracker.delivery/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `TRACKQL-API-KEY ${env.TRACKER_CLIENT_ID}:${env.TRACKER_CLIENT_SECRET}` },
      body: JSON.stringify({ query: QUERY, variables: { carrierId, trackingNumber: no } }),
    });
    const d = await r.json().catch(() => ({}));
    const t = d?.data?.track;
    if (!t) return cached || { at: Date.now(), stage: "", events: [], error: d?.errors?.[0]?.message || "조회 실패" };
    const events = (t.events?.edges || []).map((e) => e.node).map((n) => ({ time: n.time, stage: STAGE_OF[n.status?.code] || "이동중", text: n.description || n.status?.name || "", where: n.location?.name || "" }))
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const res = { at: Date.now(), stage: STAGE_OF[t.lastEvent?.status?.code] || (events[0]?.stage ?? ""), events: events.slice(0, 15) };
    if (env.SHOP) await env.SHOP.put(key, JSON.stringify(res), { expirationTtl: 86400 });
    return res;
  } catch (e) { return cached || null; }
}
