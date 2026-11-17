"""오너클랜 상품 대량 수집 → 상품 창고 warehouse/oc_*.csv.gz (상품 DB에만 올림)
- 깃허브에서는 오너클랜이 막아서 우리 서버(/oc/scan)가 대신 받아옴 (500개씩)
- 고르는 기준: 공급사 등급 다이아몬드·플래티넘·골드, 판매중, 성인 아님, 착불 아님, 판매 가능한 옵션이 있는 것
  (성인·식품·KC 없는 전기제품·손해 가격·깨진 사진은 상품 DB에 올릴 때 사이트와 같은 규칙으로 한 번 더 거름)
- 파일 형식은 오너클랜 DB 엑셀(data/오너클랜DB상품.csv)과 같은 칸 → 가격·분류 계산이 기존 상품과 똑같이 됨
- 어디까지 받았는지(cursor)를 data/oc_collect_state.json 에 저장해 다음 실행이 이어서 받음
환경변수: ADMIN_PASSWORD, OC_MAX_MIN(실행 분, 기본 300), OC_TARGET(창고 총 목표, 기본 500000)
"""
import csv, datetime, gzip, io, json, os, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://shop-api.scream0506.workers.dev/oc/scan"
PW = os.environ["ADMIN_PASSWORD"]
MAX_MIN = float(os.environ.get("OC_MAX_MIN", "300"))
TARGET = int(os.environ.get("OC_TARGET", "500000"))
STATE = ROOT / "data/oc_collect_state.json"
WH = ROOT / "warehouse"
FIELDS = ["상품코드", "상품명", "카테고리코드", "카테고리명", "공급가", "공급 배송비", "묶음배송수량", "반품배송비", "교환배송비",
          "대표 이미지 주소", "브랜드", "제조사", "상세 설명", "인증정보", "옵션명", "옵션", "공급사등급"]
GOOD = (("DIAMOND", "1"), ("PALTINUM", "2"), ("PLATINUM", "2"), ("GOLD", "3"), ("SILVER", "4"), ("NEW", "5"))  # 신규(NEW) 공급사도 포함 (대표님: 오너클랜 위주로) — 주의·BAD만 제외  # 오너클랜 표기 그대로 (PALTINUM 오타 포함) — 신규(NEW)·주의·BAD 공급사만 제외
PER_FILE = 40000


def scan(after):
    body = {"first": 500, "full": True}
    if after:
        body["after"] = after
    req = urllib.request.Request(API, json.dumps(body).encode(), {"Content-Type": "application/json", "x-admin-pass": PW, "User-Agent": "allchaeum-oc"})
    for t in range(5):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.loads(r.read().decode())
            if d.get("items") is not None and not d.get("errors"):
                return d
            err = d.get("errors") or d.get("raw")
        except Exception as e:
            err = str(e)[:200]
        time.sleep(10 * (t + 1))
    raise RuntimeError(f"수집 실패: {err}")


def cert(meta):
    c = (meta or {}).get("certificateInformation")
    if not c:
        return ""
    vals = []
    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif x not in (None, "", False):
            vals.append(str(x))
    walk(c)
    return " ".join(vals)[:200]


def box_qty(it, ship):
    """오너클랜 묶음배송 수량(boxQuantity): 2 이상이면 그 개수까지 배송비 1번 (N개마다), 0·1·없음이면 1개마다 (손해 없는 쪽)"""
    try:
        b = int(it.get("boxQuantity") or 0)
    except (TypeError, ValueError):
        b = 0
    return str(b) if ship and b > 1 else ""


