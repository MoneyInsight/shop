// 온채널 매일 점검용 — 내장 브라우저(온채널 로그인 상태)의 onch3.co.kr 페이지에서 실행
// 사용: 이 파일 내용을 붙여넣은 뒤 마지막 줄을 바꿔 가며 실행
//   await ONCH("collect")  → 우리 사이트의 온채널 상품코드 + 온채널 신상품(최근 80페이지) 모으기
//   await ONCH("request")  → 500개씩 스마트스토어 엑셀 요청 (35초씩, 남은 묶음 수를 돌려줌 → 0 될 때까지 반복)
//   await ONCH("urls")     → 이번에 만든 엑셀 파일 주소 목록
window.ONCH = async (step) => {
  const LS = localStorage, now = Date.now();
  if (step === "collect") {
    const mine = await (await fetch("https://moneyinsight.github.io/shop/onch_codes.json?" + now)).json();
    const S = new Set(mine);
    const base = "/dbcenter_renewal/index.php?cate_f=생활/건강&cate_s=문구/사무용품&orderby=agree_desc&page=";
    for (let p = 1; p <= 80; p += 10) {
      const rs = await Promise.all([...Array(10)].map((_, k) => fetch(base + (p + k)).then((r) => r.text()).catch(() => "")));
      for (const h of rs) for (const c of h.match(/CH\d{5,}/g) || []) S.add(c);
    }
    LS.__oc = JSON.stringify([...S]); LS.__ocdone = "[]"; LS.__ocstart = String(now);
    return { mine: mine.length, total: S.size, batches: Math.ceil(S.size / 500) };
  }
  if (step === "request") {
    const C = JSON.parse(LS.__oc), D = new Set(JSON.parse(LS.__ocdone)), n = Math.ceil(C.length / 500);
    const send = async (arr) => (await fetch("/dbcenter_renewal/process/excel_download_access.php", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ sel_op: "1", sear_choice: "", my_frm_download: "1107", cate_sec: "smartstore",
        list_count: new URLSearchParams(arr.map((c) => ["list_countArr", c])).toString(), filename: "scream0506" }) })).text();
    while (Date.now() - now < 35000) {
      const i = [...Array(n).keys()].find((k) => !D.has(k)); if (i === undefined) break;
      const r = await send(C.slice(i * 500, i * 500 + 500));
      if (r.includes("true")) { D.add(i); LS.__ocdone = JSON.stringify([...D]); }
      else if (!r.includes("생성 중")) return { error: r.slice(0, 200) };
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    return { left: n - D.size };
  }
  if (step === "urls") {
    const d = new DOMParser().parseFromString(await (await fetch("/mypage/excel_download_stat.php")).text(), "text/html");
    const start = +LS.__ocstart, rows = [...d.querySelectorAll("tr")].slice(1);
    const pick = rows.filter((r) => { const m = r.textContent.match(/(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/); return m && new Date(m[1].replace(" ", "T") + "+09:00").getTime() >= start - 60000; });
    return { ok: pick.filter((r) => /성공/.test(r.textContent)).map((r) => r.querySelector("[data-url]")?.dataset.url).filter(Boolean),
      waiting: pick.filter((r) => !/성공|실패/.test(r.textContent)).length, failed: pick.filter((r) => /실패/.test(r.textContent)).length,
      expected: Math.ceil(JSON.parse(LS.__oc).length / 500) };
  }
};
