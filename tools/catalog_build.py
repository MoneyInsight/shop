"""상품 DB(Cloudflare D1) 채우기 — 사이트 상품(data/) + 상품 창고(warehouse/) 전체를 DB용으로
사용: python3 tools/catalog_build.py [--state dist/d1_state.json] [--budget 85000]
 - 바뀐 상품만 골라 dist/d1/NNN.sql 로 만듦 (내용 지문 h가 같으면 건너뜀) → 무료 한도(하루 쓰기 10만 줄) 아끼기
 - 하루 쓰기 예산(--budget, 줄 수)을 넘지 않게 나눠서, 남은 건 다음 날
 - 사이트와 똑같은 규칙(product_import.load)으로 가격·필터(성인·식품·KC·손해)를 거치고,
   올리기 전에 1~10개 구매 순마진 8%를 다시 검사해 통과한 상품만 올림
검색 색인 규칙은 worker/catalog.js 의 terms() 와 똑같아야 함 (영문·숫자 단어 + 한글 2글자 조각)
"""
import argparse, datetime, hashlib, json, math, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import product_import

SCHEMA = re.search(r"SCHEMA = `([\s\S]*?)`", (ROOT / "worker/catalog.js").read_text(encoding="utf-8")).group(1)
COLS = ["id", "source", "source_no", "supplier", "name", "category", "price", "normal_price", "cost", "image", "images", "detail_html",
        "options", "qt", "option_name", "brand", "origin", "soldout", "rank", "updated", "shipping_fee", "sn", "mq", "pk", "h"]
# 상품 1개 넣을 때 D1 쓰기 줄 수 (표 1 + 색인 2 + 검색 색인 여유) — 실제 값은 워크플로가 wrangler 결과로 확인
W_NEW, W_DEL = 6, 4
PER_FILE = 1500


def terms(text):
    out = []
    for w in re.split(r"[^0-9a-z가-힣]+", str(text or "").lower()):
        if not w:
            continue
        if re.search(r"[가-힣]", w):
            if len(w) == 1:
                out.append(w)
            out += [w[i:i + 2] for i in range(len(w) - 1)]
        else:
            out.append(w)
    return list(dict.fromkeys(out))


def source_of(pid):
    return ("domeme" if pid.startswith("DM") else "onchannel" if pid.startswith("CH") else "own" if pid.startswith("OWN")
            else "ownerclan" if re.match(r"^W", pid) else "직영")


def safe(p, P):
    """1~10개(최소수량부터) 살 때 배송비 포함 원가 대비 순마진 8% 이상인지 (ship_audit 와 같은 계산)"""
    if not p["cost"]:
        return True
    pk = p["pk"]; g = p["cost"] * pk; fee, sn = p["shipping_fee"], p["sn"]
    qt = p["qt"] or [p["price"]]
    def ship(units):
        return 0 if not fee else (fee * math.ceil(units / sn) if sn else fee)
    for n in range(p["mq"], p["mq"] + 10):
        u = qt[min(n, len(qt)) - 1]
        rev = u * n + ship(n * pk)
        cost = g * n + ship(n * pk)
        net = rev - rev * P["card_fee"] - (rev - cost) / 11 - cost - P["ops_cost_won"]
        if net / cost < 0.079:
            return False
    return True


def products():
    """사이트와 완전히 같은 규칙(build.load_products: KC·성인·식품·중복·관리자 수정/숨김·재고·도매가 재계산) + 상품 창고"""
    import os
    os.environ["WITH_WAREHOUSE"] = "1"
    import build
    cfg = build.CFG
    P = cfg["pricing"]
    site = build.BASE.rstrip("/")
    nwh = len(list((ROOT / "warehouse").glob("*.csv.gz")))
    out, unsafe = [], 0
    for i, r in enumerate(build.load_products()):
        pid = str(r["id"])
        cost = int(r.get("cost") or 0)
        img = r.get("image", "")
        if img and not img.startswith("http"):
            img = f"{site}/{img}"
        p = {"id": pid, "source": source_of(pid), "source_no": re.sub(r"^(DM|CH)", "", pid), "supplier": r.get("supplier", ""),
             "name": r["name"], "category": r["category"], "price": int(r["price"]), "normal_price": int(r.get("normal_price") or r["price"]),
             "cost": cost, "image": img, "images": r.get("images") or [], "detail_html": r.get("detail_html", ""),
             "options": r.get("options") or [], "qt": [int(x) for x in (r.get("qt") or [])], "option_name": r.get("option_name", ""),
             "brand": r.get("brand", ""), "origin": r.get("origin", ""), "soldout": 1 if r.get("soldout") else 0, "rank": i,
             "shipping_fee": int(r.get("shipping_fee") or 0), "sn": int(r.get("sn") or 0), "mq": int(r.get("mq") or 1), "pk": int(r.get("pk") or 1)}
        if not safe(p, P):
            unsafe += 1; continue  # 손해 가능 상품은 DB에 올리지 않음
        body = json.dumps({k: v for k, v in p.items() if k != "rank"}, ensure_ascii=False, sort_keys=True)
        p["h"] = hashlib.sha1(body.encode()).hexdigest()[:16]
        out.append(p)
    return out, unsafe, nwh


