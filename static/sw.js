// 땡잡았땡 서비스워커 — 항상 최신 화면을 먼저 받고, 인터넷이 끊겼을 때만 안내 화면을 보여줍니다.
const CACHE = "ttaeng-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["offline.html", "style.css", "favicon.svg"]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;            // 화면 이동만 처리 (나머지는 브라우저 기본 동작)
  e.respondWith(fetch(e.request).catch(() => caches.match("offline.html")));
});
