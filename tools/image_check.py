"""대표 사진 점검 (GitHub Actions에서 실행) — 결과: data/image_fix.json
각 상품 대표 사진을 실제로 받아보고:
  ok    : 그대로 (https로 잘 보임)
  https : http 주소지만 https로 바꾸면 보임 → 주소만 https로
  proxy : 다른 사이트에서 못 보게 막았거나 http 전용 → 우리 서버(/img)가 대신 받아 보여줌
  dead  : 사진이 지워짐 → 상품의 다른 사진 중 보이는 것으로 교체(alt), 하나도 없으면 상품을 내림
"""
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["NO_IMGFIX"] = "1"  # 원래 주소로 점검
os.environ["WITH_WAREHOUSE"] = "1"  # 상품 DB에만 있는 상품(오너클랜·창고)도 함께
import build

SITE = "https://moneyinsight.github.io/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def fetch(u, referer):
    h = {"User-Agent": UA, "Range": "bytes=0-4095", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}
    if referer:
        h["Referer"] = SITE
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=20) as r:
            ct = r.headers.get("Content-Type", "")
            body = r.read(4096)
            return r.status in (200, 206) and (ct.startswith("image/") or body[:4] in (b"\x89PNG", b"GIF8", b"RIFF") or body[:3] == b"\xff\xd8\xff")
    except Exception:
        return False


def check(u):
    if not u.startswith("http"):
        return "ok"
    https = "https://" + u[7:] if u.startswith("http://") else u
    for t in range(2):
        if fetch(https, True):
            return "ok" if https == u else "https"
        if fetch(u, False) or fetch(https, False):
            return "proxy"
        time.sleep(2)
    return "dead"


def main():
    ps = build.load_products()
    urls = {}
    for p in ps:
        if p.get("image"):
            urls.setdefault(p["image"], []).append(p["id"])
    print(f"상품 {len(ps)}개, 대표 사진 {len(urls)}개 점검")
    t0 = time.time()
    with ThreadPoolExecutor(48) as ex:
        res = dict(zip(urls, ex.map(check, urls)))
    cnt = {k: sum(1 for v in res.values() if v == k) for k in ("ok", "https", "proxy", "dead")}
    print("결과:", cnt, f"{time.time() - t0:.0f}초")
    # 사진이 지워진 상품: 같은 상품의 다른 사진 중 보이는 것으로
    alt, cand = {}, {}
    for p in ps:
        if res.get(p.get("image")) == "dead":
            others = [x for x in (p.get("images") or []) if x and x != p["image"]]
            others += re.findall(r'<img[^>]+src=["\\\']([^"\\\']+)', p.get("detail_html") or "")[:3]
            cand[p["id"]] = [x if x.startswith("http") else "https:" + x if x.startswith("//") else x for x in others][:4]
    flat = sorted({u for v in cand.values() for u in v if u.startswith("http")})
    with ThreadPoolExecutor(48) as ex:
        r2 = dict(zip(flat, ex.map(check, flat)))
    for pid, us in cand.items():
        for u in us:
            if r2.get(u) in ("ok", "https", "proxy"):
                alt[pid] = [u, r2[u]]; break
    out = {"at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "count": cnt, "alt_found": len(alt),
           "map": {u: v for u, v in res.items() if v != "ok"}, "alt": alt}
    (ROOT / "data/image_fix.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"사진 지워진 상품 {len(cand)}개 중 다른 사진으로 교체 {len(alt)}개, 내림 {len(cand) - len(alt)}개")


if __name__ == "__main__":
    main()
