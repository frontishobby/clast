/**
 * Offline support. Plain file rather than a build plugin: the app is one page
 * plus a handful of hashed assets, which is small enough to handle by hand.
 *
 * - The page itself is network-first, so a deploy shows up on the next load
 *   and the cached copy is only a fallback for when there is no network.
 * - Everything else under our origin is cache-first. Vite hashes asset names,
 *   so a cached file can never be stale, only unused -- and unused ones are
 *   pruned whenever a fresh page comes in.
 *
 * Online play still needs a network, of course; single player does not.
 */

const CACHE = 'clast-v1';
const SHELL = ['./', './manifest.webmanifest', './favicon.svg', './icons/icon-192.png'];

/** Asset URLs a page references, so they can be cached before first use. */
function assetsIn(html) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)) {
    urls.add(new URL(m[1], self.registration.scope).href);
  }
  return urls;
}

async function cachePage(cache, res) {
  const html = await res.clone().text();
  const wanted = assetsIn(html);
  await cache.put(self.registration.scope, res);
  await Promise.all(
    [...wanted].map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url);
    }),
  );
  // Drop hashed assets the current page no longer points at.
  for (const req of await cache.keys()) {
    if (req.url.includes('/assets/') && !wanted.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL.slice(1));
      const res = await fetch(self.registration.scope, { cache: 'no-cache' });
      if (res.ok) await cachePage(cache, res);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res.ok) event.waitUntil(cachePage(cache, res.clone()));
          return res;
        } catch {
          return (await cache.match(self.registration.scope)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) event.waitUntil(cache.put(req, res.clone()));
      return res;
    })(),
  );
});
