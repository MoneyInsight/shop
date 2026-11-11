/* 쇼핑몰 공통 스크립트 — 장바구니·검색·결제 */
(function () {
  const ROOT = document.body.dataset.root || "./";
  const CFG = window.SHOP_CFG || {};
  const won = (n) => Number(n).toLocaleString("ko-KR") + "원";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- 저장소 ----------
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const getCart = () => store.get("cart", []);
  const setCart = (c) => { store.set("cart", c); updateBadge(); };

  function addToCart(id, qty) {
    const c = getCart();
    const it = c.find((x) => x.id === id);
    if (it) it.qty += qty; else c.push({ id, qty });
    setCart(c);
  }
  function updateBadge() {
    const n = getCart().reduce((a, b) => a + b.qty, 0);
    document.querySelectorAll(".cart-count").forEach((el) => { el.textContent = n; el.style.display = n ? "grid" : "none"; });
  }

  let PRODUCTS = null;
  async function loadProducts() {
    if (PRODUCTS) return PRODUCTS;
    const r = await fetch(ROOT + "products.json", { cache: "no-cache" });
    PRODUCTS = await r.json();
    return PRODUCTS;
  }

  // 금액 계산: 상품금액 + 상품별 배송비(같은 상품은 1회), 무료배송 기준 이상이면 0
  function calc(cart, products) {
    const map = Object.fromEntries(products.map((p) => [p.id, p]));
    const lines = cart.filter((x) => map[x.id]).map((x) => ({ ...map[x.id], qty: x.qty }));
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
    let shipping = lines.reduce((a, l) => a + (l.shipping_fee || 0), 0);
    if (CFG.free_shipping_over && subtotal >= CFG.free_shipping_over) shipping = 0;
    return { lines, subtotal, shipping, total: subtotal + shipping };
  }

  // ---------- 검색 ----------
  document.querySelectorAll("form.search").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = f.querySelector("input").value.trim();
      location.href = ROOT + "search.html?q=" + encodeURIComponent(q);
    });
  });

  function cardHTML(p) {
    const rate = p.normal_price > p.price ? Math.round((1 - p.price / p.normal_price) * 100) : 0;
    return `<a class="p-card" href="${ROOT}product/${p.id}.html">
      <div class="p-thumb"><img src="${ROOT}${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">${p.badge ? `<span class="badge ${esc(p.badge)}">${esc(p.badge)}</span>` : ""}</div>
      ${p.event ? `<div class="p-event">${esc(p.event)}</div>` : ""}
      <div class="p-name">${esc(p.name)}</div>
      <div class="p-price">${rate ? `<span class="rate">${rate}%</span>` : ""}${won(p.price)}${rate ? `<del>${won(p.normal_price)}</del>` : ""}</div>
      <div class="p-ship">${p.shipping_fee ? "배송비 " + won(p.shipping_fee) : "무료배송"}</div></a>`;
  }

  async function initSearch() {
    const box = $("#search-result");
    if (!box) return;
    const q = new URLSearchParams(location.search).get("q") || "";
    $(".search input").value = q;
    const ps = await loadProducts();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = ps.filter((p) => words.every((w) => (p.name + " " + p.category_name + " " + p.brand + " " + p.summary).toLowerCase().includes(w)));
    $("#search-title").textContent = q ? `'${q}' 검색결과 ${hit.length}개` : "전체 상품";
    box.innerHTML = hit.length ? hit.map(cardHTML).join("") : `<div class="empty">검색 결과가 없어요. 다른 단어로 찾아보세요.</div>`;
  }

  // ---------- 메인: 카테고리 칩 ----------
  function initChips() {
    const chips = document.querySelectorAll(".chips .chip");
    if (!chips.length) return;
    chips.forEach((c) => c.addEventListener("click", () => {
      chips.forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
      const cat = c.dataset.cat;
      document.querySelectorAll("#home-grid .p-card").forEach((el) => {
        el.style.display = !cat || el.dataset.cat === cat ? "" : "none";
      });
    }));
  }

  // ---------- 메인 사이드: 미니 장바구니 ----------
  async function initMiniCart() {
    const box = $("#mini-cart");
    if (!box) return;
    const cart = getCart();
    if (!cart.length) { box.innerHTML = `<p style="color:#888;font-size:14px">담긴 상품이 없어요.</p>`; return; }
    const { lines, total } = calc(cart, await loadProducts());
    box.innerHTML = `<ul class="mini-cart">${lines.slice(0, 4).map((l) => `<li><span>${esc(l.name)}</span><span>${l.qty}개</span></li>`).join("")}</ul>
      <div style="display:flex;justify-content:space-between;margin:12px 0;font-weight:800"><span>합계</span><span>${won(total)}</span></div>
      <a class="btn btn-green" href="${ROOT}cart.html">장바구니 보기</a>`;
  }

  // ---------- 상품 상세 ----------
  function initDetail() {
    const el = $("#buy");
    if (!el) return;
    document.body.classList.add("has-buybar");
    const id = el.dataset.id, price = Number(el.dataset.price);
    const inp = $("#qty");
    const sync = () => {
      let v = Math.max(1, Math.min(99, parseInt(inp.value) || 1));
      inp.value = v;
      $("#d-total").textContent = won(price * v);
    };
    $("#minus").onclick = () => { inp.value = +inp.value - 1; sync(); };
    $("#plus").onclick = () => { inp.value = +inp.value + 1; sync(); };
    inp.oninput = sync;
    $("#add-cart").onclick = () => {
      addToCart(id, +inp.value);
      if (confirm("장바구니에 담았어요. 장바구니로 이동할까요?")) location.href = ROOT + "cart.html";
    };
    $("#buy-now").onclick = () => {
      store.set("buynow", [{ id, qty: +inp.value }]);
      location.href = ROOT + "checkout.html?mode=now";
    };
    sync();
  }

  // ---------- 장바구니 ----------
  async function initCart() {
    const box = $("#cart-box");
    if (!box) return;
    const render = async () => {
      const cart = getCart();
      if (!cart.length) {
        box.innerHTML = `<div class="empty">장바구니가 비어 있어요.<br><br><a class="btn btn-green" style="max-width:240px;margin:0 auto" href="${ROOT}index.html">쇼핑하러 가기</a></div>`;
        $("#cart-sum").innerHTML = ""; return;
      }
      const { lines, subtotal, shipping, total } = calc(cart, await loadProducts());
      box.innerHTML = lines.map((l) => `<div class="c-row">
        <img src="${ROOT}${esc(l.image)}" alt="">
        <div><a class="nm" href="${ROOT}product/${l.id}.html">${esc(l.name)}</a>
          <div style="color:#888;font-size:14px">${won(l.price)} · ${l.shipping_fee ? "배송비 " + won(l.shipping_fee) : "무료배송"}</div>
          <div class="qty" style="margin-top:8px"><button data-a="-" data-id="${l.id}">−</button><input value="${l.qty}" readonly><button data-a="+" data-id="${l.id}">+</button></div>
          <button class="x" data-a="x" data-id="${l.id}">삭제</button></div>
        <strong>${won(l.price * l.qty)}</strong></div>`).join("");
      $("#cart-sum").innerHTML = `<div class="sum"><div><span>상품금액</span><span>${won(subtotal)}</span></div>
        <div><span>배송비</span><span>${won(shipping)}</span></div>
        <div class="total"><span>결제예정금액</span><b>${won(total)}</b></div></div>
        <a class="btn btn-green" style="margin-top:16px" href="${ROOT}checkout.html">주문하기</a>`;
    };
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-a]");
      if (!b) return;
      let c = getCart();
      const it = c.find((x) => x.id === b.dataset.id);
      if (b.dataset.a === "+") it.qty = Math.min(99, it.qty + 1);
      if (b.dataset.a === "-") it.qty = Math.max(1, it.qty - 1);
      if (b.dataset.a === "x") c = c.filter((x) => x.id !== b.dataset.id);
      setCart(c); render();
    });
    render();
  }

  // ---------- 주문/결제 ----------
  async function initCheckout() {
    const box = $("#checkout");
    if (!box) return;
    const now = new URLSearchParams(location.search).get("mode") === "now";
    const cart = now ? store.get("buynow", []) : getCart();
    if (!cart.length) { location.href = ROOT + "cart.html"; return; }
    const { lines, subtotal, shipping, total } = calc(cart, await loadProducts());

    $("#order-items").innerHTML = lines.map((l) => `<div class="c-row"><img src="${ROOT}${esc(l.image)}" alt=""><div><div class="nm">${esc(l.name)}</div><div style="color:#888;font-size:14px">${l.qty}개</div></div><strong>${won(l.price * l.qty)}</strong></div>`).join("");
    $("#order-sum").innerHTML = `<div class="sum"><div><span>상품금액</span><span>${won(subtotal)}</span></div><div><span>배송비</span><span>${won(shipping)}</span></div><div class="total"><span>최종 결제금액</span><b>${won(total)}</b></div></div>`;

    // 주소 검색 (다음 우편번호)
    $("#find-addr").onclick = () => {
      new daum.Postcode({ oncomplete: (d) => { $("#zip").value = d.zonecode; $("#addr1").value = d.roadAddress || d.jibunAddress; $("#addr2").focus(); } }).open();
    };

    // 토스페이먼츠 결제위젯
    const tp = TossPayments(CFG.toss_client_key);
    const widgets = tp.widgets({ customerKey: TossPayments.ANONYMOUS });
    await widgets.setAmount({ currency: "KRW", value: total });
    await Promise.all([
      widgets.renderPaymentMethods({ selector: "#payment-method", variantKey: "DEFAULT" }),
      widgets.renderAgreement({ selector: "#agreement", variantKey: "AGREEMENT" }),
    ]);

    $("#pay-btn").onclick = async () => {
      const f = (id) => $("#" + id).value.trim();
      const need = { name: "받는 분 이름", phone: "연락처", zip: "주소", addr2: "상세주소" };
      for (const k in need) if (!f(k)) { alert(need[k] + "을(를) 입력해 주세요."); $("#" + k).focus(); return; }
      if (!$("#agree").checked) { alert("주문 내용 확인 및 결제 동의에 체크해 주세요."); return; }
      const orderId = "ORD" + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase();
      const orderName = lines[0].name.slice(0, 40) + (lines.length > 1 ? ` 외 ${lines.length - 1}건` : "");
      const order = {
        orderId, orderName, amount: total, items: cart, fromCart: !now,
        customer: { name: f("name"), phone: f("phone"), email: f("email"), zip: f("zip"), addr: f("addr1") + " " + f("addr2"), memo: f("memo") },
        createdAt: new Date().toISOString(),
      };
      store.set("pending_order", order);
      try {
        await widgets.requestPayment({
          orderId, orderName,
          successUrl: new URL(ROOT + "success.html", location.href).href,
          failUrl: new URL(ROOT + "fail.html", location.href).href,
          customerName: order.customer.name,
          customerEmail: order.customer.email || undefined,
          customerMobilePhone: order.customer.phone.replace(/\D/g, ""),
          metadata: {
            items: cart.map((x) => x.id + "x" + x.qty).join(",").slice(0, 100),
            receiver: (order.customer.name + "/" + order.customer.phone).slice(0, 100),
            address: ("[" + order.customer.zip + "] " + order.customer.addr).slice(0, 100),
            memo: (order.customer.memo || "-").slice(0, 100),
          },
        });
      } catch (e) { if (e.code !== "USER_CANCEL") alert(e.message); }
    };
  }

  // ---------- 결제 완료 ----------
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
    if (CFG.worker_url) {
      try {
        const r = await fetch(CFG.worker_url + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentKey, orderId, amount, items: order.items, customer: order.customer }) });
        const d = await r.json();
        ok = r.ok; msg = ok ? "" : d.message || "결제 승인에 실패했어요.";
      } catch (e) { msg = "승인 서버에 연결하지 못했어요."; }
    } else {
      ok = true; msg = "테스트 모드: 결제 승인 서버가 아직 연결되지 않아 실제 결제는 이루어지지 않았어요.";
    }
    if (ok) {
      if (order.fromCart) setCart([]);
      store.set("pending_order", null);
      box.innerHTML = `<div style="font-size:54px">🎉</div><h2 style="margin:8px 0">주문이 완료되었어요</h2>
        <p>주문번호 <b>${esc(orderId)}</b></p><p>결제금액 <b>${won(amount)}</b></p>
        <p style="margin-top:10px;color:#666">${esc(order.customer.name)}님, 상품은 영업일 기준 1~3일 안에 출발해요.<br>주문 문의는 주문번호와 함께 고객센터로 연락 주세요.</p>
        ${msg ? `<div class="test-note" style="margin-top:16px">${esc(msg)}</div>` : ""}
        <a class="btn btn-green" style="max-width:260px;margin:20px auto 0" href="${ROOT}index.html">쇼핑 계속하기</a>`;
    } else {
      box.innerHTML = `<h2>결제가 완료되지 않았어요</h2><p>${esc(msg)}</p><a class="btn btn-dark" style="max-width:260px;margin:20px auto 0" href="${ROOT}cart.html">장바구니로</a>`;
    }
  }

  function initFail() {
    const box = $("#fail");
    if (!box) return;
    const q = new URLSearchParams(location.search);
    $("#fail-msg").textContent = q.get("message") || "결제가 취소되었어요.";
  }

  updateBadge();
  initChips(); initMiniCart(); initDetail(); initCart(); initSearch(); initCheckout(); initSuccess(); initFail();
})();
