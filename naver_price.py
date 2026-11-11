"""네이버 쇼핑 검색 API로 상품별 네이버 최저가를 찾아 채워 넣기
환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 있을 때만 동작 (깃허브 Secrets에 등록)
- 상품명으로 검색 → 이름이 충분히 비슷하고 가격이 정상 범위인 결과 중 최저가를 사용
- 결과는 .naver_cache.json 에 저장해 하루 동안 다시 묻지 않음
"""
import json, os, re, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CACHE = Path(__file__).parent / ".naver_cache.json"
TTL = 24 * 3600


def _tokens(s):
    s = re.sub(r"<[^>]+>", "", s)
    return {t for t in re.split(r"[^0-9A-Za-z가-힣]+", s.lower()) if len(t) >= 2}


def _query(name, cid, secret):
    q = " ".join(list(_tokens(name))[:8]) if len(name) > 40 else name
    url = "https://openapi.naver.com/v1/search/shop.json?" + urllib.parse.urlencode({"query": q, "display": 20, "sort": "sim"})
    req = urllib.request.Request(url, headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": secret})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.load(r).get("items", [])
        except Exception:
            time.sleep(1)
    return None


def lowest(name, our_price, items):
    """같은 상품으로 볼 만한 결과(이름 겹침 50% 이상, 가격이 우리 가격의 40%~250%) 중 최저가"""
    mine = _tokens(name)
    best = 0
    for it in items or []:
        price = int(it.get("lprice") or 0)
        if not price or not (our_price * 0.4 <= price <= our_price * 2.5):
            continue
        other = _tokens(it.get("title", ""))
        if not mine or len(mine & other) / len(mine) < 0.5:
            continue
        best = price if not best else min(best, price)
    return best


def fill(products):
    """products: [{'id','name','price','naver_low'}...] 의 naver_low 를 채움 (이미 값이 있으면 그대로)"""
    cid, secret = os.environ.get("NAVER_CLIENT_ID"), os.environ.get("NAVER_CLIENT_SECRET")
    if not cid or not secret:
        return 0
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    now = time.time()
    todo = [p for p in products if not str(p.get("naver_low") or "").strip()
            and not (p["name"] in cache and now - cache[p["name"]]["t"] < TTL)]

    def work(p):
        items = _query(p["name"], cid, secret)
        time.sleep(0.12)  # 초당 호출 제한 보호
        return p["name"], items

    with ThreadPoolExecutor(max_workers=4) as ex:
        for name, items in ex.map(work, todo):
            if items is not None:
                cache[name] = {"t": now, "items": [{"title": i.get("title", ""), "lprice": i.get("lprice")} for i in items]}
    CACHE.write_text(json.dumps(cache, ensure_ascii=False))
    n = 0
    for p in products:
        if not str(p.get("naver_low") or "").strip() and p["name"] in cache:
            low = lowest(p["name"], int(p["price"]), cache[p["name"]]["items"])
            if low:
                p["naver_low"] = str(low); n += 1
    return n
