"""SEO 자동 최적화 — 상품명·검색 태그·요약 설명을 지금 네이버 쇼핑에서 사람들이 찾는 말에 맞춰 다듬음

원칙 (손님을 속이지 않고, 사이트가 깨지지 않게):
  1) 상품명은 원래 이름을 바탕으로만 고침 — 홍보 문구(무료배송·최저가·특가…)·특수문자·같은 말 반복을 빼고,
     네이버에서 같은 상품을 부를 때 가장 많이 쓰는 '대표 이름'이 빠져 있으면 하나만 덧붙임
     (덧붙이는 말은 우리 상품 설명·카테고리에 실제로 있는 말이거나 네이버 분류 이름일 때만)
  2) 다른 회사 브랜드 이름은 절대 넣지 않음
  3) 검색 태그는 지금 잘 팔리는 같은 상품들 이름에 자주 나오는 말 + 우리 상품에 실제로 있는 말
  4) 관리자가 손으로 고친 SEO는 건드리지 않음 (자동으로 고친 것만 다시 고침)
  5) 검사에 하나라도 걸리면 그 상품은 원래대로 둠. 적용 전 값은 모두 백업 → 관리자 화면에서 한 번에 되돌리기

사용: python3 tools/seo_auto.py --mode preview|apply --scope site|db|cat:<slug>|ids:A,B --limit 20000
환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (네이버 검색 API, 없으면 규칙 정리만), ADMIN_PASSWORD
"""
import argparse, base64, collections, datetime, gzip, hashlib, hmac, json, os, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
W = "https://shop-api.scream0506.workers.dev"
CACHE = ROOT / "dist/seo_cache.json.gz"
UA = {"User-Agent": "damgosago-seo"}

PROMO = re.compile(r"무료\s*배송|무배|최저가|초특가|특가|파격|할인|세일|\bsale\b|이벤트|사은품|증정|당일\s*(발송|배송|출고)|빠른\s*배송|국내\s*배송|오늘\s*출발|"
                   r"강력\s*추천|추천\s*상품|인기\s*상품|베스트|\bbest\b|핫딜|대박|신상품?|정품\s*보장|100%\s*정품|공식\s*판매|한정\s*수량|품절\s*임박|"
                   r"도매|위탁|재고\s*정리|땡처리|가성비\s*갑|1\s*등|판매\s*1위|[가-힣]*셀러\s*제안\s*샵|셀러\s*제안", re.I)
SPECIAL = re.compile(r"[★☆♥♡◆◇■□●○▶◀▲▼※♣♠✔✨🔥💯!~^*=+|\\#@$%`{}<>\"']+")
COLORS = set("블랙 화이트 그레이 네이비 베이지 브라운 레드 블루 그린 옐로우 핑크 퍼플 오렌지 아이보리 카키 민트 실버 골드 검정 흰색 회색 남색 빨강 파랑 초록 노랑 분홍 보라 랜덤 혼합".split())
STOP = set("추천 강추 및 등 외 용 형 개 세트 1개 2개 상품 제품 신형 기본 고급 프리미엄 국산 국내산 수입 정품 새상품 단품 택1 선택 옵션 색상 사이즈 컬러 랜덤발송 랜덤".split())
GENERIC = set("대용량 소용량 미니 대형 중형 소형 휴대용 가정용 업소용 사무용 차량용 캠핑용 다용도 다용도용 초대형 슬림 접이식 고급형 일반형 신형 구형 남성 여성 남녀공용 아동 유아 성인 겨울 여름 사계절 간편 튼튼한 예쁜".split())
SPEC = re.compile(r"^(\d+([.,]\d+)?(mm|cm|m|ml|l|g|kg|매|개|입|장|p|pcs|ea|구|단|롤|인치|인용|켤레|족|팩|박스|세트|겹|호|종|미터|리터|w|v|mah|평)?|[xX×*]\d+.*|\d+[xX×*]\d+.*|\d+\+\d+|[a-z]{1,2}\d{2,}[a-z0-9-]*)$", re.I)
TOK = re.compile(r"[0-9A-Za-z가-힣][0-9A-Za-z가-힣.+\-]*")


def tokens(s):
    return TOK.findall(SPECIAL.sub(" ", str(s or "")))


