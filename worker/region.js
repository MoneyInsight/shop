// 제주·도서산간 추가 배송비 (서버·사이트 같은 규칙)
export const DEFAULT_RULE = { jeju: 3000, island: 5000, jeju_zip: [[63000, 63644]], island_zip: [[40200, 40240], [23000, 23136]],
  island_words: ["울릉", "옹진군", "백령", "연평", "대청면", "덕적", "자월", "영흥면", "신안군", "흑산", "가거도", "홍도", "비금", "도초", "하의", "장산", "안좌", "임자면", "조도면", "청산면", "보길", "노화", "소안", "금일", "생일면", "금당", "욕지", "한산면", "사량", "추도", "거문도", "삼산면", "초도", "손죽", "위도면", "어청도", "가파", "마라", "추자", "우도"] };
export function regionFee(zip, addr, rule = DEFAULT_RULE) {
  const z = parseInt(String(zip || "").replace(/\D/g, "")) || 0, a = String(addr || "");
  const inR = (rs) => (rs || []).some(([lo, hi]) => z >= lo && z <= hi);
  const island = inR(rule.island_zip) || (rule.island_words || []).some((w) => a.includes(w));
  const jeju = inR(rule.jeju_zip) || /^제주/.test(a.trim());
  if (jeju && /추자|우도|가파|마라/.test(a)) return { fee: rule.jeju + rule.island, label: "제주 섬 지역" };
  if (jeju) return { fee: rule.jeju, label: "제주" };
  if (island) return { fee: rule.island, label: "도서산간" };
  return { fee: 0, label: "" };
}
