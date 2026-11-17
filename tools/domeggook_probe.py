"""도매꾹 Open API 구조 확인 (키는 출력하지 않음) - 상품별 가격·수량·배송 원본 확인"""
import os, json, urllib.request, urllib.parse
KEY = os.environ["DOMEGGOOK_API_KEY"]
def call(params):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=60) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
for no in (os.environ.get("NOS") or "49577904").split(","):
    v = call({"ver": "4.5", "mode": "getItemView", "no": no}).get("domeggook", {})
    print("ITEM", no, json.dumps({k: v.get(k) for k in ("price", "qty", "deli", "unitQty", "basis")}, ensure_ascii=False)[:3000])
for ver in ("1.0", "1.1"):
    try:
        c = call({"ver": ver, "mode": "getCategoryList"})
        print("CATS", ver, str(c)[:400])
    except Exception as e:
        print("CATS", ver, "오류", e)