def strip_tags(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(h or "")))


def clean_name(name):
    """홍보 문구·특수문자·같은 말 반복 빼기 (뜻이 있는 말은 그대로, 순서도 그대로)"""
    s = str(name or "")
    s = re.sub(r"[\[\(【〔]([^\]\)】〕]*)[\]\)】〕]", lambda m: "" if PROMO.search(m.group(1)) or not m.group(1).strip() else m.group(0), s)  # [무료배송] 같은 괄호는 통째로
    s = PROMO.sub(" ", s)
    s = SPECIAL.sub(" ", s)
    s = re.sub(r"(?<=[가-힣a-zA-Z])\s*/\s*(?=[가-힣a-zA-Z])", " ", s)  # 남성신발/파크골프/패션화 → 띄어쓰기
    out, seen = [], set()
    for w in s.split():
        k = w.lower().strip(",.·/-")
        if not k or k in seen:
            continue
        seen.add(k); out.append(w.strip(",·"))
    s = re.sub(r"\s+", " ", " ".join(out)).strip(" ,/-·")
    s = re.sub(r"[\[\(【〔]\s*[\]\)】〕]", "", s).strip()
    return s


def content_tokens(name):
    return [t for t in tokens(name) if not SPEC.match(t) and t not in COLORS and t not in STOP and len(t) >= 2 and not PROMO.search(t)]


def core_query(name):
    """검색에 쓸 핵심 말: 끝쪽 뜻있는 말 두 개 (한국어 상품명은 보통 끝이 '무엇'인지)"""
    ct = [t for t in content_tokens(re.sub(r"[\[\(【〔][^\]\)】〕]*[\]\)】〕]", " ", name)) if re.search(r"[가-힣]", t)]
    ct = [t for t in ct if t not in GENERIC and not (t.endswith("용") and len(t) <= 4)] or ct  # 군용·업소용 같은 '~용'은 핵심 말이 아님
    return ct[-1] if ct else ""


class Naver:
    def __init__(self, cid, sec, max_calls):
        self.cid, self.sec, self.left, self.ok, self.err = cid, sec, max_calls, bool(cid and sec), ""
        self.cache = {}
        if CACHE.exists():
            try:
                self.cache = json.loads(gzip.open(CACHE, "rt", encoding="utf-8").read())
            except Exception:
                self.cache = {}
        cut = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()  # 검색 흐름이 바뀌니 7일 지나면 다시 조회
        self.cache = {k: v for k, v in self.cache.items() if v.get("d", "") >= cut}
        self.calls = 0

    def shop(self, q):
        if q in self.cache:
            return self.cache[q]["items"]
        if not self.ok or self.left <= 0:
            return None
        url = "https://openapi.naver.com/v1/search/shop.json?" + urllib.parse.urlencode({"query": q, "display": 40, "sort": "sim"})
        for t in range(3):
            try:
                req = urllib.request.Request(url, headers={"X-Naver-Client-Id": self.cid, "X-Naver-Client-Secret": self.sec, **UA})
                d = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
                self.left -= 1; self.calls += 1
                items = [{"t": strip_tags(i.get("title")), "b": i.get("brand", ""), "m": i.get("maker", ""),
                          "c": [i.get("category%d" % k, "") for k in (1, 2, 3, 4)]} for i in d.get("items", [])]
                self.cache[q] = {"d": datetime.date.today().isoformat(), "items": items}
                time.sleep(0.11)  # 초당 10회 이하
                return items
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")[:200]
                if e.code in (401, 403):  # 키가 없거나 검색 API가 꺼져 있음 → 규칙 정리만
                    self.ok, self.err = False, f"네이버 검색 API를 쓸 수 없음 ({e.code}) {body}"; return None
                if e.code == 429:  # 하루 한도
                    if t == 2:
                        self.ok, self.err = False, "네이버 검색 API 하루 한도에 도달"; return None
                    time.sleep(5 * (t + 1)); continue
                time.sleep(2)
            except Exception:
                time.sleep(2)
        return None

    def save(self):
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(CACHE, "wt", encoding="utf-8") as f:
            f.write(json.dumps(self.cache, ensure_ascii=False, separators=(",", ":")))


