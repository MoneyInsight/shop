"""오너클랜 API 구조 확인 → data/oc_schema.json (토큰·비밀번호는 저장하지 않음)"""
import json, os, urllib.request, urllib.error


def post(url, body, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), h), timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]
    except Exception as e:
        return 0, str(e)
ID, PW = os.environ["OWNERCLAN_ID"], os.environ["OWNERCLAN_PW"]
st, tok = post("https://auth.ownerclan.com/auth", {"service": "ownerclan", "userType": "seller", "username": ID, "password": PW})
tok = tok.strip().strip('"')
if tok.startswith("{"):
    tok = json.loads(tok).get("token", tok)
G = "https://api.ownerclan.com/v1/graphql"
q = lambda s: post(G, {"query": s}, tok)
out = {"auth": st}
st, sch = q("query{__schema{queryType{fields{name args{name type{name kind ofType{name kind}}} type{name kind ofType{name}}}} types{name kind fields{name type{name kind ofType{name kind ofType{name}}}} enumValues{name}}}}")
try:
    d = json.loads(sch)["data"]["__schema"]
    out["query_fields"] = d["queryType"]["fields"]
    keep = {"Item", "ItemOption", "ItemConnection", "ItemEdge", "ItemShippingFee", "ItemStatus", "ItemImage", "Order", "OrderProduct", "Shipping"}
    out["types"] = [t for t in d["types"] if t["name"] in keep or (t["name"] or "").startswith("Item") or (t["name"] or "").startswith("Order")]
except Exception as e:
    out["schema_err"] = str(e) + sch[:300]
open("data/oc_schema.json", "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
print("저장", len(out.get("types", [])))
