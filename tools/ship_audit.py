"""배송비 손해 점검: 모든 상품 × 1~10개 구매 시 순마진(8% 이상)과, 도매처가 개당 배송비를 받는 최악의 경우 손해 여부 — python3 tools/ship_audit.py"""
import csv,json,glob
P=json.load(open('config.json'))['pricing']
rows={}
for f in glob.glob('data/*.csv'):
    for r in csv.DictReader(open(f,encoding='utf-8-sig')):
        if r.get('공급가'): rows[r['상품코드']]=r
prods={p['id']:p for p in json.load(open('site/products.json'))}
def net(rev,cost): return rev-rev*P['card_fee']-(rev-cost)/11-cost-P['ops_cost_won']
bad=[];worst=[];n_check=0;types={}
for pid,p in prods.items():
    r=rows.get(pid)
    if not r: continue
    g=int(float(r['공급가']));sh=int(float(r.get('공급 배송비') or 0));bq=r.get('묶음배송수량') or ''
    k=max(1,int(bq)) if bq else 1
    if sh>3500: k=1
    t='무료' if not sh else ('묶음%d'%k if k>1 else '개당')
    types[t.split('묶음')[0] or '묶음']=types.get(t.split('묶음')[0] or '묶음',0)+1
    qt=p.get('qt') or [int(p['price'])]
    for n in range(1,11):
        u=qt[min(n,len(qt))-1]; rev=u*n
        cost=g*n+sh*(-(-n//k)); n_check+=1
        m=net(rev,cost)/cost
        if m<0.079: bad.append((pid,n,round(m*100,1)))
        if net(rev,g*n+sh*n)<0: worst.append((pid,n))
print('배송 유형별 상품 수:',types)
print('검사',len(prods),'개 ×1~10개 =',n_check,'건 / 순마진 8% 미만:',len(bad),bad[:5])
print('묶음 정보가 틀려 개당 배송비가 나오면 손해:',len(worst),'건,',len({w[0] for w in worst}),'개 상품')
