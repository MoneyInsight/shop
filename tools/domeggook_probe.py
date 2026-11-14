"""도매꾹 Open API 구조 확인 (키는 출력하지 않음) - 건강기능식품 분류 이름 확인"""
import os, json, urllib.request, urllib.parse
KEY = os.environ["DOMEGGOOK_API_KEY"]
def call(params):
    q = urllib.parse.urlencode({**params, "aid": KEY, "om": "json"})
    with urllib.request.urlopen("https://domeggook.com/ssl/api/?" + q, timeout=60) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
for no in ["65114578", "60821818", "62442203", "68747446"]:
    v = call({"ver": "4.5", "mode": "getItemView", "no": no}).get("domeggook", {})
    cat = v.get("category") or {}
    names = [e.get("name", "") for e in ((cat.get("parents") or {}).get("elem") or [])] + [(cat.get("current") or {}).get("name", "")]
    print("CAT", no, " > ".join(names), "| PRICE", json.dumps(v.get("price"), ensure_ascii=False))
tree = (call({"ver": "1.0", "mode": "getCategoryList"}).get("domeggook") or {}).get("items") or {}
def walk(node, path):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, dict) and "name" in v:
                p = path + [v["name"]]
                if any("건강" in x or "식품" in x for x in p): print("TREE", " > ".join(p))
                walk(v.get("child") or {}, p)
            elif isinstance(v, (dict, list)):
                walk(v, path)
    elif isinstance(node, list):
        for v in node: walk(v, path)
walk(tree, [])
