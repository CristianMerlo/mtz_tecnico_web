/* Service worker MTZ Técnico Franquicias: la API y api_base.json siempre a red;
   solo se cachea la cáscara. Funciona igual servido desde el túnel (raiz "/")
   que desde GitHub Pages ("/mtz_tecnico_web/"): todo relativo a este script. */
const CACHE = 'mtz-tecnico-v14';
const BASE = self.location.pathname.replace(/[^/]*$/, '');
const SHELL = [BASE, BASE + 'app/app.js', BASE + 'manifest.json', BASE + 'app/img/logo.png',
               BASE + 'app/img/icon-192.png', BASE + 'app/img/icon-512.png', BASE + 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !SHELL.includes(url.pathname)) return;  // API/json: directo a red
  e.respondWith(
    fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match(BASE)))
  );
});
