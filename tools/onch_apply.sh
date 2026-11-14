#!/bin/bash
# 온채널 매일 점검 마무리: 엑셀 파일 이름들을 인자로 받아 내려받기 → 변환 → 커밋·푸시
# 사용: bash tools/onch_apply.sh product_smartstore_2026..._xxx.xlsx ...  (또는 전체 주소)
set -e
cd "$(dirname "$0")/.."
D=$(mktemp -d /tmp/onch_XXXX)
for f in "$@"; do
  f=${f##*/}; [[ $f == product_* ]] || f="product_smartstore_$f"
  curl -sSf -o "$D/$f" "https://export.onch3.co.kr/$f"
done
echo "받음: $(ls "$D" | wc -l)개"
python3 -I tools/onch_convert.py "$D" data/onch_strict.json --out="${OUT:-온채널상품.csv}" ${CAT:+--cat=$CAT}
[ -n "$NO_GIT" ] && exit 0
git add "data/${OUT:-온채널상품.csv}"
if git diff --cached --quiet; then echo "변경 없음"; exit 0; fi
git commit -qm "온채널 품절·가격 점검 (매일)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q || (git pull -q --rebase -X theirs && git push -q) || (sleep 20; git pull -q --rebase -X theirs && git push -q)
echo "푸시 완료"
