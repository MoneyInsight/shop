"""오너클랜 상품 매일 품절·가격 점검 (GitHub Actions) → data/_oc_stock_result.json (tools/stock_sync.py 형식)
깃허브에서는 오너클랜이 접속을 막아서, 우리 서버(/oc/items)가 대신 조회한다.
- 판매중(available) 아님 → 품절
- 옵션별 품절 → 옵션 품절
- 도매가 변동 → cost (사이트·DB 가격 자동 재계산, 순마진 8% 보장)
- 배송비가 우리 판매 배송비보다 올랐거나 착불로 바뀜 → 품절로 보류 (손해 방지)
"""
import contextlib, io, json, os, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["WITH_WAREHOUSE"] = "1"
with contextlib.redirect_stdout(io.StringIO()):
    import build
    ps = build.load_products()
W = {p["id"]: p for p in ps if len(p["id"]) == 7 and p["id"].startswith("W")}
API = build.CFG["worker_url"].rstrip("/") + "/oc/items"
PW = os.environ["ADMIN_PASSWORD"]


def ask(keys):
    req = urllib.request.Request(API, json.dumps({"keys": keys}).encode(), {"Content-Type": "application/json", "x-admin-pass": PW, "User-Agent": "allchaeum-oc"})
    for t in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            err = str(e); time.sleep(5 * (t + 1))
    raise SystemExit("서버 조회 실패: " + err)


norm = lambda s: str(s).replace(" ", "")
res = {"source": "ownerclan", "checked": [], "soldout": [], "cost": {}, "opts_soldout": {}}
why = {"판매중지": 0, "배송비 인상": 0, "옵션 품절": 0, "가격 변동": 0, "조회 안 됨": 0}
keys = sorted(W)
for i in range(0, len(keys), 100):
    part = keys[i:i + 100]
    d = ask(part)
    got = {x["key"]: x for x in d.get("items", [])}
    for k in part:
        p, it = W[k], got.get(k)
        if not it:
            why["조회 안 됨"] += 1; continue  # 조회 실패한 상품은 그대로 둠 (다음 날 다시)
        res["checked"].append(k)
        fee = 0 if it.get("shippingType") == "free" else int(it.get("shippingFee") or 0)
        if it.get("status") != "available":
            res["soldout"].append(k); why["판매중지"] += 1; continue
        if it.get("shippingType") == "uponArrival" or fee > int(p.get("shipping_fee") or 0):
            res["soldout"].append(k); why["배송비 인상"] += 1; continue
        price = int(float(it.get("price") or 0))
        if price and price > int(p.get("cost") or 0):  # 오를 때만 반영 (내려간 건 옵션별 가격 차이일 수 있어 그대로)
            res["cost"][k] = price; why["가격 변동"] += 1
        ours = [o["v"] for o in (p.get("options") or [])]
        if ours and it.get("options"):
            gone, live = [], set()
            for o in it["options"]:
                vals = [norm(a.get("value", "")) for a in (o.get("optionAttributes") or [])]
                cand = {j.join(vals) for j in ("_", "/", "", "-", ",")}
                if o.get("status") != "available" or int(o.get("quantity") or 0) <= 0:
                    gone += [v for v in ours if norm(v) in cand]
                else:
                    live |= cand
            matched = [v for v in ours if norm(v) in live or v in gone]
            if matched:  # 이름 맞추기가 되는 상품만 (형식이 달라 하나도 안 맞으면 건드리지 않음)
                gone += [v for v in ours if norm(v) not in live and v not in gone]  # 도매처에서 없어진 옵션도 품절 (도매처와 똑같이)
            if len(gone) >= len(ours):
                res["soldout"].append(k); why["옵션 품절"] += 1; continue
            if gone:
                res["opts_soldout"][k] = gone; why["옵션 품절"] += 1
    time.sleep(1)
Path(ROOT / "data/_oc_stock_result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
print(f"오너클랜 {len(keys)}개 점검:", why)
