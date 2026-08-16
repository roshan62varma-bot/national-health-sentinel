/*
 * AegisHealth service worker.
 * Caching strategies (Section 1.1):
 *  - App shell / static assets  -> cache-first (instant cold start in the field)
 *  - Dashboard GET endpoints    -> stale-while-revalidate (last-known state now, refresh silently)
 *  - Write actions (POST)       -> network-first, queued in IndexedDB on failure and
 *                                  replayed via Background Sync when connectivity returns.
 * Conflict resolution is last-write-wins by server timestamp; overwritten offline
 * entries are retained server-side in the append-only audit_log.
 */
const SHELL = "aegis-shell-v1";
const DATA = "aegis-data-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/field", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Write actions: network-first, queue on failure for Background Sync replay.
  if (req.method !== "GET") {
    event.respondWith(
      fetch(req.clone()).catch(async () => {
        const body = await req.clone().text();
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.postMessage({ type: "aegis-queue", url: req.url, body }));
        if (self.registration.sync) await self.registration.sync.register("aegis-write-queue");
        return new Response(JSON.stringify({ queued: true }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return;
  }

  // Dashboard data: stale-while-revalidate.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      caches.open(DATA).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // App shell / static: cache-first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && req.destination !== "document") {
            caches.open(SHELL).then((c) => c.put(req, res.clone()));
          }
          return res;
        }),
    ),
  );
});

// Red-tier alerts must reach a District Officer with the app closed.
self.addEventListener("push", (event) => {
  let payload = { title: "AegisHealth alert", body: "Red-tier condition detected." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* keep the default copy rather than dropping the alert */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: "aegis-red-tier",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});