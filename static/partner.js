/* 공급사 입점·상품등록 + 관리자 페이지 */
(function () {
  const API = (window.SHOP_CFG || {}).worker_url;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";
  const noApi = () => { alert("아직 서버(worker_url)가 연결되지 않았어요. 관리자에게 문의해 주세요."); return true; };

  const fileToB64 = (file) => new Promise((ok, no) => {
    const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file);
  });

  // ---------- 공급사 폼 ----------
  document.querySelectorAll("button[data-api]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!API && noApi()) return;
      const box = btn.closest(".card");
      const data = {};
      for (const el of box.querySelectorAll("input,textarea,select")) {
        if (el.type === "file") {
          const f = el.files[0];
          if (f) {
            if (f.size > 2 * 1024 * 1024) { alert("이미지는 2MB 이하로 올려 주세요."); return; }
            data.image = await fileToB64(f); data.image_name = f.name;
          }
        } else data[el.name] = el.value.trim();
      }
      btn.disabled = true; const t = btn.textContent; btn.textContent = "보내는 중…";
      try {
        const r = await fetch(API + btn.dataset.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        const d = await r.json();
        alert(d.message || (r.ok ? "접수되었어요." : "오류가 났어요."));
        if (r.ok) box.querySelectorAll("input:not([name=code]),textarea").forEach((el) => (el.value = ""));
      } catch (e) { alert("서버에 연결하지 못했어요."); }
      btn.disabled = false; btn.textContent = t;
    });
  });

  // ---------- 가격 미리보기 ----------
  const costIn = $("#cost-in");
  if (costIn) costIn.addEventListener("input", () => {
    const c = parseInt(costIn.value.replace(/\D/g, "")) || 0;
    if (!c) return;
    const supply = Math.ceil(c * 1.07), price = Math.ceil(supply * 1.07 / 10) * 10;
    $("#price-preview").innerHTML = `원가 <b>${won(c)}</b> → 공급가(공급사 정산) <b>${won(supply)}</b> → 판매가 <b style="color:#e5322d">${won(price)}</b><br>오픈마켓(수수료 12%)에서 같은 마진이면 약 <b>${won(Math.ceil(supply / 0.88 / 10) * 10)}</b>`;
  });

  // ---------- 관리자 ----------
  const enter = $("#admin-enter");
  if (!enter) return;
  let PW = sessionStorage.getItem("admin_pw") || "";
  const call = async (path, body) => {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + PW }, body: JSON.stringify(body || {}) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || "오류");
    return d;
  };

  async function load() {
    const d = await call("/admin/list");
    $("#admin-login").style.display = "none"; $("#admin-body").style.display = "";
    $("#apps").innerHTML = d.apps.length ? d.apps.map((a) => `<div class="c-row" style="grid-template-columns:1fr auto">
      <div><b>${esc(a.company)}</b> (${esc(a.biz_no)})<br><small>${esc(a.manager)} · ${esc(a.phone)} · ${esc(a.email)}<br>${esc(a.items)}</small>
      ${a.code ? `<div style="margin-top:6px">입점코드: <b style="color:#03c75a">${esc(a.code)}</b></div>` : ""}</div>
      ${a.code ? "" : `<button class="chip on" data-act="approve-seller" data-id="${a.id}">승인·코드발급</button>`}</div>`).join("") : "<p>신청이 없어요.</p>";
    $("#pending").innerHTML = d.pending.length ? d.pending.map((p) => `<div class="c-row">
      <img src="${p.image_url || ""}" alt="">
      <div><b>${esc(p.name)}</b> <small>(${esc(p.supplier)})</small><br>
      <small>원가 ${won(p.cost)} · 공급가 ${won(p.supply_price)} · 자동 판매가 <b>${won(p.suggested_price)}</b></small><br>
      <small>${esc(p.summary)}</small></div>
      <div style="display:flex;flex-direction:column;gap:6px"><input data-price="${p.id}" value="${p.suggested_price}" style="width:110px;height:36px;border:1px solid #ccc;border-radius:8px;padding:0 8px">
      <button class="chip on" data-act="approve-product" data-id="${p.id}">승인</button><button class="chip" data-act="reject-product" data-id="${p.id}">반려</button></div></div>`).join("") : "<p>대기 중인 상품이 없어요.</p>";
    $("#orders").innerHTML = d.orders.length ? d.orders.map((o) => `<div class="c-row" style="grid-template-columns:1fr auto">
      <div><b>${esc(o.orderId)}</b> · ${new Date(o.paidAt).toLocaleString("ko-KR")} · <b>${won(o.amount)}</b><br>
      <small>${esc(o.customer.name)} / ${esc(o.customer.phone)} / [${esc(o.customer.zip)}] ${esc(o.customer.addr)} / ${esc(o.customer.memo || "")}</small>
      <ul style="margin:6px 0 0 18px;font-size:14px">${o.lines.map((l) => `<li>[${esc(l.supplier)}] ${esc(l.name)} × ${l.qty} — 공급가 ${won(l.supply_price * l.qty)}</li>`).join("")}</ul></div>
      <span class="chip">${esc(o.status || "결제완료")}</span></div>`).join("") : "<p>주문이 없어요.</p>";
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "approve-seller") await call("/admin/approve-seller", { id });
      if (b.dataset.act === "approve-product") await call("/admin/approve-product", { id, price: Number($(`input[data-price="${id}"]`).value) });
      if (b.dataset.act === "reject-product") await call("/admin/reject-product", { id });
      await load();
    } catch (e) { alert(e.message); }
  });

  enter.onclick = async () => {
    if (!API && noApi()) return;
    PW = $("#admin-pw").value; sessionStorage.setItem("admin_pw", PW);
    try { await load(); } catch (e) { alert(e.message); }
  };
  if (PW && API) load().catch(() => {});
})();
