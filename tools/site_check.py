"""배포 전 사이트 점검 — 하나라도 틀리면 실패(종료코드 1)로 배포를 막음
사용: python3 tools/site_check.py   (build.py 다음에 실행)
점검: 템플릿 찌꺼기, 페이지별 필수 스크립트, 상품 페이지 구조, 공용 파일, 상품 데이터·가격, 용량
"""
import json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
errors, warns = [], []
err = lambda m: errors.append(m)

# 1) 템플릿 찌꺼기: 파이썬 f-string 이 덜 채워진 흔적 ({scripts}, {root} 등)
LEFT = re.compile(r"\{(scripts|root|body|top|bot|cfg_js|ASSET_V|title|desc|name|gnb|logo|verify|extra_head|canonical|og_img)\}")
pages = sorted(SITE.glob("*.html")) + sorted((SITE / "category").glob("*.html"))
for f in pages:
    t = f.read_text(encoding="utf-8")
    m = LEFT.search(t)
    if m:
        err(f"{f.relative_to(SITE)}: 템플릿 찌꺼기 {m.group(0)}")
    if "app.js" not in t:
        err(f"{f.relative_to(SITE)}: app.js 없음")

# 2) 페이지별 꼭 있어야 하는 것
NEED = {
    "admin.html": ["admin.js", 'id="admin-body"'],
    "checkout.html": ["js.tosspayments.com", "postcode.v2.js"],
    "index.html": ["mb-track", "SHOP_CFG"],
    "cart.html": ["SHOP_CFG"],
    "orders.html": ["SHOP_CFG"],
    "login.html": ["SHOP_CFG"],
    "search.html": ["SHOP_CFG"],
}
for page, keys in NEED.items():
    p = SITE / page
    if not p.exists():
        err(f"{page}: 페이지 없음"); continue
    t = p.read_text(encoding="utf-8")
    for k in keys:
        if k not in t:
            err(f"{page}: '{k}' 없음")

# 3) 공용 파일
ch = SITE / "chrome.js"
if not ch.exists():
    err("chrome.js 없음")
else:
    t = ch.read_text(encoding="utf-8")
    for k in ("window.SHOP_CFG=", "top()", "bot()", "g1:", "g2:", "g3:", "g4:", "worker_url"):
        if k not in t:
            err(f"chrome.js: '{k}' 없음")
    r = subprocess.run(["node", "--check", str(ch)], capture_output=True, text=True)
    if r.returncode:
        err("chrome.js 문법 오류: " + r.stderr[-200:])
for js in ("app.js", "admin.js", "sw.js"):
    r = subprocess.run(["node", "--check", str(SITE / js)], capture_output=True, text=True)
    if r.returncode:
        err(f"{js} 문법 오류: " + r.stderr[-200:])

# 3-2) 카테고리별 색인
L = SITE / "idx" / "list.json"
if not L.exists():
    err("idx/list.json 없음")
else:
    n = 0
    for c in json.loads(L.read_text()):
        f = SITE / "idx" / f"{c}.json"
        if not f.exists():
            err(f"idx/{c}.json 없음")
        else:
            n += len(json.loads(f.read_text(encoding="utf-8"))["items"])
    IDX_N = n

# 4) 상품 데이터·가격
ps = json.loads((SITE / "products.json").read_text(encoding="utf-8"))
ids = set()
for p in ps:
    pid, price = p["id"], int(p["price"])
    if pid in ids:
        err(f"{pid}: 상품번호 중복")
    ids.add(pid)
    if price <= 0:
        err(f"{pid}: 가격 0원")
    if p.get("mp") and price < int(p["mp"]):
        err(f"{pid}: 공급사 최저가 {p['mp']}원보다 쌈 ({price}원)")
    qt = p.get("qt") or []
    if qt:
        if qt[0] != price:
            err(f"{pid}: 1개 가격({qt[0]})과 판매가({price}) 다름")
        if any(b > a for a, b in zip(qt, qt[1:])):
            err(f"{pid}: 많이 살수록 비싸지는 수량 가격 {qt}")
        if p.get("mp") and min(qt) < int(p["mp"]):
            err(f"{pid}: 수량 할인가가 공급사 최저가 아래 {min(qt)}<{p['mp']}")
    if not p.get("image"):
        warns.append(f"{pid}: 대표 이미지 없음")
    if not p.get("category"):
        err(f"{pid}: 카테고리 없음")

if L.exists() and IDX_N != len(ps):
    err(f"색인 상품 수 {IDX_N} ≠ 전체 {len(ps)}")

# 5) 상품 페이지 (전부 훑음)
need_prod = ["chrome.js", "CH.top()", "CH.bot()", "data-qt=", 'id="buy"', "app.js", "application/ld+json"]
prod_dir = SITE / "product"
miss_page = miss_json = 0
for p in ps:
    f = prod_dir / f'{p["id"]}.html'
    if not f.exists():
        miss_page += 1; continue
    t = f.read_text(encoding="utf-8")
    bad = [k for k in need_prod if k not in t]
    m = LEFT.search(t)
    if bad or m:
        err(f'product/{p["id"]}.html: 빠짐 {bad} {m.group(0) if m else ""}')
    if not (SITE / "p" / f'{p["id"]}.json').exists():
        miss_json += 1
if miss_page:
    err(f"상품 페이지 없는 상품 {miss_page}개")
if miss_json:
    err(f"카드 정보(p/*.json) 없는 상품 {miss_json}개")

# 6) 순마진 8% 점검 (ship_audit)
r = subprocess.run([sys.executable, str(ROOT / "tools/ship_audit.py")], capture_output=True, text=True)
m = re.search(r"8% 미만: (\d+)", r.stdout)
if not m:
    err("마진 점검 실행 실패: " + (r.stderr or r.stdout)[-200:])
elif int(m.group(1)):
    err(f"순마진 8% 미만 {m.group(1)}건")
m = re.search(r"손해: (\d+) 건", r.stdout)
if m and int(m.group(1)):
    err(f"묶음 배송 가정 손해 {m.group(1)}건")

# 7) 용량 (깃허브 무료 호스팅 1GB)
size = sum(f.stat().st_size for f in SITE.rglob("*") if f.is_file()) / 1024 / 1024
if size > 980:
    err(f"사이트 용량 {size:.0f}MB — 1GB 한도 초과 위험")
elif size > 900:
    warns.append(f"사이트 용량 {size:.0f}MB — 한도(1GB) 가까움")

print(f"점검: 페이지 {len(pages)}개, 상품 {len(ps):,}개, 용량 {size:.0f}MB")
for w in warns[:10]:
    print("주의:", w)
if len(warns) > 10:
    print(f"주의: … 외 {len(warns) - 10}건")
if errors:
    print(f"❌ 문제 {len(errors)}건 — 배포 중단")
    for e_ in errors[:40]:
        print(" -", e_)
    sys.exit(1)
print("✅ 이상 없음")
