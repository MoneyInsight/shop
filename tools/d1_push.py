"""상품 DB(D1)에 오늘 몫 올리기 — GitHub Actions(catalog_d1.yml)에서 실행
- DB가 없으면 만듦(이름 allchaeum), 표 구조 적용
- dist/d1/0001.sql … 을 차례로 올리되, 최근 24시간 쓰기 줄 수가 한도(LIMIT, 기본 9만)에 닿기 전에 멈춤 (무료 하루 10만 줄)
- 성공한 파일만 상태에 반영 → 실패·중단돼도 다음 날 이어서 (같은 상품을 다시 넣어도 결과는 같음)
- 결과는 data/d1_status.json 에 기록 (사장님·Claude가 깃허브에서 확인)
"""
import json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = os.environ.get("D1_NAME", "allchaeum")
LIMIT = int(os.environ.get("D1_WRITE_LIMIT", "85000"))  # 무료 10만 줄 — 집계가 몇 분 늦게 잡혀 여유를 둠
STATE = Path(os.environ.get("D1_STATE", ROOT / "dist/d1_state.json"))
D = ROOT / "dist/d1"
WD = ROOT / "dist/d1cfg"  # wrangler 설정 (DB 이름·id만)
STATUS = ROOT / "data/d1_status.json"
LOG = ROOT / "data/d1_log.json"  # 최근 올린 기록 [시각, 상품 수] — 쓰기 집계가 늦게 잡혀도 한도를 넘지 않게 직접 셈
PER = float(os.environ.get("D1_PER", "4.5"))  # 상품 1개당 쓰기 줄 수 (실측 3.3~4.1, 여유 포함)


def wr(*args, check=True, timeout=900):
    r = subprocess.run(["npx", "-y", "wrangler@4", *args], cwd=WD, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f"wrangler {' '.join(args[:3])} 실패: {(r.stderr or r.stdout)[-800:]}")
    return r


def js(text):
    i = min([k for k in (text.find("["), text.find("{")) if k >= 0] or [0])
    return json.loads(text[i:])


def db_id():
    WD.mkdir(parents=True, exist_ok=True)
    (WD / "wrangler.toml").write_text('name = "d1-loader"\ncompatibility_date = "2026-11-01"\n', encoding="utf-8")
    dbs = js(wr("d1", "list", "--json").stdout)
    hit = next((d for d in dbs if d.get("name") == NAME), None)
    if not hit:
        out = wr("d1", "create", NAME).stdout
        print(out[-400:])
        dbs = js(wr("d1", "list", "--json").stdout)
        hit = next(d for d in dbs if d.get("name") == NAME)
    uid = hit.get("uuid") or hit.get("id")
    (WD / "wrangler.toml").write_text(
        f'name = "d1-loader"\ncompatibility_date = "2026-11-01"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "{NAME}"\ndatabase_id = "{uid}"\n', encoding="utf-8")
    return uid


def written_24h():
    try:
        info = js(wr("d1", "info", NAME, "--json", check=False).stdout)
        for k in ("rows_written_24h", "rowsWritten24h"):
            if k in info:
                return int(info[k] or 0)
    except Exception as e:
        print("쓰기량 확인 실패:", e)
    return None


def run_sql(path):
    for t in range(3):
        r = wr("d1", "execute", NAME, "--remote", "--yes", f"--file={path}", check=False, timeout=1200)
        if r.returncode == 0:
            return True, ""
        err = (r.stderr or r.stdout)[-600:]
        if re.search(r"limit|exceeded|quota|7500|too many", err, re.I):
            return False, err  # 한도 → 오늘은 그만
        time.sleep(20 * (t + 1))
    return False, err


