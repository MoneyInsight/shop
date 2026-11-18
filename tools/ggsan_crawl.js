// 건강산(ggsan.com) 상품 읽기 — 대표님 로그인된 브라우저(ggsan.com 페이지)에서 실행.
// 끝나면 ggsan_products_latest.json 을 다운로드 폴더에 저장 → tools/ggsan_convert.py 가 사이트용 CSV로 변환
// 사용: 이 파일 내용을 그대로 javascript_tool 로 실행 → window.__gsState 가 'done' 이 될 때까지 기다림
(async () => {
  window.__gsState = "running";
  const CMT = /cmtstory/.test(location.host);  // 화장품스토리(같은 회사 건강산의 화장품 도매몰)
  const keep = CMT ? { "001": "토너/세럼", "002": "마스크/팩", "003": "바디/헤어", "004": "크림", "005": "선케어", "006": "맨즈케어", "007": "클렌징", "008": "홈/프래그런스" } : { "001": "장건강", "002": "눈건강", "003": "간건강", "005": "혈행건강", "006": "관절/뼈건강", "007": "다이어트/뷰티", "008": "비타민/미네랄", "009": "건강기능식품기타", "011": "전립선건강", "018": "반려동물용품", "021": "생활/뷰티" };
  const ids = {};
  for (const [c, n] of Object.entries(keep)) {
    for (let p = 1; p < 40; p++) {
      const h = await fetch(`/goods/goods_list.php?cateCd=${c}&page=${p}&pageNum=100`).then((r) => r.text());
      let add = 0;
      for (const m of new Set([...h.matchAll(/goodsNo=(\d+)/g)].map((m) => m[1]))) if (!ids[m]) { ids[m] = n; add++; }
      if (!add) break;
    }
  }
  const out = [], num = (s) => (s ? Number(String(s).replace(/[^\d]/g, "")) : 0);
  async function one([no, cat]) {
    try {
      const h = await fetch("/goods/goods_view.php?goodsNo=" + no).then((r) => r.text());
      const d = new DOMParser().parseFromString(h, "text/html");
      if (!d.querySelector(".item_info_box")) throw new Error("로그인 필요");
      const box = d.querySelector(".item_info_box").innerText.replace(/\s+/g, " ");
      const s = ((d.querySelector(".detail_cont") || {}).innerText || "").replace(/\s+/g, " ");
      const name = (d.querySelector(".item_detail_tit h3")?.innerText || d.querySelector(".item_detail_tit")?.innerText || "").replace(/\s+/g, " ").replace(/공유.*$/, "").trim();
      const mm = s.match(/(?:준수|최저가)\D{0,10}?1\s*(?:개|통|박스|세트|병|팩)\s*:?\s*([\d,]{4,})\s*원/) || s.match(/준수\s*:?\s*([\d,]{4,})\s*원/) || s.match(/([\d,]{4,})\s*원\s*(?:\([^)]{0,25}\))?\s*이상\s*판매/) || s.match(/준수[^\d]{0,25}([\d,]{4,})\s*원/);
      const imgs = [...new Set([...d.querySelectorAll(".item_photo_big img, .slider_goods_nm img")].map((x) => x.getAttribute("src")).filter((x) => x && /goods\/\d+\/image/.test(x)))];
      out.push({ no, cat, name, fixed: num((box.match(/정가\s*([\d,]+)원/) || [])[1]), price: num((box.match(/판매가\s*([\d,]+)원/) || [])[1]),
        ship: num((box.match(/배송비\s*([\d,]+)원/) || [])[1]), so: !!d.querySelector(".btn_add_soldout"),
        img: d.querySelector('meta[property="og:image"]')?.content || imgs[0] || "", imgs,
        det: [...d.querySelectorAll(".detail_cont img, #detail .txt-manual img")].map((x) => x.getAttribute("src")).filter(Boolean),
        min: mm ? num(mm[1]) : 0, imm: /임박|반품\s*불가/.test(s + name) });
    } catch (e) { out.push({ no, cat, err: String(e) }); }
  }
  const Q = Object.entries(ids);
  window.__gsTotal = Q.length;
  window.__gsOut = out;
  await Promise.all(Array.from({ length: 6 }, async () => { while (Q.length) await one(Q.shift()); }));
  const ok = out.filter((x) => !x.err).length;
  if (ok < (CMT ? 50 : 300)) { window.__gsState = "fail: 읽은 상품 " + ok + "개 (로그인 확인)"; return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
  a.download = CMT ? "cmtstory_products_latest.json" : "ggsan_products_latest.json";
  document.body.appendChild(a); a.click();
  window.__gsState = "done " + ok + "/" + out.length;
})();
