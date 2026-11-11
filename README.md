# 땡잡았땡 — 오픈마켓 수수료 없는 직판 쇼핑몰

GitHub Pages로 운영하는 자체 쇼핑몰입니다. 카테고리별 상품, 장바구니, 토스페이먼츠 결제, 공급사 입점·상품등록, 네이버쇼핑 가격비교 EP를 지원합니다.

## 상품 관리
- `data/products.csv`를 엑셀로 열어 고치고 저장하면, 깃허브에 올라가는 즉시 사이트가 다시 만들어집니다.
- 칸: id, 상품명, 카테고리(living/tools/sleep/digital/food), 판매가, 정가, 배송비, 이미지, 브랜드, 제조사, 원산지, 이벤트문구, 배지(BEST/NEW), 한줄소개, 상세설명(`|`로 줄 구분), 공급사, 상태(판매중/품절)
- 이미지는 `uploads/` 폴더에 넣고 `uploads/파일명.jpg`처럼 적거나, 이미지 주소(https://…)를 그대로 적습니다.

## 설정 (`config.json`)
- `base_url`: 사이트 주소 (도메인 연결 후 바꾸기)
- `toss_client_key`: 지금은 테스트 키. PG 계약 후 실제 클라이언트 키로 교체
- `worker_url`: 결제 승인·공급사·관리자 서버 주소 (아래 설치 후 입력)
- `margin_rate`, `min_margin_won`: 공급사 상품 자동 판매가 마진
- `business`: 사업자 정보 (푸터·약관에 표시, 반드시 실제 정보로 수정)
- `naver_site_verification`: 네이버 서치어드바이저 사이트 확인 코드

## 서버 설치 (Cloudflare Workers, 무료)
```
cd worker
npx wrangler login
npx wrangler kv namespace create SHOP     # 나온 id를 wrangler.toml에 입력
npx wrangler secret put TOSS_SECRET_KEY   # 테스트: test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GITHUB_TOKEN      # 이 저장소 Contents 읽기/쓰기 권한
npx wrangler deploy                       # 나온 주소를 config.json의 worker_url에 입력
```

## 네이버 가격비교 등록
1. 네이버 쇼핑파트너센터 가입 → 쇼핑몰 등록
2. 상품 DB URL(EP 3.0): `https://사이트주소/naver_ep.txt`
3. 검수 승인 후 충전금 충전하면 노출 시작 (클릭당 과금)
4. 네이버 서치어드바이저에 사이트 등록 + `sitemap.xml` 제출

## 페이지
- `/admin.html` 관리자 (입점 승인, 상품 승인, 주문·발주 확인)
- `/seller.html` 공급사 입점 신청·상품 등록