class SearchAd:
    """네이버 검색광고 키워드 도구: 검색어 → 연관 검색어 + 월간 검색량 (PC+모바일). 무료, 광고를 안 해도 됨"""
    def __init__(self, key, secret, customer, cache, max_calls):
        self.key, self.secret, self.cust = key, secret, customer
        self.ok, self.err, self.calls, self.left, self.cache = bool(key and secret and customer), "", 0, max_calls, cache

    def related(self, q):
        k = "ad:" + q
        if k in self.cache:
            return self.cache[k]["items"]
        if not self.ok or self.left <= 0:
            return None
        path = "/keywordstool"
        url = "https://api.searchad.naver.com" + path + "?" + urllib.parse.urlencode({"hintKeywords": q.replace(" ", ""), "showDetail": 1})
        for t in range(3):
            ts = str(int(time.time() * 1000))
            sig = base64.b64encode(hmac.new(self.secret.encode(), f"{ts}.GET.{path}".encode(), hashlib.sha256).digest()).decode()
            try:
                req = urllib.request.Request(url, headers={"X-Timestamp": ts, "X-API-KEY": self.key, "X-Customer": self.cust, "X-Signature": sig, **UA})
                d = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
                self.calls += 1; self.left -= 1
                num = lambda v: int(v) if str(v).isdigit() else 5  # "< 10" 같은 값
                items = [{"k": x.get("relKeyword", ""), "v": num(x.get("monthlyPcQcCnt")) + num(x.get("monthlyMobileQcCnt"))} for x in d.get("keywordList", [])[:300]]
                self.cache[k] = {"d": datetime.date.today().isoformat(), "items": items}
                time.sleep(0.25)
                return items
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")[:200]
                if e.code in (401, 403):
                    self.ok, self.err = False, f"검색광고 API 키 오류 ({e.code}) {body}"; return None
                time.sleep(3 * (t + 1))
            except Exception:
                time.sleep(3)
        return None


def ad_words(rel, core, own_text, my):
    """연관 검색어 중 우리 상품에 맞는 것만: 핵심 말 + (우리 상품 설명에 실제로 있는 말) 조합, 검색량 순"""
    tags, syn = [], []
    for x in sorted(rel or [], key=lambda x: -x["v"]):
        w = x["k"].lower()
        if not w or x["v"] < 20 or PROMO.search(w) or any(st in w for st in ("추천", "가격", "할인", "최저", "후기", "순위", "파는곳", "쇼핑몰", "브랜드", "중고", "샵", "몰", "마켓", "스토어", "사이트", "매장", "판매", "구매", "만들기", "diy")):
            continue
        if not re.fullmatch(r"[가-힣0-9a-z]+", w):
            continue
        if core and core in w:
            rest = w.replace(core, "")
            parts = re.findall(r"[가-힣]{2,}|[0-9a-z]+", rest)
            if not rest or rest in own_text or (parts and "".join(parts) == rest and all(r in own_text for r in parts)):
                tags.append((w, x["v"]))
        elif w in own_text and w not in my and len(w) >= 2:
            syn.append((w, x["v"]))  # 같은 상품을 부르는 다른 이름 (우리 설명에 실제로 있는 말)
    return tags, syn


def market(items, my_tokens, core):
    """같은 상품을 파는 네이버 상위 상품들 → 자주 쓰는 말·브랜드·분류 (핵심 말이 이름에 있는 상품만 = 진짜 같은 종류)"""
    brands, df, cats = set(), collections.Counter(), collections.Counter()
    rel = [i for i in items if core and core in i["t"].lower()]
    for i in rel:
        for x in (i["b"], i["m"]):
            for t in tokens(x):
                if len(t) >= 2:
                    brands.add(t.lower())
        for c in i["c"]:
            if c:
                cats[c] += 1
        for t in set(x.lower() for x in content_tokens(i["t"])):
            df[t] += 1
    return rel, brands, df, cats


