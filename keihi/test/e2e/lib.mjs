// 画面の自動テストの道具: リポジトリを配るサーバー・ブラウザ・テスト用の偽の Google
// 使い方は keihi/test/e2e/README.md
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
export { devices };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain' };
// リポジトリをそのまま配る（GitHub Pages と同じ形）
export function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

// 日本語のファイル名で保存されるように、UTF-8 で起動する
export const launch = () => chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });

// ページを開いて、エラーを集める
export async function openPage(browser, url, { phone = false, viewport = { width: 1400, height: 900 }, ready = '#app', setup = null } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', locale: 'ja-JP', acceptDownloads: true, ...(phone ? devices['iPhone 13'] : { viewport }) });
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(url); await page.waitForSelector(ready);
  return page;
}
export const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
export const texts = (page, sel) => page.$$eval(sel, (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
export async function download(page, click) { const [d] = await Promise.all([page.waitForEvent('download'), click()]); return d; }

// ---- テスト用の偽の Google（ログインと Drive API v3 の一部）。同じ drive を渡したページどうしは「同じアカウント」 ----
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
export function fakeDrive() {
  const files = new Map(); let seq = 0; let clock = Date.parse('2026-11-20T00:00:00Z');
  const now = () => new Date(clock += 1000).toISOString();
  const pub = (f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: String(f.content.length), appProperties: f.appProperties });
  const create = (meta, content = Buffer.alloc(0)) => { const f = { id: `f${++seq}`, name: meta.name, mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || ['root'], appProperties: meta.appProperties || {}, content, modifiedTime: now() }; files.set(f.id, f); return f; };
  const query = (q) => {
    let list = [...files.values()];
    for (const m of q.matchAll(/'([^']+)' in parents/g)) list = list.filter((f) => f.parents.includes(m[1]));
    const mt = q.match(/mimeType='([^']+)'/); if (mt) list = list.filter((f) => f.mimeType === mt[1]);
    const ap = q.match(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/); if (ap) list = list.filter((f) => f.appProperties[ap[1]] === ap[2]);
    return list;
  };
  const multipart = (buf, ct) => { const b = ct.match(/boundary=(.+)$/)[1].replace(/"/g, ''); return buf.toString('latin1').split(`--${b}`).slice(1, -1).map((p) => Buffer.from(p.slice(p.indexOf('\r\n\r\n') + 4, p.length - 2), 'latin1')); };
  async function handle(route) {
    const req = route.request(); const u = new URL(req.url()); const m = req.method(); const p = u.pathname;
    const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (!/^Bearer tok-/.test(req.headers().authorization || '')) return json({ error: { message: 'no auth' } }, 401);
    if (p === '/drive/v3/about') return json({ user: { emailAddress: 'tester@example.com' } });
    if (p === '/drive/v3/files' && m === 'GET') return json({ files: query(u.searchParams.get('q') || '').map(pub) });
    if (p === '/drive/v3/files' && m === 'POST') return json(pub(create(JSON.parse(req.postData()))));
    if (p === '/upload/drive/v3/files' && m === 'POST') { const [meta, content] = multipart(req.postDataBuffer(), req.headers()['content-type']); return json(pub(create(JSON.parse(meta.toString('utf8')), content))); }
    let mm = p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (mm && m === 'PATCH') { const f = files.get(mm[1]); f.content = req.postDataBuffer() || Buffer.alloc(0); f.modifiedTime = now(); return json(pub(f)); }
    mm = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (mm) {
      const f = files.get(mm[1]); if (!f) return json({ error: { message: 'nf' } }, 404);
      if (m === 'GET' && u.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': f.mimeType }, body: f.content });
      if (m === 'PATCH') { const meta = JSON.parse(req.postData() || '{}'); if (meta.name) f.name = meta.name; Object.assign(f.appProperties, meta.appProperties || {}); f.modifiedTime = now(); return json(pub(f)); }
      if (m === 'DELETE') { files.delete(f.id); return route.fulfill({ status: 204, headers: CORS, body: '' }); }
      return json(pub(f));
    }
    return json({ error: { message: `unknown ${m} ${p}` } }, 400);
  }
  return { files, handle };
}
const GIS = `window.google = { accounts: { oauth2: {
  initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: 'tok-' + Math.random().toString(36).slice(2), expires_in: 3599 }), 20); } }; },
  revoke(t, cb) { if (cb) cb(); } } } };`;
export const withFakeGoogle = (drive) => async (ctx) => {
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: GIS }));
  await ctx.route('https://www.googleapis.com/**', (r) => drive.handle(r));
  await ctx.addInitScript(() => { try { localStorage.setItem('gdrive.clientId', 'test-123.apps.googleusercontent.com'); } catch (_) { /* なし */ } });
};
// 画像の代わりの小さな JPEG（ブラウザで作る）
export const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
