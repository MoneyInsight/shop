"""D1에 성공적으로 올린 SQL 파일만 상태(d1_state.json)에 반영 — python3 tools/d1_state.py 상태파일 성공파일1 [성공파일2 ...]"""
import json, sys
from pathlib import Path
st_path = Path(sys.argv[1])
st = json.loads(st_path.read_text(encoding="utf-8")) if st_path.exists() else {}
plan = json.loads(Path("dist/d1/plan.json").read_text(encoding="utf-8"))
for f in sys.argv[2:]:
    for i, h in plan.get(f, {}).items():
        if h is None:
            st.pop(i, None)
        else:
            st[i] = h
st_path.parent.mkdir(parents=True, exist_ok=True)
st_path.write_text(json.dumps(st, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("DB에 올라간 상품:", len(st))
