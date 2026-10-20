/* Service worker for Market Brief
 * - Bump VERSION on every release of the app files (not needed for new bulletins).
 * - Add every file the app needs offline to PRECACHE (relative paths only).
 */
const VERSION = '1.0.0';
const CACHE = `market-brief-${VERSION}`;
const BRIEFS = 'market-brief-bulletins';   // bulletins outlive app versions

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  // Wait for the user to tap "refresh" (app.js sends SKIP_WAITING)
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('market-brief-') && k !== CACHE && k !== BRIEFS).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Bulletins change every morning: network first, keep a copy for offline listening
  if (new URL(req.url).pathname.includes('/briefs/')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(BRIEFS).then(c => c.put(req.url, copy)); }
          return res;
        })
        .catch(() => caches.open(BRIEFS).then(c => c.match(req.url)))
    );
    return;
  }

  // Pages: network first (fresh content), fall back to cached app shell when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else: cache first, then network (and store what we fetch)
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
});
