// 온채널 매일 점검 — 내장 브라우저(온채널 로그인 상태)의 onch3.co.kr 페이지에서 실행
//   await ONCH("all")  → 바로 "started" 를 돌려주고 페이지 안에서 계속 진행 (진행 상황: localStorage.__onchlog)
//   그룹별로: 우리 사이트의 상품코드 + 온채널 신상품 모으기 → 500개씩 엑셀 요청 → 완성 대기 → 파일 이름을 서버에 전달
//   → 깃허브(onch_sync.yml)가 13:07에 내려받아 품절 내리기·가격 다시 계산·배포
const ONCH_GROUPS = {
  office: { codes: "onch_codes.json", lists: ["cate_f=생활/건강&cate_s=문구/사무용품&orderby=agree_desc"], pages: 80 },
  winter: { codes: "onch_codes_winter.json", pages: 3,
    lists: ["핫팩", "손난로", "방한", "장갑", "목도리", "넥워머", "귀마개", "털모자", "비니", "전기요", "전기매트", "온수매트", "히터", "난로", "난방", "담요",
      "극세사", "수면양말", "발열", "내복", "기모", "털슬리퍼", "방풍", "단열", "뽁뽁이", "가습기", "패딩", "롱패딩", "부츠", "크리스마스", "트리", "눈썰매", "스키", "보온", "온열", "무릎담요", "방한화", "바라클라바"]
      .map((k) => "keyword=" + encodeURIComponent(k)) },
};
window.ONCH = async (step, group = "office") => {
  const LS = localStorage, now = Date.now(), G = ONCH_GROUPS[group], K = (x) => `__oc_${group}_${x}`;
  if (step === "collect") {
    const mine = await (await fetch("https://moneyinsight.github.io/shop/" + G.codes + "?" + now)).json().catch(() => []);
    const S = new Set(mine), other = new Set();
    for (const [g, o] of Object.entries(ONCH_GROUPS)) if (g !== group) (await (await fetch("https://moneyinsight.github.io/shop/" + o.codes + "?" + now)).json().catch(() => [])).forEach((c) => other.add(c));
    for (const q of G.lists) {
      const rs = await Promise.all([...Array(G.pages)].map((_, k) => fetch(`/dbcenter_renewal/index.php?${q}&page=${k + 1}`).then((r) => r.text()).catch(() => "")));
      for (const h of rs) for (const m of h.matchAll(/value="(CH\d+)"/g)) if (!other.has(m[1])) S.add(m[1]);
    }
    LS[K("codes")] = JSON.stringify([...S]); LS[K("done")] = "[]"; LS[K("start")] = String(now);
    return { mine: mine.length, total: S.size, batches: Math.ceil(S.size / 500) };
  }
  if (step === "request") {
    const C = JSON.parse(LS[K("codes")]), D = new Set(JSON.parse(LS[K("done")])), n = Math.ceil(C.length / 500);
    const send = async (arr) => (await fetch("/dbcenter_renewal/process/excel_download_access.php", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ sel_op: "1", sear_choice: "", my_frm_download: "1107", cate_sec: "smartstore",
        list_count: new URLSearchParams(arr.map((c) => ["list_countArr", c])).toString(), filename: "scream0506" }) })).text();
    while (Date.now() - now < 35000) {
      const i = [...Array(n).keys()].find((k) => !D.has(k)); if (i === undefined) break;
      const r = await send(C.slice(i * 500, i * 500 + 500));
      if (r.includes("true")) { D.add(i); LS[K("done")] = JSON.stringify([...D]); }
      else if (!r.includes("생성 중")) return { error: r.slice(0, 200) };
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    return { left: n - D.size };
  }
  if (step === "urls") {  // 이 그룹 요청 시작 이후 만들어진 파일 (목록 여러 쪽 확인)
    const start = +LS[K("start")], ok = [], st = { waiting: 0, failed: 0 };
    for (let p = 1; p <= 20; p++) {
      const d = new DOMParser().parseFromString(await (await fetch("/mypage/excel_download_stat.php?page=" + p)).text(), "text/html");
      const rows = [...d.querySelectorAll("tr")].slice(1); let older = false;
      for (const r of rows) {
        const m = r.textContent.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/); if (!m) continue;
        if (new Date(m[1].replace(" ", "T") + "+09:00").getTime() < start - 60000) { older = true; continue; }
        if (/성공/.test(r.textContent)) { const u = r.querySelector("[data-url]")?.dataset.url; if (u && !ok.includes(u)) ok.push(u); }
        else if (/실패/.test(r.textContent)) st.failed++; else st.waiting++;
      }
      if (older || !rows.length) break;
    }
    return { ok, ...st, expected: Math.ceil(JSON.parse(LS[K("codes")]).length / 500) };
  }
};
window.ONCH_RUN = async (group) => {  // 한 그룹 끝까지 (다른 그룹과 섞이지 않게 차례로)
  const log = (m) => { localStorage.__onchlog = new Date().toISOString().slice(11, 19) + ` [${group}] ` + m; };
  log("collect " + JSON.stringify(await ONCH("collect", group)));
  for (let i = 0; i < 80; i++) { const r = await ONCH("request", group); if (r.error) throw new Error(r.error); log("request left " + r.left); if (!r.left) break; }
  let u;
  for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 15000)); u = await ONCH("urls", group); log(`urls ${u.ok.length}/${u.expected} wait ${u.waiting} fail ${u.failed}`); if (!u.waiting && u.ok.length + u.failed >= u.expected) break; }
  return { files: u.ok, expected: u.expected };
};
window.ONCH_ALL = async () => {
  const out = {};
  try {
    for (const g of Object.keys(ONCH_GROUPS)) out[g] = await ONCH_RUN(g);
    const r = await fetch("https://shop-api.scream0506.workers.dev/onch/files", { method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ key: localStorage.__onchkey, groups: out }) });
    localStorage.__onchlog = new Date().toISOString().slice(11, 19) + " sent " + (await r.text());
  } catch (e) { localStorage.__onchlog = new Date().toISOString().slice(11, 19) + " error " + e; }
};
const _ONCH = window.ONCH;
window.ONCH = async (step, group) => step === "all" ? (ONCH_ALL(), "started") : _ONCH(step, group);
