// ラク経費のオフライン対応と、Android の「共有」から画像を受け取る処理
// ファイルを更新したら VERSION を上げる
const VERSION = 'rakukeihi-v12';
const FILES = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/ocr.js', './js/parse.js', './js/report.js', './js/crop.js',
  './js/store.js', './js/pdfin.js', './js/books.js', './js/assets.js', './js/finance.js', './js/bank.js', './js/eml.js', './js/invoice.js',
  './js/exports.js', './js/aijournal.js', './js/share.js', './js/policy.js', './js/zengin.js', './js/vault.js',
  './pc/', './pc/index.html', './pc/pc.css', './pc/pc.js', './pc/ui.js', './pc/editor.js', './pc/charts.js', './pc/features.js', './pc/manifest.webmanifest',
  './guide/', './guide/index.html', './guide/img/m-edit.jpg', './guide/img/m-home-drafts.jpg', './guide/img/m-home-empty.jpg', './guide/img/m-list.jpg', './guide/img/m-report.jpg', './guide/img/m-settings-drive.jpg', './guide/img/m-settings-top.jpg', './guide/img/m-transit.jpg', './guide/img/p-books.jpg', './guide/img/p-detail.jpg', './guide/img/p-home.jpg', './guide/img/p-list.jpg', './guide/img/p-report.jpg', './guide/img/p-review.jpg', './guide/img/p-settings-sync.jpg', './guide/img/p-settings-who.jpg', './guide/img/p-statements.jpg',
  './vendor/anthropic-sdk.mjs', '../lib/gdrive.js', '../config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];
// 端末内 OCR の部品（初めて使ったときに保存して、次からはオフラインでも動く）
const CDN = 'https://cdn.jsdelivr.net/npm/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rakukeihi-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 共有された画像を一時保存してアプリを開く
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('receipts').filter((f) => f && typeof f !== 'string');
      const cache = await caches.open('rakukeihi-share');
      await Promise.all(files.map((f, i) => cache.put(`./__shared/${Date.now()}-${i}`, new Response(f, { headers: { 'content-type': f.type || 'image/jpeg' } }))));
      return Response.redirect(`./?shared=${files.length}`, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;

  // OCR の部品（版を固定しているので、保存したものを使う）
  if (url.href.startsWith(CDN)) {
    e.respondWith(caches.open('rakukeihi-cdn').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // アプリ本体: ネット優先、つながらないときは保存したもの
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === 'navigate' ? caches.match(url.pathname.includes('/pc/') ? './pc/index.html' : './index.html') : Response.error()))),
  );
});
