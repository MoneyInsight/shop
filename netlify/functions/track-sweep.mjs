// Netlify 정기 실행: 2시간마다 배송중 주문의 택배 단계 확인
import { getStore } from "@netlify/blobs";
import { trackSweep } from "../../worker/worker.js";
export default async () => {
  const s = getStore({ name: "shop", consistency: "strong" });
  const k = (key) => key.replace(":", "/");
  const SHOP = {
    get: (key, type) => s.get(k(key), type === "json" ? { type: "json" } : undefined),
    put: (key, val) => s.set(k(key), val), delete: (key) => s.delete(k(key)),
    async list({ prefix }) { const { blobs } = await s.list({ prefix: k(prefix) }); return { keys: blobs.map((b) => ({ name: b.key.replace("/", ":") })), list_complete: true }; },
  };
  const env = { ...(Netlify.env.toObject ? Netlify.env.toObject() : {}), SHOP };
  const r = await trackSweep(env);
  return new Response(JSON.stringify(r));
};
export const config = { schedule: "0 */2 * * *" };
