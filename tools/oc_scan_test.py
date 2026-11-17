"""오너클랜 대량 수집 속도 시험 → data/oc_scan_test.json (상품 정보 일부만, 비밀값 없음)"""
import json, os, time, urllib.request
API = "https://shop-api.scream0506.workers.dev/oc/scan"
PW = os.environ["ADMIN_PASSWORD"]


def scan(**b):
    req = urllib.request.Request(API, json.dumps(b).encode(), {"Content-Type": "application/json", "x-admin-pass": PW, "User-Agent": "allchaeum-oc"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        d = {"error": str(e)[:300]}
    d["wall"] = round(time.time() - t, 2)
    return d


out = {"sizes": {}}
for n in (100, 500, 1000):
    d = scan(first=n)
    out["sizes"][n] = {"got": len(d.get("items") or []), "ms": d.get("ms"), "wall": d["wall"], "errors": d.get("errors") or d.get("error") or d.get("raw"), "page": d.get("page")}
best = max((n for n, v in out["sizes"].items() if v["got"]), default=100)
d = scan(first=3, full=True)
out["sample_full"] = [{k: (str(v)[:400] if k in ("content", "metadata", "images", "options") else v) for k, v in it.items()} for it in (d.get("items") or [])[:3]]
out["full_errors"] = d.get("errors") or d.get("error")
# 연속 수집 2분: 몇 개/분
t0, n, after, pages, errs = time.time(), 0, None, 0, 0
grades = {}
while time.time() - t0 < 120:
    d = scan(first=best, after=after)
    items = d.get("items") or []
    if not items:
        errs += 1
        if errs > 3:
            out["stream_error"] = d.get("errors") or d.get("error") or d.get("raw"); break
        time.sleep(3); continue
    n += len(items); pages += 1
    for it in items:
        g = str((it.get("metadata") or {}).get("grade"))
        grades[g] = grades.get(g, 0) + 1
    pg = d.get("page") or {}
    if not pg.get("hasNextPage"):
        break
    after = pg.get("endCursor")
el = time.time() - t0
out["stream"] = {"items": n, "pages": pages, "seconds": round(el, 1), "per_minute": round(n / el * 60), "per_day_estimate": round(n / el * 86400)}
out["grades_sample"] = dict(sorted(grades.items(), key=lambda x: -x[1])[:20])
open("data/oc_scan_test.json", "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
print(json.dumps(out["stream"], ensure_ascii=False), out["sizes"])
