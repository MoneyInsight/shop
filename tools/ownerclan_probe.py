"""오너클랜 API 연결 확인: 토큰 발급 → GraphQL 스키마 조회 (토큰·비밀번호는 출력하지 않음)"""
import json, os, sys, urllib.request

def post(url, body, token=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, json.dumps(body).encode(), h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]
    except Exception as e:
        return 0, str(e)

ID, PW = os.environ["OWNERCLAN_ID"], os.environ["OWNERCLAN_PW"]
INTRO = {"query": "query{__schema{queryType{name} types{name kind fields{name args{name type{name kind ofType{name kind}}} type{name kind ofType{name kind ofType{name}}}} inputFields{name type{name kind ofType{name}}} enumValues{name}}}}"}
os.makedirs("probe", exist_ok=True)
for env, auth, apis in [("sandbox", "https://auth-sandbox.ownerclan.com/auth", ["https://api-sandbox.ownerclan.com/v1/graphql"]),
                        ("production", "https://auth.ownerclan.com/auth", ["https://api.ownerclan.com/v1/graphql"])]:
    st, tok = post(auth, {"service": "ownerclan", "userType": "seller", "username": ID, "password": PW})
    ok = st == 200 and len(tok) > 20
    print(env, "auth", st, "ok" if ok else tok[:200])
    if not ok:
        continue
    tok = tok.strip().strip('"')
    try:
        tok = json.loads(tok).get("token", tok) if tok.startswith("{") else tok
    except Exception:
        pass
    for api in apis:
        st, body = post(api, INTRO, tok)
        print(env, api, st, len(body))
        open(f"probe/{env}_schema.json", "w").write(body)
        st, body = post(api, {"query": "query{allItems(first:2){edges{node{key name price}}}}"}, tok)
        print(env, "sample", st, body[:600])
