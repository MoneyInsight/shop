/* 담Go사Go 관리자 — 대시보드·주문·취소/반품·문의·리뷰·쿠폰·공급사 */
(function () {
  const API = (window.SHOP_CFG || {}).worker_url;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";
  const dt = (iso) => new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const COURIERS = ["CJ대한통운", "한진택배", "롯데택배", "우체국택배", "로젠택배", "경동택배", "대신택배", "기타"];
  let PW = sessionStorage.getItem("admin_pw") || "", D = null, tab = "dash", orderFilter = "전체";
  const HASH_P = (location.hash.match(/^#p=([0-9A-Za-z_-]+)/) || [])[1];  // 상품 페이지의 '관리자에서 수정'
  if (HASH_P) tab = "products";

  const call = async (path, body) => {
    let r, d;
    try {
      // 한글·특수문자 비밀번호도 보낼 수 있게 인코딩
      r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + encodeURIComponent(PW.trim()) }, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error("서버에 연결하지 못했어요. (" + API + ")"); }
    try { d = await r.json(); } catch (e) { throw new Error("서버 응답이 올바르지 않아요. (상태 " + r.status + ") 서버 배포가 실패했을 수 있어요."); }
    if (!r.ok) { const e = new Error(d.message || "오류가 났어요."); if (r.status === 409 && d.need) e.need = d.need; throw e; }
    return d;
  };
  // 손해 날 수 있는 처리(환불·취소): 서버가 묻는 확인을 하나씩 받고 진행. 취소하면 null
  const safeCall = async (path, body) => {
    const ok = [];
    for (let i = 0; i < 6; i++) {
      try { return await call(path, { ...body, ok }); }
      catch (e) { if (!e.need) throw e; if (!confirm("⚠️ " + e.message)) return null; ok.push(e.need); }
    }
    return null;
  };
  const SRC = (id) => { id = String(id); return /^DM/.test(id) ? "domeme" : /^W[0-9A-Z]{3,}$/.test(id) ? "ownerclan" : /^CH\d/.test(id) ? "onchannel" : /^GS\d/.test(id) ? "ggsan" : /^CM\d/.test(id) ? "cmtstory" : /^OWN/.test(id) ? "own" : "direct"; };
  const SUP = { domeme: { n: "도매매", url: "https://domeme.domeggook.com/", how: "로그인 → 주문/배송 관리 → 주문내역 → 엑셀 다운로드" },
    ownerclan: { n: "오너클랜", url: "https://ownerclan.com/", how: "1시간마다 자동으로 들어와요. 급하면 [자동으로 가져오기], 또는 다른 곳처럼 엑셀 올리기" },
    onchannel: { n: "온채널", url: "https://www.onch3.co.kr/", how: "로그인 → 판매사 → 주문관리 → 배송조회 → 엑셀 다운로드" },
    ggsan: { n: "건강산", url: "https://www.ggsan.com/", how: "로그인 → 마이페이지 → 주문배송조회에서 송장 확인 → 엑셀 올리기 또는 [주문] 탭에 입력" },
    cmtstory: { n: "화장품스토리", url: "https://www.cmtstory.com/", how: "로그인 → 마이페이지 → 주문배송조회에서 송장 확인 → 엑셀 올리기 또는 [주문] 탭에 입력" },
    own: { n: "자체상품", url: "", how: "직접 포장·발송 → [주문] 탭에서 송장 입력" },
    direct: { n: "직영·기타", url: "", how: "[주문] 탭에서 송장 직접 입력" } };
  const SRC_COLOR = { domeme: "#e8590c", ownerclan: "#1971c2", onchannel: "#2f9e44", ggsan: "#7048e8", cmtstory: "#d6336c", own: "#212529", direct: "#868e96" };
  const SRC_LEGEND = () => `<details class="card" style="padding:16px 28px"><summary style="cursor:pointer;font-weight:700">상품코드로 도매처 구분 (표 보기)</summary>
    <table class="adm-table" style="margin-top:10px;max-width:720px"><tr><th>상품코드</th><th>표시</th><th>도매처</th></tr>
    ${[["<b>DM</b>12345678", "DM1", "도매매"], ["<b>W</b>FSLBA3", "WFSLBA3", "오너클랜"], ["<b>CH</b>5641997", "CH1", "온채널"], ["<b>GS</b>1000000017", "GS1", "건강산 (ggsan.com)"],
       ["<b>CM</b>1000000046", "CM1", "화장품스토리 (cmtstory.com)"], ["<b>OWN</b>13803…", "OWN1", "숨엔·듀리온 등 직접 발송"]].map(([c, id, n]) => `<tr><td>${c}</td><td>${srcTag(id)}</td><td>${n}</td></tr>`).join("")}</table></details>`;
  const srcTag = (id) => { const k = SRC(id); return `<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${SRC_COLOR[k]};border-radius:3px;padding:1px 6px;margin-right:4px;white-space:nowrap">${SUP[k].n}</span>`; };

  // 업무 처리 순서: 매일 할 일(발주→배송→취소·반품→문의) → 상품·고객 관리 → 분석·설정
  const TABS = [["dash", "대시보드"], ["po", "① 발주"], ["orders", "② 주문·배송"], ["claims", "③ 취소·반품·교환"], ["qna", "④ 문의"], ["reviews", "리뷰"], ["products", "상품 관리"], ["customers", "회원·고객"], ["coupons", "쿠폰"], ["stats", "분석"], ["sellers", "공급사"], ["settings", "사이트 설정·기록"]];
  const tabCount = (k) => {  // 처리할 일 개수 (탭에 빨간 숫자)
    if (!D) return 0;
    if (k === "po") return (D.po || []).reduce((a, g) => a + g.lines.length, 0);
    if (k === "orders") return (D.orders || []).filter((o) => ["결제완료", "상품준비중"].includes(o.status) && !o.tracking).length;
    if (k === "claims") return (D.orders || []).filter((o) => /요청$/.test(o.status)).length;
    if (k === "qna") return (D.qnas || []).filter((q) => !q.answer).length + (D.inquiries || []).filter((q) => !q.answer).length;
    return 0;
  };

  function orderRow(o) {
    return `<tr><td><b>${esc(o.orderId)}</b><br><span class="muted">${dt(o.paidAt)}</span></td>
      <td>${o.lines.map((l) => `${esc(l.name)} × ${l.qty}<br>${srcTag(l.id)}<span class="muted">${esc(l.id)}</span>`).join("<br>")}</td>
      <td>${esc(o.customer?.name)}<br>${esc(o.customer?.phone)}<br><span class="muted">[${esc(o.customer?.zip)}] ${esc(o.customer?.addr)}${o.customer?.memo ? "<br>메모: " + esc(o.customer.memo) : ""}</span></td>
      <td><b>${won(o.amount)}</b>${o.discount ? `<br><span class="muted">쿠폰 ${esc(o.coupon)} −${won(o.discount)}</span>` : ""}${o.refunded ? `<br><span style="color:var(--sale)">환불 ${won(o.refunded)}</span>` : ""}</td>
      <td><select data-f="status">${D.statuses.map((s) => `<option${s === o.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        ${o.claim ? `<br><span class="muted">${esc(o.claim.type)}: ${o.claim.kind ? "[" + esc(o.claim.kind) + "] " : ""}${esc(o.claim.reason)}</span>${o.claim.deduct != null ? `<br><b style="color:var(--sale)">배송비 차감 ${won(o.claim.deduct)}${o.claim.refund != null ? ` → 환불 ${won(o.claim.refund)}` : ""}</b>` : ""}${Array.from({ length: o.claim.photos || 0 }, (_, i) => `<br><button class="ghost" data-act="claim-photo" data-id="${esc(o.orderId)}" data-i="${i}">📷 사진 ${i + 1}</button>`).join("")}` : ""}</td>
      <td><select data-f="courier"><option value="">택배사</option>${COURIERS.map((c) => `<option${c === o.courier ? " selected" : ""}>${c}</option>`).join("")}</select><br>
        <input data-f="tracking" placeholder="송장번호" value="${esc(o.tracking || "")}" style="margin-top:4px">${o.track?.stage ? `<br><b style="color:var(--accent)">📦 ${esc(o.track.stage)}</b>` : ""}</td>
      <td><button data-act="order-save" data-id="${esc(o.orderId)}">저장</button><br><button class="ghost" data-act="order-refund" data-id="${esc(o.orderId)}"${o.claim?.refund != null ? ` data-refund="${o.claim.refund}" data-deduct="${o.claim.deduct}"` : ""}>환불</button>${["결제완료", "상품준비중"].includes(o.status) ? `<br><button class="ghost" data-act="soldout-cancel" data-id="${esc(o.orderId)}">품절 취소</button>` : ""}</td></tr>`;
  }
  const orderTable = (list, bulk) => list.length ? `<table class="adm-table"><tr>${bulk ? `<th><input type="checkbox" id="ob-all" title="이 쪽 전체 선택" style="width:auto"></th>` : ""}<th>주문</th><th>상품</th><th>받는 분</th><th>결제</th><th>상태</th><th>송장</th><th></th></tr>${list.map((o) => bulk ? orderRow(o).replace("<tr>", `<tr><td><input type="checkbox" class="ob-chk" value="${esc(o.orderId)}" style="width:auto"></td>`) : orderRow(o)).join("")}</table>` : `<p class="empty">해당하는 주문이 없어요.</p>`;

  function view() {
    const s = D.stats;
    if (tab === "dash") return `<div class="stat-grid">
        <div class="stat"><span>오늘 주문</span><b>${s.todayOrders}건</b></div><div class="stat"><span>오늘 매출</span><b>${won(s.todaySales)}</b></div>
        <div class="stat"><span>이번 달 매출</span><b>${won(s.monthSales)}</b></div><div class="stat"><span>출고 대기</span><b>${s.toShip}건</b></div>
        <div class="stat"><span>취소·반품 요청</span><b>${s.claims}건</b></div></div>
      ${s.donation ? `<div class="card" style="margin-top:16px"><h2>💛 이웃 후원 기금 <small class="muted">순이익의 ${Math.round(s.donation.rate * 1000) / 10}%</small></h2>
        <div class="stat-grid" style="margin-top:10px">
          <div class="stat"><span>이번 달 (${s.donation.thisMonth.month}) 쌓이는 중</span><b>${won(s.donation.thisMonth.fund)}</b><small class="muted">순이익 ${won(s.donation.thisMonth.profit)}</small></div>
          <div class="stat"><span>지난달 (${s.donation.lastMonth.month}) <b style="color:var(--sale)">낼 금액</b></span><b>${won(s.donation.lastMonth.fund)}</b><small class="muted">순이익 ${won(s.donation.lastMonth.profit)}</small></div>
          <div class="stat"><span>${s.donation.year.year}년 합계</span><b>${won(s.donation.year.fund)}</b><small class="muted">순이익 ${won(s.donation.year.profit)}</small></div></div>
        ${s.donation.months.length ? `<table class="adm-table" style="margin-top:12px"><tr><th>월</th><th>주문</th><th>매출</th><th>순이익</th><th>후원 기금</th></tr>${s.donation.months.map((m) => `<tr><td>${m.month}</td><td>${m.orders}건</td><td>${won(m.sales)}</td><td>${won(m.profit)}</td><td><b>${won(m.fund)}</b></td></tr>`).join("")}</table>` : ""}
        <p class="muted" style="margin-top:10px">순이익 = 결제금액(환불 뺌) − 상품 원가(도매가+배송비) − 카드 수수료 − 부가세 − 주문당 운영비. 취소·반품 주문은 빼요. 적자 달은 0원이에요. 매달 초에 지난달 금액을 후원하시면 돼요.</p></div>` : ""}
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
      const filters = ["전체", "결제완료", "상품준비중", "배송중", "배송완료", "구매확정", "취소요청", "반품요청", "교환요청"];
      const list = OSEARCH ? OSEARCH : D.orders.filter((o) => orderFilter === "전체" || o.status === orderFilter);
      return `<div class="card"><h2>주문 관리 <small>${list.length}건${OSEARCH ? " (검색 결과)" : ""}</small></h2>
        <div style="display:flex;gap:8px;margin-bottom:12px"><input id="o-q" placeholder="주문번호·이름·연락처·상품코드(DM…)·도매처 상품번호·상품명·송장번호" value="${esc(OQ)}" style="flex:1"><button data-act="o-search">검색</button>${OSEARCH ? `<button class="ghost" data-act="o-clear">검색 지우기</button>` : ""}</div>
        <div class="chips" style="margin-bottom:14px">${filters.map((f) => `<button class="chip${f === orderFilter ? " on" : ""}" data-filter="${f}">${f}</button>`).join("")}
        <button class="chip" data-act="export">발주용 엑셀(CSV) 받기</button><button class="chip" data-act="track-sweep">배송 단계 새로고침</button></div>
        <p class="muted" style="margin-bottom:12px">택배사·송장번호만 넣고 저장하면 자동으로 ‘배송중’이 되고 고객에게 출고 알림이 가요. 이후 택배 단계(집하→이동중→배송출발→배송완료)를 2시간마다 확인해 배송완료되면 상태가 자동으로 바뀌고 리뷰 요청이 나가요.</p>
        <div id="ob-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;background:var(--accent-soft);margin-bottom:10px">
          <b>선택한 주문 <span id="ob-n">0</span>건</b> →
          <select id="ob-status" style="width:auto;height:34px"><option value="">상태 고르기</option>${["상품준비중", "배송완료", "구매확정", "교환완료"].map((x) => `<option>${x}</option>`).join("")}</select>
          <button data-act="ob-apply">일괄 변경</button>
          <span class="muted" style="font-size:12px">취소·환불·반품완료는 돈이 오가서 일괄 변경이 안 돼요 (각 주문의 [환불]로). ‘배송중’은 송장을 넣으면 자동으로 바뀌어요.</span></div>
        ${orderTable(list, true)}</div>`;
    }
    if (tab === "stats") return statsView();
    if (tab === "products") { setTimeout(prodInit, 0); return SRC_LEGEND() + prodShell(); }
    if (tab === "customers") {
      if (!CUST) { call("/admin/customers").then((r) => { CUST = r; paint(); }).catch((e) => alert(e.message)); return `<p class="muted">불러오는 중…</p>`; }
      const bl = Object.entries(CUST.blocked || {});
      return `<div class="card form"><h2>주문 차단</h2><p class="muted">장난 주문·악성 고객의 연락처를 막으면, 그 번호로는 결제 단계로 넘어가지 못해요(돈이 빠져나가지 않아요).</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="bl-phone" placeholder="연락처 (숫자만)" style="max-width:200px"><input id="bl-reason" placeholder="사유 (예: 상습 반품)" style="flex:1"><button data-act="bl-add">차단</button></div>
        ${bl.length ? `<table class="adm-table" style="margin-top:12px"><tr><th>연락처</th><th>사유</th><th>차단일</th><th></th></tr>${bl.map(([ph, v]) => `<tr><td>${esc(ph)}</td><td>${esc(v.reason)}</td><td class="muted">${dt(v.at)}</td><td><button class="ghost" data-act="bl-del" data-phone="${esc(ph)}">차단 풀기</button></td></tr>`).join("")}</table>` : `<p class="muted" style="margin-top:8px">차단한 연락처가 없어요.</p>`}</div>
        ${(() => { const M = CUST.members || [], PN = { naver: "네이버", kakao: "카카오", google: "구글" }, today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
          const by = (k) => M.filter((m) => m.provider === k).length, newT = M.filter((m) => String(m.joinedAt).slice(0, 10) === today).length;
          return `<div class="card"><h2>가입 회원 <small>${M.length.toLocaleString()}명</small></h2>
            <p class="muted" style="margin-bottom:10px">오늘 가입 ${newT}명 · 네이버 ${by("naver")} · 카카오 ${by("kakao")} · 구글 ${by("google")}</p>
            <input id="m-q" placeholder="이름·이메일·연락처로 찾기" style="width:100%;margin-bottom:10px">
            <div id="m-list">${memTable(M)}</div></div>`; })()}
        <div class="card"><h2>고객 <small>${CUST.customers.length}명</small></h2><input id="c-q" placeholder="이름·연락처로 찾기" style="width:100%;margin-bottom:10px">
        <div id="c-list">${custTable(CUST.customers)}</div></div>`;
    }
    if (tab === "settings") {
      if (!ALOG) { Promise.all([call("/admin/log"), call("/admin/product-edits")]).then(([l, e]) => { ALOG = l.log || []; PEDITS = e; paint(); }).catch((e) => alert(e.message)); return `<p class="muted">불러오는 중…</p>`; }
      const st = (PEDITS && PEDITS.site) || {};
      return `<div class="card form"><h2>공지 띠 (사이트 맨 위 한 줄)</h2>
        <label>문구</label><input id="st-notice" maxlength="120" value="${esc(st.notice || "")}" placeholder="비워 두면 기본 문구(전 상품 무료배송 · 회원가입 없이 바로 주문)">
        <label>눌렀을 때 이동할 주소 (선택)</label><input id="st-link" value="${esc(st.notice_link || "")}" placeholder="예: search.html?q=겨울 또는 https://…">
        <div style="margin-top:12px"><button data-act="st-save">저장</button></div></div>
        <div class="card"><h2>관리자 작업 기록 <small>최근 ${ALOG.length}건</small></h2><p class="muted">관리자 화면에서 바꾼 작업이 시간·접속 위치(IP)와 함께 남아요. 모르는 기록이 보이면 관리자 비밀번호를 바꾸세요.</p>
        ${ALOG.length ? `<table class="adm-table"><tr><th>때</th><th>작업</th><th>IP</th></tr>${ALOG.map((x) => `<tr><td class="muted">${dt(x.at)}</td><td>${esc(LOGNAME[x.path] || x.path)}</td><td class="muted">${esc(x.ip || "")}</td></tr>`).join("")}</table>` : `<p class="muted">아직 기록이 없어요.</p>`}</div>`;
    }
    if (tab === "po") {
      const G = D.po || [];
      const total = G.reduce((a, g) => a + g.lines.length, 0);
      const badN = G.reduce((a, g) => a + g.lines.filter((l) => l.lv && l.lv.ok === false).length, 0);
      return SRC_LEGEND() + `<div class="card"><h2>발주 대기 <small>${total}건</small>${badN ? ` <small style="color:var(--sale)">⚠️ 도매처 문제 ${badN}건</small>` : ""}
        <span style="margin-left:auto;display:flex;gap:6px"><button class="ghost" data-act="po-check">가격·재고 지금 확인 (도매매·오너클랜)</button></span></h2>
        <p class="muted" style="margin:-8px 0 10px">도매매·오너클랜은 도매처 시스템에 연결돼 10분마다 가격·재고를 자동 확인하고, 품절·가격 인상이면 카톡으로 알려 드려요.
        온채널·건강산·화장품스토리는 연결 기능(API)이 없어 자동 확인이 안 돼요 — 발주할 때 도매처 결제 금액이 표의 '도매 원가'와 같은지 꼭 확인하세요.</p>
        <p class="muted" style="margin-bottom:12px"><b>온채널</b>: [주문서 받기](.xlsx) → 온채널 판매사 메뉴 ‘대량주문등록’에 업로드(주문코드에 우리 주문번호) → 결제 → [발주 완료]<br>
        <b>오너클랜</b>: [주문서 받기] → 오너클랜 ‘엑셀 주문하기’에 그대로 업로드(오너클랜 공식 양식, 원장주문코드에 우리 주문번호) → 오클머니 결제 → [발주 완료]<br>
        <b>도매매</b>: [상품번호 복사] → 도매매 ‘엑셀일괄주문 › 일괄주문서작성’에 붙여넣고 [주문서 받기] 파일을 보며 수령자 입력(전달사항에 우리 주문번호) → e-money 결제 → [발주 완료] (1회 30개까지)<br>
        <b>직영(숨엔 등 직접 보내는 상품)</b>: 직접 포장·발송 → [주문] 탭에서 송장 입력 → 고객에게 출고 알림이 자동으로 가요.<br>
        나중에 도매처 주문·배송 목록을 엑셀로 받아 아래에 붙여넣거나 엑셀 파일을 그대로 올리면 우리 주문번호로 찾아 송장이 자동으로 들어가요.<br>
        <span style="color:var(--sale)">발주 전 확인: 도매처 결제 화면의 <b>상품값·택배비</b>가 아래 '도매 원가'·'택배비'(주문당 1번 / N개마다)와 다르면 손해일 수 있어요 — 특히 도매처가 <b>1개마다 택배비</b>를 받는데 표에 '주문당 1번'이면 발주하지 말고 알려 주세요.</span></p>
        ${G.length ? G.map((g) => `<div class="po-group"><h3>${esc(g.name)} <small>${g.lines.length}건</small>
          <button class="chip" data-act="po-sheet" data-src="${esc(g.source)}">대량주문 엑셀 받기 (${esc(((D.mysheets || {})[g.source] || {}).ext || (g.source === "onchannel" ? "xlsx" : "csv"))})</button>${(SUP[g.source] || {}).url ? `<button class="chip" data-act="open-url" data-url="${SUP[g.source].url}">${esc(SUP[g.source].n)} 사이트 열기 ↗</button>` : ""}${g.source === "domeme" ? `<button class="chip" data-act="po-nos" data-src="domeme">상품번호 복사</button>` : ""}<button class="chip" data-act="po-done" data-src="${esc(g.source)}">발주 완료</button></h3>
          <div style="overflow-x:auto"><table class="adm-table" style="font-size:12.5px"><tr><th>주문</th><th>상품코드</th><th>제품명</th><th>수량</th><th>개당가격</th><th>제품가격</th><th>택배비</th><th>종합가격<br><small>손님 결제</small></th><th>도매 원가</th><th>카드값</th><th>각종세금<br><small>부가세</small></th><th>순수마진</th><th>도매처 확인</th><th>받는 분</th></tr>${g.lines.map((l) => { const m = l.m || {}; return `<tr>
          <td>${esc(l.orderId)}<br><span class="muted">${dt(l.paidAt)}</span></td>
          <td>${srcTag(l.id)}<br><b>${esc(l.product_no)}</b></td>
          <td style="white-space:normal;min-width:160px">${esc(l.name)}${l.option ? `<br><span class="muted">옵션: ${esc(l.option)}</span>` : ""}</td>
          <td>${l.qty / (l.pk || 1)}${l.pk > 1 ? `<br><span class="muted">(도매처 ${l.qty}개)</span>` : ""}</td>
          <td>${won(m.unit)}</td><td>${won(m.goods)}${m.disc ? `<br><span class="muted">할인 −${won(m.disc)}</span>` : ""}</td><td>${won(m.ship)}${l.ship_fee ? `<br><span class="muted" style="font-size:11px">${l.sn === 1 ? "1개마다" : l.sn > 1 ? l.sn + "개마다" : "주문당 1번"} ${won(l.ship_fee)}</span>` : l.ship_fee === 0 ? `<br><span class="muted" style="font-size:11px">무료배송</span>` : ""}</td>
          <td><b>${won(m.rev)}</b></td><td>${won(m.cost)}${m.ship ? `<br><span class="muted">+택배 ${won(m.ship)}</span>` : ""}</td>
          <td>${won(m.card)}</td><td>${won(m.vat)}${m.ops ? `<br><span class="muted">운영비 ${won(m.ops)}</span>` : ""}</td>
          <td><b style="color:${m.net < 0 ? "var(--sale)" : "var(--ok)"}">${won(m.net)}</b><br><span class="muted">${m.rate}%</span></td>
          <td style="white-space:normal;max-width:200px">${!l.lv ? `<span class="muted">확인 전</span>` : l.lv.ok === false ? `<b style="color:var(--sale)">⚠️ ${esc(l.lv.msg)}</b>` : l.lv.ok ? `<span style="color:var(--ok)">✅ 정상</span>` : `<span class="muted">${esc(l.lv.msg)}</span>`}</td>
          <td>${esc(l.receiver)}<br><span class="muted">${esc(l.addr)}</span></td></tr>`; }).join("")}</table></div></div>`).join("")
          : `<p class="empty">발주할 주문이 없어요.</p>`}</div>
        <div class="card"><h2>도매처 대량주문 양식 <small>각 도매처 공식 양식에 맞춰 주문서가 만들어져요</small></h2>
        <p class="muted" style="margin-bottom:8px">도매처 사이트의 대량(엑셀) 주문 화면에서 <b>양식(샘플) 파일</b>을 내려받아 여기에 한 번만 올려 두면, 그 열 순서·이름 그대로 주문서를 만들어 드려요. 도매처가 양식을 바꾸면 다시 올리면 돼요.</p>
        <table class="adm-table"><tr><th>도매처</th><th>지금 쓰는 양식</th><th></th></tr>${["domeme", "ownerclan", "onchannel", "ggsan", "cmtstory"].map((k) => {
          const my = (D.mysheets || {})[k], cols = (my && my.cols) || (D.sheets || {})[k] || SHEET_DEFAULT, miss = cols.filter((c) => !fieldFor(c, cols));
          return `<tr><td>${srcTag(k === "domeme" ? "DM1" : k === "ownerclan" ? "WAAAAAA" : k === "onchannel" ? "CH1" : k === "ggsan" ? "GS1" : "CM1")}</td>
            <td style="white-space:normal">${my ? `<b>올린 양식</b> (${esc(my.name || "")}, ${dt(my.at)})` : (D.sheets || {})[k] ? "기본 양식" : `<span style="color:var(--sale)">공통 양식 — 도매처 양식을 올려 주세요</span>`}<br>
              <span class="muted" style="font-size:12px">${cols.map((c) => fieldFor(c, cols) ? esc(c) : `<b style="color:var(--sale)">${esc(c)}(빈칸)</b>`).join(" · ")}</span></td>
            <td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap"><button class="ghost" data-act="open-url" data-url="${SUP[k].url}">사이트 열기 ↗</button><button class="ghost" data-act="sheet-up" data-src="${k}">양식 올리기</button>${my ? `<button class="ghost" data-act="sheet-reset" data-src="${k}">기본으로</button>` : ""}</div></td></tr>`; }).join("")}</table>
        <input type="file" id="sheet-file" accept=".xlsx,.xls,.csv" hidden></div>
        <div class="card"><h2>도매처별 송장 가져오기 <small>송장 기다리는 주문 ${D.orders.filter((o) => o.status === "상품준비중" && !o.tracking).length}건</small></h2>
        <table class="adm-table"><tr><th>도매처</th><th>송장 기다림</th><th>가져오는 방법</th><th></th></tr>${["ownerclan", "domeme", "onchannel", "ggsan", "cmtstory", "own", "direct"].map((k) => {
          const n = D.orders.filter((o) => o.status === "상품준비중" && !o.tracking && o.lines.some((l) => SRC(l.id) === k)).length;
          return `<tr><td><b>${SUP[k].n}</b></td><td>${n ? `<b>${n}건</b>` : `<span class="muted">0건</span>`}</td><td class="muted" style="white-space:normal">${SUP[k].how}</td>
            <td><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${k === "direct" || k === "own" ? `<span class="muted">직접 입력</span>` : `<button class="ghost" data-act="open-url" data-url="${SUP[k].url}">사이트 열기 ↗</button><button class="ghost" data-act="trk-file-up">엑셀 올리기</button>${k === "ownerclan" ? `<button data-act="oc-trk">자동으로 가져오기</button>` : ""}`}
            ${n ? `<button class="ghost" data-act="trk-wait" data-src="${k}">기다리는 주문 목록</button>` : ""}</div></td></tr>`; }).join("")}</table>
        <p class="muted" style="margin-top:8px">엑셀 올리기: 도매처에서 받은 주문·배송 엑셀을 그대로 올리면 우리 주문번호로 찾아 송장이 들어가고, 손님께 출고 알림이 자동으로 가요. 어느 도매처 파일이든 같은 버튼이에요.</p></div>
        <div class="card"><h2>송장 한 번에 넣기</h2>
        <p class="muted" style="margin-bottom:10px">도매처에서 받은 송장 엑셀을 열어 <b>전체 복사(Ctrl+A → Ctrl+C)</b> 후 아래에 붙여넣거나, CSV로 저장해 올려 주세요. 각 줄에서 우리 주문번호(T로 시작)·택배사·송장번호를 자동으로 찾아요.</p>
        <textarea id="trk-paste" style="width:100%;height:120px" placeholder="여기에 붙여넣기"></textarea>
        <div style="margin-top:8px"><input type="file" id="trk-file" accept=".xlsx,.xls,.csv,.txt"> <button data-act="trk-import">송장 넣기</button></div><div id="trk-result" class="muted" style="margin-top:8px"></div></div>`;
    }
    if (tab === "claims") {
      const open = D.orders.filter((o) => /요청$/.test(o.status));
      const step = (o, k, label, done) => done ? `<span style="color:var(--ok)">✅ ${label}<br><small class="muted">${dt(done)}</small></span> <button class="ghost" style="padding:1px 6px;font-size:11px" data-act="cl-step" data-id="${esc(o.orderId)}" data-step="${k}" data-undo="1">되돌리기</button>`
        : `<button data-act="cl-step" data-id="${esc(o.orderId)}" data-step="${k}">${label}</button>`;
      const card = (o) => {
        const st = (o.claim && o.claim.steps) || {}, type = o.status.replace(/요청$/, ""), srcs = [...new Set(o.lines.map((l) => SRC(l.id)))];
        const left = o.amount - (o.refunded || 0), sug = o.claim && o.claim.refund != null ? o.claim.refund : left;
        const cost = o.lines.reduce((a, l) => a + (Number(l.cost) || 0) * (Number(l.qty) || 1), 0);
        const flow = type === "취소" ? [["ws", "① 도매처 주문 취소 완료"]] : type === "반품" ? [["ws", "① 도매처 반품 신청 완료"], ["retrieved", "② 회수(상품 도착) 확인"]] : [["ws", "① 도매처 교환 신청 완료"], ["retrieved", "② 회수 확인"], ["resent", "③ 새 상품 발송 → 교환완료"]];
        const canRefund = type !== "교환" && (type === "취소" ? (!o.lines.some((l) => l.po) || st.ws) : st.retrieved);
        return `<div class="po-group" style="border:1px solid var(--line);padding:14px;margin-bottom:12px">
          <h3 style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="state">${esc(o.status)}</span> ${esc(o.orderId)} <small class="muted">${esc(o.customer?.name || "")} · ${esc(o.customer?.phone || "")}</small></h3>
          <p>${o.lines.map((l) => `${esc(l.name)} × ${l.qty} <span class="muted">[${esc(SUP[SRC(l.id)].n)} ${esc(l.source_no || String(l.id).replace(/^DM/, ""))}]${l.po ? " · 발주함" : " · 발주 전"}</span>`).join("<br>")}</p>
          ${o.claim ? `<p class="muted">${o.claim.kind ? "[" + esc(o.claim.kind) + "] " : ""}${esc(o.claim.reason || "")} ${Array.from({ length: o.claim.photos || 0 }, (_, i) => `<button class="ghost" style="padding:1px 6px" data-act="claim-photo" data-id="${esc(o.orderId)}" data-i="${i}">사진 ${i + 1}</button>`).join(" ")}</p>` : ""}
          <p>결제 ${won(o.amount)}${o.refunded ? ` · 환불됨 ${won(o.refunded)}` : ""} · <b>${type === "교환" ? (/변심/.test(o.claim?.kind || "") ? `왕복 배송비 ${won(o.claim?.deduct || 0)} 손님 부담 (입금 확인 후 진행)` : "불량·오배송: 도매처 부담으로 교환") : `환불할 금액 ${won(sug)}`}</b>
            ${cost && o.lines.some((l) => l.po) ? `<br><span class="muted">도매처에 낸 원가 약 ${won(cost)} → 도매처 ${type}로 돌려받기${/변심/.test(o.claim?.kind || "") ? ` (도매처 반품·교환 배송비는 손님 부담분 ${won(o.claim?.deduct || 0)}로 충당)` : " (불량·오배송이면 배송비도 도매처 부담으로 요청)"}</span>` : ""}</p>
          <p class="muted" style="margin:6px 0">${srcs.filter((x) => SUP[x].url).map((x) => `<button class="ghost" style="padding:3px 8px;font-size:12px" data-act="open-url" data-url="${SUP[x].url}">${SUP[x].n} 열기 ↗</button>`).join(" ")}${srcs.includes("direct") ? " · 직영 상품: 직접 회수·처리" : ""}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${flow.map(([k, lb]) => step(o, k, lb, st[k])).join(" → ")}
            ${type !== "교환" ? ` → <button ${canRefund ? "" : 'class="ghost" '}data-act="order-refund" data-id="${esc(o.orderId)}"${o.claim?.refund != null ? ` data-refund="${o.claim.refund}" data-deduct="${o.claim.deduct}"` : ""}>${type === "취소" ? "②" : "③"} 환불 ${won(sug)}</button>` : ""}</div>
          ${!canRefund && type !== "교환" ? `<p class="muted" style="font-size:12px;margin-top:4px">앞 단계를 끝낸 뒤 환불하세요. 순서를 건너뛰면 한 번 더 확인해요.</p>` : ""}</div>`;
      };
      return `<div class="card"><h2>처리할 취소·반품·교환 <small>${open.length}건</small></h2>
        <p class="muted" style="margin-bottom:12px">순서대로 버튼만 누르면 돼요. 도매처 처리를 확인하기 전에 환불하려고 하면 한 번 더 물어봐서 손해를 막아요.
        단순 변심은 받은 날부터 7일 안에만 신청할 수 있고(사이트에서 자동 차단), 배송비는 손님 부담으로 자동 계산돼요. 받은 뒤 8일이 지나면 자동 구매확정돼요.</p>
        ${open.length ? open.map(card).join("") : `<p class="empty">처리할 요청이 없어요.</p>`}</div>
      <div class="card"><h2>처리 완료</h2>${orderTable(D.orders.filter((o) => ["취소완료", "반품완료", "교환완료"].includes(o.status)))}</div>`;
    }
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
    $("#adm-tabs").innerHTML = TABS.map(([k, n]) => { const c = tabCount(k); return `<button class="chip${k === tab ? " on" : ""}" data-tab="${k}">${n}${c ? ` <b style="display:inline-block;min-width:18px;margin-left:4px;padding:0 5px;border-radius:9px;background:var(--sale);color:#fff;font-size:11px;line-height:18px;text-align:center">${c}</b>` : ""}</button>`; }).join("");
    $("#adm-view").innerHTML = view();
  }
  async function load() {
    D = await call("/admin/list");
    const po = await call("/admin/po").catch(() => ({ groups: [] }));
    D.po = po.groups || []; D.sheets = po.sheets || {}; D.mysheets = po.mysheets || {};
    D.kc = await fetch("kc_check.json").then((r) => r.json()).catch(() => []);
    $("#admin-login").style.display = "none"; $("#admin-body").style.display = "";
    paint();
  }

  // ── 상품 관리: 검색 → 이름·가격·카테고리·소개·표시·품절·숨김 고치기 (서버 저장 → 사이트 빌드 때 반영) ──
  let PIDX = null, PEDITS = null, PSEL = null, OSEARCH = null, OQ = "", CUST = null, ALOG = null;
  const BADGES = ["", "NEW", "BEST", "SALE", "추천", "특가"];
  const LOGNAME = { "/admin/order-update": "주문 상태·송장 저장", "/admin/order-cancel": "주문 취소·환불", "/admin/soldout-cancel": "품절 취소", "/admin/product-save": "상품 수정", "/admin/product-bulk": "상품 여러 개 수정", "/admin/block": "주문 차단 변경", "/admin/site-save": "공지 띠 변경", "/admin/coupon-save": "쿠폰 저장", "/admin/answer": "문의 답변", "/admin/delete": "삭제", "/admin/po-done": "발주 완료", "/admin/po-mark": "도매처 주문서 받기", "/admin/tracking-import": "송장 한 번에 넣기", "/admin/offer-reply": "가격 제안 답변", "/admin/approve-seller": "공급사 승인", "/admin/approve-product": "상품 승인", "/admin/reject-product": "상품 반려" };
  const memTable = (list) => list.length ? `<table class="adm-table"><tr><th>가입일</th><th>이름</th><th>가입 방법</th><th>이메일</th><th>연락처</th><th>주문</th><th>최근 로그인</th></tr>${list.map((m) => `<tr><td class="muted">${m.joinedAt ? dt(m.joinedAt) : ""}</td><td>${esc(m.name || "-")}</td><td>${esc({ naver: "네이버", kakao: "카카오", google: "구글" }[m.provider] || m.provider)}</td><td>${esc(m.email || "-")}</td><td>${esc(m.phone || "-")}</td><td>${m.orders}</td><td class="muted">${m.lastLogin ? dt(m.lastLogin) : ""}</td></tr>`).join("")}</table>${list.length > 500 ? `<p class="muted" style="margin-top:8px">최근 500명만 보여요. 검색으로 찾아 주세요.</p>` : ""}` : `<p class="empty">아직 가입한 회원이 없어요.</p>`;
  const custTable = (list) => list.length ? `<table class="adm-table"><tr><th>이름</th><th>연락처</th><th>주문</th><th>구매액</th><th>취소/반품</th><th>최근 주문</th><th></th></tr>${list.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${c.orders}</td><td>${won(c.total)}</td><td>${c.cancels}/${c.claims}</td><td class="muted">${c.last ? dt(c.last) : ""}</td>
    <td><button class="ghost" data-act="c-orders" data-phone="${esc(c.phone)}">주문 보기</button> ${(CUST.blocked || {})[c.phone] ? `<button class="ghost" data-act="bl-del" data-phone="${esc(c.phone)}">차단 풀기</button>` : `<button class="ghost" data-act="bl-quick" data-phone="${esc(c.phone)}">차단</button>`}</td></tr>`).join("")}</table>` : `<p class="muted">아직 고객이 없어요.</p>`;
  function prodShell() {
    return `<div class="card form"><h2>상품 찾기</h2>
      <input id="p-q" placeholder="상품명 또는 상품코드(예: DM12345678)" autocomplete="off" style="width:100%">
      <p class="muted" style="margin-top:6px">고친 내용은 서버에 저장되고, 30분 안에 사이트에 자동으로 반영돼요. 가격은 손해를 막기 위해 공급사 최저가·순마진 8% 아래로는 내려가지 않아요.</p>
      <div id="p-res" style="margin-top:10px"></div></div>
      <div class="card form" id="p-edit" style="display:none"></div>
      <div class="card form"><h2>SEO 자동 최적화 <small class="muted">네이버 쇼핑 검색 흐름 기준</small></h2>
        <p class="muted">지금 네이버에서 같은 상품을 찾을 때 많이 쓰는 말을 조사해서 <b>상품명·검색 태그·요약 설명</b>을 다듬어요.<br>
        · 상품명은 원래 이름을 바탕으로 홍보 문구·특수문자·반복을 빼고, 대표 검색어가 빠졌으면 하나만 붙여요 (우리 상품 설명에 있는 말만, 다른 브랜드 이름은 절대 안 넣어요)<br>
        · 손으로 고친 SEO는 건드리지 않아요 · 검사에 걸리면 그 상품은 원래대로 · 적용 전 값은 백업돼서 <b>한 번에 되돌리기</b> 가능</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <select id="sa-scope"><option value="site">사이트 상품</option><option value="db">상품 DB 전체</option>${Object.entries((window.SHOP_CFG || {}).cat_names || {}).map(([k, v]) => `<option value="cat:${esc(k)}">${esc(v)}</option>`).join("")}<option value="ids">상품코드 직접 입력</option></select>
          <input id="sa-ids" placeholder="상품코드 (쉼표로 구분)" style="display:none;min-width:240px">
          <label class="muted">최대 <input id="sa-limit" type="number" value="20000" min="1" max="200000" step="1000" style="width:100px"> 개</label>
          <button class="btn btn-ghost" data-act="sa-run" data-m="preview">① 미리보기</button>
          <button class="btn" data-act="sa-run" data-m="apply">② 적용</button>
          <label style="display:flex;gap:6px;align-items:center;margin-left:auto"><input type="checkbox" id="sa-daily" style="width:auto"> 매일 새벽 자동 (사이트 상품)</label></div>
        <div id="sa-status" style="margin-top:10px"><p class="muted">불러오는 중…</p></div></div>
      <div class="card form"><h2>SEO 일괄 수정 (엑셀)</h2>
        <p class="muted">① 상품 목록을 내려받아 엑셀에서 <b>상품명·검색키워드·요약설명</b>을 고치고 ② 저장한 파일(엑셀·CSV 모두 가능)을 올리면 돼요. 상품코드·기존 상품명 칸은 고치지 마세요.<br>
        검색키워드는 쉼표(,)로 구분, 요약설명은 150자 안. 올린 내용은 30분 안에 사이트·상품 DB에 반영돼요. (엑셀은 한 파일에 100만 줄까지라 30만 개씩 나눠서 받아요)</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <select id="seo-cat"><option value="">전체 상품</option>${Object.entries((window.SHOP_CFG || {}).cat_names || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select>
          <button data-act="seo-down" data-fmt="xlsx">엑셀(.xlsx)로 내려받기</button>
          <button class="ghost" data-act="seo-down" data-fmt="csv">CSV로 내려받기</button>
          <label class="ghost" style="cursor:pointer;border:1px solid var(--line);padding:6px 12px">수정본 올리기 (엑셀·CSV)<input type="file" id="seo-file" accept=".xlsx,.xls,.csv,text/csv" hidden></label></div>
        <div id="seo-msg" class="muted" style="margin-top:8px"></div></div>
      <div class="card form"><h2>여러 상품 한 번에</h2>
        <textarea id="pb-ids" rows="3" placeholder="상품코드를 띄어쓰기·쉼표·줄바꿈으로 구분해 넣어 주세요. 도매매는 숫자 번호만 넣어도 돼요. (예: DM20067843, 65114578)" style="width:100%"></textarea>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button data-act="pb" data-a="hide">숨기기(판매 중지)</button><button data-act="pb" data-a="soldout">품절로 표시</button><button class="ghost" data-act="pb" data-a="show">다시 판매</button><button class="ghost" data-act="pb" data-a="reset">고친 내용 모두 되돌리기</button></div></div>
      <div class="card"><h2>고친 상품 <small id="p-cnt"></small></h2><div id="p-edited"><p class="muted">불러오는 중…</p></div></div>`;
  }
  // ── SEO 일괄 수정: CSV 내려받기·올리기 ──
  const csvCell = (v) => { v = String(v ?? ""); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function parseCSV(t) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
      if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c !== "\r") cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  const SEO_HEAD = ["상품코드", "기존 상품명(수정 금지)", "상품명", "검색키워드(쉼표로 구분)", "요약설명(150자)", "카테고리", "판매가(참고)", "상품 링크"];
  // 엑셀(.xlsx) 읽기·쓰기 라이브러리 (SheetJS) — 엑셀을 고를 때만 불러옴
  const loadXLSX = () => window.XLSX ? Promise.resolve(window.XLSX) : new Promise((ok, no) => { const sc = document.createElement("script"); sc.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"; sc.onload = () => ok(window.XLSX); sc.onerror = () => no(new Error("엑셀 기능을 불러오지 못했어요. CSV로 받아 주세요.")); document.head.appendChild(sc); });
  async function seoDownload(fmt = "xlsx") {
    const msg = $("#seo-msg"), cat = $("#seo-cat").value, catN = cat ? $("#seo-cat").selectedOptions[0].text : "전체";
    let after = "", part = 1, buf = [], total = 0;
    const X = fmt === "xlsx" ? await loadXLSX().catch((e) => { msg.textContent = e.message; return null; }) : null;
    if (fmt === "xlsx" && !X) return;
    const PER = fmt === "xlsx" ? 100000 : 300000;  // 엑셀 파일은 브라우저 메모리 때문에 10만 개씩
    const save = () => {
      if (!buf.length) return;
      const fname = `담고사고_SEO_${catN.replace(/[\/·]/g, "_")}_${part}`;
      if (X) {
        const ws = X.utils.aoa_to_sheet([SEO_HEAD, ...buf]);
        ws["!cols"] = [{ wch: 14 }, { wch: 40 }, { wch: 40 }, { wch: 30 }, { wch: 40 }, { wch: 12 }, { wch: 10 }, { wch: 30 }];
        const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "상품목록"); X.writeFile(wb, fname + ".xlsx", { compression: true });
      } else {
        const blob = new Blob(["\ufeff" + [SEO_HEAD, ...buf].map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname + ".csv"; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      }
      part++; buf = [];
    };
    try {
      do {
        const r = await call("/admin/catalog-export", { cat, after, limit: 20000 });
        for (const [id, name, kw, sum, c, price] of r.rows) buf.push([id, name, name, kw, sum, ((window.SHOP_CFG || {}).cat_names || {})[c] || c, price, `https://damgosago.com/product/item.html?id=${id}`]);
        total += r.rows.length; after = r.next;
        msg.textContent = `내려받는 중… ${total.toLocaleString()}개`;
        if (buf.length >= PER) save();
      } while (after);
      save(); msg.textContent = `완료: ${total.toLocaleString()}개 (${part - 1}개 파일)`;
    } catch (e) { msg.textContent = "실패: " + e.message; }
  }
  async function seoUploadFile(f) {
    const msg = $("#seo-msg");
    let rows;
    if (/\.xlsx?$/i.test(f.name)) {
      msg.textContent = "엑셀 파일 읽는 중…";
      const X = await loadXLSX().catch((e) => { alert(e.message); return null; }); if (!X) return;
      const wb = X.read(await f.arrayBuffer()); rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
    } else rows = parseCSV(await f.text());
    const head = (rows.shift() || []).map((h) => h.replace(/^\ufeff/, "").trim());
    const ix = (k) => head.findIndex((h) => h.startsWith(k));
    const iId = ix("상품코드"), iOld = ix("기존 상품명"), iName = head.findIndex((h) => h === "상품명"), iKw = ix("검색키워드"), iSum = ix("요약설명");
    if (iId < 0 || iName < 0) { alert("상품코드·상품명 칸을 찾지 못했어요. 내려받은 파일 그대로 고쳐서 올려 주세요."); return; }
    const out = [];
    for (const r of rows) {
      const id = (r[iId] || "").trim(); if (!id) continue;
      const name = (r[iName] || "").trim(), old = iOld >= 0 ? (r[iOld] || "").trim() : "", kw = iKw >= 0 ? (r[iKw] || "").trim() : "", sum = iSum >= 0 ? (r[iSum] || "").trim() : "";
      const e = { id }; if (name && name !== old) e.name = name; if (kw) e.kw = kw; if (sum) e.summary = sum;
      if (e.name || e.kw || e.summary) out.push(e);
    }
    if (!out.length) { msg.textContent = "바뀐 내용이 없어요."; return; }
    if (!confirm(`${out.length.toLocaleString()}개 상품의 SEO 정보를 저장할까요?`)) return;
    let done = 0;
    try {
      for (let i = 0; i < out.length; i += 3000) { await call("/admin/seo-upload", { rows: out.slice(i, i + 3000) }); done = Math.min(out.length, i + 3000); msg.textContent = `올리는 중… ${done.toLocaleString()} / ${out.length.toLocaleString()}`; }
      msg.textContent = `완료: ${done.toLocaleString()}개 저장. 30분 안에 사이트에 반영돼요.`;
    } catch (e) { msg.textContent = `실패 (${done.toLocaleString()}개까지 저장됨): ` + e.message; }
  }
  const SA = { list: [], page: 1, size: +(localStorage.getItem("sa_size") || 10), only: localStorage.getItem("sa_only") === "1" };
  function saTable() {  // 예시 표: 페이지 나누기 + 한 쪽에 몇 개
    const box = $("#sa-tbl"); if (!box) return;
    const L = SA.only ? SA.list.filter((x) => x.after !== x.before) : SA.list;
    const pages = Math.max(1, Math.ceil(L.length / SA.size)); SA.page = Math.min(Math.max(1, SA.page), pages);
    const rows = L.slice((SA.page - 1) * SA.size, SA.page * SA.size);
    const nav = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0">
      <label class="muted">한 쪽에 <select id="sa-size" style="width:auto">${[10, 20, 50, 100].map((n) => `<option${n === SA.size ? " selected" : ""}>${n}</option>`).join("")}</select> 개</label>
      <label class="muted" style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="sa-only" style="width:auto"${SA.only ? " checked" : ""}> 상품명이 바뀌는 것만 (${SA.list.filter((x) => x.after !== x.before).length}개)</label>
      <span style="margin-left:auto;display:flex;gap:4px;align-items:center"><button class="ghost" data-act="sa-pg" data-p="1"${SA.page === 1 ? " disabled" : ""}>«</button><button class="ghost" data-act="sa-pg" data-p="${SA.page - 1}"${SA.page === 1 ? " disabled" : ""}>‹ 이전</button>
      <span class="muted">${SA.page} / ${pages} 쪽 (${L.length}개)</span>
      <button class="ghost" data-act="sa-pg" data-p="${SA.page + 1}"${SA.page === pages ? " disabled" : ""}>다음 ›</button><button class="ghost" data-act="sa-pg" data-p="${pages}"${SA.page === pages ? " disabled" : ""}>»</button></span></div>`;
    box.innerHTML = nav + `<table class="adm-table" data-nopage="1"><tr><th>상품코드</th><th>지금 상품명</th><th>바뀔 상품명</th><th>검색 태그</th><th>이유</th></tr>${rows.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.before)}</td><td>${x.after !== x.before ? `<b>${esc(x.after)}</b>` : `<span class="muted">그대로</span>`}</td><td class="muted">${esc(x.kw)}</td><td class="muted">${esc((x.why || []).join(", "))}</td></tr>`).join("")}</table>`;
    $("#sa-size").onchange = (ev) => { SA.size = +ev.target.value; SA.page = 1; try { localStorage.setItem("sa_size", SA.size); } catch (e) {} saTable(); };
    $("#sa-only").onchange = (ev) => { SA.only = ev.target.checked; SA.page = 1; try { localStorage.setItem("sa_only", SA.only ? "1" : "0"); } catch (e) {} saTable(); };
  }
  async function seoAutoPaint() {
    const box = $("#sa-status"); if (!box) return;
    let d; try { d = await call("/admin/seo-auto-status"); } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    $("#sa-daily").checked = !!d.daily;
    const rq = d.req, rp = d.report, MODE = { preview: "미리보기", apply: "적용" };
    const scopeName = (x) => x === "site" ? "사이트 상품" : x === "db" ? "상품 DB 전체" : String(x || "").startsWith("cat:") ? (((window.SHOP_CFG || {}).cat_names || {})[x.slice(4)] || x) : "상품코드 지정";
    let h = "";
    if (rq) h += `<p>⏳ <b>${MODE[rq.mode]}</b> (${esc(scopeName(rq.scope))}, 최대 ${(+rq.limit).toLocaleString()}개) ${rq.taken ? "실행 중이에요. 상품 수에 따라 몇 분~몇 시간 걸려요." : "요청됨 — 30분 안에 시작해요."}</p>`;
    if (rp) {
      const st = rp.stats || {};
      h += `<p><b>최근 결과</b> · ${esc(MODE[rp.mode] || rp.mode)} · ${esc(scopeName(rp.scope))} · ${rp.at ? dt(rp.at) : ""} ${rp.ok ? "✅" : "❌ " + esc(rp.error || "")}<br>
        <span class="muted">확인 ${(rp.checked || 0).toLocaleString()}개 → 바뀜 ${(rp.changed || 0).toLocaleString()}개${rp.applied ? ` (적용 ${rp.applied.toLocaleString()}개)` : ""} · ${Object.entries(st).map(([k, v]) => `${esc(k)} ${(+v).toLocaleString()}`).join(" · ")} · 네이버 조회 ${(rp.api_calls || 0).toLocaleString()}회 (${esc(rp.api || "")})</span></p>`;
      if ((rp.samples || []).length) { SA.list = rp.samples; SA.page = 1; h += `<details${rp.mode === "preview" ? " open" : ""}><summary>바뀌는 예시 ${rp.samples.length}개 보기</summary><div id="sa-tbl"></div></details>`; }
    }
    if ((d.runs || []).length) h += `<p style="margin-top:8px">적용한 기록: ${d.runs.slice().reverse().map((r) => `<span style="display:inline-block;margin:2px 6px 2px 0">${esc(r)} <button class="ghost" style="padding:2px 8px" data-act="sa-undo" data-run="${esc(r)}">되돌리기</button></span>`).join("")}</p>`;
    box.innerHTML = h || `<p class="muted">아직 실행한 적이 없어요. ① 미리보기로 먼저 확인해 보세요.</p>`;
    saTable();
    if (rq) { clearTimeout(box._t); box._t = setTimeout(seoAutoPaint, 60000); }
  }
  async function prodInit() {
    if (!PIDX) PIDX = await fetch("idx/list.json?t=" + Date.now()).then((r) => r.json())
      .then((L) => Promise.all(L.map((c) => fetch(`idx/${c}.json?t=${Date.now()}`).then((r) => r.json()))))
      .then((a) => ({ ...a[0], items: a.flatMap((d) => d.items) })).catch(() => null);
    PEDITS = await call("/admin/product-edits").catch(() => ({ items: {} }));
    const sc = $("#sa-scope"); if (sc) { sc.onchange = () => ($("#sa-ids").style.display = sc.value === "ids" ? "" : "none"); $("#sa-daily").onchange = async (ev) => { try { alert((await call("/admin/seo-auto-req", { daily: ev.target.checked })).message); } catch (e) { alert(e.message); ev.target.checked = !ev.target.checked; } }; seoAutoPaint(); }
    const sf = $("#seo-file"); if (sf) sf.onchange = () => { if (sf.files[0]) seoUploadFile(sf.files[0]); sf.value = ""; };
    const q = $("#p-q"); if (!q) return;
    q.oninput = () => { clearTimeout(q._t); q._t = setTimeout(prodSearch, 200); };
    prodEdited(); if (PSEL) prodForm(PSEL.id); else if (HASH_P && !prodInit._h) { prodInit._h = 1; prodForm(HASH_P); }
  }
  const catName = (i) => (PIDX && PIDX.cats[i] ? PIDX.cats[i][1] : "");
  function prodSearch() {
    const v = ($("#p-q").value || "").trim().toLowerCase(), box = $("#p-res");
    if (!PIDX) { box.innerHTML = `<p class="muted">상품 목록을 불러오지 못했어요.</p>`; return; }
    if (v.length < 2) { box.innerHTML = ""; return; }
    const words = v.split(/\s+/), hits = [];
    for (const r of PIDX.items) { const t = (r[0] + " " + r[1]).toLowerCase(); if (words.every((w) => t.includes(w))) { hits.push(r); if (hits.length >= 40) break; } }
    const row = (r) => `<tr>
      <td><img src="${esc(r[4])}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px"></td>
      <td>${esc(r[1])}<br>${srcTag(r[0])}<span class="muted">${esc(r[0])}${r[7] ? " · 품절" : ""}${PEDITS.items[r[0]] ? " · ✏️ 고침" : ""}</span></td>
      <td>${esc(r[6] === null ? "" : catName(r[6]) || r[6])}</td><td>${won(r[2])}</td>
      <td><button data-act="p-pick" data-id="${esc(r[0])}">수정</button> <a class="muted" href="product/item.html?id=${encodeURIComponent(r[0])}" target="_blank">보기</a></td></tr>`;
    // 사이트 목록 밖(상품 DB 150만 개)도 서버에서 찾기
    const tok = (box._tok = (box._tok || 0) + 1);
    const code = v.toUpperCase().replace(/\s/g, "");
    Promise.all([
      /^[A-Z]{1,3}\d{4,}$|^\d{6,}$/.test(code) ? call("/admin/product-get", { id: code }).then((d) => d.row && d.row.name ? [[d.row.id, d.row.name, d.row.price, 0, d.row.image, 0, d.row.category, d.row.soldout]] : []).catch(() => []) : Promise.resolve([]),
      fetch(`${API}/catalog/list?q=${encodeURIComponent(v)}&size=40`).then((x) => x.json()).then((d) => (d.items || []).map((it) => [it.id, it.name, it.price, 0, it.image, 0, it.category, it.soldout])).catch(() => []),
    ]).then(([a, b2]) => {
      if (tok !== box._tok) return;
      const seen = new Set(hits.map((r) => r[0])), more = [...a, ...b2].filter((r) => !seen.has(r[0]) && seen.add(r[0]));
      if (more.length) box.insertAdjacentHTML("beforeend", `<h3 style="margin:14px 0 6px">상품 DB에서 찾은 상품 <small class="muted">${more.length}개</small></h3><table class="adm-table"><tr><th></th><th>상품</th><th>카테고리</th><th>가격</th><th></th></tr>${more.map(row).join("")}</table>`);
      else if (!hits.length) box.innerHTML = `<p class="muted">찾는 상품이 없어요.</p>`;
    });
    box.innerHTML = hits.length ? `<table class="adm-table"><tr><th></th><th>상품</th><th>카테고리</th><th>가격</th><th></th></tr>${hits.map((r) => `<tr>
      <td><img src="${esc(r[4])}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px"></td>
      <td>${esc(r[1])}<br><span class="muted">${esc(r[0])}${r[7] ? " · 품절" : ""}${PEDITS.items[r[0]] ? " · ✏️ 고침" : ""}</span></td>
      <td>${esc(catName(r[6]))}</td><td>${won(r[2])}</td>
      <td><button data-act="p-pick" data-id="${esc(r[0])}">수정</button> <a class="muted" href="product/${esc(r[0])}.html" target="_blank">보기</a></td></tr>`).join("")}</table>` : `<p class="muted">찾는 중…</p>`;
  }
  async function prodForm(id) {
    const r = PIDX && PIDX.items.find((x) => x[0] === id);
    const [det, srv] = await Promise.all([fetch(`p/${id}.json`).then((x) => x.json()).catch(() => ({})), call("/admin/product-get", { id }).catch(() => ({}))]);
    const row = srv.row || {}, big = srv.big || {}, e = (PEDITS.items || {})[id] || srv.edit || {};
    const cur = { name: row.name || det.name || (r && r[1]) || "", price: row.price || det.price || (r && r[2]) || 0, category: row.category || det.category || "", summary: det.summary || "", badge: det.badge || "" };
    const imgs = big.images || [row.image || det.image || (r && r[4]) || "", ...(row.images || det.images || [])].filter(Boolean);
    const opts = (big.options || row.options || det.options || []).map((o) => ({ v: o.v, add: o.add || 0, so: !!o.so }));
    const html = big.detail_html !== undefined ? big.detail_html : (row.detail_html || det.detail_html || "");
    PSEL = { id, cur, imgs: [...imgs], opts, optName: big.option_name ?? row.option_name ?? det.option_name ?? "", html0: null, imgs0: JSON.stringify(imgs), opts0: JSON.stringify(opts), floor: row.floor || 0 };
    const box = $("#p-edit"); box.style.display = "";
    box.innerHTML = `<h2>상품 수정 <small>${srcTag(id)}${esc(id)}</small></h2>
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <img src="${esc(imgs[0] || "")}" alt="" style="width:120px;height:120px;object-fit:cover;border-radius:8px">
        <div style="flex:1;min-width:260px">
          <label>상품명</label><input id="pe-name" value="${esc(e.name || cur.name)}" maxlength="100">
          <label>판매가 (1개)${row.cost ? ` <span class="muted">· 원가 ${won(row.cost)} · 손해 안 나는 최저 ${won(row.floor)}</span>` : ""}</label><input id="pe-price" type="number" min="0" step="10" value="${esc(e.price || cur.price)}">
          <label>카테고리</label><select id="pe-cat">${(PIDX ? PIDX.cats : []).filter((c) => !["food", "adult"].includes(c[0])).map((c) => `<option value="${esc(c[0])}"${c[0] === (e.category || cur.category) ? " selected" : ""}>${esc(c[1])}</option>`).join("")}</select>
          <label>한 줄 소개</label><input id="pe-sum" value="${esc(e.summary || cur.summary)}" maxlength="80" placeholder="상품명 아래에 보이는 짧은 소개">
          <label>사진 표시</label><select id="pe-badge">${BADGES.map((b) => `<option value="${b}"${b === (e.badge || "") ? " selected" : ""}>${b || "없음"}</option>`).join("")}</select>
          <label style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="pe-sold"${e.soldout ? " checked" : ""} style="width:auto"> 품절로 표시</label>
          <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pe-hide"${e.hidden ? " checked" : ""} style="width:auto"> 사이트에서 숨기기 (판매 중지)</label>
        </div></div>
      <h3 style="margin:18px 0 6px">사진 <small class="muted">첫 번째가 대표 사진 · 최대 20장</small></h3>
      <div id="pe-imgs" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input id="pe-img-url" placeholder="사진 주소(https://…) 붙여넣기" style="flex:1;min-width:200px"><button class="ghost" data-act="pe-img-add">주소로 추가</button>
        <label class="btn btn-ghost" style="cursor:pointer">사진 올리기<input type="file" id="pe-img-file" accept="image/*" multiple style="display:none"></label></div>
      <h3 style="margin:18px 0 6px">옵션</h3>
      <label>옵션 이름</label><input id="pe-optname" value="${esc(PSEL.optName)}" placeholder="예: 색상 / 사이즈" maxlength="30">
      <div id="pe-opts"></div><button class="ghost" data-act="pe-opt-add" style="margin-top:6px">+ 옵션 추가</button>
      <h3 style="margin:18px 0 6px">상세페이지 <small class="muted">글을 바로 고치거나, 사진을 눌러 선택 후 삭제</small></h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <button class="ghost" data-act="pe-d-text">+ 글 추가</button>
        <label class="btn btn-ghost" style="cursor:pointer">+ 사진 추가<input type="file" id="pe-d-file" accept="image/*" multiple style="display:none"></label>
        <button class="ghost" data-act="pe-d-del">선택한 사진 삭제</button>
        <button class="ghost" data-act="pe-d-bold">굵게</button>
        <button class="ghost" data-act="pe-d-html">HTML 보기/편집</button>
        ${srv.orig ? `<button class="ghost" data-act="pe-d-orig">도매처 원본 불러오기</button>` : ""}
      </div>
      <div id="pe-detail" contenteditable="true" style="border:1px solid #ddd;border-radius:8px;padding:10px;max-height:600px;overflow:auto;background:#fff">${peClean(html)}</div>
      <textarea id="pe-detail-html" style="display:none;width:100%;height:400px;font-family:monospace;font-size:12px"></textarea>
      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><button data-act="p-save" data-id="${esc(id)}">저장</button>${PEDITS.items[id] ? `<button class="ghost" data-act="p-reset" data-id="${esc(id)}">원래대로 (도매처 원본)</button>` : ""}<a class="btn btn-ghost" href="product/item.html?id=${encodeURIComponent(id)}&x=1" target="_blank">사이트에서 보기</a></div>
      <p class="muted" style="margin-top:6px">저장하면 상품 페이지에 바로 반영돼요. 도매처가 매일 정보를 갱신해도 고친 내용은 유지돼요.</p>`;
    peImgs(); peOpts();
    const det2 = $("#pe-detail"); PSEL.html0 = det2.innerHTML;  // 브라우저가 정리한 모양 기준으로 바뀜 여부 판단
    det2.addEventListener("click", (ev) => { det2.querySelectorAll("img").forEach((x) => (x.style.outline = "")); if (ev.target.tagName === "IMG") { ev.target.style.outline = "3px solid #e33"; PSEL.selImg = ev.target; } else PSEL.selImg = null; });
    $("#pe-img-file").onchange = async (ev) => { for (const f of ev.target.files) { const u = await peUpload(f); if (u) PSEL.imgs.push(u); } ev.target.value = ""; peImgs(); };
    $("#pe-d-file").onchange = async (ev) => { for (const f of ev.target.files) { const u = await peUpload(f); if (u) peInsert(`<p><img src="${esc(u)}" style="max-width:100%"></p>`); } ev.target.value = ""; };
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const peClean = (h) => String(h || "").replace(/<(script|style|iframe|object|textarea)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<\/?(script|iframe|object|embed|style|form|input|button|link|meta|textarea|base)\b[^>]*>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, "");
  async function peUpload(f) {  // 사진을 1600px JPEG로 줄여 서버에 올림
    try {
      const data = await new Promise((ok, no) => { const img = new Image(); img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); ok(c.toDataURL("image/jpeg", 0.85)); }; img.onerror = () => no(new Error("사진을 읽지 못했어요.")); img.src = URL.createObjectURL(f); });
      return (await call("/admin/product-img", { data })).url;
    } catch (e) { alert(e.message); return ""; }
  }
  function peInsert(h) {
    const d = $("#pe-detail"), sel = window.getSelection();
    if (sel.rangeCount && d.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.collapse(false); r.insertNode(document.createRange().createContextualFragment(h)); }
    else d.insertAdjacentHTML("beforeend", h);
  }
  function peImgs() {
    $("#pe-imgs").innerHTML = PSEL.imgs.map((u, i) => `<div style="position:relative;width:96px;text-align:center"><img src="${esc(u)}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:6px;${i === 0 ? "outline:3px solid #2a7" : ""}">
      <div style="display:flex;justify-content:center;gap:2px"><button class="ghost" style="padding:2px 6px" data-act="pe-img-mv" data-i="${i}" data-d="-1">◀</button><button class="ghost" style="padding:2px 6px" data-act="pe-img-del" data-i="${i}">✕</button><button class="ghost" style="padding:2px 6px" data-act="pe-img-mv" data-i="${i}" data-d="1">▶</button></div></div>`).join("") || `<p class="muted">사진이 없어요.</p>`;
  }
  function peOpts() {
    $("#pe-opts").innerHTML = PSEL.opts.length ? `<table class="adm-table"><tr><th>옵션</th><th>추가금(원)</th><th>품절</th><th></th></tr>${PSEL.opts.map((o, i) => `<tr>
      <td><input data-oi="${i}" data-ok="v" value="${esc(o.v)}" maxlength="80"></td><td><input data-oi="${i}" data-ok="add" type="number" step="10" value="${o.add}" style="width:100px"></td>
      <td><input data-oi="${i}" data-ok="so" type="checkbox"${o.so ? " checked" : ""} style="width:auto"></td><td><button class="ghost" data-act="pe-opt-del" data-i="${i}">삭제</button></td></tr>`).join("")}</table>` : `<p class="muted">옵션 없음 (단일 상품)</p>`;
    $("#pe-opts").querySelectorAll("input").forEach((x) => (x.oninput = x.onchange = () => { const o = PSEL.opts[+x.dataset.oi]; o[x.dataset.ok] = x.type === "checkbox" ? x.checked : x.dataset.ok === "add" ? parseInt(x.value) || 0 : x.value; }));
  }
  function prodEdited() {
    const it = Object.entries((PEDITS || {}).items || {}).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    if ($("#p-cnt")) $("#p-cnt").textContent = it.length + "개";
    const L = { name: "이름", price: "가격", category: "카테고리", summary: "소개", badge: "표시", soldout: "품절", hidden: "숨김" };
    $("#p-edited").innerHTML = it.length ? `<table class="adm-table"><tr><th>상품코드</th><th>고친 내용</th><th>고친 때</th><th></th></tr>${it.map(([id, e]) => `<tr><td>${esc(id)}</td>
      <td>${Object.keys(L).filter((k) => e[k] !== undefined).map((k) => `${L[k]}: ${k === "price" ? won(e[k]) : e[k] === true ? "예" : esc(e[k])}`).join("<br>")}</td>
      <td class="muted">${e.at ? dt(e.at) : ""}</td><td><button data-act="p-pick" data-id="${esc(id)}">수정</button> <button class="ghost" data-act="p-reset" data-id="${esc(id)}">원래대로</button></td></tr>`).join("")}</table>` : `<p class="muted">아직 고친 상품이 없어요.</p>`;
  }

  // 도매처 주문서: 열 이름은 config.json 의 order_sheets 로 바꿀 수 있음 (도매처 대량주문 양식에 맞추기)
  const SHEET_DEFAULT = ["상품번호", "옵션", "수량", "수령자명", "수령자 연락처", "우편번호", "주소", "배송메시지", "주문번호"];
  const memoWithId = (l) => `${l.memo ? l.memo + " " : ""}(${l.orderId})`;
  const FIELD = { 상품번호: (l) => l.product_no, 상품코드: (l) => l.product_no, "오너클랜 상품코드": (l) => l.product_no, "온채널 상품코드": (l) => l.product_no, 주문코드: (l) => l.orderId, "주문 옵션": (l) => l.option || "단일상품", "옵션 주문 수량": (l) => l.qty, "배송비 결제 유형": () => "선불", 받는사람: (l) => l.receiver, 전화번호: (l) => l.phone, 비상연락처: () => "", "배송 메시지": (l) => l.memo, 통관고유부호: () => "", "(국제)배송방식": () => "", 옵션: (l) => l.option, 옵션명: (l) => l.option, 옵션1: (l) => l.option, 옵션2: () => "",
    수량: (l) => l.qty, 상품명: (l) => l.name.replace(/ \[.*\]$/, ""), 배송방식: (l) => l.ship_mode || "무료",
    수령자명: (l) => l.receiver, 수령자: (l) => l.receiver, 받는분: (l) => l.receiver, "받는사람 이름": (l) => l.receiver,
    "수령자 연락처": (l) => l.phone, 연락처: (l) => l.phone, 휴대폰: (l) => l.phone, 휴대전화: (l) => l.phone, "받는사람 휴대폰": (l) => l.phone, "받는사람 전화번호": (l) => l.phone, 추가연락처: () => "",
    우편번호: (l) => l.zip, 주소: (l) => l.addr, "받는사람 주소": (l) => l.addr, 배송지주소: (l) => l.addr1, 배송상세주소: (l) => l.addr2,
    배송메시지: memoWithId, 배송메모: memoWithId, 배송요청사항: (l) => l.memo, "배송시 요청사항": (l) => l.memo,
    주문번호: (l) => l.orderId, 주문자관리번호: (l) => l.orderId, 원장주문코드: (l) => l.orderId, 전달사항: (l) => "주문 " + l.orderId, 쇼핑몰명: () => "담Go사Go",
    "판매사 주문관리 메모": (l) => "담Go사Go " + l.orderId, "마켓 정산가(배송비 포함)": (l) => l.amount };
  const NO_COMMA = { ownerclan: true };  // 오너클랜 CSV는 값에 쉼표가 있으면 안 됨
  const csvDown = (rows, name) => {
    const csv = "\ufeff" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click();
  };
  // 간단한 .xlsx 만들기 (압축 없는 zip) — 온채널 대량주문은 엑셀 파일만 받음
  const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const [name, text] of files) {
      const nb = enc.encode(name), db = enc.encode(text), c = crc32(db);
      const h = [...u32(0x04034b50), ...u16(20), 0, 8, 0, 0, 0, 0, 0, 0, ...u32(c), ...u32(db.length), ...u32(db.length), ...u16(nb.length), 0, 0];
      parts.push(new Uint8Array(h), nb, db);
      cen.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), 0, 8, 0, 0, 0, 0, 0, 0, ...u32(c), ...u32(db.length), ...u32(db.length), ...u16(nb.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(off)]), nb);
      off += h.length + nb.length + db.length;
    }
    const cl = cen.reduce((a, b) => a + b.length, 0);
    return new Blob([...parts, ...cen, new Uint8Array([...u32(0x06054b50), 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cl), ...u32(off), 0, 0])], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  const xesc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  const colName = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") + String.fromCharCode(65 + (i % 26));
  const xlsxDown = (rows, name) => {
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${xesc(v)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
    const blob = zip([
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
      ["xl/worksheets/sheet1.xml", sheet]]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  };
  const XLSX_ONLY = { onchannel: true };
  // 도매처 양식의 열 이름 → 넣을 값 (정확한 이름이 없으면 비슷한 말로 찾음). 못 찾으면 null = 빈칸 (화면에 빨간색으로 알려 줌)
  function fieldFor(c, cols) {
    const hasDetail = (cols || []).some((x) => /상세주소|나머지주소|주소2/.test(String(x).replace(/\s/g, "")));
    if (FIELD[c] && !(c === "주소" && hasDetail)) return FIELD[c];
    const k = String(c).replace(/\s|\(.*?\)|\*|필수|선택/g, "");
    if (/상품(코드|번호)|품번|상품id/i.test(k)) return (l) => l.product_no;
    if (/옵션.*(수량)|주문수량|^수량|구매수량|개수/.test(k)) return (l) => l.qty;
    if (/옵션/.test(k)) return (l) => l.option || "";
    if (/(받는|수령|수취|수하|배송받)/.test(k) && /(이름|명|인|사람|자|분|성함)$/.test(k)) return (l) => l.receiver;
    if (/(휴대|핸드폰|폰|연락처|전화)/.test(k) && !/(추가|비상|2)/.test(k)) return (l) => l.phone;
    if (/(추가|비상|보조).*(연락|전화)|전화2|연락처2/.test(k)) return () => "";
    if (/우편|zip/i.test(k)) return (l) => l.zip;
    if (/상세주소|나머지주소|주소2/.test(k)) return (l) => l.addr2;
    if (/주소/.test(k)) return (l) => (hasDetail ? l.addr1 : l.addr);
    if (/(배송|요청|전달).*(메시지|메세지|메모|사항)|메시지|메세지|배송메모/.test(k)) return memoWithId;
    if (/(주문|관리|원장).*(번호|코드)|주문id/i.test(k)) return (l) => l.orderId;
    if (/(판매사|셀러).*메모|관리메모/.test(k)) return (l) => "담Go사Go " + l.orderId;
    if (/쇼핑몰|판매처|마켓명/.test(k)) return () => "담Go사Go";
    if (/상품명|제품명/.test(k)) return (l) => l.name.replace(/ \[.*\]$/, "");
    if (/배송비.*(유형|방식|결제)|결제방식/.test(k)) return () => "선불";
    if (/통관|생년월일|국제/.test(k)) return () => "";
    return null;
  }
  function poSheet(src) {
    const g = (D.po || []).find((x) => x.source === src); if (!g) return;
    const my = (D.mysheets || {})[src];  // 관리자가 올린 도매처 공식 양식 (있으면 우선)
    const cols = (my && my.cols) || (D.sheets || {})[src] || SHEET_DEFAULT;
    const miss = cols.filter((c) => !fieldFor(c, cols));
    if (miss.length && !confirm(`이 양식에서 자동으로 못 채우는 칸이 있어요: ${miss.join(", ")}\n빈칸으로 받을까요? (받은 뒤 엑셀에서 채워 주세요)`)) return;
    const val = (c, l) => { const f = fieldFor(c, cols), v = f ? f(l) : ""; return NO_COMMA[src] ? String(v ?? "").replace(/,/g, " ") : v; };
    const rows = [cols, ...g.lines.map((l) => cols.map((c) => val(c, l)))], fn = `${g.name}_대량주문서_${new Date().toISOString().slice(0, 10)}`;
    const ext = (my && my.ext) || (XLSX_ONLY[src] ? "xlsx" : "csv");
    ext === "xlsx" ? xlsxDown(rows, fn + ".xlsx") : csvDown(rows, fn + ".csv");
    // 주문서를 받은 주문은 손님이 '자동 즉시 환불'로 취소하지 못하게 표시 (도매처에 이미 주문했을 수 있음)
    call("/admin/po-mark", { ids: [...new Set(g.lines.map((l) => l.orderId))] }).catch(() => {});
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
      const m = all.match(/T\d{6}-?[A-Z0-9]{6}/); if (!m) continue;
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

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "m-q" && CUST) { const v = ev.target.value.trim().toLowerCase(), dv = v.replace(/\D/g, ""); $("#m-list").innerHTML = memTable((CUST.members || []).filter((m) => (m.name || "").toLowerCase().includes(v) || (m.email || "").toLowerCase().includes(v) || (dv && (m.phone || "").replace(/\D/g, "").includes(dv)))); }
    if (ev.target.id === "c-q" && CUST) { const v = ev.target.value.trim(), dv = v.replace(/\D/g, ""); $("#c-list").innerHTML = custTable(CUST.customers.filter((c) => c.name.includes(v) || (dv && c.phone.includes(dv)))); }
  });
  // ── 모든 목록 표 쪽 나누기: 줄이 많으면 자동으로 [한 쪽에 N개] + 쪽 이동 (설정은 이 브라우저에 기억) ──
  const PG = { size: +(localStorage.getItem("adm_pg") || 20), page: {} };
  function autoPage() {
    const view = $("#adm-view"); if (!view) return;
    view.querySelectorAll("table.adm-table:not([data-nopage])").forEach((t, ti) => {
      const rows = [...t.querySelectorAll("tr")].filter((r) => !r.querySelector("th"));
      const key = tab + ":" + ti, old = t.nextElementSibling && t.nextElementSibling.classList.contains("adm-pager") ? t.nextElementSibling : null;
      if (rows.length <= Math.min(PG.size, 10) && !old) return;
      const size = PG.size, pages = Math.max(1, Math.ceil(rows.length / size));
      let pg = Math.min(PG.page[key] || 1, pages); PG.page[key] = pg;
      rows.forEach((r, i) => { r.style.display = i >= (pg - 1) * size && i < pg * size ? "" : "none"; });
      const sig = `${rows.length}|${size}|${pg}`;
      if (old && old.dataset.sig === sig) return;  // 바뀐 게 없으면 다시 그리지 않음 (무한 반복 방지)
      const nav = old || Object.assign(document.createElement("div"), { className: "adm-pager" });
      nav.dataset.sig = sig;
      nav.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0 0;font-size:13px";
      nav.innerHTML = `<span class="muted">총 ${rows.length.toLocaleString()}개 · 한 쪽에</span><select data-pgsize style="width:auto;height:30px">${[10, 20, 50, 100, 200].map((n) => `<option${n === size ? " selected" : ""}>${n}</option>`).join("")}</select><span class="muted">개</span>
        <span style="margin-left:auto;display:flex;gap:4px;align-items:center"><button class="ghost" data-pg="1" ${pg === 1 ? "disabled" : ""}>«</button><button class="ghost" data-pg="${pg - 1}" ${pg === 1 ? "disabled" : ""}>‹ 이전</button>
        <span class="muted">${pg} / ${pages} 쪽</span><button class="ghost" data-pg="${pg + 1}" ${pg === pages ? "disabled" : ""}>다음 ›</button><button class="ghost" data-pg="${pages}" ${pg === pages ? "disabled" : ""}>»</button></span>`;
      nav.dataset.key = key;
      if (!old) t.after(nav);
    });
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest(".adm-pager [data-pg]"); if (!b || b.disabled) return;
    PG.page[b.closest(".adm-pager").dataset.key] = +b.dataset.pg; autoPage();
  });
  document.addEventListener("change", (ev) => {
    if (!ev.target.matches(".adm-pager [data-pgsize]")) return;
    PG.size = +ev.target.value; PG.page = {}; try { localStorage.setItem("adm_pg", PG.size); } catch (e) {} autoPage();
  });
  new MutationObserver(() => { clearTimeout(autoPage._t); autoPage._t = setTimeout(autoPage, 30); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("change", (ev) => {  // 주문 일괄 선택 (전체 선택은 지금 보이는 쪽만)
    if (ev.target.id === "ob-all") document.querySelectorAll(".ob-chk").forEach((c) => { if (c.closest("tr").style.display !== "none") c.checked = ev.target.checked; });
    if (ev.target.id === "ob-all" || ev.target.classList.contains("ob-chk")) { const n = $("#ob-n"); if (n) n.textContent = document.querySelectorAll(".ob-chk:checked").length; }
  });
  document.addEventListener("change", (ev) => { if (ev.target.id === "trk-file" && ev.target.files[0]) $('[data-act="trk-import"]')?.click(); });
  document.addEventListener("change", async (ev) => {  // 도매처 양식 올리기: 첫 줄(열 이름)만 읽어 저장
    if (ev.target.id !== "sheet-file" || !ev.target.files[0]) return;
    const f = ev.target.files[0], src = ev.target.dataset.src;
    try {
      let rows;
      if (/\.csv$/i.test(f.name)) rows = (await f.text()).replace(/^\ufeff/, "").split(/\r?\n/).map((r) => r.split(",").map((x) => x.replace(/^"|"$/g, "").trim()));
      else { const X = await loadXLSX(); const wb = X.read(await f.arrayBuffer(), { type: "array" }); rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" }); }
      const head = (rows.find((r) => r.filter((x) => String(x).trim()).length >= 3) || []).map((x) => String(x).trim()).filter(Boolean);
      if (head.length < 3) { alert("양식의 열 이름(첫 줄)을 찾지 못했어요. 도매처에서 받은 양식 파일 그대로 올려 주세요."); return; }
      const miss = head.filter((c) => !fieldFor(c, head));
      if (!confirm(`${SUP[src].n} 양식: ${head.length}개 열을 찾았어요.\n${head.join(" · ")}${miss.length ? `\n\n자동으로 못 채우는 칸(빈칸으로 나감): ${miss.join(", ")}` : "\n\n모든 칸을 자동으로 채울 수 있어요."}\n\n이 양식으로 저장할까요?`)) return;
      alert((await call("/admin/sheet-save", { src, cols: head, ext: /\.csv$/i.test(f.name) ? "csv" : "xlsx", name: f.name })).message); load();
    } catch (e) { alert("양식을 읽지 못했어요: " + e.message); }
  });  // 엑셀 고르면 바로 넣기
  document.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "o-q") $('[data-act="o-search"]')?.click(); });
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; return paint(); }
    const f = ev.target.closest("[data-filter]"); if (f) { orderFilter = f.dataset.filter; return paint(); }
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id, key = b.dataset.key, row = b.closest("tr");
    try {
      if (act === "export") return exportCsv();
      if (act === "soldout-cancel") {
        if (!confirm("도매처 품절로 이 주문을 취소하고 전액 환불할까요? 손님께 사과 안내가 자동으로 가요.")) return;
        const r = await safeCall("/admin/soldout-cancel", { orderId: id }); if (r) alert(r.message); return load();
      }
      if (act === "backup") {
        const r = await fetch(API + "/admin/export", { method: "POST", headers: { Authorization: "Bearer " + encodeURIComponent(PW.trim()) } });
        if (!r.ok) { alert("백업을 받지 못했어요."); return; }
        const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `담Go사Go_백업_${new Date().toISOString().slice(0, 10)}.json`; a.click();
        return load();
      }
      if (act === "period") { period = b.dataset.p; A = null; return paint(); }
      if (act === "po-sheet") return poSheet(b.dataset.src);
      if (act === "p-pick") return prodForm(b.dataset.id);
      if (act === "o-search") { OQ = $("#o-q").value.trim(); OSEARCH = (await call("/admin/order-search", { q: OQ })).orders; return paint(); }
      if (act === "o-clear") { OQ = ""; OSEARCH = null; return paint(); }
      if (act === "c-orders") { OQ = b.dataset.phone; OSEARCH = (await call("/admin/order-search", { q: OQ })).orders; tab = "orders"; return paint(); }
      if (act === "bl-add" || act === "bl-quick" || act === "bl-del") {
        const phone = act === "bl-add" ? $("#bl-phone").value : b.dataset.phone;
        let reason = act === "bl-add" ? $("#bl-reason").value : "";
        if (act === "bl-quick") { reason = prompt("차단 사유 (선택)", ""); if (reason === null) return; }
        if (act === "bl-del" && !confirm("차단을 풀까요?")) return;
        alert((await call("/admin/block", { phone, reason, block: act !== "bl-del" })).message); CUST = null; return paint();
      }
      if (act === "seo-down") { seoDownload(b.dataset.fmt); return; }
      if (act === "sa-run") {
        let scope = $("#sa-scope").value;
        if (scope === "ids") { const ids = $("#sa-ids").value.split(/[\s,]+/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? "DM" + x : x)); if (!ids.length) { alert("상품코드를 넣어 주세요."); return; } scope = "ids:" + ids.join(","); }
        const m = b.dataset.m, lim = +$("#sa-limit").value || 20000;
        if (m === "apply" && !confirm(`SEO 자동 최적화를 적용할까요?\n(손으로 고친 상품은 건드리지 않고, 적용 전 값은 백업돼서 언제든 되돌릴 수 있어요)`)) return;
        alert((await call("/admin/seo-auto-req", { mode: m, scope, limit: lim })).message); return seoAutoPaint();
      }
      if (act === "sa-pg") { SA.page = +b.dataset.p; return saTable(); }
      if (act === "sa-undo") { if (!confirm(`${b.dataset.run} 실행으로 바뀐 SEO를 모두 되돌릴까요?`)) return; alert((await call("/admin/seo-restore", { run: b.dataset.run })).message); return seoAutoPaint(); }
      if (act === "pb") {
        const ids = $("#pb-ids").value; if (!ids.trim()) { alert("상품코드를 넣어 주세요."); return; }
        if (!confirm("선택한 작업을 적용할까요?")) return;
        alert((await call("/admin/product-bulk", { ids, action: b.dataset.a })).message); PEDITS = await call("/admin/product-edits"); prodEdited(); return;
      }
      if (act === "st-save") { alert((await call("/admin/site-save", { notice: $("#st-notice").value.trim(), notice_link: $("#st-link").value.trim() })).message); ALOG = null; return paint(); }
      if (act === "pe-img-add") { const u = $("#pe-img-url").value.trim(); if (!/^https:\/\//.test(u)) { alert("https:// 로 시작하는 사진 주소를 넣어 주세요."); return; } PSEL.imgs.push(u); $("#pe-img-url").value = ""; return peImgs(); }
      if (act === "pe-img-del") { PSEL.imgs.splice(+b.dataset.i, 1); return peImgs(); }
      if (act === "pe-img-mv") { const i = +b.dataset.i, j = i + +b.dataset.d; if (j < 0 || j >= PSEL.imgs.length) return; [PSEL.imgs[i], PSEL.imgs[j]] = [PSEL.imgs[j], PSEL.imgs[i]]; return peImgs(); }
      if (act === "pe-opt-add") { PSEL.opts.push({ v: "", add: 0, so: false }); return peOpts(); }
      if (act === "pe-opt-del") { PSEL.opts.splice(+b.dataset.i, 1); return peOpts(); }
      if (act === "pe-d-text") { const t = prompt("추가할 글"); if (t) peInsert(`<p>${esc(t)}</p>`); return; }
      if (act === "pe-d-del") { if (!PSEL.selImg) { alert("지울 사진을 먼저 눌러 선택해 주세요."); return; } const p = PSEL.selImg.parentElement; PSEL.selImg.remove(); if (p && p !== $("#pe-detail") && !p.textContent.trim() && !p.querySelector("img")) p.remove(); PSEL.selImg = null; return; }
      if (act === "pe-d-bold") { document.execCommand("bold"); return; }
      if (act === "pe-d-html") { const d = $("#pe-detail"), ta = $("#pe-detail-html"); if (ta.style.display === "none") { ta.value = d.innerHTML; ta.style.display = ""; d.style.display = "none"; } else { d.innerHTML = ta.value; ta.style.display = "none"; d.style.display = ""; } return; }
      if (act === "pe-d-orig") { const o = (await call("/admin/product-get", { id: PSEL.id })).orig; if (o && confirm("상세페이지를 도매처 원본으로 바꿀까요? (저장해야 반영돼요)")) $("#pe-detail").innerHTML = peClean(o.detail_html); return; }
      if (act === "p-save" || act === "p-reset") {
        const pid = b.dataset.id;
        if (act === "p-reset" && !confirm("고친 내용을 지우고 원래대로 되돌릴까요?")) return;
        const c = (PSEL && PSEL.cur) || {}, fields = {};
        if (act === "p-save") {  // 원래 값과 다른 것만 저장
          const v = { name: $("#pe-name").value.trim(), price: $("#pe-price").value, category: $("#pe-cat").value, summary: $("#pe-sum").value.trim(), badge: $("#pe-badge").value };
          for (const k of Object.keys(v)) if (String(v[k]) !== String(c[k] ?? "")) fields[k] = v[k];
          if ($("#pe-sold").checked) fields.soldout = true;
          if ($("#pe-hide").checked) fields.hidden = true;
        }
        const big = {};
        if (act === "p-save" && PSEL) {
          const ta = $("#pe-detail-html"); if (ta.style.display !== "none") $("#pe-detail").innerHTML = ta.value;
          $("#pe-detail").querySelectorAll("img").forEach((x) => (x.style.outline = ""));
          const html = $("#pe-detail").innerHTML;
          if (html !== PSEL.html0) big.detail_html = html;
          if (JSON.stringify(PSEL.imgs) !== PSEL.imgs0) big.images = PSEL.imgs;
          const opts = PSEL.opts.filter((o) => String(o.v).trim());
          if (JSON.stringify(opts) !== PSEL.opts0 || $("#pe-optname").value.trim() !== PSEL.optName) { big.options = opts; big.option_name = $("#pe-optname").value.trim(); }
          const low = opts.filter((o) => PSEL.floor && (+fields.price || +c.price) + o.add < PSEL.floor);
          if (fields.price && PSEL.floor && +fields.price < PSEL.floor && !confirm(`판매가가 손해 안 나는 최저가(${won(PSEL.floor)})보다 낮아요. 최저가로 저장돼요. 계속할까요?`)) return;
          if (low.length && !confirm(`옵션 ${low.length}개의 가격이 최저가보다 낮아 자동으로 올려서 저장돼요. 계속할까요?`)) return;
          if (!Object.keys(fields).length && !Object.keys(big).length) { alert("바뀐 내용이 없어요."); return; }
        }
        const r = await call("/admin/product-save", { id: pid, fields, big, reset: act === "p-reset" });
        PEDITS = await call("/admin/product-edits").catch(() => PEDITS);
        alert(r.message); prodEdited(); if (act === "p-reset") { $("#p-edit").style.display = "none"; PSEL = null; } return;
      }
      if (act === "po-nos") { const g = (D.po || []).find((x) => x.source === "domeme"); await navigator.clipboard.writeText([...new Set(g.lines.map((l) => l.product_no))].join(",")); alert("상품번호를 복사했어요. 도매매 ‘일괄주문서작성’의 상품번호 칸에 붙여넣으세요. (1회 30개까지)"); return; }
      if (act === "po-done") {
        const g = (D.po || []).find((x) => x.source === b.dataset.src);
        if (!g || !confirm(`${g.name} ${g.lines.length}건을 발주 완료로 표시할까요? (도매처 결제까지 끝낸 뒤 눌러 주세요)`)) return;
        alert((await call("/admin/po-done", { items: g.lines.map((l) => ({ orderId: l.orderId, idx: l.idx })) })).message); return load();
      }
      if (act === "cl-step") { await call("/admin/claim-step", { orderId: b.dataset.id, step: b.dataset.step, undo: !!b.dataset.undo }); return load(); }
      if (act === "trk-file-up") { $("#trk-file").click(); return; }
      if (act === "ob-apply") {
        const ids = [...document.querySelectorAll(".ob-chk:checked")].map((x) => x.value), st = $("#ob-status").value;
        if (!ids.length) { alert("바꿀 주문을 먼저 체크해 주세요."); return; }
        if (!st) { alert("바꿀 상태를 골라 주세요."); return; }
        if (!confirm(`선택한 ${ids.length}건을 ‘${st}’(으)로 바꿀까요?`)) return;
        const r = await call("/admin/order-bulk", { ids, status: st });
        alert(r.message); return load();
      }
      if (act === "sheet-up") { const f = $("#sheet-file"); f.dataset.src = b.dataset.src; f.value = ""; f.click(); return; }
      if (act === "sheet-reset") { if (!confirm("올린 양식을 지우고 기본 양식으로 돌릴까요?")) return; await call("/admin/sheet-save", { src: b.dataset.src, reset: true }); return load(); }
      if (act === "open-url") { window.open(b.dataset.url, "_blank", "noopener"); return; }
      if (act === "trk-wait") {  // 송장 기다리는 주문 목록 (도매처 사이트에서 찾기 쉽게)
        const src = b.dataset.src, rows = [["우리 주문번호", "도매처 상품번호", "상품명", "수량", "받는 분", "연락처", "발주일"]];
        for (const o of D.orders.filter((o) => o.status === "상품준비중" && !o.tracking)) for (const l of o.lines) if (SRC(l.id) === src) rows.push([o.orderId, l.source_no || String(l.id).replace(/^DM/, ""), l.name, l.qty, o.customer?.name || "", o.customer?.phone || "", (l.po || "").slice(0, 10)]);
        const csv = "\ufeff" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `송장대기_${SUP[src].n}_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); return;
      }
      if (act === "po-check") { b.disabled = true; b.textContent = "확인 중…"; try { const r = await call("/admin/po-check"); alert(r.bad ? `⚠️ 문제 ${r.bad}건을 찾았어요. 표의 빨간 줄을 확인해 주세요.` : "확인했어요. 표의 '도매처 확인' 칸을 보세요."); } catch (e) { alert(e.message); } return load(); }
      if (act === "oc-trk") { b.disabled = true; b.textContent = "가져오는 중…"; try { alert((await call("/admin/oc-tracking-sync")).message); } catch (e) { alert(e.message); } return load(); }
      if (act === "trk-import") {
        let text = $("#trk-paste").value;
        const f = $("#trk-file").files[0];
        if (f && /\.xlsx?$/i.test(f.name)) {  // 도매처 엑셀 그대로
          const X = await loadXLSX().catch((e) => { alert(e.message); return null; }); if (!X) return;
          const wb = X.read(await f.arrayBuffer(), { type: "array" });
          for (const n of wb.SheetNames) text += "\n" + X.utils.sheet_to_csv(wb.Sheets[n], { FS: "\t" });
        } else if (f) text += "\n" + (await f.text());
        const rows = parseTracking(text);
        if (!rows.length) { $("#trk-result").textContent = "주문번호(T로 시작)와 송장번호가 있는 줄을 찾지 못했어요."; return; }
        const r = await call("/admin/tracking-import", { rows });
        $("#trk-result").textContent = r.message; return load();
      }
      if (act === "kakao-connect") {
        location.href = (await call("/admin/kakao-start")).url;
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
      if (act === "claim-photo") {
        const w = window.open("", "_blank");
        const r = await call("/admin/claim-photo", { orderId: id, i: b.dataset.i });
        if (w) { w.document.title = id + " 사진"; w.document.body.style.margin = "0"; w.document.body.innerHTML = `<img src="${r.data}" style="max-width:100%;display:block;margin:auto">`; }
        return;
      }
      if (act === "order-refund") {
        const sug = b.dataset.refund;  // 단순 변심 반품: 배송비 뺀 금액 미리 채움
        const amt = prompt(sug != null ? `단순 변심 반품이에요. 배송비 ${Number(b.dataset.deduct).toLocaleString()}원을 뺀 금액이 채워져 있어요. 확인 후 진행하세요. (비우면 전액 환불)` : "환불할 금액을 입력하세요. 비워 두면 전액 환불돼요.", sug ?? "");
        if (amt === null) return;
        if (!confirm("결제가 실제로 취소돼요. 진행할까요?")) return;
        if (!(await safeCall("/admin/order-cancel", { orderId: id, amount: amt.replace(/\D/g, ""), reason: "판매자 환불" }))) return;
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
    PW = $("#admin-pw").value; sessionStorage.setItem("admin_pw", PW); try { localStorage.setItem("is_admin", "1"); } catch (e) {}
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
  { const km = new URLSearchParams(location.search).get("kakao"); if (km) { history.replaceState(null, "", location.pathname); setTimeout(() => alert(km === "ok" ? "카카오톡 알림이 연결됐어요. ‘나와의 채팅’에 테스트 알림을 보냈어요." : km), 300); } }
  const kcode = new URLSearchParams(location.search).get("code");
  if (kcode) history.replaceState(null, "", location.pathname);
  if (PW && API) load().then(async () => {
    if (!kcode) return;
    try { alert((await call("/admin/kakao-connect", { code: kcode, redirect_uri: kakaoRedirect() })).message); await load(); } catch (e) { alert(e.message); }
  }).catch(() => { if (kcode) alert("관리자 로그인 후 ‘카카오톡 연결하기’를 다시 눌러 주세요."); });
})();
