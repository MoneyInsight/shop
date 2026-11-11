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
    store.set("wish", w); updateCounts();
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
      return { ok: r.ok, d: await r.json() };
    } catch (e) { return { ok: false, d: { message: "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." } }; }
  }

  let PRODUCTS = null;
  async function loadProducts() {
    if (!PRODUCTS) PRODUCTS = await (await fetch(ROOT + "products.json", { cache: "no-cache" })).json();
    return PRODUCTS;
  }

  // 금액: 상품금액(옵션 추가금 포함) + 배송비(상품별 1회) − 쿠폰
  function calc(cart, products, discount) {
    const map = Object.fromEntries(products.map((p) => [p.id, p]));
    const lines = cart.filter((x) => map[x.id]).map((x) => {
      const p = map[x.id], o = x.opt != null && p.options ? p.options[x.opt] : null;
      return { ...p, qty: x.qty, opt: x.opt, price: p.price + (o ? o.add : 0), optName: o ? o.v : "" };
    });
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
    let shipping = lines.reduce((a, l) => a + (l.shipping_fee || 0), 0);
    if (CFG.free_shipping_over && subtotal >= CFG.free_shipping_over) shipping = 0;
    discount = Math.min(discount || 0, subtotal);
    return { lines, subtotal, shipping, discount, total: subtotal - discount + shipping };
  }

  // ── 상품 카드 ──
  function cardHTML(p) {
    const rate = p.normal_price > p.price ? Math.round((1 - p.price / p.normal_price) * 100) : 0;
    const wished = getWish().includes(p.id);
    return `<a class="p-card" href="${ROOT}product/${encodeURIComponent(p.id)}.html">
      <div class="p-thumb"><img src="${esc(img(p.image))}" alt="${esc(p.name)}" loading="lazy">${p.badge ? `<span class="badge ${esc(p.badge)}">${esc(p.badge)}</span>` : ""}
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

  // ── 검색창 ──
  $$("form.search").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    location.href = ROOT + "search.html?q=" + encodeURIComponent(f.querySelector("input").value.trim());
  }));

  // ── 목록 (카테고리·검색·찜): 정렬 + 페이지 ──
  async function initListing() {
    const box = $("#listing");
    if (!box) return;
    const q = new URLSearchParams(location.search);
    const mode = box.dataset.mode, grid = $("#list-grid"), pager = $("#pager");
    let sort = q.get("sort") || "rec", page = Math.max(1, parseInt(q.get("page")) || 1);
    const all = await loadProducts();
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
    const render = () => {
      const sorted = [...list];
      if (sort === "low") sorted.sort((a, b) => a.price - b.price);
      if (sort === "high") sorted.sort((a, b) => b.price - a.price);
      if (sort === "sale") sorted.sort((a, b) => (1 - b.price / b.normal_price) - (1 - a.price / a.normal_price));
      if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      const pages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
      page = Math.min(page, pages);
      $("#list-count").textContent = sorted.length.toLocaleString() + "개";
      grid.innerHTML = sorted.length ? sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(cardHTML).join("")
        : `<div class="empty">${mode === "wish" ? "찜한 상품이 없어요." : mode === "search" ? "검색 결과가 없어요. 다른 단어로 찾아보세요." : "상품을 준비하고 있어요."}</div>`;
      $$(".sort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sort));
      let html = "";
      if (pages > 1) {
        const from = Math.max(1, Math.min(page - 4, pages - 8)), to = Math.min(pages, from + 8);
        if (page > 1) html += `<button data-p="${page - 1}" aria-label="이전">‹</button>`;
        for (let i = from; i <= to; i++) html += `<button data-p="${i}" class="${i === page ? "on" : ""}">${i}</button>`;
        if (page < pages) html += `<button data-p="${page + 1}" aria-label="다음">›</button>`;
      }
      pager.innerHTML = html;
      const u = new URLSearchParams(location.search);
      sort === "rec" ? u.delete("sort") : u.set("sort", sort);
      page === 1 ? u.delete("page") : u.set("page", page);
      history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
    };
    if (!box.dataset.bound) {
      box.dataset.bound = 1;
      $$(".sort button").forEach((b) => b.addEventListener("click", () => { sort = b.dataset.sort; page = 1; render(); }));
      pager.addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; page = +b.dataset.p; render(); box.scrollIntoView({ behavior: "smooth" }); });
    }
    render();
  }

  // ── 최근 본 상품 (메인) ──
  async function initRecent() {
    const box = $("#recent-box");
    if (!box) return;
    const ids = store.get("recent", []);
    if (!ids.length) return;
    const all = await loadProducts();
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
    const id = el.dataset.id, name = el.dataset.name, base = Number(el.dataset.price), adds = JSON.parse(el.dataset.opts || "[]");
    store.set("recent", [id, ...store.get("recent", []).filter((x) => x !== id)].slice(0, 20));
    const inp = $("#qty"), sel = $("#opt");
    const optIdx = () => (sel && sel.value !== "" ? Number(sel.value) : null);
    const sync = () => {
      const v = Math.max(1, Math.min(99, parseInt(inp.value) || 1));
      inp.value = v;
      const o = optIdx();
      $("#d-total").textContent = won((base + (o != null ? adds[o] : 0)) * v);
    };
    $("#minus").onclick = () => { inp.value = +inp.value - 1; sync(); };
    $("#plus").onclick = () => { inp.value = +inp.value + 1; sync(); };
    inp.oninput = sync;
    if (sel) sel.onchange = sync;
    const needOpt = () => { if (sel && sel.value === "") { alert("옵션을 선택해 주세요."); sel.focus(); return true; } return false; };
    $("#add-cart").onclick = () => {
      if (needOpt()) return;
      addToCart(id, +inp.value, optIdx());
      if (confirm("장바구니에 담았어요. 장바구니로 이동할까요?")) location.href = ROOT + "cart.html";
    };
    $("#buy-now").onclick = () => {
      if (needOpt()) return;
      const o = optIdx();
      store.set("buynow", [o == null ? { id, qty: +inp.value } : { id, qty: +inp.value, opt: o }]);
      location.href = ROOT + "checkout.html?mode=now";
    };
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
      const { lines, subtotal, shipping, total } = calc(cart, await loadProducts());
      box.innerHTML = lines.map((l, i) => `<div class="c-row">
        <a href="${ROOT}product/${encodeURIComponent(l.id)}.html"><img src="${esc(img(l.image))}" alt=""></a>
        <div><a class="nm" href="${ROOT}product/${encodeURIComponent(l.id)}.html">${esc(l.name)}</a>
          ${l.optName ? `<div class="muted">옵션: ${esc(l.optName)}</div>` : ""}
          <div class="muted">${won(l.price)} · ${l.shipping_fee ? "배송비 " + won(l.shipping_fee) : "무료배송"}</div>
          <div class="qty" style="margin-top:10px"><button data-a="-" data-k="${i}" aria-label="빼기">−</button><input value="${l.qty}" readonly aria-label="수량"><button data-a="+" data-k="${i}" aria-label="더하기">+</button></div>
          <button class="x" data-a="x" data-k="${i}">삭제</button></div>
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
    const products = await loadProducts();
    let coupon = "", discount = 0, widgets = null;
    let sums = calc(cart, products, 0);

    $("#order-items").innerHTML = sums.lines.map((l) => `<div class="c-row"><img src="${esc(img(l.image))}" alt=""><div><div class="nm">${esc(l.name)}</div>
      <div class="muted">${l.optName ? esc(l.optName) + " · " : ""}${l.qty}개</div></div><strong>${won(l.price * l.qty)}</strong></div>`).join("");
    const paint = async () => {
      sums = calc(cart, products, discount);
      $("#order-sum").innerHTML = `<div class="sum"><div><span>상품 금액</span><span>${won(sums.subtotal)}</span></div>
        ${sums.discount ? `<div class="minus"><span>쿠폰 할인</span><span>−${won(sums.discount)}</span></div>` : ""}
        <div><span>배송비</span><span>${sums.shipping ? won(sums.shipping) : "무료"}</span></div>
        <div class="total"><span>최종 결제 금액</span><b>${won(sums.total)}</b></div></div>`;
      $("#pay-btn").textContent = won(sums.total) + " 결제하기";
      if (widgets) await widgets.setAmount({ currency: "KRW", value: sums.total });
    };

    // 배송지 불러오기 · 메모 · 주소검색
    const saved = store.get("addr", null);
    if (saved) ["name", "phone", "email", "zip", "addr1", "addr2"].forEach((k) => { if (saved[k]) $("#" + k).value = saved[k]; });
    $("#memo-sel").onchange = (e) => { const v = e.target.value; $("#memo").style.display = v === "직접 입력" ? "" : "none"; $("#memo").value = v === "직접 입력" ? "" : v; };
    $("#find-addr").onclick = () => new daum.Postcode({ oncomplete: (d) => { $("#zip").value = d.zonecode; $("#addr1").value = d.roadAddress || d.jibunAddress; $("#addr2").focus(); } }).open();
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
      if ($("#save-addr").checked) store.set("addr", { name: f("name"), phone: f("phone"), email: f("email"), zip: f("zip"), addr1: f("addr1"), addr2: f("addr2") });
      else store.set("addr", null);
      const orderId = "T" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const first = sums.lines[0].name;
      const orderName = (first.length > 40 ? first.slice(0, 40) + "…" : first) + (sums.lines.length > 1 ? ` 외 ${sums.lines.length - 1}건` : "");
      const order = { orderId, orderName, amount: sums.total, items: cart, coupon, fromCart: !now,
        customer: { name: f("name"), phone: f("phone"), email: f("email"), zip: f("zip"), addr: f("addr1") + " " + f("addr2"), memo: f("memo") } };
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
      const r = await api("/confirm", { paymentKey, orderId, amount, items: order.items, customer: order.customer, coupon: order.coupon });
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
        ${o.tracking ? `<p style="margin:14px 0 0;font-size:14px">${esc(o.courier)} <b>${esc(o.tracking)}</b> · <a style="text-decoration:underline" target="_blank" rel="noopener" href="https://search.naver.com/search.naver?query=${encodeURIComponent((o.courier || "택배") + " " + o.tracking)}">배송 추적</a></p>` : ""}
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
    if (mine.length) {
      $("#my-orders").innerHTML = `<h2>이 기기에서 주문한 내역</h2>` + mine.map((m, i) => `<div class="c-row" style="grid-template-columns:1fr auto"><div><div class="nm">${esc(m.name || m.orderId)}</div><div class="muted">${esc(m.orderId)} · ${date(m.at)}</div></div><button class="mini-btn" data-i="${i}">조회</button></div>`).join("");
      $("#my-orders").style.display = "";
      $("#my-orders").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (b) { const m = mine[+b.dataset.i]; $("#o-id").value = m.orderId; $("#o-phone").value = m.phone; lookup(m.orderId, m.phone); } };
    }
    const qid = new URLSearchParams(location.search).get("id");
    if (qid) { const m = mine.find((x) => x.orderId === qid); $("#o-id").value = qid; if (m) { $("#o-phone").value = m.phone; lookup(qid, m.phone); } }
  }

  // ── 고객센터 1:1 문의 ──
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

  updateCounts(); markWished();
  initListing(); initRecent(); initDetail(); initCart(); initCheckout(); initSuccess(); initFail(); initOrders(); initCs();
})();
