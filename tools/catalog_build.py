"""상품 DB(SQLite/D1) 만들기 — 지금 가진 모든 상품 파일(data/)을 DB 하나로
사용: python3 tools/catalog_build.py            → dist/catalog.sqlite (확인용) + dist/catalog_NNN.sql (D1에 올릴 파일)
      wrangler d1 execute ttaengjab --remote --file=dist/catalog_001.sql  (서버 연결 후, 파일마다)
검색 색인 규칙은 worker/catalog.js 의 terms() 와 똑같아야 함 (영문·숫자 단어 + 한글 2글자 조각)
"""
import datetime, json, re, sqlite3, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import product_import

SCHEMA = re.search(r"SCHEMA = `([\s\S]*?)`", (ROOT / "worker/catalog.js").read_text(encoding="utf-8")).group(1)
ROWS_PER_SQL = 2000  # D1 한 번에 올리는 파일 크기를 적당히


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
    return "domeme" if pid.startswith("DM") else "ownerclan" if re.match(r"^W", pid) else "직영"


def products():
    cfg = json.load(open(ROOT / "config.json", encoding="utf-8"))
    cats = cfg["categories"]
    rows, warns, _ = product_import.load(ROOT / "data", cats, cfg.get("customer_discount", 0), cfg.get("pricing"))
    stock = json.loads((ROOT / "data/stock.json").read_text(encoding="utf-8")).get("items", {}) if (ROOT / "data/stock.json").exists() else {}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    out = []
    for i, r in enumerate(rows):
        st = stock.get(r["id"], {})
        price = int(r["price"])
        cost = int(r.get("cost") or 0)
        if st.get("cost") and cost and int(st["cost"]) != cost:
            cost = int(st["cost"]); price = product_import.price_from_cost(cost, cfg["pricing"])
        opts = r.get("options") or []
        gone = set(st.get("opts_soldout") or [])
        for o in opts:
            o["so"] = o["v"] in gone
        out.append({"id": r["id"], "source": source_of(r["id"]), "source_no": re.sub(r"^DM", "", r["id"]), "supplier": r.get("supplier", ""),
                    "name": r["name"], "category": r["category"], "price": price, "normal_price": price if cost else int(r.get("normal_price") or price),
                    "cost": cost, "image": r.get("image", ""), "images": r.get("images") or [], "detail_html": r.get("detail_html", ""),
                    "options": opts, "qt": [] if (st.get("cost") and cost != int(r.get("cost") or 0)) else (r.get("qt") or []), "option_name": r.get("option_name", ""), "brand": r.get("brand", ""), "origin": r.get("origin", ""),
                    "soldout": 1 if (st.get("soldout") or (opts and all(o["so"] for o in opts))) else 0, "rank": i, "updated": now})
    return out


COLS = ["id", "source", "source_no", "supplier", "name", "category", "price", "normal_price", "cost", "image", "images", "detail_html",
        "options", "qt", "option_name", "brand", "origin", "soldout", "rank", "updated"]


def vals(p):
    return [json.dumps(p[c], ensure_ascii=False) if c in ("images", "options", "qt") else p[c] for c in COLS]


def sql_lit(v):
    return str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'"


def main():
    ps = products()
    dist = ROOT / "dist"; dist.mkdir(exist_ok=True)
    db_path = dist / "catalog.sqlite"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    db.executemany(f"INSERT INTO products ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})", [vals(p) for p in ps])
    db.executemany("INSERT INTO products_fts (id, terms) VALUES (?, ?)", [(p["id"], " ".join(terms(f"{p['name']} {p['brand']}"))) for p in ps])
    db.commit(); db.close()
    for f in dist.glob("catalog_*.sql"):
        f.unlink()
    for n in range(0, len(ps), ROWS_PER_SQL):
        part = ps[n:n + ROWS_PER_SQL]
        lines = [SCHEMA.strip()] if n == 0 else []
        for p in part:
            lines.append(f"INSERT OR REPLACE INTO products ({','.join(COLS)}) VALUES ({','.join(sql_lit(v) for v in vals(p))});")
            lines.append(f"DELETE FROM products_fts WHERE id = {sql_lit(p['id'])};")
            lines.append(f"INSERT INTO products_fts (id, terms) VALUES ({sql_lit(p['id'])}, {sql_lit(' '.join(terms(p['name'] + ' ' + p['brand'])))});")
        (dist / f"catalog_{n // ROWS_PER_SQL + 1:03d}.sql").write_text("\n".join(lines), encoding="utf-8")
    print(f"상품 DB: {len(ps)}개 → {db_path} , D1용 SQL {len(range(0, len(ps), ROWS_PER_SQL))}개 파일")


if __name__ == "__main__":
    main()