def row(it):
    meta = it.get("metadata") or {}
    g = str(meta.get("grade") or "")
    gnum = next((n for p, n in GOOD if g.upper().startswith(p)), None)
    if not gnum or it.get("status") != "available" or it.get("adultOnly") or it.get("shippingType") == "uponArrival":
        return None
    price = int(float(it.get("price") or 0))
    imgs = it.get("images") or []
    if price <= 0 or not imgs:
        return None
    opts = [o for o in (it.get("options") or []) if o.get("status") == "available" and int(o.get("quantity") or 0) > 0]
    if it.get("options") and not opts:
        return None  # 옵션이 전부 품절
    names, vals = "", []
    if len(opts) > 1 or (opts and (opts[0].get("optionAttributes") or [])):
        names = "_".join(a.get("name", "") for a in (opts[0].get("optionAttributes") or []))
        for o in opts:
            v = "_".join(str(a.get("value", "")).strip() for a in (o.get("optionAttributes") or []))
            add = max(0, int(float(o.get("price") or price)) - price)  # 옵션이 더 싸도 0 (손해 없는 쪽)
            if v:
                vals.append(f"{v.replace('|', '/').replace('=', '-')}={add}")
    ship = 0 if it.get("shippingType") == "free" else int(it.get("shippingFee") or 0)
    ret = int(meta.get("returnShippingFee") or 0)
    return {"상품코드": it["key"], "상품명": it.get("name", ""), "카테고리코드": meta.get("smartstoreCategoryCode") or "",
            "카테고리명": meta.get("smartstoreCategoryFullName") or "", "공급가": price, "공급 배송비": ship, "묶음배송수량": box_qty(it, ship),
            "반품배송비": ret, "교환배송비": ret * 2, "대표 이미지 주소": imgs[0], "브랜드": "", "제조사": it.get("production") or "",
            "상세 설명": it.get("content") or "", "인증정보": cert(meta), "옵션명": names, "옵션": "|".join(vals), "공급사등급": gnum}


def push_now(total):
    """모인 만큼 바로 깃허브에 저장 → 1시간마다 도는 상품 DB 반영이 바로 사이트에 올림 (실패해도 수집은 계속)"""
    import subprocess
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    sh = lambda c: subprocess.run(c, shell=True, cwd=ROOT, capture_output=True, text=True)
    sh('git config user.name "allchaeum-bot"; git config user.email "bot@users.noreply.github.com"')
    sh("git add warehouse data/oc_collect_state.json")
    if sh(f'git commit -m "오너클랜 상품 수집 중간 저장 (창고 {total:,}개)"').returncode:
        return
    for _ in range(5):
        if sh("git pull --rebase --autostash -X theirs && git push").returncode == 0:
            print(f"중간 저장: 창고 {total:,}개"); return
        time.sleep(15)


def main():
    WH.mkdir(exist_ok=True)
    have = set()
    p0 = ROOT / "data/오너클랜DB상품.csv"
    if p0.exists():
        have |= {r["상품코드"] for r in csv.DictReader(open(p0, encoding="utf-8-sig"))}
    total = 0
    for f in WH.glob("oc_*.csv.gz"):
        for r in csv.DictReader(io.StringIO(gzip.decompress(f.read_bytes()).decode("utf-8-sig"))):
            have.add(r["상품코드"]); total += 1
    st = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    after, seen, kept = st.get("cursor"), 0, []
    t0 = time.time()
    day = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%Y%m%d")
    part = len(list(WH.glob(f"oc_{day}_*.csv.gz"))) + 1

    def flush():
        nonlocal kept, part
        if not kept:
            return
        buf = io.StringIO(); w = csv.DictWriter(buf, fieldnames=FIELDS); w.writeheader(); w.writerows(kept)
        (WH / f"oc_{day}_{part:02d}.csv.gz").write_bytes(gzip.compress(buf.getvalue().encode("utf-8-sig"), 9))
        part += 1; kept = []

    done = False
    while time.time() - t0 < MAX_MIN * 60 and total + len(kept) < TARGET:
        try:
            d = scan(after)
        except Exception as e:
            print("수집 중단 (다음 실행에서 이어서):", e); break
        items = d.get("items") or []
        seen += len(items)
        for it in items:
            if it.get("key") in have:
                continue
            r = row(it)
            if r:
                kept.append(r); have.add(r["상품코드"])
        pg = d.get("page") or {}
        nxt = pg.get("endCursor")
        if not items or not nxt or nxt == after:  # 오너클랜 hasNextPage 값은 믿지 않고, 받은 게 없거나 커서가 그대로일 때만 끝
            done = True; st["cursor"] = None; st["rounds"] = st.get("rounds", 0) + 1; break
        after = nxt
        st.update(cursor=after, seen=st.get("seen", 0) + len(items))
        if len(kept) >= PER_FILE:
            total += len(kept); flush()
            STATE.write_text(json.dumps(st), encoding="utf-8")
            push_now(total)
    total += len(kept); flush()
    st["warehouse_total"] = total; st["at"] = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    STATE.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    el = time.time() - t0
    print(f"이번 실행: 오너클랜 {seen:,}개 확인, 창고 누적 {total:,}개 ({el / 60:.0f}분){' — 전체 한 바퀴 완료' if done else ''}")


if __name__ == "__main__":
    main()
