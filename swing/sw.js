// スイングボードのオフライン用キャッシュ。画面のファイルを変えたら VERSION を上げる
const VERSION = 'swing-v2';
const FILES = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('swing-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// ネット優先（データは毎回新しいものを取りにいく）・つながらないときはキャッシュ
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
