/* 땡잡았땡 관리자 — 대시보드·주문·취소/반품·문의·리뷰·쿠폰·공급사 */
(function () {
  const API = (window.SHOP_CFG || {}).worker_url;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";
  const dt = (iso) => new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const COURIERS = ["CJ대한통운", "한진택배", "롯데택배", "우체국택배", "로젠택배", "경동택배", "대신택배", "기타"];
  let PW = sessionStorage.getItem("admin_pw") || "", D = null, tab = "dash", orderFilter = "전체";

  const call = async (path, body) => {
    let r, d;
    try {
      // 한글·특수문자 비밀번호도 보낼 수 있게 인코딩
      r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + encodeURIComponent(PW.trim()) }, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error("서버에 연결하지 못했어요. (" + API + ")"); }
    try { d = await r.json(); } catch (e) { throw new Error("서버 응답이 올바르지 않아요. (상태 " + r.status + ") 서버 배포가 실패했을 수 있어요."); }
    if (!r.ok) throw new Error(d.message || "오류가 났어요.");
    return d;
  };

  const TABS = [["dash", "대시보드"], ["orders", "주문"], ["claims", "취소·반품·교환"], ["qna", "문의"], ["reviews", "리뷰"], ["coupons", "쿠폰"], ["sellers", "공급사"]];

  function orderRow(o) {
    return `<tr><td><b>${esc(o.orderId)}</b><br><span class="muted">${dt(o.paidAt)}</span></td>
      <td>${o.lines.map((l) => `${esc(l.name)} × ${l.qty}<br><span class="muted">[${esc(l.supplier || "직영")}] ${esc(l.id)}</span>`).join("<br>")}</td>
      <td>${esc(o.customer?.name)}<br>${esc(o.customer?.phone)}<br><span class="muted">[${esc(o.customer?.zip)}] ${esc(o.customer?.addr)}${o.customer?.memo ? "<br>메모: " + esc(o.customer.memo) : ""}</span></td>
      <td><b>${won(o.amount)}</b>${o.discount ? `<br><span class="muted">쿠폰 ${esc(o.coupon)} −${won(o.discount)}</span>` : ""}${o.refunded ? `<br><span style="color:var(--sale)">환불 ${won(o.refunded)}</span>` : ""}</td>
      <td><select data-f="status">${D.statuses.map((s) => `<option${s === o.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        ${o.claim ? `<br><span class="muted">${esc(o.claim.type)}: ${esc(o.claim.reason)}</span>` : ""}</td>
      <td><select data-f="courier"><option value="">택배사</option>${COURIERS.map((c) => `<option${c === o.courier ? " selected" : ""}>${c}</option>`).join("")}</select><br>
        <input data-f="tracking" placeholder="송장번호" value="${esc(o.tracking || "")}" style="margin-top:4px"></td>
      <td><button data-act="order-save" data-id="${esc(o.orderId)}">저장</button><br><button class="ghost" data-act="order-refund" data-id="${esc(o.orderId)}">환불</button></td></tr>`;
  }
  const orderTable = (list) => list.length ? `<table class="adm-table"><tr><th>주문</th><th>상품</th><th>받는 분</th><th>결제</th><th>상태</th><th>송장</th><th></th></tr>${list.map(orderRow).join("")}</table>` : `<p class="empty">해당하는 주문이 없어요.</p>`;

  function view() {
    const s = D.stats;
    if (tab === "dash") return `<div class="stat-grid">
        <div class="stat"><span>오늘 주문</span><b>${s.todayOrders}건</b></div><div class="stat"><span>오늘 매출</span><b>${won(s.todaySales)}</b></div>
        <div class="stat"><span>이번 달 매출</span><b>${won(s.monthSales)}</b></div><div class="stat"><span>출고 대기</span><b>${s.toShip}건</b></div>
        <div class="stat"><span>취소·반품 요청</span><b>${s.claims}건</b></div></div>
      <div class="card" style="margin-top:16px"><h2>처리할 일</h2><ul class="why">
        <li>출고 대기 주문 <b>${s.toShip}</b>건 — 발주하고 송장번호를 입력해 주세요.</li>
        <li>취소·반품·교환 요청 <b>${s.claims}</b>건</li>
        <li>답변 대기 문의 <b>${D.qnas.filter((q) => !q.answer).length + D.inquiries.filter((q) => !q.answer).length}</b>건</li>
        <li>공급사 입점 신청 <b>${D.apps.filter((a) => !a.code).length}</b>건 · 상품 승인 대기 <b>${D.pending.length}</b>건</li></ul></div>
      <div class="card"><h2>최근 주문</h2>${orderTable(D.orders.slice(0, 5))}</div>`;
    if (tab === "orders") {
      const filters = ["전체", "결제완료", "상품준비중", "배송중", "배송완료", "구매확정"];
      const list = D.orders.filter((o) => orderFilter === "전체" || o.status === orderFilter);
      return `<div class="card"><h2>주문 관리 <small>${list.length}건</small></h2>
        <div class="chips" style="margin-bottom:14px">${filters.map((f) => `<button class="chip${f === orderFilter ? " on" : ""}" data-filter="${f}">${f}</button>`).join("")}
        <button class="chip" data-act="export">발주용 엑셀(CSV) 받기</button></div>
        <p class="muted" style="margin-bottom:12px">상태를 ‘배송중’으로 바꾸고 송장번호를 저장하면 고객이 주문 조회에서 배송을 추적할 수 있어요.</p>${orderTable(list)}</div>`;
    }
    if (tab === "claims") return `<div class="card"><h2>취소·반품·교환 요청</h2><p class="muted" style="margin-bottom:12px">환불 버튼을 누르면 결제가 실제로 취소돼요. 교환은 처리 후 상태를 ‘교환완료’로 바꿔 주세요.</p>${orderTable(D.orders.filter((o) => /요청$/.test(o.status)))}</div>
      <div class="card"><h2>처리 완료</h2>${orderTable(D.orders.filter((o) => ["취소완료", "반품완료", "교환완료"].includes(o.status)).slice(0, 30))}</div>`;
    if (tab === "qna") {
      const item = (q) => `<tr><td>${dt(q.at)}<br><span class="state${q.answer ? " done" : ""}" style="margin:0">${q.answer ? "답변완료" : "대기"}</span></td>
        <td>${q.product_name ? `<b>${esc(q.product_name)}</b><br>` : `<b>[${esc(q.type)}]</b> ${q.orderId ? "주문 " + esc(q.orderId) : ""}<br>`}${esc(q.text)}<br><span class="muted">${esc(q.name)} · ${esc(q.contact || "-")}${q.secret ? " · 비밀글" : ""}</span></td>
        <td style="min-width:240px"><textarea data-f="answer" placeholder="답변">${esc(q.answer || "")}</textarea><button data-act="answer" data-key="${esc(q.key)}">답변 저장</button><button class="ghost" data-act="delete" data-key="${esc(q.key)}">삭제</button></td></tr>`;
      const table = (list) => list.length ? `<table class="adm-table"><tr><th>일시</th><th>내용</th><th>답변</th></tr>${list.map(item).join("")}</table>` : `<p class="empty">문의가 없어요.</p>`;
      return `<div class="card"><h2>상품 문의</h2>${table(D.qnas)}</div><div class="card"><h2>1:1 문의</h2><p class="muted" style="margin-bottom:12px">1:1 문의는 답변을 기록해 두고, 고객이 남긴 연락처로 직접 알려 주세요.</p>${table(D.inquiries)}</div>`;
    }
    if (tab === "reviews") return `<div class="card"><h2>리뷰 <small>${D.reviews.length}건</small></h2>${D.reviews.length ? `<table class="adm-table"><tr><th>일시</th><th>상품</th><th>별점</th><th>내용</th><th></th></tr>
      ${D.reviews.map((r) => `<tr><td>${dt(r.at)}</td><td>${esc(r.product_name)}<br><span class="muted">${esc(r.orderId)} · ${esc(r.name)}</span></td><td>${"★".repeat(r.rating)}</td><td style="white-space:normal">${esc(r.text)}</td>
      <td><button class="ghost" data-act="delete" data-key="${esc(r.key)}">삭제</button></td></tr>`).join("")}</table>` : `<p class="empty">리뷰가 없어요.</p>`}</div>`;
    if (tab === "coupons") return `<div class="card form"><h2>쿠폰 만들기</h2>
        <div class="row"><input id="c-code" placeholder="코드 (예: WELCOME)"><input id="c-name" placeholder="쿠폰 이름"></div>
        <div class="row" style="margin-top:8px"><select id="c-type"><option value="amount">정액 (원)</option><option value="percent">정률 (%)</option></select><input id="c-value" placeholder="할인 값" inputmode="numeric"><input id="c-min" placeholder="최소 주문금액" inputmode="numeric"></div>
        <div class="row" style="margin-top:8px"><input id="c-maxd" placeholder="최대 할인액 (정률용, 선택)" inputmode="numeric"><input id="c-uses" placeholder="선착순 수량 (선택)" inputmode="numeric"><input id="c-exp" type="date" aria-label="만료일"></div>
        <button class="btn btn-dark sm" style="margin-top:12px" data-act="coupon-save">쿠폰 저장</button>
        <p class="muted" style="margin-top:10px">마진이 얇은 상품이 많으니 할인액과 최소 주문금액을 꼭 확인해 주세요.</p></div>
      <div class="card"><h2>쿠폰 목록</h2>${D.coupons.length ? `<table class="adm-table"><tr><th>코드</th><th>이름</th><th>할인</th><th>조건</th><th>사용</th><th></th></tr>
        ${D.coupons.map((c) => `<tr><td><b>${esc(c.code)}</b></td><td>${esc(c.name)}</td><td>${c.type === "percent" ? c.value + "%" + (c.max_discount ? ` (최대 ${won(c.max_discount)})` : "") : won(c.value)}</td>
        <td>${c.min_order ? won(c.min_order) + " 이상" : "-"}${c.expires ? "<br>~" + esc(c.expires) : ""}</td><td>${c.used || 0}${c.max_uses ? " / " + c.max_uses : ""}</td>
        <td><button class="ghost" data-act="delete" data-key="coupon:${esc(c.code)}">삭제</button></td></tr>`).join("")}</table>` : `<p class="empty">쿠폰이 없어요.</p>`}</div>`;
    if (tab === "sellers") return `<div class="card"><h2>입점 신청</h2>${D.apps.length ? D.apps.map((a) => `<div class="c-row" style="grid-template-columns:1fr auto">
        <div><b>${esc(a.company)}</b> (${esc(a.biz_no)})<br><span class="muted">${esc(a.manager)} · ${esc(a.phone)} · ${esc(a.email)}<br>${esc(a.items)}</span>
        ${a.code ? `<div style="margin-top:6px">입점코드 <b>${esc(a.code)}</b></div>` : ""}</div>
        ${a.code ? "" : `<button class="mini-btn" data-act="approve-seller" data-id="${esc(a.id)}">승인·코드 발급</button>`}</div>`).join("") : `<p class="empty">신청이 없어요.</p>`}</div>
      <div class="card"><h2>상품 등록 요청</h2>${D.pending.length ? D.pending.map((p) => `<div class="c-row"><img src="${p.image_url || ""}" alt="">
        <div><b>${esc(p.name)}</b> <span class="muted">(${esc(p.supplier)})</span><br><span class="muted">오픈마켓가 ${won(p.market_price)} · 정산금 ${won(p.supply_price)} · 자동 판매가 ${won(p.suggested_price)}</span></div>
        <div><input data-price="${esc(p.id)}" value="${p.suggested_price}" class="field" style="width:110px;height:36px"><br>
        <button class="mini-btn" data-act="approve-product" data-id="${esc(p.id)}">승인</button><button class="mini-btn ghost" data-act="reject-product" data-id="${esc(p.id)}">반려</button></div></div>`).join("") : `<p class="empty">대기 중인 상품이 없어요.</p>`}</div>`;
    return "";
  }

  function paint() {
    $("#adm-tabs").innerHTML = TABS.map(([k, n]) => `<button class="chip${k === tab ? " on" : ""}" data-tab="${k}">${n}</button>`).join("");
    $("#adm-view").innerHTML = view();
  }
  async function load() {
    D = await call("/admin/list");
    $("#admin-login").style.display = "none"; $("#admin-body").style.display = "";
    paint();
  }

  function exportCsv() {
    const rows = [["주문번호", "주문일", "공급사", "상품코드", "상품명", "수량", "받는분", "연락처", "우편번호", "주소", "배송메모", "결제금액"]];
    D.orders.filter((o) => ["결제완료", "상품준비중"].includes(o.status)).forEach((o) => o.lines.forEach((l) =>
      rows.push([o.orderId, o.paidAt.slice(0, 10), l.supplier || "직영", l.id, l.name, l.qty, o.customer?.name, o.customer?.phone, o.customer?.zip, o.customer?.addr, o.customer?.memo || "", o.amount])));
    if (rows.length === 1) { alert("출고 대기 주문이 없어요."); return; }
    const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "발주목록_" + new Date().toISOString().slice(0, 10) + ".csv"; a.click();
  }

  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; return paint(); }
    const f = ev.target.closest("[data-filter]"); if (f) { orderFilter = f.dataset.filter; return paint(); }
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id, key = b.dataset.key, row = b.closest("tr");
    try {
      if (act === "export") return exportCsv();
      if (act === "order-save") await call("/admin/order-update", { orderId: id, status: $('[data-f="status"]', row).value, courier: $('[data-f="courier"]', row).value, tracking: $('[data-f="tracking"]', row).value });
      if (act === "order-refund") {
        const amt = prompt("환불할 금액을 입력하세요. 비워 두면 전액 환불돼요.", "");
        if (amt === null) return;
        if (!confirm("결제가 실제로 취소돼요. 진행할까요?")) return;
        await call("/admin/order-cancel", { orderId: id, amount: amt.replace(/\D/g, ""), reason: "판매자 환불" });
      }
      if (act === "answer") await call("/admin/answer", { key, answer: $('[data-f="answer"]', row).value });
      if (act === "delete") { if (!confirm("삭제할까요?")) return; await call("/admin/delete", { key }); }
      if (act === "coupon-save") await call("/admin/coupon-save", { code: $("#c-code").value, name: $("#c-name").value, type: $("#c-type").value, value: $("#c-value").value, min_order: $("#c-min").value, max_discount: $("#c-maxd").value, max_uses: $("#c-uses").value, expires: $("#c-exp").value });
      if (act === "approve-seller") await call("/admin/approve-seller", { id });
      if (act === "approve-product") await call("/admin/approve-product", { id, price: Number($(`input[data-price="${id}"]`).value) });
      if (act === "reject-product") await call("/admin/reject-product", { id });
      await load();
    } catch (e) { alert(e.message); }
  });

  $("#admin-enter").onclick = async () => {
    if (!API) { alert("서버 주소(worker_url)가 설정되지 않았어요."); return; }
    PW = $("#admin-pw").value; sessionStorage.setItem("admin_pw", PW);
    try { await load(); } catch (e) { alert(e.message); }
  };
  $("#admin-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#admin-enter").click(); });
  if (PW && API) load().catch(() => {});
})();
