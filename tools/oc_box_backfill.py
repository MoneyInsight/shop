"""오너클랜 창고 상품에 묶음배송 수량(boxQuantity) 채우기 (한 번 실행, GitHub Actions)
- 예전에 모은 오너클랜 상품은 묶음배송 수량이 비어 있어 '1개마다 배송비'로 받고 있었음 → 여러 개 사면 배송비가 너무 많이 붙음
- 우리 서버(/oc/items, 100개씩)로 boxQuantity를 받아 warehouse/oc_*.csv.gz 의 '묶음배송수량'을 채움 (2 이상일 때만, 아니면 그대로 1개마다)
"""
import csv, gzip, io, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.load(open(ROOT / "config.json", encoding="utf-8"))
API = CFG["worker_url"].rstrip("/") + "/oc/items"
PW = os.environ["ADMIN_PASSWORD"]
MAX_MIN = float(os.environ.get("MAX_MIN", "300"))
STATE = ROOT / "data/oc_box.json"  # {상품코드: boxQuantity} — 끊겨도 이어서


def ask(keys):
    req = urllib.request.Request(API, json.dumps({"keys": keys}).encode(), {"Content-Type": "application/json", "x-admin-pass": PW, "User-Agent": "allchaeum-oc"})
    for t in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode()).get("items") or []
        except Exception:
            time.sleep(5 * (t + 1))
    return None


def main():
    files = sorted((ROOT / "warehouse").glob("oc_*.csv.gz"))
    data = {f: list(csv.DictReader(io.StringIO(gzip.decompress(f.read_bytes()).decode("utf-8-sig")))) for f in files}
    box = json.loads(STATE.read_text()) if STATE.exists() else {}
    keys = [r["상품코드"] for rows in data.values() for r in rows if r.get("상품코드") and r["상품코드"] not in box]
    print(f"오너클랜 창고 {sum(len(v) for v in data.values()):,}개 중 묶음배송 수량 조회할 상품 {len(keys):,}개")
    t0 = time.time()
    chunks = [keys[i:i + 100] for i in range(0, len(keys), 100)]
    done = 0
    with ThreadPoolExecutor(4) as ex:
        for i in range(0, len(chunks), 40):
            if time.time() - t0 > MAX_MIN * 60:
                print("시간 다 됨 → 다음 실행에서 이어서"); break
            for ch, items in zip(chunks[i:i + 40], ex.map(ask, chunks[i:i + 40])):
                if items is None:
                    continue
                got = {it["key"]: int(it.get("boxQuantity") or 0) for it in items if it and it.get("key")}
                for k in ch:
                    box[k] = got.get(k, 0)
                done += len(ch)
            STATE.write_text(json.dumps(box, separators=(",", ":")))
            print(f"{done:,}/{len(keys):,}", flush=True)
    from collections import Counter
    print("boxQuantity 분포(상위):", Counter(box.values()).most_common(12))
    changed = 0
    for f, rows in data.items():
        n = 0
        for r in rows:
            b = box.get(r.get("상품코드"), 0)
            want = str(b) if b > 1 and str(r.get("공급 배송비") or "0") not in ("", "0") else ""
            if (r.get("묶음배송수량") or "") != want:
                r["묶음배송수량"] = want; n += 1
        if n:
            buf = io.StringIO(); w = csv.DictWriter(buf, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
            f.write_bytes(gzip.compress(buf.getvalue().encode("utf-8-sig"), 9)); changed += n
    print(f"묶음배송 수량 반영: {changed:,}개 상품")


if __name__ == "__main__":
    main()
