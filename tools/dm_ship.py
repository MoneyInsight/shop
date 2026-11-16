"""도매매 배송비 규칙 해석 (공급 배송정보 deli.supply)
반환: (배송비, 묶음수량) — 묶음수량 "" = 주문당 1번, N = N개마다 1번
- 고정배송비: (fee, "")
- 수량별비례 "50+3000|50+3000": 50개마다 3,000원 → (3000, 50)  (여러 칸이면 가장 비싼 배송비·가장 작은 묶음으로 = 손해 없는 쪽)
- 수량별차등 "1+3000|41+6000|100+9000": 1~40개 3,000원, 41~99개 6,000원 … → 40개마다 3,000원으로 계산 (실제보다 같거나 많게)
- 무료: (0, "")
"""


def parse(sup):
    t = str(sup.get("type") or "")
    if "무료" in t:
        return 0, ""
    def n(x):
        try:
            return int(float(str(x).replace(",", "")))
        except Exception:
            return 0
    if t == "고정배송비":
        return n(sup.get("fee")), ""
    tiers = []
    for seg in str(sup.get("tbl") or "").split("|"):
        if "+" in seg:
            a, b = seg.split("+", 1)
            tiers.append((n(a), n(b)))
    if t == "수량별비례" and tiers:
        return max(f for _, f in tiers), max(1, min(q for q, _ in tiers))
    if t == "수량별차등" and tiers:
        tiers.sort()
        first = tiers[0][1] or max(f for _, f in tiers)
        nxt = next((q for q, _ in tiers[1:] if q > tiers[0][0]), 0)
        return first, max(1, nxt - 1) if nxt else ""
    fee = n(sup.get("fee"))
    return fee, (1 if fee else "")  # 모르는 방식: 1개마다 (손해 방지)
