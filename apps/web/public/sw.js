/*
 * Offline/cold-start shell. Caches only what is public and immutable:
 *  - the static app shell (index.html: markup and asset links, no user data),
 *  - hashed build assets (/assets/*-<hash>.*, immutable by name),
 *  - the public external basemap (style, sprites, glyphs, tiles) of the configured origin.
 * The platform API (/v1, /auth, /health, /openapi.json) is never intercepted or cached:
 * restricted data, sessions and published-layer tiles always go to the network.
 * Registered by src/shell/offline.ts with ?v=<build>&basemap=<style URL>.
 */
const params = new URL(self.location.href).searchParams;
const VERSION = params.get('v') || 'dev';
const BASEMAP_ORIGIN = (() => {
  try {
    return params.get('basemap') ? new URL(params.get('basemap')).origin : null;
  } catch {
    return null;
  }
})();
const SHELL = `pg-shell-${VERSION}`;
const ASSETS = 'pg-assets';
const BASEMAP = 'pg-basemap';
const LIMITS = { [ASSETS]: 300, [BASEMAP]: 3000 };
const NEVER = ['/v1/', '/auth/', '/health', '/openapi.json'];

// The entry assets are named only in index.html: read them from it so a cold start without
// network has the shell and its scripts/styles. Lazy chunks are cached when first loaded.
async function precache() {
  const shell = await caches.open(SHELL);
  const res = await fetch(new Request('/', { cache: 'reload' }));
  if (!res.ok) throw new Error(`shell HTTP ${res.status}`);
  const html = await res.clone().text();
  await shell.put('/', res);
  await shell.add(new Request('/favicon.svg', { cache: 'reload' }));
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
  await (await caches.open(ASSETS)).addAll(assets);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pg-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const over = keys.length - LIMITS[name];
  // Cache keys keep insertion order: the oldest entries go first.
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: ASSETS });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const cache = await caches.open(ASSETS);
    await cache.put(request, res.clone());
    void trim(ASSETS);
  }
  return res;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(BASEMAP);
  const hit = await cache.match(event.request);
  const update = fetch(event.request)
    .then(async (res) => {
      // Only plain public responses: no opaque, partial or error bodies.
      if (res.ok && res.status === 200 && res.type === 'cors') {
        await cache.put(event.request, res.clone());
        void trim(BASEMAP);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  const res = await update;
  return res ?? Response.error();
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    // The shell is the same static file for every route; refresh it on success.
    if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
      const cache = await caches.open(SHELL);
      await cache.put('/', res.clone());
    }
    return res;
  } catch {
    const shell = await caches.match('/', { cacheName: SHELL });
    return shell ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (NEVER.some((p) => url.pathname.startsWith(p))) return;
    if (request.mode === 'navigate') return event.respondWith(navigate(request));
    if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request));
    if (url.pathname === '/favicon.svg') {
      return event.respondWith(fetch(request).catch(async () => (await caches.match('/favicon.svg', { cacheName: SHELL })) ?? Response.error()));
    }
    return;
  }
  if (BASEMAP_ORIGIN && url.origin === BASEMAP_ORIGIN && request.credentials !== 'include') {
    event.respondWith(staleWhileRevalidate(event));
  }
});
