"""도매꾹 Open API 연결 확인 (키는 출력하지 않음)"""
import os, json, urllib.request, urllib.parse
KEY = os.environ["DOMEGGOOK_API_KEY"]
os.makedirs("probe", exist_ok=True)
def call(params, name):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    try:
        with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception as e:
        body = "ERR " + str(e)
    open(f"probe/{name}.json", "w").write(body)
    print(name, len(body), body[:700].replace(KEY, "***"))
call({"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": "목걸이", "sz": "3"}, "list_supply")
call({"ver": "4.1", "mode": "getItemList", "market": "dome", "kw": "목걸이", "sz": "3"}, "list_dome")
call({"ver": "4.5", "mode": "getItemView", "no": "51859528"}, "view")
call({"ver": "4.5", "mode": "getItemView", "no": "51859528", "market": "supply"}, "view_supply")
