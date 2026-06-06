/*
 * Genosyn service worker.
 *
 * This is a plain static file the browser fetches directly at /sw.js — it is
 * not part of the TypeScript build (a service worker cannot be a bundled
 * module). Registered from client/main.tsx in production only; in dev it would
 * fight Vite's HMR. See also manifest.webmanifest.
 *
 * Genosyn is an API-driven app that is useless without its server, so this
 * worker is about installability + a fast, resilient shell, not deep offline:
 *   - navigations   → network-first, falling back to the cached shell offline
 *   - static assets → stale-while-revalidate (Vite content-hashes filenames,
 *                     so a cached asset is never stale for its URL)
 *   - /api/*        → never touched; always hits the network (auth-sensitive,
 *                     dynamic, and covers the WebSocket + SSE endpoints)
 *
 * Bump CACHE when the caching logic changes to drop stale caches on activate.
 */
const CACHE = "genosyn-v1";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Precache the shell so the app opens offline once installed. Best-effort:
      // a failed precache must not block the worker from installing.
      try {
        await cache.add(new Request(SHELL, { cache: "reload" }));
      } catch {
        /* offline at install time — the fetch handler will fill the cache */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Same-origin only — leave Google Fonts and any other cross-origin GETs to
  // the browser's own HTTP cache.
  if (url.origin !== self.location.origin) return;
  // The API (including /api/ws and SSE streams) must always reach the server.
  if (url.pathname.startsWith("/api/")) return;

  // App navigations: prefer the network so we always render the latest shell
  // (which references the current content-hashed assets); fall back to the
  // cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(SHELL, fresh.clone());
          return fresh;
        } catch {
          const cached =
            (await caches.match(SHELL)) || (await caches.match("/"));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets (JS, CSS, icons, fonts): serve from cache immediately and
  // refresh the entry in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })(),
  );
});
