"""사이트를 상품 DB 모드로 자동 전환 (한 번만) — 아래 점검을 모두 통과해야 config.json catalog_api=true
① 사이트 상품의 99% 이상이 DB에 들어감 ② 서버가 DB에 연결됨 ③ 검색·상품 조회가 되고 ④ 표본 상품 가격·배송비가 사이트와 같음
통과 못 하면 아무것도 바꾸지 않음 (지금 사이트 그대로)
"""
import json, os, random, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
W = cfg["worker_url"].rstrip("/")
SITE = "https://moneyinsight.github.io/shop"


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "allchaeum-check"}), timeout=30) as r:
        return json.loads(r.read().decode())


def out(k, v):
    if os.environ.get("GITHUB_OUTPUT"):
        open(os.environ["GITHUB_OUTPUT"], "a").write(f"{k}={v}\n")


def main():
    if cfg.get("catalog_api"):
        print("이미 상품 DB 모드"); return
    st = json.loads((ROOT / "data/d1_status.json").read_text(encoding="utf-8"))
    site = json.load(open(ROOT / "dist/site_ids.json"))
    state = json.load(open(ROOT / "dist/d1_state.json"))
    have = sum(1 for i in site if i in state)
    print(f"사이트 상품 {len(site)}개 중 DB에 {have}개")
    if have < len(site) * 0.99:
        print("아직 다 안 들어감 → 전환 안 함"); return
    h = get(W + "/health")
    if "연결됨" not in str(h.get("catalog", "")):
        print("서버에 상품 DB 연결 안 됨 → 전환 안 함", h.get("catalog")); return
    lst = get(W + "/catalog/list?" + urllib.parse.urlencode({"q": "볼펜", "size": 5}))
    if not lst.get("items"):
        print("검색 결과 없음 → 전환 안 함"); return
    bad = 0
    for pid in random.sample([i for i in site if i in state], 30):
        a = get(f"{SITE}/p/{urllib.parse.quote(pid)}.json")
        try:
            b = get(f"{W}/catalog/item?id={urllib.parse.quote(pid)}")
        except Exception:
            b = {}
        if int(a.get("price", 0)) != int(b.get("price", -1)) or int(a.get("shipping_fee") or 0) != int(b.get("shipping_fee") or 0):
            bad += 1; print("다름:", pid, a.get("price"), b.get("price"), a.get("shipping_fee"), b.get("shipping_fee"))
    if bad > 1:  # 하루 사이 가격 변동 1건 정도는 허용 (주문 때는 사이트 파일 가격을 우선 확인)
        print(f"표본 30개 중 {bad}개 다름 → 전환 안 함"); return
    t = (ROOT / "config.json").read_text(encoding="utf-8")
    assert '"catalog_api": false' in t
    (ROOT / "config.json").write_text(t.replace('"catalog_api": false', '"catalog_api": true', 1), encoding="utf-8")
    print("✅ 점검 통과 → 상품 DB 모드로 전환")
    out("switched", "1")


if __name__ == "__main__":
    main()
