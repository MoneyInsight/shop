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
  const costIn = $("#market-in");
  const lowIn = $("#naver-low-in");
  if (lowIn && costIn) lowIn.addEventListener("input", () => costIn.dispatchEvent(new Event("input")));
  if (costIn) costIn.addEventListener("input", () => {
    const c = parseInt(costIn.value.replace(/\D/g, "")) || 0;
    if (!c) return;
    const price = Math.ceil(c * 0.95 / 10) * 10, card = Math.round(price * 0.034), fee = Math.round(price * 0.03), settle = Math.floor(price * 0.936);
    $("#price-preview").innerHTML = `오픈마켓 판매가 <b>${won(c)}</b> → 땡잡았땡 판매가 <b style="color:#e5322d">${won(price)}</b> (고객 5% 할인)<br>
      공급사 정산금 <b>${won(settle)}</b> = 판매가 − 카드수수료 ${won(card)} − 플랫폼 3% ${won(fee)}<br>
      같은 상품을 오픈마켓(수수료 12%)에서 팔 때 정산금 약 <b>${won(Math.floor(c * 0.88))}</b>` +
      (() => { const low = parseInt(($("#naver-low-in").value || "").replace(/\D/g, "")) || 0;
        return !low ? "" : price < low ? `<br>✅ 네이버 최저가 ${won(low)}보다 ${won(low - price)} 싸요 — 등록 가능` : `<br>❌ 네이버 최저가 ${won(low)}보다 비싸요 — 등록 불가`; })();
  });

  // ---------- 엑셀 일괄 등록 (땡잡았땡 양식) ----------
  const bulkBtn = $("#bulk-btn");
  if (bulkBtn) bulkBtn.addEventListener("click", async () => {
    if (!API && noApi()) return;
    const code = $("#bulk-code").value.trim(), file = $("#bulk-file").files[0], out = $("#bulk-result");
    if (!code || !file) { alert("입점코드와 엑셀 파일을 넣어 주세요."); return; }
    if (!window.XLSX) await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const norm = (s) => String(s).replace(/\s+/g, "");
    const h = rows.findIndex((r) => r.map(norm).includes("상품명"));
    if (h < 0) { alert("'상품명' 열을 찾지 못했어요. 땡잡았땡 상품등록 양식인지 확인해 주세요."); return; }
    const head = rows[h].map(norm);
    const col = (...names) => { for (const n of names) { const i = head.indexOf(norm(n)); if (i >= 0) return i; } return -1; };
    const C = { name: col("상품명"), price: col("오픈마켓 판매가", "판매가"), img: col("대표 이미지 주소", "대표 이미지 파일명", "대표이미지", "대표 이미지 URL"), detail: col("상세 설명", "상품 상세정보", "상세설명"), summary: col("한 줄 소개"),
      brand: col("브랜드"), maker: col("제조사"), origin: col("원산지 직접입력", "원산지"), shipType: col("배송비 유형"), ship: col("기본배송비"),
      disc: col("즉시할인 값(기본할인)", "즉시할인 값"), discUnit: col("즉시할인 단위(기본할인)", "즉시할인 단위"), cat: col("카테고리", "쇼핑몰카테고리"), low: col("네이버 최저가", "네이버최저가") };
    const num = (v) => parseInt(String(v).replace(/[^0-9.-]/g, "")) || 0;
    const v = (r, i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
    const { cats = [], keywords = [] } = window.SHOP_CATS || {};
    const guess = (name, c) => { const byName = cats.find((x) => x.name === c || x.slug === c); if (byName) return byName.slug;
      for (const [slug, words] of keywords) if (words.split(" ").some((w) => name.includes(w))) return slug; return "living"; };
    const list = rows.slice(h + 1).filter((r) => v(r, C.name) && num(v(r, C.price)));
    if (!list.length) { alert("등록할 상품이 없어요. 상품명과 판매가를 확인해 주세요."); return; }
    bulkBtn.disabled = true; out.innerHTML = "";
    let okN = 0;
    for (const [i, r] of list.entries()) {
      const price = num(v(r, C.price));
      let disc = num(v(r, C.disc)); if (disc && v(r, C.discUnit).includes("%")) disc = Math.round(price * disc / 100);
      const ship = v(r, C.shipType).includes("무료") ? 0 : num(v(r, C.ship));
      const body = { code, name: v(r, C.name), category: guess(v(r, C.name), v(r, C.cat)), market_price: price - disc + ship, naver_low: num(v(r, C.low)),
        image: v(r, C.img), brand: v(r, C.brand), maker: v(r, C.maker), origin: v(r, C.origin), description: v(r, C.detail), summary: v(r, C.summary) };
      bulkBtn.textContent = `등록 중… ${i + 1}/${list.length}`;
      let msg;
      try { const res = await fetch(API + "/seller/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await res.json(); msg = res.ok ? "✅ 접수" : "❌ " + (d.message || "오류"); if (res.ok) okN++; }
      catch (e) { msg = "❌ 서버 연결 실패"; }
      out.insertAdjacentHTML("beforeend", `<div style="padding:4px 0;border-bottom:1px dashed #eee">${esc(body.name)} — ${esc(msg)}</div>`);
    }
    out.insertAdjacentHTML("afterbegin", `<b>총 ${list.length}개 중 ${okN}개 접수 완료</b> (검수 후 판매 시작)`);
    bulkBtn.disabled = false; bulkBtn.textContent = "엑셀 상품 등록 요청";
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
      <small>오픈마켓가 ${won(p.market_price)} · 정산금 ${won(p.supply_price)} · 자동 판매가 <b>${won(p.suggested_price)}</b></small><br>
      <small>네이버 최저가 ${won(p.naver_low)}</small><br><small>${esc(p.summary)}</small></div>
      <div style="display:flex;flex-direction:column;gap:6px"><input data-price="${p.id}" value="${p.suggested_price}" style="width:110px;height:36px;border:1px solid #ccc;border-radius:8px;padding:0 8px">
      <button class="chip on" data-act="approve-product" data-id="${p.id}">승인</button><button class="chip" data-act="reject-product" data-id="${p.id}">반려</button></div></div>`).join("") : "<p>대기 중인 상품이 없어요.</p>";
    $("#orders").innerHTML = d.orders.length ? d.orders.map((o) => `<div class="c-row" style="grid-template-columns:1fr auto">
      <div><b>${esc(o.orderId)}</b> · ${new Date(o.paidAt).toLocaleString("ko-KR")} · <b>${won(o.amount)}</b><br>
      <small>${esc(o.customer.name)} / ${esc(o.customer.phone)} / [${esc(o.customer.zip)}] ${esc(o.customer.addr)} / ${esc(o.customer.memo || "")}</small>
      <ul style="margin:6px 0 0 18px;font-size:14px">${o.lines.map((l) => `<li>[${esc(l.supplier)}] ${esc(l.name)} × ${l.qty} — 정산금 ${won(l.supply_price * l.qty)}</li>`).join("")}</ul></div>
      <span class="chip">${esc(o.status || "결제완료")}</span></div>`).join("") : "<p>주문이 없어요.</p>";
    $("#reports").innerHTML = (d.reports || []).length ? d.reports.map((r) => `<div class="c-row" style="grid-template-columns:1fr auto">
      <div><a href="product/${encodeURIComponent(r.product_id)}.html" target="_blank"><b>${esc(r.product_name)}</b></a><br>
      <small>우리 ${won(r.our_price)} → 신고 가격 <b style="color:#e5322d">${won(r.price)}</b> · <a href="${esc(r.url)}" target="_blank" rel="noopener">신고된 곳 보기</a> · 연락처 ${esc(r.contact || "-")} · ${new Date(r.createdAt).toLocaleString("ko-KR")}</small></div>
      ${r.status === "확인 전" ? `<div style="display:flex;flex-direction:column;gap:6px"><button class="chip on" data-act="report-done" data-id="${r.id}">보상 완료</button><button class="chip" data-act="report-reject" data-id="${r.id}">해당 없음</button></div>` : `<span class="chip">${esc(r.status)}</span>`}</div>`).join("") : "<p>신고가 없어요.</p>";
  }

  async function loadPriceCheck() {
    const box = $("#price-check"); if (!box) return;
    try {
      const list = await (await fetch("price_check.json", { cache: "no-cache" })).json();
      box.innerHTML = list.length ? list.map((x) => `<div class="c-row" style="grid-template-columns:1fr auto"><div>${esc(x.name)}<br><small>${esc(x.file)}</small></div><div style="text-align:right;font-size:14px">우리 ${won(x.price)}<br>네이버 ${won(x.naver_low)}</div></div>`).join("") : "<p>없어요 👍</p>";
    } catch (e) { box.innerHTML = "<p>없어요 👍</p>"; }
  }
  loadPriceCheck();

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === "approve-seller") await call("/admin/approve-seller", { id });
      if (b.dataset.act === "approve-product") await call("/admin/approve-product", { id, price: Number($(`input[data-price="${id}"]`).value) });
      if (b.dataset.act === "reject-product") await call("/admin/reject-product", { id });
      if (b.dataset.act === "report-done") await call("/admin/close-report", { id, status: "보상 완료" });
      if (b.dataset.act === "report-reject") await call("/admin/close-report", { id, status: "해당 없음" });
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
