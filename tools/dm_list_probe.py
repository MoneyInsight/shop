"""도매꾹 목록 API에서 '인기순' 정렬이 되는지 확인 (호출 약 12번) → data/dm_list_probe.json"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import domeggook_discover as d

out = {}
base = {"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": "볼펜", "sz": "20", "pg": "1"}
for so in ["", "rd", "ha", "hd", "da", "aa", "ad", "sa", "sd", "ra", "pop", "sale"]:
    r = d.api({**base, **({"so": so} if so else {})})
    g = r.get("domeggook") or {}
    items = (g.get("list") or {}).get("item") or []
    if isinstance(items, dict):
        items = [items]
    out[so or "기본"] = {"header": g.get("header"), "err": None if g else str(r)[:300],
                        "first": [{k: it.get(k) for k in it} for it in items[:3]], "nos": [it.get("no") for it in items[:20]]}
Path("data/dm_list_probe.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({k: v["nos"][:5] for k, v in out.items()}, ensure_ascii=False))
