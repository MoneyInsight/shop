"""도매꾹 Open API 구조 확인 (키는 출력하지 않음) - 건강기능식품 최저판매가(가격 준수) 정보 위치 확인"""
import os, re, json, urllib.request, urllib.parse
KEY = os.environ["DOMEGGOOK_API_KEY"]
def call(params):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=60) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
nos = []
for kw in ["비타민", "유산균", "오메가3"]:
    d = call({"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": kw, "sz": "20", "pg": "1"})
    items = d.get("domeggook", {}).get("list", {}).get("item", [])
    if isinstance(items, dict): items = [items]
    print("LIST", kw, len(items), json.dumps(items[:1], ensure_ascii=False)[:800])
    nos += [str(i.get("no")) for i in items[:4]]
for no in nos:
    v = call({"ver": "4.5", "mode": "getItemView", "no": no}).get("domeggook", {})
    print("=" * 30, no, (v.get("basis") or {}).get("title"))
    print("KEYS", list(v.keys()))
    print("PRICE", json.dumps(v.get("price"), ensure_ascii=False)[:800])
    print("BASIS", json.dumps(v.get("basis"), ensure_ascii=False)[:800])
    flat = json.dumps(v, ensure_ascii=False)
    for m in re.finditer(r'"([^"]*(?:resale|min|limit|recommend|policy|consumer)[^"]*)"\s*:\s*("[^"]{0,80}"|\{[^}]{0,300}\}|[0-9.]+)', flat, re.I):
        print("FIELD", m.group(1), m.group(2))
    desc = re.sub(r"<[^>]+>", " ", json.dumps(v.get("desc"), ensure_ascii=False))
    for m in re.finditer(r".{0,40}(최저|판매가|준수|이하로|미만|가격\s?정책|덤핑).{0,60}", desc):
        print("DESC", m.group(0).replace("\\n", " ")[:140])
