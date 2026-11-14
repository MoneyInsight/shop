// 올채움 서비스워커 — 항상 최신 화면을 먼저 받고, 인터넷이 끊겼을 때만 안내 화면을 보여줍니다.
const CACHE = "allchaeum-v5";
const API = new URL(self.location.href).searchParams.get("api") || "";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["offline.html", "style.css", "favicon.svg"]))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;            // 화면 이동만 처리 (나머지는 브라우저 기본 동작)
  e.respondWith(fetch(e.request).catch(() => caches.match("offline.html")));
});

// ── 웹 푸시: 서버는 빈 신호만 보내고, 내용은 여기서 가져와 표시 ──
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let list = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const r = await fetch(API + "/push/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub && sub.endpoint }) });
      list = (await r.json()).messages || [];
    } catch (err) {}
    if (!list.length) list = [{ title: "올채움", body: "새 알림이 있어요.", url: "./" }];
    await Promise.all(list.map((m, i) => self.registration.showNotification(m.title || "올채움", {
      body: m.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "ttaeng-" + Date.now() + i, data: { url: m.url || "./" } })));
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url === url);
    return c ? c.focus() : self.clients.openWindow(url);
  }));
});
