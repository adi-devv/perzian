// Perzian's service worker: shows Web Push notifications and opens the app on the right session when tapped.
// It holds no token and no data. A push says only a status word and a session title (no code, no diffs).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const SESSION_URL = /^\/#session=([\w-]{1,64})$/;

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {}
  const text = (v, n, fallback) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : fallback);
  // Every push must show something (iOS revokes the subscription otherwise).
  event.waitUntil(
    self.registration.showNotification(text(d.title, 80, "Perzian"), {
      body: text(d.body, 160, ""),
      tag: "perzian",
      renotify: true,
      icon: "icon-192.png",
      data: { url: typeof d.url === "string" && (d.url === "/" || SESSION_URL.test(d.url)) ? d.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  const m = SESSION_URL.exec(url);
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (open.length) {
        await open[0].focus();
        if (m) open[0].postMessage({ type: "perzian.open", sessionId: m[1] });
        return;
      }
      await self.clients.openWindow(new URL(url, self.registration.scope).href);
    })(),
  );
});
