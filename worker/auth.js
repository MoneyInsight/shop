/**
 * 땡잡았땡 회원 로그인 (네이버·카카오·구글, 모두 무료)
 *  GET  /auth/start?provider=naver|kakao|google&return=돌아갈주소  → 각 회사 로그인 화면으로
 *  GET  /auth/callback/{provider}?code&state                      → 회원 저장 후 사이트로 (#login=세션)
 *  POST /me            {token}                 → 내 정보
 *  POST /me/save       {token, addr?, wish?}   → 배송지·찜 저장
 *  POST /me/orders     {token}                 → 내 주문 목록
 *  POST /auth/logout   {token}
 * 필요한 서버 설정값(없으면 그 버튼만 '준비 중'):
 *  NAVER_CLIENT_ID / NAVER_CLIENT_SECRET, KAKAO_REST_KEY (/ KAKAO_CLIENT_SECRET), GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * 각 회사에 등록할 Redirect URI: {서버주소}/auth/callback/naver (kakao, google 동일)
 */
const SESSION_DAYS = 30;
const enc = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""))).toString();
const rand = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const phone = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.startsWith("82")) d = "0" + d.slice(2); return d.length >= 10 ? d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3") : ""; };

export const PROVIDERS = {
  naver: {
    name: "네이버", ready: (e) => e.NAVER_CLIENT_ID && e.NAVER_CLIENT_SECRET,
    authUrl: (e, redirect, state) => "https://nid.naver.com/oauth2.0/authorize?" + enc({ response_type: "code", client_id: e.NAVER_CLIENT_ID, redirect_uri: redirect, state }),
    token: (e, code, redirect, state) => fetch("https://nid.naver.com/oauth2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: enc({ grant_type: "authorization_code", client_id: e.NAVER_CLIENT_ID, client_secret: e.NAVER_CLIENT_SECRET, code, state, redirect_uri: redirect }) }),
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    profile: (d) => { const r = d.response || {}; return { id: r.id, name: r.name || r.nickname || "", email: r.email || "", phone: phone(r.mobile) }; },
  },
  kakao: {
    name: "카카오", ready: (e) => e.KAKAO_REST_KEY,
    authUrl: (e, redirect, state) => "https://kauth.kakao.com/oauth/authorize?" + enc({ response_type: "code", client_id: e.KAKAO_REST_KEY, redirect_uri: redirect, state }),
    token: (e, code, redirect) => fetch("https://kauth.kakao.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: enc({ grant_type: "authorization_code", client_id: e.KAKAO_REST_KEY, client_secret: e.KAKAO_CLIENT_SECRET, code, redirect_uri: redirect }) }),
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    profile: (d) => { const a = d.kakao_account || {}; return { id: d.id && String(d.id), name: a.name || a.profile?.nickname || d.properties?.nickname || "", email: a.email || "", phone: phone(a.phone_number) }; },
  },
  google: {
    name: "구글", ready: (e) => e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET,
    authUrl: (e, redirect, state) => "https://accounts.google.com/o/oauth2/v2/auth?" + enc({ response_type: "code", client_id: e.GOOGLE_CLIENT_ID, redirect_uri: redirect, scope: "openid email profile", state, prompt: "select_account" }),
    token: (e, code, redirect) => fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: enc({ grant_type: "authorization_code", client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, code, redirect_uri: redirect }) }),
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    profile: (d) => ({ id: d.sub, name: d.name || "", email: d.email || "", phone: "" }),
  },
};

export const loginStatus = (env) => Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, !!p.ready(env)]));

// 돌아갈 주소는 우리 사이트만 허용 (다른 사이트로 세션이 새지 않게)
function safeReturn(env, url) {
  const site = String(env.SITE_URL || "").replace(/\/$/, "");
  try { const u = new URL(url); if (site && (u.origin + u.pathname).startsWith(site)) return u.origin + u.pathname + u.search; } catch (e) {}
  return (site || "") + "/login.html";
}
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
const back = (ret, hash) => redirect(ret.split("#")[0] + "#" + hash);

