"""도매꾹 목록 API에서 '인기순' 정렬·인기 지표가 있는지 확인 (호출 약 14번) → data/dm_list_probe.json"""
import json, sys, traceback
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import domeggook_discover as d

out = {}
base = {"ver": "4.1", "mode": "getItemList", "market": "supply", "kw": "볼펜", "sz": "20", "pg": "1"}
for so in ["", "rd", "ha", "hd", "da", "aa", "ad", "sa", "sd", "ra", "pop", "sale"]:
    try:
        r = d.api({**base, **({"so": so} if so else {})})
        g = r.get("domeggook") or {}
        lst = g.get("list") or {}
        items = lst.get("item") if isinstance(lst, dict) else lst
        if isinstance(items, dict):
            items = [items]
        items = items or []
        out[so or "기본"] = {"header": g.get("header"), "raw_head": json.dumps(r, ensure_ascii=False)[:600],
                            "first": items[:2], "nos": [it.get("no") if isinstance(it, dict) else it for it in items[:20]]}
    except Exception:
        out[so or "기본"] = {"error": traceback.format_exc()[-500:], "nos": []}
nos = next((v["nos"] for v in out.values() if v.get("nos")), [])[:2]
for no in nos:
    try:
        out["view_" + str(no)] = d.api({"ver": "4.5", "mode": "getItemView", "no": no})
    except Exception:
        out["view_" + str(no)] = {"error": traceback.format_exc()[-500:]}
Path("data/dm_list_probe.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({k: v.get("nos", [])[:5] for k, v in out.items() if not k.startswith("view_")}, ensure_ascii=False))
