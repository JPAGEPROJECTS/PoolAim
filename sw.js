'use strict';
/*
 * Service worker: guarda la app en caché para que funcione sin conexión.
 * Primero intenta la red (así siempre se ve la última versión) y guarda la respuesta;
 * sin conexión responde desde la caché. Sube VERSION si cambia la lista de archivos.
 */
const VERSION = 'poolaim-v5';
const FILES = [
  './',
  'index.html',
  'css/styles.css',
  'js/physics.js',
  'js/bank.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const key = req.mode === 'navigate' ? './' : req;
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(key, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })
  );
});
