/* 올채움 관리자 — 대시보드·주문·취소/반품·문의·리뷰·쿠폰·공급사 */
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

  const TABS = [["dash", "대시보드"], ["stats", "분석"], ["po", "발주"], ["orders", "주문"], ["claims", "취소·반품·교환"], ["qna", "문의"], ["reviews", "리뷰"], ["coupons", "쿠폰"], ["sellers", "공급사"]];

  function orderRow(o) {
    return `<tr><td><b>${esc(o.orderId)}</b><br><span class="muted">${dt(o.paidAt)}</span></td>
      <td>${o.lines.map((l) => `${esc(l.name)} × ${l.qty}<br><span class="muted">[${esc(l.supplier || "직영")}] ${esc(l.id)}</span>`).join("<br>")}</td>
      <td>${esc(o.customer?.name)}<br>${esc(o.customer?.phone)}<br><span class="muted">[${esc(o.customer?.zip)}] ${esc(o.customer?.addr)}${o.customer?.memo ? "<br>메모: " + esc(o.customer.memo) : ""}</span></td>
      <td><b>${won(o.amount)}</b>${o.discount ? `<br><span class="muted">쿠폰 ${esc(o.coupon)} −${won(o.discount)}</span>` : ""}${o.refunded ? `<br><span style="color:var(--sale)">환불 ${won(o.refunded)}</span>` : ""}</td>
      <td><select data-f="status">${D.statuses.map((s) => `<option${s === o.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        ${o.claim ? `<br><span class="muted">${esc(o.claim.type)}: ${esc(o.claim.reason)}</span>` : ""}</td>
      <td><select data-f="courier"><option value="">택배사</option>${COURIERS.map((c) => `<option${c === o.courier ? " selected" : ""}>${c}</option>`).join("")}</select><br>
        <input data-f="tracking" placeholder="송장번호" value="${esc(o.tracking || "")}" style="margin-top:4px">${o.track?.stage ? `<br><b style="color:var(--accent)">📦 ${esc(o.track.stage)}</b>` : ""}</td>
      <td><button data-act="order-save" data-id="${esc(o.orderId)}">저장</button><br><button class="ghost" data-act="order-refund" data-id="${esc(o.orderId)}">환불</button>${["결제완료", "상품준비중"].includes(o.status) ? `<br><button class="ghost" data-act="soldout-cancel" data-id="${esc(o.orderId)}">품절 취소</button>` : ""}</td></tr>`;
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
      <div class="card"><h2>이 기기로 주문 알림 <small>무료 · 웹 푸시</small></h2><p class="muted">휴대폰에서 관리자 페이지를 열고 켜 두면 주문·문의가 올 때 알림이 떠요. (아이폰은 홈 화면에 앱 설치 후)</p>
        <div class="act-row"><button class="mini-btn" data-act="push-on">이 기기 알림 켜기</button><button class="mini-btn ghost" data-act="push-test">테스트 알림</button></div></div>
      <div class="card"><h2>카카오톡 알림 <small>무료 · 나와의 채팅</small></h2>${kakaoCard()}</div>
      <div class="card"><h2>점검</h2><ul class="why">
        <li>KC 인증번호 확인 필요 상품 <b>${(D.kc || []).length}</b>개 ${(D.kc || []).slice(0, 5).map((x) => `<br><span class="muted">· ${esc(x.name)} (${esc(x.kind)})</span>`).join("")}<br><span class="muted">어린이·전기용품은 KC 인증이 없으면 판매하면 안 돼요. 도매처 상세페이지에서 인증번호를 확인하세요.</span></li>
        <li>사진이 안 뜨는 상품 <b>${Object.keys(D.broken || {}).length}</b>개 ${Object.keys(D.broken || {}).slice(0, 8).map((id) => `<a class="muted" href="product/${esc(id)}.html" target="_blank">${esc(id)}</a>`).join(" ")}</li>
        <li>마지막 백업 <b>${D.lastBackup ? dt(D.lastBackup) : "없음"}</b> <button class="mini-btn" data-act="backup">지금 백업 받기</button><br><span class="muted">주문·회원·리뷰·문의 전체를 파일로 받아요. 일주일에 한 번 받아 두세요. (개인정보가 들어 있으니 PC에만 보관)</span></li></ul></div>
      <div class="card"><h2>최근 주문</h2>${orderTable(D.orders.slice(0, 5))}</div>`;
    if (tab === "orders") {
      const filters = ["전체", "결제완료", "상품준비중", "배송중", "배송완료", "구매확정"];
      const list = D.orders.filter((o) => orderFilter === "전체" || o.status === orderFilter);
      return `<div class="card"><h2>주문 관리 <small>${list.length}건</small></h2>
        <div class="chips" style="margin-bottom:14px">${filters.map((f) => `<button class="chip${f === orderFilter ? " on" : ""}" data-filter="${f}">${f}</button>`).join("")}
        <button class="chip" data-act="export">발주용 엑셀(CSV) 받기</button><button class="chip" data-act="track-sweep">배송 단계 새로고침</button></div>
        <p class="muted" style="margin-bottom:12px">택배사·송장번호만 넣고 저장하면 자동으로 ‘배송중’이 되고 고객에게 출고 알림이 가요. 이후 택배 단계(집하→이동중→배송출발→배송완료)를 2시간마다 확인해 배송완료되면 상태가 자동으로 바뀌고 리뷰 요청이 나가요.</p>${orderTable(list)}</div>`;
    }
    if (tab === "stats") return statsView();
    if (tab === "po") {
      const G = D.po || [];
      const total = G.reduce((a, g) => a + g.lines.length, 0);
      return `<div class="card"><h2>발주 대기 <small>${total}건</small></h2>
        <p class="muted" style="margin-bottom:12px"><b>오너클랜</b>: [주문서 받기] → 오너클랜 ‘엑셀 주문하기’에 그대로 업로드(오너클랜 공식 양식, 원장주문코드에 우리 주문번호) → 오클머니 결제 → [발주 완료]<br>
        <b>도매매</b>: [상품번호 복사] → 도매매 ‘엑셀일괄주문 › 일괄주문서작성’에 붙여넣고 [주문서 받기] 파일을 보며 수령자 입력(전달사항에 우리 주문번호) → e-money 결제 → [발주 완료] (1회 30개까지)<br>
        나중에 도매처 주문·배송 목록을 엑셀로 받아 아래에 붙여넣으면 우리 주문번호로 찾아 송장이 자동으로 들어가요.</p>
        ${G.length ? G.map((g) => `<div class="po-group"><h3>${esc(g.name)} <small>${g.lines.length}건</small>
          <button class="chip" data-act="po-sheet" data-src="${esc(g.source)}">주문서 받기 (CSV)</button>${g.source === "domeme" ? `<button class="chip" data-act="po-nos" data-src="domeme">상품번호 복사</button>` : ""}<button class="chip" data-act="po-done" data-src="${esc(g.source)}">발주 완료</button></h3>
          <table class="adm-table"><tr><th>주문</th><th>상품번호</th><th>상품</th><th>수량</th><th>받는 분</th></tr>${g.lines.map((l) => `<tr><td>${esc(l.orderId)}<br><span class="muted">${dt(l.paidAt)}</span></td>
          <td><b>${esc(l.product_no)}</b></td><td style="white-space:normal">${esc(l.name)}</td><td>${l.qty}</td><td>${esc(l.receiver)}<br><span class="muted">${esc(l.addr)}</span></td></tr>`).join("")}</table></div>`).join("")
          : `<p class="empty">발주할 주문이 없어요.</p>`}</div>
        <div class="card"><h2>송장 한 번에 넣기</h2>
        <p class="muted" style="margin-bottom:10px">도매처에서 받은 송장 엑셀을 열어 <b>전체 복사(Ctrl+A → Ctrl+C)</b> 후 아래에 붙여넣거나, CSV로 저장해 올려 주세요. 각 줄에서 우리 주문번호(T로 시작)·택배사·송장번호를 자동으로 찾아요.</p>
        <textarea id="trk-paste" style="width:100%;height:120px" placeholder="여기에 붙여넣기"></textarea>
        <div style="margin-top:8px"><input type="file" id="trk-file" accept=".csv,.txt"> <button data-act="trk-import">송장 넣기</button></div><div id="trk-result" class="muted" style="margin-top:8px"></div></div>`;
    }
    if (tab === "claims") return `<div class="card"><h2>처리 순서</h2><ol class="why" style="padding-left:18px;list-style:decimal">
        <li><b>취소 (발주 전)</b>: 고객이 직접 취소하면 자동 환불돼요. 할 일 없음.</li>
        <li><b>취소 (발주 후·출고 전)</b>: 도매처(도매매·오너클랜) 주문 화면에서 <b>주문 취소</b> 요청 → 취소되면 여기서 [환불].</li>
        <li><b>반품</b>: 도매처 주문·배송 조회 → 해당 주문 <b>반품 신청</b> (사유·회수지 = 고객 주소) → 도매처가 회수 → 회수 확인되면 [환불] → 상태 ‘반품완료’.<br>
          <span class="muted">단순 변심은 왕복 배송비를 고객 부담으로 빼고 부분 환불(환불 금액 입력), 불량·오배송은 전액 환불하고 도매처에 배송비 청구.</span></li>
        <li><b>교환</b>: 도매처에 교환 신청 → 새 송장 받으면 송장 입력 → 상태 ‘교환완료’.</li>
        <li>도매처 반품·교환 배송비는 상품마다 달라요. 도매처 상품 페이지의 반품/교환비를 확인하세요.</li></ol></div>
      <div class="card"><h2>취소·반품·교환 요청</h2><p class="muted" style="margin-bottom:12px">환불 버튼을 누르면 결제가 실제로 취소돼요. 교환은 처리 후 상태를 ‘교환완료’로 바꿔 주세요.</p>${orderTable(D.orders.filter((o) => /요청$/.test(o.status)))}</div>
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
    if (tab === "offers") {
      const L = D.offers || [];
      return `<div class="card"><h2>대량 구매 가격 제안 <small>${L.length}건</small></h2>
        <p class="muted" style="margin-bottom:12px">3개 이상 구매 시 최대 3% 제안. 직영 상품은 여기서 수락·거절하고, 공급사 상품은 공급사 페이지에서 공급사가 응답해요(급하면 여기서 대신 처리 가능).</p>
        ${L.length ? `<table class="adm-table"><tr><th>제안</th><th>상품</th><th>가격</th><th>고객</th><th>상태</th></tr>${L.map((o) => `<tr>
        <td><b>${esc(o.id)}</b><br><span class="muted">${dt(o.createdAt)}</span></td>
        <td style="white-space:normal">${esc(o.product_name)}${o.opt_name ? ` [${esc(o.opt_name)}]` : ""} × ${o.qty}<br><span class="muted">[${esc(o.supplier)}]</span></td>
        <td>${won(o.unit)} → <b>${won(o.price)}</b><br><span class="muted">−${((1 - o.price / o.unit) * 100).toFixed(1)}% · 합계 ${won(o.price * o.qty)}</span></td>
        <td>${esc(o.name)}<br>${esc(o.phone)}${o.memo ? `<br><span class="muted">${esc(o.memo)}</span>` : ""}</td>
        <td>${o.status === "대기" ? `<button data-act="offer-yes" data-id="${esc(o.id)}">수락</button><button class="ghost" data-act="offer-no" data-id="${esc(o.id)}">거절</button>` : `${esc(o.status)}${o.orderId ? "<br>" + esc(o.orderId) : ""}`}</td></tr>`).join("")}</table>` : `<p class="empty">가격 제안이 없어요.</p>`}</div>`;
    }
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

  const kakaoRedirect = () => location.origin + location.pathname;
  function kakaoCard() {
    const k = D.kakaoMe || {};
    if (!k.clientId) return `<p class="muted">서버에 카카오 REST API 키(KAKAO_REST_KEY)를 넣으면 연결 버튼이 생겨요. 연결하면 주문·가격 제안·문의·취소 요청이 들어올 때 대표님 카카오톡 ‘나와의 채팅’으로 바로 알림이 와요.</p>`;
    return k.connected
      ? `<p>연결됨 <span class="muted">(${dt(k.connectedAt)})</span> — 주문·제안·문의가 오면 카카오톡 ‘나와의 채팅’으로 알려드려요.</p>
         <div class="act-row"><button class="mini-btn" data-act="kakao-test">테스트 알림 보내기</button><button class="mini-btn ghost" data-act="kakao-connect">다시 연결</button></div>`
      : `<p class="muted">아직 연결되지 않았어요. 버튼을 누르고 대표님 카카오 계정으로 로그인한 뒤 ‘카카오톡 메시지 전송’에 동의해 주세요.</p>
         <button class="btn btn-dark sm" style="margin-top:10px" data-act="kakao-connect">카카오톡 연결하기</button>`;
  }

  function paint() {
    $("#adm-tabs").innerHTML = TABS.map(([k, n]) => `<button class="chip${k === tab ? " on" : ""}" data-tab="${k}">${n}</button>`).join("");
    $("#adm-view").innerHTML = view();
  }
  async function load() {
    D = await call("/admin/list");
    const po = await call("/admin/po").catch(() => ({ groups: [] }));
    D.po = po.groups || []; D.sheets = po.sheets || {};
    D.kc = await fetch("kc_check.json").then((r) => r.json()).catch(() => []);
    $("#admin-login").style.display = "none"; $("#admin-body").style.display = "";
    paint();
  }

  // 도매처 주문서: 열 이름은 config.json 의 order_sheets 로 바꿀 수 있음 (도매처 대량주문 양식에 맞추기)
  const SHEET_DEFAULT = ["상품번호", "옵션", "수량", "수령자명", "수령자 연락처", "우편번호", "주소", "배송메시지", "주문번호"];
  const memoWithId = (l) => `${l.memo ? l.memo + " " : ""}(${l.orderId})`;
  const FIELD = { 상품번호: (l) => l.product_no, 상품코드: (l) => l.product_no, "오너클랜 상품코드": (l) => l.product_no, 옵션: (l) => l.option, 옵션명: (l) => l.option, 옵션1: (l) => l.option, 옵션2: () => "",
    수량: (l) => l.qty, 상품명: (l) => l.name.replace(/ \[.*\]$/, ""), 배송방식: (l) => l.ship_mode || "무료",
    수령자명: (l) => l.receiver, 수령자: (l) => l.receiver, 받는분: (l) => l.receiver, "받는사람 이름": (l) => l.receiver,
    "수령자 연락처": (l) => l.phone, 연락처: (l) => l.phone, 휴대폰: (l) => l.phone, 휴대전화: (l) => l.phone, "받는사람 휴대폰": (l) => l.phone, "받는사람 전화번호": (l) => l.phone, 추가연락처: () => "",
    우편번호: (l) => l.zip, 주소: (l) => l.addr, "받는사람 주소": (l) => l.addr, 배송지주소: (l) => l.addr1, 배송상세주소: (l) => l.addr2,
    배송메시지: memoWithId, 배송메모: memoWithId, 배송요청사항: (l) => l.memo, "배송시 요청사항": (l) => l.memo,
    주문번호: (l) => l.orderId, 주문자관리번호: (l) => l.orderId, 원장주문코드: (l) => l.orderId, 전달사항: (l) => "주문 " + l.orderId, 쇼핑몰명: () => "올채움",
    "판매사 주문관리 메모": (l) => "올채움 " + l.orderId, "마켓 정산가(배송비 포함)": (l) => l.amount };
  const NO_COMMA = { ownerclan: true };  // 오너클랜 CSV는 값에 쉼표가 있으면 안 됨
  const csvDown = (rows, name) => {
    const csv = "\ufeff" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click();
  };
  function poSheet(src) {
    const g = (D.po || []).find((x) => x.source === src); if (!g) return;
    const cols = (D.sheets || {})[src] || SHEET_DEFAULT;
    const val = (c, l) => { const v = FIELD[c] ? FIELD[c](l) : ""; return NO_COMMA[src] ? String(v ?? "").replace(/,/g, " ") : v; };
    csvDown([cols, ...g.lines.map((l) => cols.map((c) => val(c, l)))], `${g.name}_주문서_${new Date().toISOString().slice(0, 10)}.csv`);
  }
  // 붙여넣은 표/CSV에서 주문번호·택배사·송장번호 찾기
  const COURIER_NAMES = ["CJ대한통운", "대한통운", "한진", "롯데", "우체국", "로젠", "경동", "대신", "일양", "합동", "천일", "건영"];
  const courierFix = (t) => { const c = COURIER_NAMES.find((n) => t.includes(n)); return !c ? "" : c === "대한통운" || c === "CJ대한통운" ? "CJ대한통운" : ["한진", "롯데", "로젠"].includes(c) ? c + "택배" : c === "우체국" ? "우체국택배" : c + "택배"; };
  function parseTracking(text) {
    const lines = text.split(/\r?\n/).filter((x) => x.trim());
    const split = (s) => (s.includes("\t") ? s.split("\t") : s.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')));
    const head = split(lines[0] || "");
    const ti = head.findIndex((h) => /송장|운송장/.test(h)), ci = head.findIndex((h) => /택배사|배송사|택배/.test(h) && !/비|송장/.test(h));
    const out = [];
    for (const ln of lines) {
      const cells = split(ln), all = cells.join(" ");
      const m = all.match(/T\d{6}-[A-Z0-9]{6}/); if (!m) continue;
      let tr = ti >= 0 ? cells[ti] : (cells.find((c) => /^\d[\d-]{8,15}$/.test(c.trim())) || "");
      tr = String(tr || "").replace(/[^\d]/g, "");
      if (tr.length < 9) continue;
      out.push({ orderId: m[0], tracking: tr, courier: courierFix(ci >= 0 ? cells[ci] : all) });
    }
    return out;
  }

  // ── 사이트 분석 ──
  const kday = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const PERIODS = { 오늘: () => [kday(), kday()], 어제: () => { const y = kday(new Date(Date.now() - 86400e3)); return [y, y]; }, "최근 7일": () => [kday(new Date(Date.now() - 6 * 86400e3)), kday()],
    "최근 30일": () => [kday(new Date(Date.now() - 29 * 86400e3)), kday()], "이번 달": () => [kday().slice(0, 8) + "01", kday()], 올해: () => [kday().slice(0, 5) + "01-01", kday()] };
  let period = "오늘", A = null, statTimer = null;
  async function loadStats() {
    const [from, to] = PERIODS[period]();
    A = await call("/admin/analytics", { from, to });
    if (tab === "stats") paint();
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  function statsView() {
    clearTimeout(statTimer);
    statTimer = setTimeout(() => tab === "stats" && loadStats(), 60000);  // 1분마다 새로고침 (실시간)
    if (!A) { loadStats(); return `<p class="empty">불러오는 중…</p>`; }
    const T = A.totals, max = Math.max(1, ...A.days.map((d) => d.sales)), maxV = Math.max(1, ...A.days.map((d) => d.uv));
    const kpi = (n, v, sub = "") => `<div class="stat"><span>${n}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const table = (head, rows) => rows.length ? `<table class="adm-table"><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.join("")}</table>` : `<p class="empty">자료가 아직 없어요.</p>`;
    return `<div class="chips" style="margin-bottom:12px">${Object.keys(PERIODS).map((k) => `<button class="chip${k === period ? " on" : ""}" data-act="period" data-p="${k}">${k}</button>`).join("")}
      <span class="muted" style="margin-left:8px">${A.from} ~ ${A.to} · 1분마다 자동 새로고침</span></div>
      <div class="stat-grid">
        ${kpi("방문자", T.uv.toLocaleString() + "명", `페이지뷰 ${T.pv.toLocaleString()}`)}${kpi("주문", T.orders + "건", `구매전환 ${T.conv}%`)}
        ${kpi("매출", won(T.sales), `객단가 ${won(T.aov)}`)}${kpi("순이익" + (T.costEstimated ? " (추정)" : ""), won(T.profit), `매출의 ${pct(T.profit, T.sales)}%`)}
        ${kpi("신규 가입", T.signups + "명", `전체 회원 ${T.members}명`)}${kpi("리뷰", T.reviews + "개", `전체 ${T.reviewsAll}개 · 평균 ★${T.reviewAvg}`)}
        ${kpi("취소·반품·교환", `${T.canceled}·${T.returned}·${T.exchanged}건`, T.refunds ? `환불 ${won(T.refunds)}` : "")}${kpi("발주", `${T.poLines}건 완료`, `대기 ${T.poWait}건`)}</div>
      <div class="card"><h2>손익 <small>${A.from} ~ ${A.to}</small></h2>${table(["항목", "금액", "비율"], [
        ["매출 (결제금액, 환불 차감)", T.sales], ["상품 원가 (도매가+배송비)" + (T.costEstimated ? " *추정" : ""), -T.cost], ["카드 수수료", -T.cardFee], ["부가세 (매출세액−매입세액)", -Math.round((T.sales - T.cost) / 11)], ["운영비 (주문당)", -T.ops], ["<b>순이익</b>", T.profit]]
        .map(([n, v]) => `<tr><td>${n}</td><td style="text-align:right"><b>${won(v)}</b></td><td style="text-align:right">${pct(Math.abs(v), T.sales)}%</td></tr>`))}
        ${T.costEstimated ? `<p class="muted" style="margin-top:8px">*원가가 기록되지 않은 주문은 판매가에서 가격 공식(순마진 12%)을 거꾸로 계산한 추정치예요.</p>` : ""}</div>
      <div class="card"><h2>날짜별</h2>${table(["날짜", "방문자", "주문", "매출", "순이익", "가입", "리뷰"], A.days.slice().reverse().map((d) => `<tr><td>${d.day.slice(5)}</td>
        <td><span class="bar v" style="width:${Math.round((d.uv / maxV) * 60)}px"></span>${d.uv}</td><td>${d.orders}</td>
        <td><span class="bar" style="width:${Math.round((d.sales / max) * 90)}px"></span>${won(d.sales)}</td><td>${won(d.profit)}</td><td>${d.signups}</td><td>${d.reviews}</td></tr>`))}</div>
      <div class="two-col"><div class="card"><h2>많이 팔린 상품</h2>${table(["상품", "수량", "매출"], A.products.slice(0, 15).map((p) => `<tr><td style="white-space:normal">${esc(p.name)}<br><span class="muted">${esc(p.id)}</span></td><td>${p.qty}</td><td>${won(p.sales)}</td></tr>`))}</div>
      <div class="card"><h2>유입경로</h2>${table(["경로", "방문자", "주문", "매출", "전환"], A.sources.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.visits}</td><td>${s.orders}</td><td>${won(s.sales)}</td><td>${s.visits ? pct(s.orders, s.visits) + "%" : "-"}</td></tr>`))}</div></div>
      <div class="two-col"><div class="card"><h2>리뷰 많은 상품</h2>${table(["상품", "리뷰", "평점"], A.reviewTop.map((x) => `<tr><td style="white-space:normal">${esc(x.name)}</td><td>${x.count}</td><td>★${x.avg}</td></tr>`))}</div>
      <div class="card"><h2>많이 본 페이지</h2>${table(["페이지", "조회"], A.pages.map((x) => `<tr><td>${esc(x.path)}</td><td>${x.pv}</td></tr>`))}</div></div>
      <div class="card"><h2>세금 예상 <small>${A.tax.year}년 · 참고용</small></h2>
        ${table(["부가세", "매출", "매출세액", "매입세액", "낼 세금"], A.tax.vat.map((v) => `<tr><td>${v.period}</td><td>${won(v.sales)}</td><td>${won(v.salesVat)}</td><td>−${won(v.buyVat)}</td><td><b>${won(v.pay)}</b></td></tr>`))}
        ${table(["종합소득세 (지방소득세 포함)", "소득(이익)", "세금"], [
          `<tr><td>지금까지 기준</td><td>${won(A.tax.income.profit)}</td><td><b>${won(A.tax.income.tax)}</b></td></tr>`,
          `<tr><td>지금 추세로 1년 환산</td><td>${won(A.tax.income.yearEstimate)}</td><td><b>${won(A.tax.income.taxYear)}</b></td></tr>`])}
        <p class="muted" style="margin-top:8px">부가세: 도매처에서 세금계산서·현금영수증을 받은 매입만 공제돼요. 종합소득세: ${A.tax.income.due}. 다른 소득, 인적공제·경비(임대료·광고비 등)는 빠진 대략적인 값이라 실제 신고는 세무사·홈택스로 확인하세요.</p></div>`;
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
      if (act === "soldout-cancel") {
        if (!confirm("도매처 품절로 이 주문을 취소하고 전액 환불할까요? 손님께 사과 안내가 자동으로 가요.")) return;
        alert((await call("/admin/soldout-cancel", { orderId: id })).message); return load();
      }
      if (act === "backup") {
        const r = await fetch(API + "/admin/export", { method: "POST", headers: { Authorization: "Bearer " + encodeURIComponent(PW.trim()) } });
        if (!r.ok) { alert("백업을 받지 못했어요."); return; }
        const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `올채움_백업_${new Date().toISOString().slice(0, 10)}.json`; a.click();
        return load();
      }
      if (act === "period") { period = b.dataset.p; A = null; return paint(); }
      if (act === "po-sheet") return poSheet(b.dataset.src);
      if (act === "po-nos") { const g = (D.po || []).find((x) => x.source === "domeme"); await navigator.clipboard.writeText([...new Set(g.lines.map((l) => l.product_no))].join(",")); alert("상품번호를 복사했어요. 도매매 ‘일괄주문서작성’의 상품번호 칸에 붙여넣으세요. (1회 30개까지)"); return; }
      if (act === "po-done") {
        const g = (D.po || []).find((x) => x.source === b.dataset.src);
        if (!g || !confirm(`${g.name} ${g.lines.length}건을 발주 완료로 표시할까요? (도매처 결제까지 끝낸 뒤 눌러 주세요)`)) return;
        alert((await call("/admin/po-done", { items: g.lines.map((l) => ({ orderId: l.orderId, idx: l.idx })) })).message); return load();
      }
      if (act === "trk-import") {
        let text = $("#trk-paste").value;
        const f = $("#trk-file").files[0]; if (f) text += "\n" + (await f.text());
        const rows = parseTracking(text);
        if (!rows.length) { $("#trk-result").textContent = "주문번호(T로 시작)와 송장번호가 있는 줄을 찾지 못했어요."; return; }
        const r = await call("/admin/tracking-import", { rows });
        $("#trk-result").textContent = r.message; return load();
      }
      if (act === "kakao-connect") {
        location.href = "https://kauth.kakao.com/oauth/authorize?" + new URLSearchParams({ client_id: D.kakaoMe.clientId, redirect_uri: kakaoRedirect(), response_type: "code", scope: "talk_message" });
        return;
      }
      if (act === "kakao-test") { alert((await call("/admin/kakao-test")).message); return; }
      if (act === "push-test") { alert((await call("/admin/push-test")).message); return; }
      if (act === "push-on") {
        if (!("serviceWorker" in navigator && "PushManager" in window) || location.protocol !== "https:") { alert("이 브라우저는 알림을 지원하지 않아요. (아이폰은 홈 화면에 추가한 앱에서)"); return; }
        if (await Notification.requestPermission() !== "granted") { alert("브라우저 설정에서 알림을 허용해 주세요."); return; }
        const key = (await (await fetch(API + "/push/key", { method: "POST" })).json()).key;
        const reg = await navigator.serviceWorker.register("sw.js?api=" + encodeURIComponent(API)).then(() => navigator.serviceWorker.ready);
        const u8 = Uint8Array.from(atob((key + "===".slice((key.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8 }));
        alert((await call("/admin/push-subscribe", { sub: sub.toJSON() })).message); return;
      }
      if (act === "track-sweep") { const r = await call("/admin/track-sweep", {}); alert(`배송중 ${r.checked ?? 0}건 확인, 배송완료 ${r.delivered ?? 0}건`); }
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
      if (act === "offer-yes") { if (!confirm("이 가격으로 판매할까요?")) return; await call("/admin/offer-reply", { id, accept: true }); }
      if (act === "offer-no") { const note = prompt("거절 사유 (선택)", ""); if (note === null) return; await call("/admin/offer-reply", { id, accept: false, note }); }
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
  // 서버 상태 표시: 로그인 실패 원인 확인용
  (async () => {
    const box = document.createElement("p"); box.className = "muted"; box.style.marginTop = "14px";
    $("#admin-login").appendChild(box);
    if (!API) { box.textContent = "서버 주소가 설정되지 않았어요."; return; }
    try {
      const h = await (await fetch(API + "/health", { cache: "no-store" })).json();
      box.textContent = `서버 연결됨 · 버전 ${h.version || "예전"} · 관리자 비밀번호 ${h.adminPassword || "확인 불가(예전 버전)"} · 결제 ${h.toss || "-"}`;
    } catch (e) { box.textContent = "서버에 연결하지 못했어요: " + API; }
  })();
  // 카카오 로그인 후 돌아왔을 때: 인증 코드로 연결 마무리
  const kcode = new URLSearchParams(location.search).get("code");
  if (kcode) history.replaceState(null, "", location.pathname);
  if (PW && API) load().then(async () => {
    if (!kcode) return;
    try { alert((await call("/admin/kakao-connect", { code: kcode, redirect_uri: kakaoRedirect() })).message); await load(); } catch (e) { alert(e.message); }
  }).catch(() => { if (kcode) alert("관리자 로그인 후 ‘카카오톡 연결하기’를 다시 눌러 주세요."); });
})();