def lit(v):
    if isinstance(v, (list, dict)):
        v = json.dumps(v, ensure_ascii=False)
    return str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default=str(ROOT / "dist/d1_state.json"))  # 지난번까지 DB에 올린 {id: h}
    ap.add_argument("--budget", type=int, default=85000)  # 하루 무료 한도 10만 줄 중 오늘 쓸 몫
    a = ap.parse_args()
    ps, unsafe, nwh = products()
    import csv, gzip, io
    whids = set()
    for f in (ROOT / "warehouse").glob("*.csv.gz"):
        whids |= {r["상품코드"] for r in csv.DictReader(io.StringIO(gzip.decompress(f.read_bytes()).decode("utf-8-sig")))}
    (ROOT / "dist").mkdir(exist_ok=True)
    (ROOT / "dist/site_ids.json").write_text(json.dumps([p["id"] for p in ps if p["id"] not in whids]), encoding="utf-8")  # 자동 전환 점검용
    stp = Path(a.state)
    state = json.loads(stp.read_text(encoding="utf-8")) if stp.exists() else {}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    cur = {p["id"]: p for p in ps}
    gone = [i for i in state if i not in cur]  # 사이트·창고에서 빠진 상품 (도매처 판매중지·필터) → DB에서도 지움
    # 새 상품보다 '바뀐 상품'(가격·품절)을 먼저 — 손님에게 틀린 정보가 오래 남지 않게
    changed = [p for p in ps if p["id"] in state and state[p["id"]] != p["h"]]
    new = [p for p in ps if p["id"] not in state]
    out = Path(ROOT / "dist/d1"); out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.sql"):
        f.unlink()
    lines, used, files, done, plan, part = [], 0, [], {}, {}, {}
    def flush():
        if lines:
            f = out / f"{len(files) + 1:04d}.sql"; f.write_text("\n".join(lines), encoding="utf-8"); files.append(f.name)
            plan[f.name] = dict(part); lines.clear(); part.clear()
    for i in gone:
        if used + W_DEL > a.budget:
            break
        lines += [f"DELETE FROM products WHERE id = {lit(i)};", f"DELETE FROM products_fts WHERE id = {lit(i)};"]
        used += W_DEL; done[i] = part[i] = None
        if len(lines) >= PER_FILE * 3:
            flush()
    for p in changed + new:
        if used + W_NEW > a.budget:
            break
        p = dict(p, updated=now)
        lines.append(f"INSERT OR REPLACE INTO products ({','.join(COLS)}) VALUES ({','.join(lit(p[c]) for c in COLS)});")
        lines.append(f"DELETE FROM products_fts WHERE id = {lit(p['id'])};")
        lines.append(f"INSERT INTO products_fts (id, terms) VALUES ({lit(p['id'])}, {lit(' '.join(terms(p['name'] + ' ' + p['brand'])))});")
        used += W_NEW; done[p["id"]] = part[p["id"]] = p["h"]
        if len(lines) >= PER_FILE * 3:
            flush()
    flush()
    (out / "schema.sql").write_text(SCHEMA.strip(), encoding="utf-8")
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")  # {파일: {id: h 또는 null(삭제)}} — 성공한 파일만 상태에 반영
    left = len(gone) + len(changed) + len(new) - len(done)
    summary = {"at": now, "total": len(ps), "warehouse_files": nwh, "unsafe_skipped": unsafe, "in_db_before": len(state),
               "delete": len(gone), "changed": len(changed), "new": len(new), "today": len(done), "left": left, "files": files}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "files"}, ensure_ascii=False), f"SQL 파일 {len(files)}개")


if __name__ == "__main__":
    main()
