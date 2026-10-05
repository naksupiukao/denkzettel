// Denkzettel Service Worker
// - empfängt Push-Nachrichten vom Server und zeigt sie an
// - hält die App offline verfügbar

const CACHE = 'denkzettel-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Seiten: erst Netz, bei Funkloch aus dem Speicher. API-Aufrufe nie zwischenspeichern.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || caches.match('./index.html');
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Denkzettel', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: './', reminderId: data.tag || null },
    });
    // Offene App informieren, damit sie die Erinnerung als erledigt markiert
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    all.forEach((c) => c.postMessage({ type: 'push-shown', reminderId: data.tag || null }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
