"""도매꾹 Open API 구조 확인 (키는 출력하지 않음)"""
import os, json, urllib.request, urllib.parse
KEY = os.environ["DOMEGGOOK_API_KEY"]
def call(params):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=60) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
for ca in ["01_00_00_00_00", "13_00_00_00_00"]:
    d = call({"ver": "4.1", "mode": "getItemList", "market": "supply", "ca": ca, "sz": "200", "pg": "1"})
    h = d.get("domeggook", {}).get("header", {}); items = d.get("domeggook", {}).get("list", {}).get("item", [])
    print("LIST", ca, json.dumps(h, ensure_ascii=False), len(items))
    if not items: print("RAW", json.dumps(d, ensure_ascii=False)[:400])
for no in ["52261299", "40437844", "67579217"]:
    v = call({"ver": "4.5", "mode": "getItemView", "no": no})["domeggook"]
    print("OPT", no, json.dumps(v.get("selectOpt"), ensure_ascii=False)[:1200])
    print("CAT", json.dumps(v.get("category"), ensure_ascii=False)[:300], "| DESC_LIC", json.dumps((v.get("desc") or {}).get("license"), ensure_ascii=False))
c = call({"ver": "1.0", "mode": "getCategoryList"})
print("CATLIST", json.dumps(c, ensure_ascii=False)[:1500])