def load_state_from_db():
    """캐시가 없을 때: DB에 이미 있는 상품 지문(id, h)을 받아 상태 복구 (id 순서로 10만 개씩 — 읽기 한도 아낌)"""
    st, last = {}, ""
    while True:
        q = f"SELECT id, h FROM products WHERE id > '{last}' ORDER BY id LIMIT 100000"
        r = wr("d1", "execute", NAME, "--remote", "--json", f"--command={q}", check=False, timeout=600)
        if r.returncode:
            print("DB 상태 읽기 실패(새 DB면 정상):", (r.stderr or r.stdout)[-300:]); break
        rows = (js(r.stdout) or [{}])[0].get("results") or []
        for x in rows:
            st[x["id"]] = x["h"]
        if len(rows) < 100000:
            break
        last = rows[-1]["id"]
    return st


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else "push"
    uid = db_id()
    print("상품 DB:", NAME, uid[:8] + "…")
    if stage == "prepare":  # 표 구조 + (캐시 없으면) 상태 복구
        D.mkdir(parents=True, exist_ok=True)
        cj = (ROOT / "worker/catalog.js").read_text(encoding="utf-8")
        (D / "schema.sql").write_text(re.search(r"SCHEMA = `([\s\S]*?)`", cj).group(1).strip(), encoding="utf-8")
        ok, err = run_sql(D / "schema.sql")
        if not ok:
            sys.exit("표 구조 적용 실패: " + err)
        if not STATE.exists():
            st = load_state_from_db()
            STATE.parent.mkdir(parents=True, exist_ok=True)
            STATE.write_text(json.dumps(st, separators=(",", ":")), encoding="utf-8")
            print("DB에서 상태 복구:", len(st), "개")
        return
    plan = json.loads((D / "plan.json").read_text(encoding="utf-8"))
    files = sorted(plan)
    w0 = written_24h()
    per = None  # 상품 1개당 실제 쓰기 줄 수 (첫 파일로 측정)
    done, stop, cum = [], "", 0
    now = time.time()
    day0 = now - now % 86400  # D1 하루 한도는 UTC 0시(한국 오전 9시)에 초기화
    log = [x for x in (json.loads(LOG.read_text()) if LOG.exists() else []) if x[0] >= day0]
    mine = sum(x[1] for x in log) * PER  # 오늘(UTC) 우리가 쓴 양 (직접 셈)
    for f in files:
        n = len(plan[f])
        w = mine + cum * PER  # 직접 센 오늘 쓰기량 (Cloudflare 집계는 최근 24시간 기준·지연이 있어 쓰지 않음)
        est = n * max(PER, per or 0)
        if w is not None and w + est > LIMIT:
            stop = f"최근 24시간 쓰기 {w:,}줄 + 다음 파일 예상 {est:,}줄 > 한도 {LIMIT:,}"; break
        if w is None and (cum + n) * 8 > LIMIT:  # 쓰기량을 못 읽으면 보수적으로 (상품 1개 = 8줄)
            stop = "쓰기량 확인 불가 → 보수적 한도에서 멈춤"; break
        ok, err = run_sql(D / f)
        if not ok:
            stop = f"{f} 실패: {err[-300:]}"; break
        done.append(f); cum += n
        LOG.write_text(json.dumps(log + [[now, cum]]), encoding="utf-8")
        w2 = written_24h()
        if w0 is not None and w2 is not None and w2 > w0:
            per = max(PER, (w2 - w0) / cum)  # 오늘 올린 전체 평균 (집계가 몇 분 늦게 잡혀서 파일 하나로 재면 들쭉날쭉)
        subprocess.run([sys.executable, str(ROOT / "tools/d1_state.py"), str(STATE), f], check=True)  # 파일마다 바로 저장
    st = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    summ = json.loads((D / "summary.json").read_text(encoding="utf-8"))
    status = {"at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "db": NAME, "in_db": len(st), "site_and_warehouse_total": summ["total"],
              "uploaded_today": sum(len(plan[f]) for f in done), "left": summ["total"] - len(st) + summ["delete"], "files_ok": len(done), "files_planned": len(files),
              "rows_written_24h_before": w0, "rows_written_24h_after": written_24h(), "writes_per_product": round(per, 1) if per else None,
              "unsafe_skipped": summ["unsafe_skipped"], "warehouse_files": summ["warehouse_files"], "stopped": stop}
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(status, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
