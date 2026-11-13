# 상품 DB 켜기 (상품 수만~100만 개)

지금은 상품을 `products.json` 한 파일 + 상품마다 정적 페이지로 보여줍니다. 몇천 개까지는 이걸로 충분하고,
그보다 많아지면 아래처럼 **상품 DB 모드**로 바꿉니다. 코드는 모두 준비돼 있고, 서버만 켜면 됩니다.

## 이미 만들어 둔 것 (무료)
- `worker/catalog.js` — 상품 DB(Cloudflare D1, SQLite) 표·검색 색인(한글 2글자 조각)·목록/검색/상세/품절 갱신
- 서버 주소 `GET /catalog/list?q=&cat=&sort=&page=`, `/catalog/item?id=`, `/catalog/counts` (원가는 절대 안 나감)
- 결제 확인·가격 제안은 DB가 있으면 DB 가격으로 검증
- `product/item.html?id=상품번호` — 상품 페이지 1장으로 모든 상품을 보여주는 템플릿
- `tools/catalog_build.py` — 지금 상품 전부를 DB 파일(`dist/catalog.sqlite`)과 D1 업로드용 SQL로 변환
- 테스트: `tests/catalog_test.mjs`, `tests/ui_catalog_test.py`

## 켜는 순서 (서버 연결 때 = 나중에)
1. `npx wrangler d1 create ttaengjab` → `worker/wrangler.toml` 의 D1 4줄 주석 해제, id 입력
2. `python3 tools/catalog_build.py` → `npx wrangler d1 execute ttaengjab --remote --file=dist/catalog_001.sql` (파일마다)
3. `config.json` 의 `"catalog_api": true` → 커밋하면 사이트가 DB 모드로 바뀜

무료 한도(D1): 저장 5GB, 하루 읽기 500만 행 — 100만 개 상품(상세는 이미지 주소만 저장)도 들어갑니다.
