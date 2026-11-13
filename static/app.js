/* 땡잡았땡 쇼핑몰 스크립트 — 목록·상세·찜·장바구니·결제·주문조회·리뷰·문의 */
(function () {
  const ROOT = document.body.dataset.root || "./";
  const CFG = window.SHOP_CFG || {};
  const API = CFG.worker_url || "";
  const PER_PAGE = 40;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const img = (u) => (/^https?:\/\//.test(u || "") ? u : ROOT + (u || ""));
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const date = (iso) => new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  const HEART = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>';
  const stars = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

  // ── 저장소 ──
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const getCart = () => store.get("cart", []);
  const setCart = (c) => { store.set("cart", c); updateCounts(); };
  const getWish = () => store.get("wish", []);
  function addToCart(id, qty, opt) {
    const c = getCart();
    const it = c.find((x) => x.id === id && (x.opt ?? null) === (opt ?? null));
    if (it) it.qty = Math.min(99, it.qty + qty); else c.push(opt == null ? { id, qty } : { id, qty, opt });
    setCart(c);
  }
  function toggleWish(id) {
    let w = getWish();
    const on = !w.includes(id);
    w = on ? [id, ...w].slice(0, 200) : w.filter((x) => x !== id);
    store.set("wish", w); updateCounts(); memberSave({ wish: w });
    return on;
  }
  function updateCounts() {
    const n = { cart: getCart().reduce((a, b) => a + b.qty, 0), wish: getWish().length };
    $$(".count[data-count]").forEach((el) => { const v = n[el.dataset.count]; el.textContent = v > 99 ? "99+" : v; el.style.display = v ? "grid" : "none"; });
  }

  async function api(path, body) {
    if (!API) return { ok: false, d: { message: "서비스 준비 중이에요. 고객센터로 문의해 주세요." } };
    try {
      const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const d = await r.json();
      // 서버가 아직 이 기능을 지원하지 않는 버전일 때(연결 전) 영어 오류 대신 안내 문구
      if (!r.ok && (d.message === "Not found" || !d.message)) d.message = "이 기능은 준비 중이에요. 고객센터로 문의해 주세요.";
      return { ok: r.ok, d };
    } catch (e) { return { ok: false, d: { message: "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." } }; }
  }

  // ── 택배사 배송 조회 주소 (공식 사이트로 바로 이동, 무료) ──
  const TRACK = {
    "CJ대한통운": "https://trace.cjlogistics.com/next/tracking.html?wblNo=",
    "한진택배": "https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=",
    "롯데택배": "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=",
    "우체국택배": "https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=",
    "로젠택배": "https://www.ilogen.com/web/personal/trace/",
    "경동택배": "https://kdexp.com/service/delivery/etc/delivery.do?barcode=",
    "대신택배": "https://www.ds3211.co.kr/freight/internalFreightSearch.ht?billno=",
  };
  const trackUrl = (courier, no) => { const n = digits(no); const b = TRACK[courier]; return b && n ? b + n : "https://search.naver.com/search.naver?query=" + encodeURIComponent((courier || "택배") + " 배송조회 " + n); };
  const STAGES = ["접수", "집하", "이동중", "배송출발", "배송완료"];
  const STAGE_TIP = { 접수: "택배사에 송장이 등록됐어요", 집하: "택배기사님이 상품을 가져갔어요", 이동중: "물류센터를 거쳐 이동하고 있어요", 배송출발: "오늘 도착 예정! 기사님이 배송을 시작했어요", 배송완료: "배송이 완료됐어요" };
  const trackHTML = (o) => {
    if (!o.tracking) return "";
    const t = o.track, si = t && t.stage ? STAGES.indexOf(t.stage) : -1;
    const time = (s) => { const d = new Date(s); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    return `<div class="track-box"><div class="track-head"><div><span class="muted">${esc(o.courier || "택배")}</span> <b>${esc(o.tracking)}</b></div>
      <div class="track-btns"><a class="btn btn-dark sm" target="_blank" rel="noopener" href="${esc(trackUrl(o.courier, o.tracking))}">택배사에서 보기</a>
      <button class="btn btn-line sm" type="button" data-copy="${esc(digits(o.tracking))}">송장번호 복사</button></div></div>
      ${si >= 0 ? `<div class="stage-bar">${STAGES.map((s, i) => `<div class="${i < si ? "on" : i === si ? "on now" : ""}"><i></i>${s}</div>`).join("")}</div>
      <p class="stage-tip"><b>${esc(t.stage)}</b> · ${STAGE_TIP[t.stage] || ""}</p>
      ${(t.events || []).length ? `<details class="stage-log"><summary>상세 이동 기록 ${t.events.length}건</summary><ul>${t.events.map((e) => `<li><span>${time(e.time)}</span>${esc(e.where ? e.where + " · " : "")}${esc(e.text)}</li>`).join("")}</ul></details>` : ""}` : ""}</div>`;
  };
  document.addEventListener("click", async (e) => { const b = e.target.closest("[data-copy]"); if (!b) return; try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "복사했어요"; } catch (x) {} });

  // ── 회원 (네이버·카카오·구글 간편 로그인) ──
  const member = () => store.get("user", null);
  const token = () => store.get("tk", "");
  let saveTimer = null;
  function memberSave(data) {
    if (!token()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { const r = await api("/me/save", { token: token(), ...data }); if (r.ok) store.set("user", r.d.user); }, 600);
  }
  function paintLogin() {
    const u = member();
    $$(".login-link").forEach((a) => { a.href = ROOT + "login.html"; const t = a.querySelector(".login-txt"); if (t) t.textContent = u ? "내 정보" : "로그인·가입"; });
  }
  async function memberRefresh() {
    if (!token()) return null;
    const r = await api("/me", { token: token() });
    if (!r.ok) { store.set("tk", ""); store.set("user", null); paintLogin(); return null; }
    store.set("user", r.d.user); paintLogin();
    return r.d.user;
  }
  async function handleLoginHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("login_error")) { history.replaceState(null, "", location.pathname + location.search); alert(h.get("login_error")); return; }
    if (!h.get("login")) return;
    history.replaceState(null, "", location.pathname + location.search);
    store.set("tk", h.get("login"));
    const u = await memberRefresh();
    if (!u) { alert("로그인에 실패했어요. 다시 시도해 주세요."); return; }
    // 이 기기의 찜·배송지를 회원 정보와 합치기
    const wish = [...new Set([...getWish(), ...(u.wish || [])])].slice(0, 200);
    store.set("wish", wish); updateCounts(); markWished();
    if (u.addr && !store.get("addr", null)) store.set("addr", u.addr);
    const addr = !u.addr && store.get("addr", null);
    const r = await api("/me/save", { token: token(), wish, ...(addr ? { addr } : {}) });
    if (r.ok) store.set("user", r.d.user);
    if (h.get("new")) alert(`${u.name || "회원"}님, 땡잡았땡 가입을 환영해요!`);
    const back = sessionStorage.getItem("login_back");
    if (back) { sessionStorage.removeItem("login_back"); location.href = back; }
  }
  async function initLogin() {
    const box = $("#login-box");
    if (!box) return;
    const health = API ? await fetch(API + "/health").then((r) => r.json()).catch(() => null) : null;
    $$(".sns-btn").forEach((a) => {
      const p = a.dataset.provider;
      if (health?.login?.[p]) a.href = API + "/auth/start?provider=" + p + "&return=" + encodeURIComponent(location.href.split("#")[0].split("?")[0]);
      else { a.classList.add("off"); a.onclick = (e) => { e.preventDefault(); alert("간편 로그인을 준비하고 있어요. 지금은 회원가입 없이 바로 주문하실 수 있어요."); }; }
    });
    const ref = document.referrer;
    if (ref && ref.startsWith(location.origin) && !/login\.html/.test(ref)) sessionStorage.setItem("login_back", ref);
    const u = member() && (await memberRefresh());
    if (!u) return;
    sessionStorage.removeItem("login_back");
    box.hidden = true;
    const me = $("#me-box"); me.hidden = false;
    const NAME = { naver: "네이버", kakao: "카카오", google: "구글" };
    me.innerHTML = `<div class="me-head"><h2 style="margin:0">${esc(u.name || "회원")}님</h2><span class="me-badge">${NAME[u.provider] || ""} 로그인</span></div>
      <dl class="kv"><dt>이메일</dt><dd>${esc(u.email || "-")}</dd><dt>연락처</dt><dd>${esc(u.phone || "-")}</dd>
      <dt>배송지</dt><dd>${u.addr ? `${esc(u.addr.name || "")} · [${esc(u.addr.zip || "")}] ${esc(u.addr.addr1 || "")} ${esc(u.addr.addr2 || "")}` : "첫 주문 때 ‘배송지 저장’을 선택하면 자동으로 채워져요"}</dd>
      <dt>가입일</dt><dd>${date(u.joinedAt)}</dd></dl>
      <div class="act-row" style="margin-top:18px"><a class="btn btn-dark sm" href="orders.html">내 주문 ${u.orderCount ? u.orderCount + "건" : ""}</a><a class="btn btn-line sm" href="wish.html">찜한 상품</a><button class="btn btn-line sm" id="logout">로그아웃</button></div>`;
    $("#logout").onclick = async () => { await api("/auth/logout", { token: token() }); store.set("tk", ""); store.set("user", null); location.reload(); };
  }

  // ── 웹 푸시 알림 켜기 (무료) ──
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && location.protocol === "https:";
  const b64toU8 = (s) => { const b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  async function enablePush(phone, path = "/push/subscribe") {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!pushSupported()) { alert(isIos ? "아이폰은 사파리 ‘공유 › 홈 화면에 추가’로 앱을 설치한 뒤, 앱에서 알림을 켤 수 있어요." : "이 브라우저는 알림을 지원하지 않아요. 크롬이나 앱 설치 후 이용해 주세요."); return false; }
    if (await Notification.requestPermission() !== "granted") { alert("알림이 차단되어 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요."); return false; }
    const k = await api("/push/key", {});
    if (!k.ok) { alert(k.d.message); return false; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64toU8(k.d.key) }));
    const r = await api(path, { sub: sub.toJSON(), phone });
    alert(r.d.message || (r.ok ? "알림이 켜졌어요." : "알림을 켜지 못했어요."));
    if (r.ok) store.set("push_on", [...new Set([...store.get("push_on", []), digits(phone)])]);
    return r.ok;
  }
  const pushBtn = (phone, label = "이 기기로 알림 받기") => store.get("push_on", []).includes(digits(phone)) ? `<p class="muted" style="margin-top:10px">🔔 이 기기로 알림을 받고 있어요.</p>`
    : `<button class="btn btn-line sm push-on" data-phone="${esc(phone)}" style="margin-top:12px">🔔 ${label}</button>`;
  document.addEventListener("click", async (e) => {
    const b = e.target.closest(".push-on"); if (!b) return;
    b.disabled = true; if (await enablePush(b.dataset.phone)) b.outerHTML = `<p class="muted" style="margin-top:10px">🔔 이 기기로 알림을 받고 있어요.</p>`; else b.disabled = false;
  });

  let PRODUCTS = null;
  async function loadProducts() {
    if (!PRODUCTS) PRODUCTS = await (await fetch(ROOT + "products.json", { cache: "no-cache" })).json();
    return PRODUCTS;
  }
  // 상품 DB 모드(config catalog_api=true): 상품을 서버에서 필요한 만큼만 받아옴 (100만 개용)
  const DBMODE = !!(CFG.catalog_api && API);
  async function apiGet(path) { try { const r = await fetch(API + path); return r.ok ? await r.json() : null; } catch (e) { return null; } }
  async function getProducts(ids) {
    if (!DBMODE) return loadProducts();
    return (await Promise.all([...new Set(ids)].map((id) => apiGet("/catalog/item?id=" + encodeURIComponent(id))))).filter(Boolean);
  }
  const productHref = (id) => DBMODE ? `${ROOT}product/item.html?id=${encodeURIComponent(id)}` : `${ROOT}product/${encodeURIComponent(id)}.html`;

  // 수량 할인: 같은 상품을 n개(옵션 달라도 합산) 사면 개당 가격 qt[n-1] (11개 이상은 마지막 값)
  const unitFor = (p, n) => (p.qt && p.qt.length ? p.qt[Math.min(Math.max(n, 1), p.qt.length) - 1] : Number(p.price));
  // 로그인 회원 추가 즉시 할인 (서버 worker/member.js 와 같은 계산, 순마진 8% 아래로는 안 깎음)
  function memberDisc(lines) {
    const P = CFG.member_discount; if (!P || !P.rate) return 0;
    const k = 1 - P.card_fee - 1 / 11;
    let d = 0;
    for (const l of lines) {
      let c = (l.list1 * k - P.ops_cost_won) / (10 / 11 + P.net_margin);
      if (c * P.net_margin < P.min_margin_won) c = (l.list1 * k - P.ops_cost_won - P.min_margin_won) * 11 / 10;
      c = Math.max(0, c);
      const floor = (c * 10 / 11 + c * P.min_net_margin) / k;
      d += Math.max(0, Math.min(l.price * P.rate, l.price - floor)) * l.qty;
    }
    return Math.floor(d / 10) * 10;
  }
  const memberPct = () => (CFG.member_discount?.rate ? Math.round(CFG.member_discount.rate * 100) : 0);
  // 간편 로그인이 실제로 켜져 있을 때만 '로그인하면 할인' 안내 (세션마다 한 번 확인)
  async function loginOn() {
    let v = sessionStorage.getItem("login_on");
    if (v == null) {
      const h = API ? await fetch(API + "/health").then((r) => r.json()).catch(() => null) : null;
      v = h?.login && Object.values(h.login).some(Boolean) ? "1" : "0";
      try { sessionStorage.setItem("login_on", v); } catch (e) {}
    }
    return v === "1";
  }
  // 제주·도서산간 추가 배송비 (서버 worker/region.js 와 같은 규칙)
  function regionFee(zip, addr) {
    const rule = CFG.remote_ship; if (!rule) return { fee: 0, label: "" };
    const z = parseInt(String(zip || "").replace(/\D/g, "")) || 0, a = String(addr || "");
    const inR = (rs) => (rs || []).some(([lo, hi]) => z >= lo && z <= hi);
    const island = inR(rule.island_zip) || (rule.island_words || []).some((w) => a.includes(w));
    const jeju = inR(rule.jeju_zip) || /^제주/.test(a.trim());
    if (jeju && /추자|우도|가파|마라/.test(a)) return { fee: rule.jeju + rule.island, label: "제주 섬 지역" };
    if (jeju) return { fee: rule.jeju, label: "제주" };
    if (island) return { fee: rule.island, label: "도서산간" };
    return { fee: 0, label: "" };
  }
  // 금액: 상품금액(옵션 추가금 포함) + 배송비(상품별 1회) − 쿠폰
  function calc(cart, products, discount) {
    const map = Object.fromEntries(products.map((p) => [p.id, p]));
    const isSold = (x) => map[x.id] && (map[x.id].soldout || (x.opt != null && map[x.id].options?.[x.opt]?.so));
    const soldout = cart.filter(isSold).map((x) => map[x.id].name);
    const qn = {};
    cart.filter((x) => map[x.id] && !isSold(x) && !x.offer).forEach((x) => (qn[x.id] = (qn[x.id] || 0) + x.qty));
    const lines = cart.filter((x) => map[x.id] && !isSold(x)).map((x) => {
      const p = map[x.id], o = x.opt != null && p.options ? p.options[x.opt] : null;
      const list = unitFor(p, qn[x.id] || x.qty) + (o ? o.add : 0), list1 = unitFor(p, 1) + (o ? o.add : 0);
      return { ...p, qty: x.qty, opt: x.opt, price: x.offer_price || list, list, list1, offer: x.offer || "", optName: o ? o.v : "", ci: cart.indexOf(x) };
    });
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
    let shipping = lines.reduce((a, l) => a + (l.shipping_fee || 0), 0);
    if (CFG.free_shipping_over && subtotal >= CFG.free_shipping_over) shipping = 0;
    discount = Math.min(discount || 0, subtotal);
    return { lines, subtotal, shipping, discount, total: subtotal - discount + shipping, soldout };
  }

  // ── 상품 카드 ──
  function cardHTML(p) {
    const rate = p.normal_price > p.price ? Math.round((1 - p.price / p.normal_price) * 100) : 0;
    const wished = getWish().includes(p.id);
    return `<a class="p-card${p.soldout ? " is-soldout" : ""}" href="${productHref(p.id)}">
      <div class="p-thumb"><img src="${esc(img(p.image))}" alt="${esc(p.name)}" loading="lazy">${p.badge ? `<span class="badge ${esc(p.badge)}">${esc(p.badge)}</span>` : ""}${p.soldout ? `<span class="soldout-cover">일시품절</span>` : ""}
      <button class="wish-btn${wished ? " on" : ""}" data-wish="${esc(p.id)}" aria-label="찜하기">${HEART}</button></div>
      <div class="p-brand">${esc(p.brand || "")}</div><div class="p-name">${esc(p.name)}</div>
      <div class="p-price">${rate ? `<span class="rate">${rate}%</span>` : ""}<span>${won(p.price)}</span>${rate ? `<del>${won(p.normal_price)}</del>` : ""}</div>
      <div class="p-ship">${p.shipping_fee ? "배송비 " + won(p.shipping_fee) : "무료배송"}</div></a>`;
  }
  // 카드 안 찜 버튼 (정적·동적 카드 공통)
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-wish]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    b.classList.toggle("on", toggleWish(b.dataset.wish));
    if ($("#listing")?.dataset.mode === "wish") initListing();
  });
  function markWished() { const w = getWish(); $$("[data-wish]").forEach((b) => b.classList.toggle("on", w.includes(b.dataset.wish))); }

  // ── 사진을 못 불러오면 대체 그림 ──
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t.tagName === "IMG" && !t.dataset.fb) {
      t.dataset.fb = 1; t.src = ROOT + "noimg.svg";
      // 대표 사진이 안 뜨는 상품은 관리자에게 자동 신고 (같은 상품은 한 번만)
      const id = t.closest(".p-card")?.querySelector("[data-wish]")?.dataset.wish || (t.id === "main-img" && $("#buy")?.dataset.id);
      const sent = store.get("broken_sent", []);
      if (id && API && !sent.includes(id)) { store.set("broken_sent", [...sent, id].slice(-200)); fetch(API + "/track/broken", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), keepalive: true }).catch(() => {}); }
    }
  }, true);

  // ── 검색창 ──
  $$("form.search").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    location.href = ROOT + "search.html?q=" + encodeURIComponent(f.querySelector("input").value.trim());
  }));

  // ── 검색 자동완성: 글자를 치면 맞는 상품을 바로 보여줌 ──
  $$("form.search").forEach((f) => {
    const inp = f.querySelector("input");
    inp.setAttribute("autocomplete", "off");
    const box = document.createElement("div");
    box.className = "suggest"; box.hidden = true; f.appendChild(box);
    let timer = null, seq = 0, idx = -1;
    const hl = (name, words) => { let s = esc(name); words.forEach((w) => { if (w) s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<b>${m}</b>`); }); return s; };
    const show = async () => {
      const q = inp.value.trim(), my = ++seq;
      if (q.length < 1) { box.hidden = true; return; }
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      let list;
      if (DBMODE) list = ((await apiGet("/catalog/list?" + new URLSearchParams({ q, size: 8 }))) || {}).items || [];
      else {
        const all = await loadProducts();
        list = all.filter((p) => !p.soldout && words.every((w) => (p.name + " " + (p.brand || "") + " " + (p.category_name || "")).toLowerCase().includes(w)))
          .sort((a, b) => a.name.toLowerCase().indexOf(words[0]) - b.name.toLowerCase().indexOf(words[0])).slice(0, 8);
      }
      if (my !== seq) return;
      idx = -1;
      box.innerHTML = list.length ? list.map((p) => `<a class="sg-item" href="${productHref(p.id)}"><img src="${esc(img(p.image))}" alt="" loading="lazy"><span class="sg-name">${hl(p.name, words)}</span><span class="sg-price">${won(p.qt?.length ? p.qt[0] : p.price)}</span></a>`).join("") +
        `<a class="sg-all" href="${ROOT}search.html?q=${encodeURIComponent(q)}">‘${esc(q)}’ 전체 검색 결과 보기 ›</a>` : `<div class="sg-none">맞는 상품이 없어요. 다른 단어로 찾아보세요.</div>`;
      box.hidden = false;
    };
    inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(show, DBMODE ? 200 : 60); });
    inp.addEventListener("focus", () => inp.value.trim() && show());
    inp.addEventListener("keydown", (e) => {
      const items = [...box.querySelectorAll("a")];
      if (box.hidden || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items.forEach((a, i) => a.classList.toggle("on", i === idx)); }
      else if (e.key === "Enter" && idx >= 0) { e.preventDefault(); location.href = items[idx].href; }
      else if (e.key === "Escape") box.hidden = true;
    });
    document.addEventListener("click", (e) => { if (!f.contains(e.target)) box.hidden = true; });
  });

  // 바닥 근처에 오면 계속 불러오기
  function watchBottom(el, fn) {
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && fn()), { rootMargin: "800px 0px" }).observe(el);
    else window.addEventListener("scroll", () => { if (el.getBoundingClientRect().top < innerHeight + 800) fn(); });
  }
  // ── 목록 (카테고리·검색·찜): 정렬 + 페이지 ──
  async function initListing() {
    const box = $("#listing");
    if (!box) return;
    const q = new URLSearchParams(location.search);
    const mode = box.dataset.mode, grid = $("#list-grid"), pager = $("#pager");
    let sort = q.get("sort") || "rec", page = Math.max(1, parseInt(q.get("page")) || 1);
    if (DBMODE && mode !== "wish") return initListingDB(box, q, mode);
    const all = mode === "wish" ? await getProducts(getWish()) : await loadProducts();
    let list = all;
    if (mode === "cat") list = all.filter((p) => p.category === box.dataset.cat);
    if (mode === "wish") { const w = getWish(); list = w.map((id) => all.find((p) => p.id === id)).filter(Boolean); }
    if (mode === "search") {
      const term = (q.get("q") || "").trim();
      const words = term.toLowerCase().split(/\s+/).filter(Boolean);
      const si = $(".search input"); if (si) si.value = term;
      list = all.filter((p) => words.every((w) => (p.name + " " + p.category_name + " " + (p.brand || "") + " " + (p.summary || "")).toLowerCase().includes(w)));
      $("#list-title").firstChild.textContent = term ? `‘${term}’ 검색 결과` : "전체 상품";
    }
    // 무한 스크롤: 처음 40개, 바닥 근처에 오면 40개씩 더 붙임
    let sorted = [];
    const more = () => {
      const have = grid.querySelectorAll(".p-card").length;
      if (have >= sorted.length) { pager.innerHTML = sorted.length > PER_PAGE ? `<p class="end-note">모든 상품을 다 봤어요 (${sorted.length.toLocaleString()}개)</p>` : ""; return; }
      grid.insertAdjacentHTML("beforeend", sorted.slice(have, have + PER_PAGE).map(cardHTML).join(""));
      markWished();
      pager.innerHTML = grid.querySelectorAll(".p-card").length < sorted.length ? `<div class="loading-more">상품을 더 불러오고 있어요…</div>` : (sorted.length > PER_PAGE ? `<p class="end-note">모든 상품을 다 봤어요 (${sorted.length.toLocaleString()}개)</p>` : "");
    };
    const render = () => {
      sorted = [...list];
      if (sort === "low") sorted.sort((a, b) => a.price - b.price);
      if (sort === "high") sorted.sort((a, b) => b.price - a.price);
      if (sort === "sale") sorted.sort((a, b) => (1 - b.price / b.normal_price) - (1 - a.price / a.normal_price));
      if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      $("#list-count").textContent = sorted.length.toLocaleString() + "개";
      grid.innerHTML = sorted.length ? "" : `<div class="empty">${mode === "wish" ? "찜한 상품이 없어요." : mode === "search" ? "검색 결과가 없어요. 다른 단어로 찾아보세요." : "상품을 준비하고 있어요."}</div>`;
      $$(".sort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sort));
      // 예전 주소(?page=3)로 들어오면 그 페이지까지 한 번에 보여줌
      for (let i = 0; i < page; i++) more();
      page = 1;
      const u = new URLSearchParams(location.search);
      sort === "rec" ? u.delete("sort") : u.set("sort", sort);
      u.delete("page");
      history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
    };
    if (!box.dataset.bound) {
      box.dataset.bound = 1;
      $$(".sort button").forEach((b) => b.addEventListener("click", () => { sort = b.dataset.sort; page = 1; render(); }));
      watchBottom(pager, () => more());
    }
    render();
  }

  // 목록 (상품 DB 모드): 정렬·검색·페이지를 서버가 처리
  async function initListingDB(box, q, mode) {
    const grid = $("#list-grid"), pager = $("#pager");
    let sort = q.get("sort") || "rec", page = Math.max(1, parseInt(q.get("page")) || 1);
    const term = mode === "search" ? (q.get("q") || "").trim() : "";
    if (mode === "search") { const si = $(".search input"); if (si) si.value = term; $("#list-title").firstChild.textContent = term ? `‘${term}’ 검색 결과` : "전체 상품"; }
    let total = 0, loading = false;
    const load = async (reset) => {
      if (loading) return; loading = true;
      if (reset) { page = 1; grid.innerHTML = ""; }
      const qs = new URLSearchParams({ sort, page, size: PER_PAGE });
      if (term) qs.set("q", term);
      if (mode === "cat") qs.set("cat", box.dataset.cat);
      const d = await apiGet("/catalog/list?" + qs);
      loading = false;
      if (!d) { if (reset) grid.innerHTML = `<div class="empty">상품을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</div>`; return; }
      total = d.total;
      $("#list-count").textContent = d.total.toLocaleString() + "개";
      if (reset && !d.items.length) grid.innerHTML = `<div class="empty">${mode === "search" ? "검색 결과가 없어요. 다른 단어로 찾아보세요." : "상품을 준비하고 있어요."}</div>`;
      grid.insertAdjacentHTML("beforeend", d.items.map(cardHTML).join(""));
      $$(".sort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sort));
      const have = grid.querySelectorAll(".p-card").length;
      pager.innerHTML = have < total ? `<div class="loading-more">상품을 더 불러오고 있어요…</div>` : (total > PER_PAGE ? `<p class="end-note">모든 상품을 다 봤어요 (${total.toLocaleString()}개)</p>` : "");
      markWished();
      page++;
      const u = new URLSearchParams(location.search);
      sort === "rec" ? u.delete("sort") : u.set("sort", sort);
      u.delete("page");
      history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
    };
    const render = () => load(true);
    $$(".sort button").forEach((b) => b.addEventListener("click", () => { sort = b.dataset.sort; render(); }));
    watchBottom(pager, () => { if (grid.querySelectorAll(".p-card").length < total) load(false); });
    render();
  }

  // ── 상품 DB 템플릿(product/item.html) 채우기 ──
  async function fillItem() {
    const box = $("#item-tpl");
    if (!box) return;
    const id = new URLSearchParams(location.search).get("id") || "";
    const p = id && API ? await apiGet("/catalog/item?id=" + encodeURIComponent(id)) : null;
    if (!p) { box.innerHTML = `<div class="page"><div class="empty">상품을 찾을 수 없어요. <a href="${ROOT}index.html" style="text-decoration:underline">홈으로</a></div></div>`; return false; }
    document.title = `${p.name} — ${CFG.shop_name || ""}`;
    const cat = (CFG.cat_names || {})[p.category] || "";
    $(".crumb").innerHTML = `<a href="${ROOT}index.html">홈</a>` + (p.category ? ` / <a href="${ROOT}category/${esc(p.category)}.html">${esc(cat || "카테고리")}</a>` : "");
    const gallery = [p.image, ...(p.images || [])].filter(Boolean);
    $("#main-img").src = img(p.image); $("#main-img").alt = p.name;
    if (gallery.length > 1) $(".gallery").insertAdjacentHTML("beforeend", `<div class="thumbs">${gallery.map((u, i) => `<button data-src="${esc(img(u))}" class="${i ? "" : "on"}" aria-label="사진 ${i + 1}"><img src="${esc(img(u))}" alt="" loading="lazy"></button>`).join("")}</div>`);
    if (p.brand) $(".d-name").insertAdjacentHTML("beforebegin", `<div class="d-brand">${esc(p.brand)}</div>`);
    $(".d-name").textContent = p.name;
    $(".d-price").innerHTML = `<span class="now">${won(p.price)}</span>`;
    const opts = p.options || [];
    if (opts.length) $(".qty-row").insertAdjacentHTML("beforebegin", `<label class="opt-label" for="opt">${esc(p.option_name || "옵션")}</label><select id="opt" class="opt-select"><option value="">선택해 주세요</option>` +
      opts.map((o, i) => `<option value="${i}"${o.so ? " disabled" : ""}>${o.so ? "[품절] " : ""}${esc(o.v)}${o.add > 0 ? ` (+${won(o.add)})` : o.add < 0 ? ` (${won(o.add)})` : ""}</option>`).join("") + `</select>`);
    const buy = $("#buy");
    Object.assign(buy.dataset, { id: p.id, name: p.name, price: p.price, opts: JSON.stringify(opts.map((o) => o.add)), qt: JSON.stringify(p.qt || []) });
    const bb = $("#bulk-box"); if (bb) { bb.href = ROOT + "bulk.html?id=" + encodeURIComponent(p.id); bb.hidden = !!p.soldout; }
    const qd = $("#qty-deal");
    if (qd && (p.qt || []).length >= 3 && !p.soldout && p.qt[2] <= p.qt[0] * 0.97) {
      qd.hidden = false; $(".offer-box").hidden = true;
      qd.innerHTML = `<p><b>많이 살수록 개당 가격이 내려가요</b> <span class="muted">2개부터 자동 할인 · 옵션이 달라도 같은 상품이면 합산돼요</span></p><div class="qty-cells">` +
        [1, 2, 3, 5].filter((n) => n <= p.qt.length && !(n === 5 && p.qt[4] >= p.qt[2])).map((n) => `<button type="button" data-q="${n}"><b>${n}개</b><span>개당 ${won(p.qt[n - 1])}</span><em>${n > 1 && p.qt[n - 1] < p.qt[0] ? Math.round((1 - p.qt[n - 1] / p.qt[0]) * 100) + "%↓" : "&nbsp;"}</em></button>`).join("") + `</div>`;
    }
    if (p.soldout) { $("#add-cart")?.remove(); $("#buy-now")?.replaceWith(Object.assign(document.createElement("button"), { className: "btn btn-soldout", disabled: true, textContent: "일시품절 · 입고되면 다시 판매해요" })); $(".offer-box").hidden = true; }
    $(".detail-body").innerHTML = p.detail_html ? `<div class="detail-html">${p.detail_html}</div>` : `<img src="${esc(img(p.image))}" alt="${esc(p.name)}" loading="lazy" style="max-width:640px;width:100%"><p style="margin-top:18px">${esc(p.name)}</p>`;
    $$(".notice-table tr").forEach((tr) => { const k = tr.querySelector("th")?.textContent, td = tr.querySelector("td");
      if (k === "상품명") td.textContent = p.name; if (k === "브랜드") td.textContent = p.brand || "상세페이지 참조"; });
    return true;
  }

  // ── 최근 본 상품 (메인) ──
  async function initRecent() {
    const box = $("#recent-box");
    if (!box) return;
    const ids = store.get("recent", []);
    if (!ids.length) return;
    const all = await getProducts(ids.slice(0, 8));
    const list = ids.map((id) => all.find((p) => p.id === id)).filter(Boolean).slice(0, 4);
    if (!list.length) return;
    $("#recent-grid").innerHTML = list.map(cardHTML).join("");
    box.style.display = "";
  }

  // ── 상품 상세 ──
  function initDetail() {
    const el = $("#buy");
    if (!el) return;
    document.body.classList.add("has-buybar");
    if (memberPct() && $(".d-price")) {
      if (token() && member()) $(".d-price").insertAdjacentHTML("afterend", `<p class="member-badge on">회원 ${memberPct()}% 추가 즉시 할인 · 결제할 때 적용</p>`);
      else loginOn().then((on) => on && $(".d-price").insertAdjacentHTML("afterend", `<a class="member-badge" href="${ROOT}login.html">로그인하면 <b>${memberPct()}% 추가</b> 즉시 할인 ›</a>`));
    }
    const id = el.dataset.id, name = el.dataset.name, base = Number(el.dataset.price), adds = JSON.parse(el.dataset.opts || "[]"), qt = JSON.parse(el.dataset.qt || "[]");
    const unitAt = (n) => (qt.length ? qt[Math.min(n, qt.length) - 1] : base);
    store.set("recent", [id, ...store.get("recent", []).filter((x) => x !== id)].slice(0, 20));
    const inp = $("#qty"), sel = $("#opt");
    const optIdx = () => (sel && sel.value !== "" ? Number(sel.value) : null);
    const sync = () => {
      const v = Math.max(1, Math.min(99, parseInt(inp.value) || 1));
      inp.value = v;
      const o = optIdx(), unit = unitAt(v) + (o != null ? adds[o] : 0);
      $("#d-total").innerHTML = (qt.length && v > 1 && unitAt(v) < base ? `<small class="per">개당 ${won(unit)} · ${won((unitAt(1) - unitAt(v)) * v)} 할인</small>` : "") + won(unit * v);
      $$("#qty-deal [data-q]").forEach((b) => b.classList.toggle("on", +b.dataset.q === v || (+b.dataset.q === 5 && v >= 5) || (+b.dataset.q === 3 && (v === 4 || (v >= 5 && !$("#qty-deal [data-q='5']"))))));
    };
    $$("#qty-deal [data-q]").forEach((b) => (b.onclick = () => { inp.value = b.dataset.q; sync(); }));
    $("#minus").onclick = () => { inp.value = +inp.value - 1; sync(); };
    $("#plus").onclick = () => { inp.value = +inp.value + 1; sync(); };
    inp.oninput = sync;
    if (sel) sel.onchange = sync;
    const needOpt = () => { if (sel && sel.value === "") { alert("옵션을 선택해 주세요."); sel.focus(); return true; } return false; };
    if ($("#add-cart")) $("#add-cart").onclick = () => {
      if (needOpt()) return;
      addToCart(id, +inp.value, optIdx());
      if (confirm("장바구니에 담았어요. 장바구니로 이동할까요?")) location.href = ROOT + "cart.html";
    };
    if ($("#buy-now")) $("#buy-now").onclick = () => {
      if (needOpt()) return;
      const o = optIdx();
      store.set("buynow", [o == null ? { id, qty: +inp.value } : { id, qty: +inp.value, opt: o }]);
      location.href = ROOT + "checkout.html?mode=now";
    };
    // 대량 구매 가격 제안 (3개 이상, 최대 3%)
    const OF = CFG.offer || { min_qty: 3, max_rate: 0.03 };
    const ofForm = $("#offer-form");
    if (ofForm) {
      const unitNow = () => base + (optIdx() != null ? adds[optIdx()] : 0);
      const floor = () => Math.ceil(unitNow() * (1 - OF.max_rate) / 10) * 10;
      const ratePrice = (r) => Math.max(floor(), Math.ceil(unitNow() * (1 - r) / 10) * 10);
      const paintOffer = () => {
        const q = +inp.value, u = unitNow(), p = parseInt(digits($("#offer-price").value)) || 0;
        $("#offer-rates").innerHTML = [0.01, 0.02, 0.03].map((r) => `<button type="button" class="chip${p === ratePrice(r) ? " on" : ""}" data-rate="${r}">${r * 100}% 낮게 · ${won(ratePrice(r))}</button>`).join("");
        $("#offer-calc").innerHTML = q < OF.min_qty ? `<b>수량을 ${OF.min_qty}개 이상</b>으로 늘려 주세요. (지금 ${q}개)`
          : `판매가 개당 ${won(u)} × ${q}개 = ${won(u * q)}` + (p ? `<br>제안가 개당 <b>${won(p)}</b> × ${q}개 = <b>${won(p * q)}</b> <span style="color:var(--sale)">(−${won((u - p) * q)})</span>` : "");
      };
      $("#offer-open").onclick = () => {
        if (needOpt()) return;
        ofForm.hidden = !ofForm.hidden;
        if (!ofForm.hidden) {
          if (+inp.value < OF.min_qty) { inp.value = OF.min_qty; sync(); }
          const a = store.get("addr", null);
          if (a) { if (!$("#offer-name").value) $("#offer-name").value = a.name || ""; if (!$("#offer-phone").value) $("#offer-phone").value = a.phone || ""; if (!$("#offer-email").value) $("#offer-email").value = a.email || ""; }
          if (!$("#offer-price").value) $("#offer-price").value = ratePrice(0.03);
          paintOffer();
        }
      };
      $("#offer-rates").onclick = (e) => { const b = e.target.closest("[data-rate]"); if (b) { $("#offer-price").value = ratePrice(+b.dataset.rate); paintOffer(); } };
      $("#offer-price").oninput = paintOffer;
      [inp, sel].forEach((x) => x && x.addEventListener("input", () => { if (!ofForm.hidden) { $("#offer-price").value = ratePrice(0.03); paintOffer(); } }));
      if (sel) sel.addEventListener("change", () => { if (!ofForm.hidden) { $("#offer-price").value = ratePrice(0.03); paintOffer(); } });
      $("#minus").addEventListener("click", () => !ofForm.hidden && paintOffer());
      $("#plus").addEventListener("click", () => !ofForm.hidden && paintOffer());
      $("#offer-send").onclick = async () => {
        if (needOpt()) return;
        const q = +inp.value, u = unitNow(), p = parseInt(digits($("#offer-price").value)) || 0;
        if (q < OF.min_qty) { alert(`가격 제안은 ${OF.min_qty}개 이상 구매할 때 할 수 있어요.`); return; }
        if (!p || p >= u) { alert("제안 가격은 판매가보다 낮게 적어 주세요."); return; }
        if (p < floor()) { alert(`개당 ${won(floor())}(최대 ${OF.max_rate * 100}% 할인)까지 제안할 수 있어요.`); return; }
        const name = $("#offer-name").value.trim(), phone = $("#offer-phone").value.trim();
        if (!name || digits(phone).length < 10) { alert("이름과 연락처를 정확히 입력해 주세요."); return; }
        const b = $("#offer-send"); b.disabled = true;
        const { ok, d } = await api("/offer/add", { product_id: id, opt: optIdx(), qty: q, price: p, name, phone, email: $("#offer-email").value.trim(), memo: $("#offer-memo").value });
        b.disabled = false;
        if (ok) {
          store.set("my_offers", [{ id: d.offer.id, phone, at: new Date().toISOString() }, ...store.get("my_offers", [])].slice(0, 30));
          alert(d.message + "\n제안번호: " + d.offer.id);
          ofForm.innerHTML = `<div class="offer-calc"><b>제안을 보냈어요</b> (제안번호 ${esc(d.offer.id)})<br>판매자가 답하면 바로 알려드릴게요.${pushBtn(phone, "답변 오면 알림 받기")}</div>`;
        } else alert(d.message);
      };
    }
    const wt = $(".wish-toggle");
    wt.classList.toggle("on", getWish().includes(id));
    wt.onclick = () => wt.classList.toggle("on", toggleWish(id));
    $("#share-btn").onclick = async () => {
      const data = { title: document.title, url: location.href.split("?")[0] };
      try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(data.url); alert("상품 주소를 복사했어요."); } } catch (e) {}
    };
    // 이미지 갤러리
    $$(".thumbs button").forEach((b) => b.addEventListener("click", () => {
      $("#main-img").src = b.dataset.src;
      $$(".thumbs button").forEach((x) => x.classList.toggle("on", x === b));
    }));
    // 탭 강조
    const tabs = $$(".tabs a"), secs = tabs.map((a) => $(a.getAttribute("href")));
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) tabs.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id)); }), { rootMargin: "-30% 0px -60% 0px" });
      secs.forEach((s) => s && io.observe(s));
    }
    sync();
    initReviews(id);
    initQna(id, name);
  }

  async function initReviews(id) {
    const box = $("#rv-box");
    const load = async () => {
      const { ok, d } = await api("/review/list", { product_id: id });
      if (!ok) { box.innerHTML = `<p class="empty">아직 리뷰가 없어요.</p>`; return; }
      $$(".rv-count").forEach((e) => (e.textContent = d.count));
      if (d.count) $("#d-rating").innerHTML = `<span class="stars">${stars(d.avg)}</span><b>${d.avg}</b><a href="#review" class="muted">리뷰 ${d.count}개</a>`;
      box.innerHTML = d.count ? `<div class="rv-sum"><div class="big">${d.avg}</div><div><div class="stars" style="font-size:20px">${stars(d.avg)}</div><div class="muted">구매 고객 ${d.count}명의 평가</div></div></div>` +
        d.reviews.map((r) => `<div class="rv-item"><span class="stars">${stars(r.rating)}</span><div class="meta">${esc(r.name)} · ${date(r.at)}${r.option ? " · " + esc(r.option) : ""}</div><p>${esc(r.text)}</p></div>`).join("")
        : `<p class="empty">아직 리뷰가 없어요. 첫 리뷰를 남겨 주세요.</p>`;
    };
    load();
    const form = $("#rv-form");
    $("#rv-open").onclick = () => {
      form.classList.toggle("open");
      const my = store.get("my_orders", []).find((o) => (o.items || []).includes(id));
      if (my) { $("#rv-order").value = my.orderId; $("#rv-phone").value = my.phone || ""; }
      const qo = new URLSearchParams(location.search).get("order");
      if (qo && !$("#rv-order").value) $("#rv-order").value = qo;
      if (token()) api("/me/orders", { token: token() }).then((r) => {  // 회원: 이 상품을 받은 주문 자동 선택
        const o = r.ok && r.d.orders.find((x) => x.lines.some((l) => String(l.id) === String(id)) && ["배송중", "배송완료", "구매확정"].includes(x.status));
        if (o) { $("#rv-order").value = o.orderId; $("#rv-phone").value = o.phone || ""; $("#rv-text").focus(); }
      });
    };
    let rating = 5;
    const paint = () => $$(".star-pick button").forEach((b) => b.classList.toggle("on", +b.dataset.v <= rating));
    $$(".star-pick button").forEach((b) => (b.onclick = () => { rating = +b.dataset.v; paint(); }));
    paint();
    $("#rv-submit").onclick = async () => {
      const { ok, d } = await api("/review/add", { orderId: $("#rv-order").value.trim(), phone: $("#rv-phone").value, product_id: id, rating, text: $("#rv-text").value });
      alert(d.message || "오류가 났어요.");
      if (ok) { form.classList.remove("open"); $("#rv-text").value = ""; load(); }
    };
    if (location.hash === "#review" && new URLSearchParams(location.search).get("write")) $("#rv-open").click();
  }

  async function initQna(id, name) {
    const box = $("#qa-box");
    const load = async () => {
      const { ok, d } = await api("/qna/list", { product_id: id });
      const list = ok ? d.list : [];
      $$(".qa-count").forEach((e) => (e.textContent = list.length));
      box.innerHTML = list.length ? list.map((q) => `<div class="qa-item"><div class="q">${q.secret ? "비밀글이에요." : esc(q.text)}<span class="state${q.answered ? " done" : ""}">${q.answered ? "답변완료" : "답변대기"}</span></div>
        <div class="muted" style="margin:4px 0 0 22px">${esc(q.name)} · ${date(q.at)}</div>${q.answer ? `<div class="a">${esc(q.answer)}</div>` : ""}</div>`).join("")
        : `<p class="empty">등록된 문의가 없어요.</p>`;
    };
    load();
    const form = $("#qa-form");
    $("#qa-open").onclick = () => form.classList.toggle("open");
    $("#qa-submit").onclick = async () => {
      const { ok, d } = await api("/qna/add", { product_id: id, product_name: name, name: $("#qa-name").value, contact: $("#qa-contact").value, text: $("#qa-text").value, secret: $("#qa-secret").checked });
      alert(d.message || "오류가 났어요.");
      if (ok) { form.classList.remove("open"); $("#qa-text").value = ""; load(); }
    };
  }

  // ── 장바구니 ──
  async function initCart() {
    const box = $("#cart-box");
    if (!box) return;
    const render = async () => {
      const cart = getCart();
      if (!cart.length) {
        box.innerHTML = `<div class="empty">장바구니에 담긴 상품이 없어요.<br><br><a class="btn btn-dark" style="max-width:240px;margin:0 auto" href="${ROOT}index.html">쇼핑 계속하기</a></div>`;
        $("#cart-sum").innerHTML = `<p class="muted">상품을 담으면 결제 금액이 여기에 보여요.</p>`; return;
      }
      const { lines, subtotal, shipping, total, soldout } = calc(cart, await getProducts(cart.map((x) => x.id)));
      const soldNote = soldout.length ? `<p class="note" style="margin-bottom:12px">일시품절: ${soldout.map(esc).join(", ")} — 결제 금액에서 빠져요.</p>` : "";
      box.innerHTML = soldNote + lines.map((l) => `<div class="c-row">
        <a href="${ROOT}product/${encodeURIComponent(l.id)}.html"><img src="${esc(img(l.image))}" alt=""></a>
        <div><a class="nm" href="${ROOT}product/${encodeURIComponent(l.id)}.html">${esc(l.name)}</a>
          ${l.optName ? `<div class="muted">옵션: ${esc(l.optName)}</div>` : ""}
          <div class="muted">${won(l.price)} · ${l.shipping_fee ? "배송비 " + won(l.shipping_fee) : "무료배송"}</div>
          <div class="qty" style="margin-top:10px"><button data-a="-" data-k="${l.ci}" aria-label="빼기">−</button><input value="${l.qty}" readonly aria-label="수량"><button data-a="+" data-k="${l.ci}" aria-label="더하기">+</button></div>
          <button class="x" data-a="x" data-k="${l.ci}">삭제</button></div>
        <strong>${won(l.price * l.qty)}</strong></div>`).join("");
      $("#cart-sum").innerHTML = `<h2>결제 예정 금액</h2><div class="sum"><div><span>상품 금액</span><span>${won(subtotal)}</span></div>
        <div><span>배송비</span><span>${shipping ? won(shipping) : "무료"}</span></div>
        <div class="total"><span>합계</span><b>${won(total)}</b></div></div>
        <a class="btn btn-dark" style="margin-top:22px" href="${ROOT}checkout.html">주문하기</a>
        <a class="btn btn-soft" style="margin-top:8px" href="${ROOT}index.html">쇼핑 계속하기</a>`;
    };
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-a]");
      if (!b) return;
      let c = getCart();
      const k = Number(b.dataset.k), it = c[k];
      if (!it) return;
      if (b.dataset.a === "+") it.qty = Math.min(99, it.qty + 1);
      if (b.dataset.a === "-") it.qty = Math.max(1, it.qty - 1);
      if (b.dataset.a === "x") c = c.filter((_, j) => j !== k);
      setCart(c); render();
    });
    render();
  }

  // ── 주문/결제 ──
  async function initCheckout() {
    if (!$("#checkout")) return;
    const now = new URLSearchParams(location.search).get("mode") === "now";
    const cart = now ? store.get("buynow", []) : getCart();
    if (!cart.length) { location.href = ROOT + "cart.html"; return; }
    const products = await getProducts(cart.map((x) => x.id));
    let coupon = "", discount = 0, widgets = null;
    let sums = calc(cart, products, 0);
    if (sums.soldout.length) {
      alert("일시품절된 상품은 주문에서 빠졌어요.\n- " + sums.soldout.join("\n- "));
      if (!sums.lines.length) { location.href = ROOT + (now ? "index.html" : "cart.html"); return; }
    }

    $("#order-items").innerHTML = sums.lines.map((l) => `<div class="c-row"><img src="${esc(img(l.image))}" alt=""><div><div class="nm">${esc(l.name)}</div>
      <div class="muted">${l.optName ? esc(l.optName) + " · " : ""}${l.qty}개${l.offer ? ` · <span style="color:var(--sale)">제안가 개당 ${won(l.price)}</span> <del>${won(l.list)}</del>` : ""}</div></div><strong>${won(l.price * l.qty)}</strong></div>`).join("");
    const paint = async () => {
      sums = calc(cart, products, discount);
      const rf = regionFee($("#zip").value, ($("#addr1").value + " " + $("#addr2").value).trim());
      if (rf.fee) { sums.shipping += rf.fee; sums.total += rf.fee; sums.remote = rf; }
      sums.member = token() && member() ? memberDisc(sums.lines) : 0;
      if (sums.member) sums.total -= sums.member;
      $("#order-sum").innerHTML = `<div class="sum"><div><span>상품 금액</span><span>${won(sums.subtotal)}</span></div>
        ${sums.discount ? `<div class="minus"><span>쿠폰 할인</span><span>−${won(sums.discount)}</span></div>` : ""}
        ${sums.member ? `<div class="minus"><span>회원 즉시 할인 (${memberPct()}%)</span><span>−${won(sums.member)}</span></div>` : ""}
        <div><span>배송비</span><span>${sums.shipping ? won(sums.shipping) : "무료"}</span></div>
        ${sums.remote ? `<p class="muted" style="margin:4px 0 0;font-size:12px">${esc(sums.remote.label)} 지역 추가 배송비 ${won(sums.remote.fee)}이 포함됐어요.</p>` : ""}
        <div class="total"><span>최종 결제 금액</span><b>${won(sums.total)}</b></div></div>
        ${!sums.member && memberPct() && !token() && sessionStorage.getItem("login_on") === "1" ? `<a class="member-nudge" href="${ROOT}login.html">로그인하면 <b>${memberPct()}% 더</b> 즉시 할인돼요 · 네이버·카카오로 3초 ›</a>` : ""}`;
      $("#pay-btn").textContent = won(sums.total) + " 결제하기";
      if (widgets) await widgets.setAmount({ currency: "KRW", value: sums.total });
    };

    // 배송지 불러오기 · 메모 · 주소검색
    const saved = store.get("addr", null);
    const prefill = saved || (member() && { name: member().name, phone: member().phone, email: member().email });
    if (prefill) ["name", "phone", "email", "zip", "addr1", "addr2"].forEach((k) => { if (prefill[k]) $("#" + k).value = prefill[k]; });
    const offerItem = cart.find((x) => x.offer);
    if (offerItem) {
      if (offerItem.phone) $("#phone").value = offerItem.phone;
      $("#order-items").insertAdjacentHTML("afterend", `<p class="note" style="margin-top:12px">가격 제안이 수락된 주문이에요. 제안을 보낸 연락처로 주문해 주셔야 제안 가격이 적용돼요.</p>`);
    }
    $("#memo-sel").onchange = (e) => { const v = e.target.value; $("#memo").style.display = v === "직접 입력" ? "" : "none"; $("#memo").value = v === "직접 입력" ? "" : v; };
    $("#find-addr").onclick = () => new daum.Postcode({ oncomplete: (d) => { $("#zip").value = d.zonecode; $("#addr1").value = d.roadAddress || d.jibunAddress; $("#addr2").focus(); paint(); } }).open();
    ["zip", "addr1", "addr2"].forEach((k) => $("#" + k).addEventListener("change", () => paint()));
    // 약관 전체 동의
    const reqs = $$(".agree-req");
    $("#agree-all").onchange = (e) => reqs.forEach((c) => (c.checked = e.target.checked));
    reqs.forEach((c) => (c.onchange = () => ($("#agree-all").checked = reqs.every((x) => x.checked))));
    // 쿠폰
    $("#coupon-btn").onclick = async () => {
      const code = $("#coupon-in").value.trim();
      if (!code) { coupon = ""; discount = 0; $("#coupon-msg").textContent = ""; return paint(); }
      const { ok, d } = await api("/coupon/check", { code, subtotal: sums.subtotal });
      coupon = ok ? d.code : ""; discount = ok ? d.discount : 0;
      $("#coupon-msg").textContent = ok ? `‘${d.name}’ 쿠폰이 적용되었어요. (−${won(d.discount)})` : d.message;
      $("#coupon-msg").style.color = ok ? "var(--ok)" : "var(--sale)";
      paint();
    };

    await paint();
    if (typeof TossPayments === "undefined") {
      $("#payment-method").innerHTML = `<p class="note" style="margin:0">결제 모듈을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요.</p>`;
      $("#pay-btn").disabled = true; return;
    }
    const tp = TossPayments(CFG.toss_client_key);
    widgets = tp.widgets({ customerKey: TossPayments.ANONYMOUS });
    await widgets.setAmount({ currency: "KRW", value: sums.total });
    await Promise.all([
      widgets.renderPaymentMethods({ selector: "#payment-method", variantKey: "DEFAULT" }),
      widgets.renderAgreement({ selector: "#agreement", variantKey: "AGREEMENT" }),
    ]);

    $("#pay-btn").onclick = async () => {
      const f = (id) => $("#" + id).value.trim();
      const need = { name: "받는 분 이름", phone: "연락처", zip: "주소", addr2: "상세 주소" };
      for (const k in need) if (!f(k)) { alert(need[k] + "을(를) 입력해 주세요."); $("#" + k).focus(); return; }
      if (digits(f("phone")).length < 9) { alert("연락처를 정확히 입력해 주세요."); $("#phone").focus(); return; }
      if (!reqs.every((c) => c.checked)) { alert("필수 약관에 동의해 주세요."); return; }
      if ($("#save-addr").checked) { store.set("addr", { name: f("name"), phone: f("phone"), email: f("email"), zip: f("zip"), addr1: f("addr1"), addr2: f("addr2") }); memberSave({ addr: store.get("addr") }); }
      else store.set("addr", null);
      await paint();  // 주소에 따른 추가 배송비 반영
      const orderId = "T" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const first = sums.lines[0].name;
      const orderName = (first.length > 40 ? first.slice(0, 40) + "…" : first) + (sums.lines.length > 1 ? ` 외 ${sums.lines.length - 1}건` : "");
      const order = { orderId, orderName, amount: sums.total, items: cart, coupon, fromCart: !now,
        customer: { name: f("name"), phone: f("phone"), email: f("email"), zip: f("zip"), addr: f("addr1") + " " + f("addr2"), addr1: f("addr1"), addr2: f("addr2"), memo: f("memo") } };
      store.set("pending_order", order);
      try {
        await widgets.requestPayment({
          orderId, orderName,
          successUrl: new URL(ROOT + "success.html", location.href).href,
          failUrl: new URL(ROOT + "fail.html", location.href).href,
          customerName: order.customer.name,
          customerEmail: order.customer.email || undefined,
          customerMobilePhone: digits(order.customer.phone),
          metadata: {
            items: cart.map((x) => x.id + (x.opt != null ? "-" + x.opt : "") + "x" + x.qty).join(",").slice(0, 100),
            receiver: (order.customer.name + "/" + order.customer.phone).slice(0, 100),
            address: ("[" + order.customer.zip + "] " + order.customer.addr).slice(0, 100),
            memo: (order.customer.memo || "-").slice(0, 100),
          },
        });
      } catch (e) { if (e.code !== "USER_CANCEL") alert(e.message); }
    };
  }

  // ── 결제 완료 ──
  async function initSuccess() {
    const box = $("#success");
    if (!box) return;
    const q = new URLSearchParams(location.search);
    const paymentKey = q.get("paymentKey"), orderId = q.get("orderId"), amount = Number(q.get("amount"));
    const order = store.get("pending_order", null);
    if (!order || order.orderId !== orderId || order.amount !== amount) {
      box.innerHTML = `<h2>주문 정보를 확인할 수 없어요</h2><p>고객센터로 문의해 주세요. (주문번호 ${esc(orderId || "-")})</p>`; return;
    }
    let ok = false, msg = "";
    if (API) {
      const r = await api("/confirm", { paymentKey, orderId, amount, items: order.items, customer: order.customer, coupon: order.coupon, token: token() || undefined, src: visitSrc });
      ok = r.ok; msg = ok ? "" : r.d.message || "결제 승인에 실패했어요.";
    } else { ok = true; msg = "테스트 모드: 결제 승인 서버가 연결되지 않아 실제 결제는 이루어지지 않았어요."; }
    if (ok) {
      if (order.fromCart) setCart([]);
      store.set("pending_order", null);
      store.set("my_orders", [{ orderId, phone: order.customer.phone, at: new Date().toISOString(), name: order.orderName, items: order.items.map((x) => x.id) }, ...store.get("my_orders", [])].slice(0, 30));
      box.innerHTML = `<div class="mark"><svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h2>주문이 완료되었습니다</h2>
        <p style="margin-top:6px">${esc(order.customer.name)}님, 주문해 주셔서 감사합니다.</p>
        <dl class="kv narrow" style="margin-top:26px;text-align:left;border-top:1px solid var(--ink);padding-top:18px">
          <dt>주문번호</dt><dd><b>${esc(orderId)}</b></dd><dt>결제 금액</dt><dd>${won(amount)}</dd><dt>배송지</dt><dd>${esc(order.customer.addr)}</dd></dl>
        <p class="muted" style="margin-top:18px">영업일 기준 1~3일 안에 출고돼요. 주문번호와 연락처로 언제든 배송 상황을 확인할 수 있어요.</p>
        ${msg ? `<div class="note narrow" style="margin-top:16px">${esc(msg)}</div>` : ""}
        <div style="margin-top:6px">${pushBtn(order.customer.phone, "배송 알림 받기")}</div>
        <div class="act-row" style="justify-content:center;margin-top:26px"><a class="btn btn-dark sm" href="${ROOT}orders.html?id=${encodeURIComponent(orderId)}">주문 조회</a><a class="btn btn-line sm" href="${ROOT}index.html">쇼핑 계속하기</a></div>`;
    } else {
      box.innerHTML = `<h2>결제가 완료되지 않았어요</h2><p>${esc(msg)}</p><a class="btn btn-dark sm" style="margin:22px auto 0;max-width:220px" href="${ROOT}cart.html">장바구니로</a>`;
    }
  }
  function initFail() {
    if (!$("#fail")) return;
    $("#fail-msg").textContent = new URLSearchParams(location.search).get("message") || "결제가 취소되었어요.";
  }

  // ── 주문 조회 · 취소 · 반품/교환 ──
  function initOrders() {
    const res = $("#order-result");
    if (!res) return;
    const FLOW = ["결제완료", "상품준비중", "배송중", "배송완료"];
    const mine = store.get("my_orders", []);
    const render = (o, phone) => {
      const step = o.status === "구매확정" ? 3 : FLOW.indexOf(o.status);
      const special = step < 0;
      const canCancel = ["결제완료", "상품준비중"].includes(o.status), shipped = ["배송중", "배송완료"].includes(o.status);
      res.innerHTML = `<div class="card"><h2>주문 ${esc(o.orderId)} <span class="state${special ? "" : " done"}">${esc(o.status)}</span></h2>
        ${special ? "" : `<div class="track">${FLOW.map((s, i) => `<div class="${i <= step ? "on" : ""}">${s}</div>`).join("")}</div>`}
        ${trackHTML(o)}
        ${o.claim ? `<div class="note" style="margin-top:16px">${esc(o.claim.type)} 신청 (${esc(o.claim.status)}) — ${esc(o.claim.reason)}</div>` : ""}
        <div style="margin-top:20px">${o.lines.map((l) => `<div class="c-row" style="grid-template-columns:1fr auto"><div><a class="nm" href="${ROOT}product/${encodeURIComponent(l.id)}.html">${esc(l.name)}</a><div class="muted">${l.qty}개</div>
          ${shipped || o.status === "구매확정" ? `<a class="mini-btn" style="display:inline-block;margin-top:6px" href="${ROOT}product/${encodeURIComponent(l.id)}.html?write=1#review">리뷰 쓰기</a>` : ""}</div><strong>${won(l.price * l.qty)}</strong></div>`).join("")}</div>
        <dl class="kv" style="margin-top:18px;border-top:1px solid var(--line);padding-top:18px">
          <dt>주문일</dt><dd>${date(o.paidAt)}</dd><dt>결제 금액</dt><dd><b>${won(o.amount)}</b>${o.discount ? ` (쿠폰 −${won(o.discount)})` : ""} · ${esc(o.method || "")}</dd>
          <dt>받는 분</dt><dd>${esc(o.receiver.name || "")}</dd><dt>배송지</dt><dd>[${esc(o.receiver.zip || "")}] ${esc(o.receiver.addr || "")}</dd>
          ${o.receiver.memo ? `<dt>배송 메모</dt><dd>${esc(o.receiver.memo)}</dd>` : ""}</dl>
        <div class="act-row">${canCancel ? `<button class="btn btn-line sm" data-act="cancel">주문 취소</button>` : ""}
          ${shipped ? `<button class="btn btn-dark sm" data-act="confirm-receipt">구매 확정</button><button class="btn btn-line sm" data-act="반품">반품 신청</button><button class="btn btn-line sm" data-act="교환">교환 신청</button>` : ""}</div>
        <div class="mini-form" id="act-form"><label class="opt-label" id="act-label"></label><textarea class="field" id="act-reason" placeholder="사유를 적어 주세요"></textarea>
          <button class="btn btn-dark sm" style="margin-top:10px" id="act-send">신청하기</button></div></div>`;
      let act = "";
      res.onclick = async (e) => {
        const b = e.target.closest("button[data-act]");
        if (b) {
          act = b.dataset.act;
          if (act === "confirm-receipt") {
            if (!confirm("구매를 확정할까요? 확정 후에는 반품/교환 신청이 어려워요.")) return;
            const r = await api("/order/confirm-receipt", { orderId: o.orderId, phone });
            alert(r.d.message); if (r.ok) render(r.d.order, phone); return;
          }
          $("#act-label").textContent = act === "cancel" ? "취소 사유" : act + " 사유";
          $("#act-form").classList.add("open"); $("#act-reason").focus(); return;
        }
        if (e.target.id === "act-send") {
          const reason = $("#act-reason").value.trim();
          const r = act === "cancel" ? await api("/order/cancel", { orderId: o.orderId, phone, reason }) : await api("/order/claim", { orderId: o.orderId, phone, type: act, reason });
          alert(r.d.message); if (r.ok) render(r.d.order, phone);
        }
      };
    };
    const lookup = async (orderId, phone) => {
      if (!orderId || !phone) { alert("주문번호와 연락처를 입력해 주세요."); return; }
      res.innerHTML = `<p class="empty">조회하고 있어요…</p>`;
      const { ok, d } = await api("/order/lookup", { orderId, phone });
      if (!ok) { res.innerHTML = `<p class="empty">${esc(d.message)}</p>`; return; }
      render(d.order, phone);
    };
    $("#o-btn").onclick = () => lookup($("#o-id").value.trim(), $("#o-phone").value.trim());
    if (token()) (async () => {  // 회원: 내 주문 전체
      const r = await api("/me/orders", { token: token() });
      if (!r.ok || !r.d.orders.length) return;
      const list = r.d.orders, box = document.createElement("div");
      box.className = "card"; box.style.marginBottom = "16px";
      box.innerHTML = `<h2>${esc(member()?.name || "회원")}님의 주문</h2>` + list.map((o, i) => `<div class="c-row" style="grid-template-columns:1fr auto"><div><div class="nm">${esc(o.lines[0].name)}${o.lines.length > 1 ? ` 외 ${o.lines.length - 1}건` : ""}</div><div class="muted">${esc(o.orderId)} · ${date(o.paidAt)} · ${won(o.amount)} · <b>${esc(o.status)}</b></div></div><button class="mini-btn" data-m="${i}">보기</button></div>`).join("");
      $("#o-id").closest(".narrow").prepend(box);
      box.onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) { const o = list[+b.dataset.m]; render(o, o.phone); res.scrollIntoView({ behavior: "smooth" }); } };
    })();
    if (mine.length) {
      $("#my-orders").innerHTML = `<h2>이 기기에서 주문한 내역</h2>` + mine.map((m, i) => `<div class="c-row" style="grid-template-columns:1fr auto"><div><div class="nm">${esc(m.name || m.orderId)}</div><div class="muted">${esc(m.orderId)} · ${date(m.at)}</div></div><button class="mini-btn" data-i="${i}">조회</button></div>`).join("");
      $("#my-orders").style.display = "";
      $("#my-orders").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (b) { const m = mine[+b.dataset.i]; $("#o-id").value = m.orderId; $("#o-phone").value = m.phone; lookup(m.orderId, m.phone); } };
    }
    // 가격 제안 내역
    const OFS = { "대기": "답변 대기", "수락": "수락됨", "거절": "거절됨", "기간만료": "기간 만료", "주문완료": "주문 완료" };
    const offerRow = (o, phone) => `<div class="c-row" style="grid-template-columns:1fr auto;align-items:center"><div>
      <a class="nm" href="${ROOT}product/${encodeURIComponent(o.product_id)}.html">${esc(o.product_name)}</a>${o.opt_name ? ` <span class="muted">[${esc(o.opt_name)}]</span>` : ""}
      <div class="muted">${esc(o.id)} · ${o.qty}개 · 개당 <del>${won(o.unit)}</del> → <b style="color:var(--ink)">${won(o.price)}</b> · 합계 ${won(o.price * o.qty)}</div>
      <div class="muted">${o.status === "대기" ? `답변 기한 ${date(o.expiresAt)}` : o.status === "수락" ? `<b style="color:var(--ok)">${date(o.payBy)}까지 주문하세요</b>` : o.status === "주문완료" ? `주문 ${esc(o.orderId)}` : ""}${o.note ? " · 판매자: " + esc(o.note) : ""}</div></div>
      <div><span class="state${o.status === "수락" ? " done" : ""}">${OFS[o.status] || esc(o.status)}</span>
      ${o.status === "수락" ? `<br><button class="btn btn-dark sm" style="margin-top:8px" data-buy="${esc(o.id)}" data-phone="${esc(phone)}">제안가로 주문</button>` : ""}</div></div>`;
    let shownOffers = [];
    const showOffers = async (ids, phone, box) => {
      const { ok, d } = await api("/offer/check", { ids, phone });
      if (!ok) { box.innerHTML = `<p class="muted">${esc(d.message)}</p>`; return; }
      shownOffers = shownOffers.filter((x) => !d.offers.some((y) => y.id === x.id)).concat(d.offers.map((x) => ({ ...x, phone })));
      box.innerHTML = d.offers.length ? d.offers.map((o) => offerRow(o, phone)).join("") : `<p class="muted">제안을 찾을 수 없어요. 제안번호와 연락처를 확인해 주세요.</p>`;
    };
    const offersSec = $("#offers");
    if (offersSec) {
      const myOf = store.get("my_offers", []);
      const groups = {};
      myOf.forEach((m) => (groups[digits(m.phone)] = groups[digits(m.phone)] || []).push(m.id));
      const mineBox = $("#offer-mine");
      mineBox.innerHTML = myOf.length ? "" : `<p class="muted" style="margin:10px 0 0">이 기기에서 보낸 제안이 없어요. 상품 페이지에서 3개 이상 선택한 뒤 ‘대량 구매 가격 제안’을 눌러 보세요.</p>`;
      Object.entries(groups).forEach(([ph, ids]) => { const div = document.createElement("div"); mineBox.appendChild(div); showOffers(ids, ph, div).then(() => div.insertAdjacentHTML("beforeend", pushBtn(ph, "답변 오면 알림 받기"))); });
      $("#of-btn").onclick = () => {
        const idv = $("#of-id").value.trim().toUpperCase(), ph = $("#of-phone").value.trim();
        if (!idv || !ph) { alert("제안번호와 연락처를 입력해 주세요."); return; }
        let div = $("#offer-found"); if (!div) { div = document.createElement("div"); div.id = "offer-found"; div.style.marginTop = "14px"; offersSec.querySelector(".card").appendChild(div); }
        showOffers([idv], ph, div);
      };
      offersSec.addEventListener("click", (e) => {
        const b = e.target.closest("[data-buy]"); if (!b) return;
        const o = shownOffers.find((x) => x.id === b.dataset.buy); if (!o) return;
        const item = { id: o.product_id, qty: o.qty, offer: o.id, offer_price: o.price, phone: b.dataset.phone };
        if (o.opt != null) item.opt = o.opt;
        store.set("buynow", [item]);
        location.href = ROOT + "checkout.html?mode=now";
      });
    }
    const qid = new URLSearchParams(location.search).get("id");
    if (qid) { const m = mine.find((x) => x.orderId === qid); $("#o-id").value = qid; if (m) { $("#o-phone").value = m.phone; lookup(qid, m.phone); } }
  }

  // ── 고객센터 1:1 문의 ──
  // ── 대량 구매 문의 ──
  async function initBulk() {
    if (!$("#bulk")) return;
    const id = new URLSearchParams(location.search).get("id");
    if (id) {
      const p = (await getProducts([id])).find((x) => x.id === id);
      if (p) {
        $("#bk-product").value = p.name;
        const bi = $("#bulk-item"); bi.hidden = false;
        bi.innerHTML = `<img src="${esc(img(p.image))}" alt=""><div><b>${esc(p.name)}</b><div class="muted">상품번호 ${esc(p.id)} · 1개 ${won(p.price)}${p.qt?.length ? ` · 10개 이상 개당 ${won(p.qt[p.qt.length - 1])}` : ""}</div></div>`;
      }
    }
    const a = store.get("addr", null) || member();
    if (a) { $("#bk-contact").value = a.phone || ""; $("#bk-email").value = a.email || ""; }
    $("#bk-btn").onclick = async () => {
      const v = (k) => $("#bk-" + k).value.trim();
      if (!v("product") || !(parseInt(digits(v("qty"))) > 0)) { alert("상품과 필요 수량을 입력해 주세요."); return; }
      if (!v("name") || digits(v("contact")).length < 9) { alert("회사·단체명(담당자)과 연락처를 입력해 주세요."); return; }
      if (!$("#bk-agree").checked) { alert("개인정보 수집·이용에 동의해 주세요."); return; }
      const text = [`[대량 구매 견적 요청]`, `상품: ${v("product")}${id ? ` (상품번호 ${id})` : ""}`, `수량: ${v("qty")}개`, v("date") && `희망 날짜: ${v("date")}`, v("price") && `희망 단가/예산: ${v("price")}`,
        v("email") && `이메일: ${v("email")}`, $("#bk-tax").checked && "세금계산서 필요", $("#bk-print").checked && "맞춤 작업(인쇄·포장) 필요", v("text") && `요청 사항: ${v("text")}`].filter(Boolean).join("\n");
      const b = $("#bk-btn"); b.disabled = true;
      const { ok, d } = await api("/inquiry/add", { name: v("name"), contact: v("contact"), type: "대량구매", orderId: id || "", text });
      b.disabled = false;
      alert(ok ? "견적 요청이 접수되었어요. 확인 후 연락드릴게요." : d.message);
      if (ok) ["qty", "price", "text"].forEach((k) => ($("#bk-" + k).value = ""));
    };
  }

  function initCs() {
    const b = $("#inq-btn");
    if (!b) return;
    b.onclick = async () => {
      if (!$("#inq-agree").checked) { alert("개인정보 수집·이용에 동의해 주세요."); return; }
      const { ok, d } = await api("/inquiry/add", { name: $("#inq-name").value, contact: $("#inq-contact").value, type: $("#inq-type").value, orderId: $("#inq-order").value, text: $("#inq-text").value });
      alert(d.message || "오류가 났어요.");
      if (ok) ["inq-text", "inq-order"].forEach((id) => ($("#" + id).value = ""));
    };
  }

  // ── 앱 설치 (홈 화면에 추가) ──
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register(ROOT + "sw.js?api=" + encodeURIComponent(API || "")).catch(() => {});
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $$(".install-link").forEach((a) => (a.style.display = "")); });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  if (isIos) $$(".install-link").forEach((a) => (a.style.display = ""));
  document.addEventListener("click", async (e) => {
    if (!e.target.closest(".install-link")) return;
    e.preventDefault();
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; $$(".install-link").forEach((a) => (a.style.display = "none")); }
    else alert("사파리 아래쪽 ‘공유’ 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하면 앱처럼 설치돼요.");
  });

  // ── 방문 기록 (사이트 분석용, 개인정보 없이 무작위 방문자 번호만) ──
  const visitSrc = (() => {
    let v = null;
    try { v = JSON.parse(sessionStorage.getItem("src0") || "null"); } catch (e) {}
    if (!v) {
      const ref = document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer.slice(0, 200) : "";
      v = { ref, utm: new URLSearchParams(location.search).get("utm_source") || "" };
      try { sessionStorage.setItem("src0", JSON.stringify(v)); } catch (e) {}
    }
    return v;
  })();
  if (API && !/admin\.html$/.test(location.pathname)) {
    let vid = store.get("vid", "");
    if (!vid) { vid = Math.random().toString(36).slice(2, 12); store.set("vid", vid); }
    try { fetch(API + "/track/visit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vid, path: location.pathname.replace(/^.*\/shop/, ""), ...visitSrc }), keepalive: true }).catch(() => {}); } catch (e) {}
  }
  updateCounts(); markWished(); paintLogin(); handleLoginHash().then(initLogin);
  initListing(); initRecent(); fillItem().then((r) => r !== false && initDetail()); initCart(); initCheckout(); initSuccess(); initFail(); initOrders(); initCs(); initBulk();
})();
