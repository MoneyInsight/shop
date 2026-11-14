"""손해 점검: 모든 상품 × 1~10개 구매 시 순마진(8% 이상) — python3 tools/ship_audit.py
배송비는 손님이 따로 냄 (도매처 배송 규칙 그대로: sn=0 같은 상품 주문당 1번, sn=N N개마다).
- 순마진 = (상품값+받은 배송비) − 카드수수료 − 부가세차액 − (공급가+도매처 배송비) − 운영비, 공급가+배송비 대비 8% 이상
- 최악의 경우: 배송 규칙을 확인하지 못한 도매처가 실제로는 1개마다 배송비를 받으면 손해인지
  (확인됨: 온채널 CH — 발주 화면 계산으로 같은 상품 주문당 1번 / 도매매 DM 고정배송비 — 상품 페이지 '주문시결제' 고정)
"""
import csv, json, glob, math
P = json.load(open('config.json'))['pricing']
rows = {}
for f in glob.glob('data/*.csv'):
    for r in csv.DictReader(open(f, encoding='utf-8-sig')):
        if r.get('공급가'):
            rows[r['상품코드']] = r
prods = {p['id']: p for p in json.load(open('site/products.json'))}
VERIFIED = ("CH", "DM")


def net(rev, cost):
    return rev - rev * P['card_fee'] - (rev - cost) / 11 - cost - P['ops_cost_won']


def ship(fee, sn, units):
    return 0 if not fee else (fee * math.ceil(units / sn) if sn else fee)


bad, worst, n_check, types = [], [], 0, {}
for pid, p in prods.items():
    r = rows.get(pid)
    if not r:
        continue
    pk = int(p.get('pk') or 1)
    g = int(float(r['공급가'])) * pk
    sh = int(float(r.get('공급 배송비') or 0))
    fee, sn = int(p.get('shipping_fee') or 0), int(p.get('sn') or 0)
    if fee != sh:
        bad.append((pid, 0, '받는 배송비가 도매처와 다름')); continue
    t = '무료' if not sh else ('주문당1번' if not sn else '개당' if sn == 1 else '묶음')
    types[t] = types.get(t, 0) + 1
    qt = p.get('qt') or [int(p['price'])]
    mq = int(p.get('mq') or 1)  # 'N개부터 구매' 상품은 N개부터 검사
    for n in range(mq, mq + 10):
        u = qt[min(n, len(qt)) - 1]
        charged = ship(fee, sn, n * pk)
        rev = u * n + charged
        cost = g * n + ship(sh, sn, n * pk)
        n_check += 1
        m = net(rev, cost) / cost
        if m < 0.079:
            bad.append((pid, n, round(m * 100, 1)))
        if sh and not pid.startswith(VERIFIED) and net(rev, g * n + sh * n * pk) < 0:
            worst.append((pid, n))
print('배송 유형별 상품 수:', types)
print('검사', len(prods), '개 ×1~10개 =', n_check, '건 / 순마진 8% 미만:', len(bad), bad[:5])
print('묶음 정보가 틀려 개당 배송비가 나오면 손해:', len(worst), '건,', len({w[0] for w in worst}), '개 상품')