def optimize(p, nv):
    """상품 하나 → 새 SEO {name, kw, summary} (바뀐 것만), 이유 목록. 문제가 있으면 None"""
    name0 = str(p.get("name") or "").strip()
    if not name0:
        return None, ["이름 없음"]
    why = []
    name = clean_name(name0)
    if name != name0:
        why.append("홍보문구·특수문자·반복 정리")
    own_text = " ".join([name0, strip_tags(p.get("detail_html"))[:5000], " ".join(p.get("desc_lines") or []), str(p.get("category_name") or ""),
                         " ".join(str(o.get("v", "")) for o in (p.get("options") or [])), str(p.get("summary") or "")]).lower()
    my = set(t.lower() for t in content_tokens(name))
    q = core_query(name)
    tags, add = [], None
    items = nv.shop(q) if q else None
    ad = getattr(nv, "ad", None)
    core_w = q.split()[-1].lower() if q else ""
    arel = ad.related(core_w) if (ad and core_w) else None
    if arel:
        atags, syn = ad_words(arel, core_w, own_text, my)
        syn = [x for x in syn if not any(x[0] in t.lower() for t in tokens(name))]  # 이미 이름 속 말에 들어 있으면(신발 ⊂ 남성신발) 안 붙임
        if syn and syn[0][1] >= 1000 and len(name) + len(syn[0][0]) + 1 <= 50:
            add = syn[0][0]; name = f"{name} {add}"; why.append(f"검색 많은 이름 '{add}' 추가 (월 {syn[0][1]:,}회)")
        for w, v in atags[:8] + syn[1:3]:
            if w not in tags and w != core_w:
                tags.append(w)
        if tags:
            why.append(f"연관 검색어 {len(tags)}개 (월 검색량 순)")
        # 상품명 재구성: [브랜드] + 검색량 높은 대표 키워드(최대 2개, 우리 상품에 맞는 말만) + 나머지 원래 말 + 규격·색상 (50자 안)
        vol = {x["k"].lower(): x["v"] for x in arel}
        lead = []
        for w, v in sorted([x for x in atags + syn if x[1] >= 300], key=lambda x: -x[1]):
            if len(lead) >= 2:
                break
            if any(w in l or l in w for l, _ in lead):
                continue
            lead.append((w, v))
        if core_w and vol.get(core_w, 0) >= max([v for _, v in lead] or [0]) and not any(core_w in l for l, _ in lead):
            lead = [(core_w, vol[core_w])] + lead[:1]  # 핵심 말 자체가 제일 많이 찾는 말이면 맨 앞
        if lead:
            m = re.match(r"^\s*([\[\(][^\]\)]{1,20}[\]\)])\s*", name)
            brand = m.group(1) if m else ""
            rest = name[m.end():] if m else name
            toks = rest.split()
            spec = [t for t in toks if SPEC.match(t) or t in COLORS]
            body = [t for t in toks if t not in spec and not any(t.lower() in l for l, _ in lead)]
            cand = " ".join(x for x in [brand, " ".join(l for l, _ in lead), " ".join(body), " ".join(spec)] if x).strip()
            cand = re.sub(r"\s+", " ", cand)
            if 4 <= len(cand) <= 50 and cand.replace(" ", "") != name.replace(" ", ""):
                name = cand
                why.append("대표 키워드 앞으로: " + ", ".join(f"'{l}'(월 {v:,}회)" for l, v in lead))
    rel = []
    if items and not arel:
        rel, brands, df, cats = market(items, my, (q.split()[-1].lower() if q else ""))
    if len(rel) >= 5:  # 같은 종류 상품이 충분히 있을 때만 시장 말을 씀 (엉뚱한 말이 붙지 않게)
        n = max(1, len(rel))
        mybrand = set(t.lower() for t in tokens(p.get("brand") or "")) | set(t.lower() for t in tokens(re.findall(r"^[\[\(]([^\]\)]+)[\]\)]", name0)[0] if re.match(r"^[\[\(]", name0) else ""))
        bad = (brands - mybrand) | STOP | COLORS
        cat_words = set()
        for c, k in cats.most_common(6):
            for t in tokens(c):
                if len(t) >= 2:
                    cat_words.add(t.lower())
        # 대표 이름: 상위 상품 절반 이상이 쓰는 말 중, 우리 이름에 없고 (우리 상품 설명에 있거나 네이버 분류 이름) 인 것
        for t, k in df.most_common(15):
            if k / n < 0.5:
                break
            if t in my or t in bad or SPEC.match(t) or not re.search(r"[가-힣]", t) or len(t) < 2:
                continue
            if t in own_text:  # 이름에 붙이는 말은 우리 상품 설명에 실제로 있는 말만
                add = t; break
        for t, k in df.most_common(40):
            if k / n < 0.2 or len(tags) >= 8:
                break
            if t in bad or SPEC.match(t) or t in my or t == add or PROMO.search(t):
                continue
            if t in own_text or t in cat_words:
                tags.append(t)
        for c, _ in cats.most_common(3):
            for t in tokens(c):
                if len(t) >= 2 and t.lower() not in my and t.lower() not in tags and t.lower() not in bad and len(tags) < 10:
                    tags.append(t.lower())
        if add and add not in name and len(name) + len(add) + 1 <= 50:
            name = f"{name} {add}"; why.append(f"대표 검색어 '{add}' 추가")
        if tags:
            why.append("검색 태그 " + str(len(tags)) + "개")
    # 우리 이름의 핵심 말도 태그로 (검색 태그가 비지 않게)
    base = [t for t in content_tokens(name) if re.search(r"[가-힣a-zA-Z]", t)]
    kw = []
    for t in [q] + [x for x in base[::-1]] + tags + [str(p.get("category_name") or "")]:
        t = str(t).strip().lower()
        if t and t not in kw and len(kw) < 12 and not PROMO.search(t):
            kw.append(t)
    kw_s = ",".join(kw)[:300]
    top = [x for x in kw if x != q][:3]
    summary = f"{name} — {', '.join(top)} 찾으셨다면 담Go사Go에서 합리적인 가격으로 만나보세요." if top else f"{name} — 담Go사Go에서 합리적인 가격으로 만나보세요."
    summary = summary[:150]
    # 검사 (하나라도 걸리면 이름은 원래대로)
    problems = []
    if not (2 <= len(name) <= 60): problems.append("이름 길이")
    if PROMO.search(name): problems.append("홍보 문구 남음")
    if re.search(r"[<>\"']", name + kw_s + summary): problems.append("특수문자")
    core = q.split()[-1] if q else ""
    if core and core.lower() not in name.lower(): problems.append("핵심 말 빠짐")
    lost = [t for t in content_tokens(name0) if t.lower() not in name.lower()]
    if lost: problems.append("원래 말 빠짐: " + ",".join(lost[:3]))
    out = {}
    if not problems and name != name0:
        out["name"] = name
    elif problems:
        why.append("이름은 그대로(" + "/".join(problems) + ")")
    out["kw"] = kw_s
    out["summary"] = summary
    return out, why


