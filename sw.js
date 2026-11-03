/* Service worker: app shell offline + cache jadwal (network-first). */
'use strict';

const VERSION = '1.0.0';
const SHELL = `shell-${VERSION}`;
const DATA = 'data-v1';
const DATA_MAX = 40;
const ASSETS = [
  './',
  'assets/css/app.css?v=1.0.0',
  'assets/js/app.js?v=1.0.0',
  'assets/img/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - DATA_MAX; i++) await cache.delete(keys[i]);
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (res.ok) {
      cache.put(req, res.clone()).then(() => cacheName === DATA && trim(cache));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/api.php')) {
    const action = url.searchParams.get('action');
    if (action === 'schedule' || action === 'cities') e.respondWith(networkFirst(req, DATA, 7000));
    return; // locate: selalu langsung ke jaringan
  }

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, SHELL, 5000).catch(() => caches.match('./')));
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    return win ? win.focus() : self.clients.openWindow('./');
  }));
});