export async function start(req, env, base) {
  const u = new URL(req.url).searchParams, key = u.get("provider"), p = PROVIDERS[key];
  const ret = safeReturn(env, u.get("return") || "");
  if (!p) return back(ret, "login_error=" + encodeURIComponent("지원하지 않는 로그인이에요."));
  if (!p.ready(env)) return back(ret, "login_error=" + encodeURIComponent(`${p.name} 로그인은 준비 중이에요.`));
  const state = rand();
  await env.SHOP.put("authstate:" + state, JSON.stringify({ key, ret }), { expirationTtl: 600 });
  return redirect(p.authUrl(env, `${base}/auth/callback/${key}`, state));
}

export async function callback(req, env, base, key) {
  const u = new URL(req.url).searchParams, p = PROVIDERS[key];
  const st = await env.SHOP.get("authstate:" + (u.get("state") || ""), "json");
  const ret = st?.ret || safeReturn(env, "");
  const err = (m) => back(ret, "login_error=" + encodeURIComponent(m));
  if (!p || !st || st.key !== key) return err("로그인 시간이 지났어요. 다시 시도해 주세요.");
  await env.SHOP.delete("authstate:" + u.get("state"));
  if (!u.get("code")) return err("로그인을 취소했어요.");
  try {
    const tr = await p.token(env, u.get("code"), `${base}/auth/callback/${key}`, u.get("state"));
    const tk = await tr.json().catch(() => ({}));
    if (!tk.access_token) return err(`${p.name} 로그인에 실패했어요.`);
    const pr = await fetch(p.profileUrl, { headers: { Authorization: "Bearer " + tk.access_token } });
    const prof = p.profile(await pr.json().catch(() => ({})));
    if (!prof.id) return err(`${p.name} 회원 정보를 받지 못했어요.`);
    const uid = `${key}:${prof.id}`, now = new Date().toISOString();
    const found = await env.SHOP.get("user:" + uid, "json");
    const old = found || { uid, provider: key, joinedAt: now, orders: [], wish: [], addr: null };
    const user = { ...old, name: prof.name || old.name || "", email: prof.email || old.email || "", phone: prof.phone || old.phone || "", lastLogin: now };
    await env.SHOP.put("user:" + uid, JSON.stringify(user));
    const token = rand();
    await env.SHOP.put("sess:" + token, uid, { expirationTtl: SESSION_DAYS * 86400 });
    return back(ret, "login=" + token + (found ? "" : "&new=1"));
  } catch (e) { return err(`${p.name} 로그인 중 오류가 났어요.`); }
}

export async function userFromToken(env, token) {
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  const uid = await env.SHOP.get("sess:" + token);
  return uid ? await env.SHOP.get("user:" + uid, "json") : null;
}
const pub = (u) => ({ name: u.name, email: u.email, phone: u.phone, provider: u.provider, joinedAt: u.joinedAt, addr: u.addr, wish: u.wish || [], orderCount: (u.orders || []).length });

export async function me(env, d) {
  const u = await userFromToken(env, d.token);
  return u ? { ok: true, user: pub(u) } : null;
}

export async function save(env, d) {
  const u = await userFromToken(env, d.token);
  if (!u) return null;
  if (d.addr && typeof d.addr === "object") u.addr = Object.fromEntries(["name", "phone", "email", "zip", "addr1", "addr2", "memo"].map((k) => [k, String(d.addr[k] || "").slice(0, 200)]));
  if (Array.isArray(d.wish)) u.wish = [...new Set(d.wish.map(String))].slice(0, 300);
  await env.SHOP.put("user:" + u.uid, JSON.stringify(u));
  return { ok: true, user: pub(u) };
}

// 결제 완료 때 호출: 로그인한 회원이면 주문번호를 회원에게 연결
export async function linkOrder(env, token, orderId) {
  const u = await userFromToken(env, token);
  if (!u) return "";
  u.orders = [orderId, ...(u.orders || []).filter((x) => x !== orderId)].slice(0, 200);
  await env.SHOP.put("user:" + u.uid, JSON.stringify(u));
  return u.uid;
}

export async function logout(env, d) {
  if (d.token && /^[0-9a-f]{48}$/.test(d.token)) await env.SHOP.delete("sess:" + d.token);
  return { ok: true };
}
