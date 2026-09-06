const CACHE_NAME = 'bianastore-v17'; // bumped: quick-buy do feed agora mostra seletor de cor
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js?v=13',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/material-symbols-outlined.woff2',
];

// Install: cache static shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for the app shell HTML, cache-first for versioned assets
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests (font is now self-hosted, no external font CDN needed)
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // The app shell HTML (/ and /index.html, or any navigation) was the
  // actual source of a real bug: serving it cache-first meant that if a
  // stale copy EVER landed in the cache (e.g. a leftover background tab
  // still fetching an old ?v=N asset gets cached alongside it), every
  // future load kept re-serving that same stale HTML forever — with its
  // old app.js?v=N reference baked in — and the app could never update
  // itself again short of the user manually clearing site data. Network-first
  // here means a new deploy is picked up on the very next load while
  // online; cache is only a fallback for genuinely being offline.
  const isAppShell = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isAppShell) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first (stale-while-revalidate) for everything else — versioned
  // assets like app.js?v=N, icons, and the font are safe to serve
  // immediately from cache since their URL itself changes whenever the
  // content does.
  e.respondWith(
    caches.match(request).then(cached => {
      const fetchPromise = fetch(request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Push notifications
self.addEventListener('push', e => {
  const data = e.data?.json() || { title: 'BianaStore', body: 'Nova oferta disponível!' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'bianastore-push',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
});