def seo_current():
    cur = {}
    meta = json.loads(urllib.request.urlopen(urllib.request.Request(W + "/edits/seo", headers=UA), timeout=20).read().decode())
    for b in range(int(meta.get("n", 0))):
        cur.update(json.loads(urllib.request.urlopen(urllib.request.Request(f"{W}/edits/seo?b={b}", headers=UA), timeout=30).read().decode()))
    return cur


def admin(path, body):
    pw = urllib.parse.quote(os.environ.get("ADMIN_PASSWORD", "").strip())
    req = urllib.request.Request(W + path, data=json.dumps(body, ensure_ascii=False).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + pw, **UA})
    for t in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
        except urllib.error.HTTPError as e:
            if e.code < 500 or t == 3:
                raise RuntimeError(f"{path} {e.code} {e.read().decode('utf-8', 'replace')[:200]}")
        except Exception as e:
            if t == 3:
                raise
        time.sleep(5 * (t + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="preview")
    ap.add_argument("--scope", default="site")
    ap.add_argument("--limit", type=int, default=20000)
    ap.add_argument("--run", default="")
    ap.add_argument("--max-calls", type=int, default=int(os.environ.get("SEO_MAX_CALLS", "20000")))
    a = ap.parse_args()
    run = a.run or datetime.datetime.utcnow().strftime("%Y%m%d%H%M")
    t0 = time.time()
    report = {"run": run, "mode": a.mode, "scope": a.scope, "at": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z", "ok": False}
    try:
        if a.scope == "db" or a.scope.startswith("ids:"):
            os.environ["WITH_WAREHOUSE"] = "1"
        import build
        ps = build.load_products()
        if a.scope.startswith("cat:"):
            ps = [p for p in ps if p.get("category") == a.scope[4:]]
        elif a.scope.startswith("ids:"):
            want = {x.strip().upper() for x in a.scope[4:].split(",") if x.strip()}
            ps = [p for p in ps if str(p["id"]).upper() in want]
        cur = seo_current()
        manual = {i for i, e in cur.items() if e and not e.get("auto")}
        # 손으로 고친 것 빼고, 아직 안 한 것 → 오래전에 자동으로 한 것 순서 (검색 흐름이 바뀌니 다시)
        todo = [p for p in ps if p["id"] not in manual]
        todo.sort(key=lambda p: (cur.get(p["id"], {}).get("auto", "") if p["id"] in cur else "", -int(p.get("price") or 0)))
        todo = todo[:a.limit]
        nv = Naver(os.environ.get("NAVER_CLIENT_ID", "").strip(), os.environ.get("NAVER_CLIENT_SECRET", "").strip(), a.max_calls)
        nv.ad = SearchAd(os.environ.get("NAVER_AD_API_KEY", "").strip(), os.environ.get("NAVER_AD_SECRET", "").strip(), os.environ.get("NAVER_AD_CUSTOMER", "").strip(), nv.cache, a.max_calls)
        # 같은 핵심 말끼리 묶어서 조회 한 번으로 여러 상품
        todo.sort(key=lambda p: core_query(clean_name(p.get("name"))))
        rows, samples, stats, errs = [], [], collections.Counter(), 0
        today = datetime.date.today().isoformat()
        for p in todo:
            try:
                out, why = optimize(p, nv)
            except Exception as e:  # 한 상품 오류가 전체를 멈추지 않게
                errs += 1; stats["오류(건너뜀)"] += 1; continue
            if not out:
                stats["건너뜀"] += 1; continue
            old = cur.get(p["id"]) or {}
            row = {"id": p["id"], "kw": out["kw"], "summary": out["summary"], "auto": today}
            if out.get("name"): row["name"] = out["name"]; stats["상품명 개선"] += 1
            elif old.get("name"): row["name"] = old["name"]  # 예전에 자동으로 고친 이름 유지
            if old.get("kw") == row["kw"] and old.get("summary") == row["summary"] and old.get("name", "") == row.get("name", ""):
                stats["바뀐 것 없음"] += 1; continue
            rows.append(row); stats["태그·설명 갱신"] += 1
            if len(samples) < 300:
                samples.append({"id": p["id"], "before": p.get("name"), "after": row.get("name") or p.get("name"), "kw": row["kw"], "why": why})
            if time.time() - t0 > 5.3 * 3600:
                stats["시간 부족으로 다음에"] += 1; break
        nv.save()
        report.update({"total": len(ps), "checked": len(todo), "changed": len(rows), "stats": dict(stats), "api_calls": nv.calls + nv.ad.calls,
                       "api": "검색광고 키워드 도구 ok" if nv.ad.calls else ("쇼핑 검색 ok" if nv.ok and nv.calls else (nv.ad.err or nv.err or ("키 없음 — 규칙 정리만" if not (nv.cid or nv.ad.key) else "지난 조회 결과 사용"))), "samples": samples, "errors": errs})
        if a.mode == "apply" and rows:
            done = 0
            for k in range(0, len(rows), 2000):
                admin("/admin/seo-upload", {"rows": rows[k:k + 2000], "auto": True, "run": run})
                done += len(rows[k:k + 2000])
            report["applied"] = done
        report["ok"] = True
    except Exception as e:
        report["error"] = str(e)[:500]
        print("오류:", e)
    report["sec"] = int(time.time() - t0)
    print(json.dumps({k: v for k, v in report.items() if k != "samples"}, ensure_ascii=False))
    for s in report.get("samples", [])[:15]:
        print(" ·", s["id"], s["before"], "→", s["after"], "|", s["kw"][:80])
    try:
        admin("/admin/seo-auto-report", report)
    except Exception as e:
        print("보고 저장 실패:", e)
    if not report["ok"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
