// オフライン用キャッシュ。ファイルを更新したら VERSION を上げる
const VERSION = 'genbacad-v8';
const FILES = [
  './', './index.html', './css/style.css', './js/app.js', './js/geo.js', './js/io.js', './js/cogo.js', './js/calc.js', './js/sheet.js',
  './js/draft.js', './js/sync.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './pc/', './pc/index.html', './pc/pc.css', './pc/main.js', './pc/geom.js', './pc/icons.js', './pc/commands.js', './pc/civil.js', './pc/link.js', './pc/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネット優先・オフライン時はキャッシュ
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match(new URL(e.request.url).pathname.includes('/pc/') ? './pc/index.html' : './index.html'))),
  );
});
