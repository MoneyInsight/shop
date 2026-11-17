"""사이트 실제 점검 (GitHub Actions에서 실행): 홈의 상품 링크가 전부 상품 DB에 있는지, 카테고리·검색·인기순위·상품 상세 API가 정상인지"""
import json, re, sys, time, urllib.request, urllib.parse

SITE = "https://damgosago.com"
API = "https://shop-api.scream0506.workers.dev"
UA = {"User-Agent": "damgosago-health"}


def get(url, tries=3):
    for t in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if t == tries - 1:
                return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            if t == tries - 1:
                return 0, str(e)
        time.sleep(2)


bad = []
st, home = get(SITE + "/")
if st != 200:
    bad.append(f"홈 {st}")
ids = sorted(set(re.findall(r'product/([A-Za-z0-9_-]+)\.html', home)) | set(urllib.parse.unquote(x) for x in re.findall(r'item\.html\?id=([^"&]+)', home)))
for i in ids:
    s, b = get(API + "/catalog/item?id=" + urllib.parse.quote(i))
    if s != 200:
        bad.append(f"홈 상품 {i}: {s}")
print(f"홈 상품 링크 {len(ids)}개 확인")
for c in ["living", "kitchen", "fashion", "beauty", "winter", "digital", "supplement"]:
    s, b = get(API + f"/catalog/list?cat={c}&size=5")
    n = len(json.loads(b).get("items", [])) if s == 200 else 0
    if s != 200 or not n:
        bad.append(f"카테고리 {c}: {s}, {n}개")
    elif c == "living":
        for it in json.loads(b)["items"][:3]:  # 상세 3개
            s2, _ = get(API + "/catalog/item?id=" + urllib.parse.quote(it["id"]))
            if s2 != 200:
                bad.append(f"상세 {it['id']}: {s2}")
for q in ["핫팩", "텀블러", "볼펜"]:
    s, b = get(API + "/catalog/list?q=" + urllib.parse.quote(q) + "&size=5")
    if s != 200 or not json.loads(b).get("items"):
        bad.append(f"검색 {q}: {s}")
for path in ["/catalog/counts", "/catalog/popular"]:
    s, b = get(API + path)
    if s != 200:
        bad.append(f"{path}: {s}")
    elif path == "/catalog/counts":
        c = json.loads(b); print("상품 수:", sum(v for k, v in c.items() if not k.startswith("_") and k != "winter"), "| 화장품", c.get("beauty"), "| 건강식품", c.get("supplement"))
for page in ["search.html?q=핫팩", "cart.html", "find.html", "category/winter.html", "product/item.html"]:
    s, _ = get(SITE + "/" + urllib.parse.quote(page, safe="/?=&"))
    if s != 200:
        bad.append(f"페이지 {page}: {s}")
print("문제:", bad if bad else "없음")
sys.exit(1 if bad else 0)
