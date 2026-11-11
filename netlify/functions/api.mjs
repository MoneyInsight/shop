// Netlify 서버: /api/* 요청을 worker.js 공통 처리기로 전달, 저장소는 Netlify Blobs
import { getStore } from "@netlify/blobs";
import { handle } from "../../worker/worker.js";

function kv() {
  const s = getStore({ name: "shop", consistency: "strong" });
  const k = (key) => key.replace(":", "/");
  return {
    get: (key, type) => s.get(k(key), type === "json" ? { type: "json" } : undefined),
    put: (key, val) => s.set(k(key), val),
    delete: (key) => s.delete(k(key)),
    async list({ prefix }) {
      const { blobs } = await s.list({ prefix: k(prefix) });
      return { keys: blobs.map((b) => ({ name: b.key })), list_complete: true };
    },
  };
}

export default async (req) => {
  const e = (n, d = "") => Netlify.env.get(n) ?? d;
  const env = {
    SHOP: kv(),
    TOSS_SECRET_KEY: e("TOSS_SECRET_KEY", "test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6"),
    ADMIN_PASSWORD: e("ADMIN_PASSWORD"),
    GITHUB_TOKEN: e("GITHUB_TOKEN"),
    GITHUB_REPO: e("GITHUB_REPO", "MoneyInsight/shop"),
    SITE_URL: e("SITE_URL", "https://moneyinsight.github.io/shop"),
    MARGIN_RATE: e("MARGIN_RATE", "0.03"),
    CARD_FEE: e("CARD_FEE", "0.034"),
    MARKET_FEE: e("MARKET_FEE", "0.12"),
    CUSTOMER_DISCOUNT: e("CUSTOMER_DISCOUNT", "0.05"),
    SUPPLIER_MARGIN: e("SUPPLIER_MARGIN", "0.08"),
    MIN_MARGIN: e("MIN_MARGIN", "0"),
    FREE_SHIPPING_OVER: e("FREE_SHIPPING_OVER", "0"),
  };
  const path = new URL(req.url).pathname.replace(/^\/api/, "");
  return handle(req, env, path);
};

export const config = { path: "/api/*" };
