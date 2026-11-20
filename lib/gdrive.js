// Google ドライブにブラウザから直接つなぐ（サーバーなし）。現場CAD・ラク経費で共通
// - ログインは Google Identity Services（トークン方式）。アクセストークンは 1 時間で切れるので、切れたら「つなぎ直す」を 1 回押す
// - 権限は drive.file: このアプリが作ったファイルだけを読み書きする（ほかのファイルは見えない）
// - OAuth のクライアント ID は config.js（または設定画面で貼り付け）。ID は秘密の情報ではない

import { GOOGLE_CLIENT_ID } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';
const LS = 'gdrive.';
const lsGet = (k) => { try { return localStorage.getItem(LS + k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(LS + k); else localStorage.setItem(LS + k, v); } catch (_) { /* 使えない */ } };

export const drive = {
  token: lsGet('token'), exp: +(lsGet('exp') || 0), email: lsGet('email') || '', used: lsGet('used') === '1',
};
export const clientId = () => (lsGet('clientId') || GOOGLE_CLIENT_ID || '').trim();
export const setClientId = (id) => lsSet('clientId', (id || '').trim() || null);
export const configured = () => !!clientId();
export const connected = () => !!drive.token && Date.now() < drive.exp - 60000;
// 一度つないだことがあって、トークンだけ切れている（「つなぎ直す」を出す）
export const needsReconnect = () => drive.used && !connected();

let gisP = null;
function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('Google のログイン部品を読み込めませんでした（インターネットにつながっていますか）')); };
    document.head.appendChild(s);
  });
  return gisP;
}

// つなぐ（ボタンを押したときに呼ぶ。ポップアップが出る）
export async function connect({ silent = false } = {}) {
  if (!configured()) throw new Error('Google の OAuth クライアント ID が設定されていません');
  await loadGis();
  return new Promise((resolve, reject) => {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId(), scope: SCOPE, prompt: silent ? '' : (drive.used ? '' : 'consent'), hint: drive.email || undefined,
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        drive.token = r.access_token; drive.exp = Date.now() + (+r.expires_in || 3600) * 1000; drive.used = true;
        lsSet('token', drive.token); lsSet('exp', String(drive.exp)); lsSet('used', '1');
        resolve(true);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'ログインの画面が閉じられました' : e && e.type === 'popup_failed_to_open' ? 'ポップアップがブロックされました。ブラウザで許可してください' : 'Google につなげませんでした')),
    });
    tc.requestAccessToken();
  }).then(async (ok) => {
    try { const me = await api('GET', `${API}/about?fields=user(emailAddress)`); drive.email = (me.user && me.user.emailAddress) || ''; lsSet('email', drive.email); } catch (_) { /* なくてもよい */ }
    return ok;
  });
}
export function disconnect() {
  const t = drive.token;
  Object.assign(drive, { token: null, exp: 0, used: false, email: '' });
  ['token', 'exp', 'used', 'email'].forEach((k) => lsSet(k, null));
  try { if (t && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(t, () => {}); } catch (_) { /* なし */ }
}

export class DriveAuthError extends Error {}
async function api(method, url, { body, headers = {}, raw = false } = {}) {
  if (!connected()) throw new DriveAuthError('Google ドライブとのつながりが切れました。「つなぎ直す」を押してください');
  const r = await fetch(url, { method, body, headers: { Authorization: `Bearer ${drive.token}`, ...headers } });
  if (r.status === 401) { drive.exp = 0; lsSet('exp', '0'); throw new DriveAuthError('Google ドライブとのつながりが切れました。「つなぎ直す」を押してください'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) { /* なし */ } throw new Error(`Google ドライブ: ${r.status} ${m}`); }
  if (raw) return r;
  if (r.status === 204) return null;
  return r.json();
}
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// フォルダ（なければ作る）。appProperties の key で見分けるので、名前を変えられても大丈夫
export async function folder(name, { parent = null, key = name } = {}) {
  const q = [`mimeType='application/vnd.google-apps.folder'`, 'trashed=false', `appProperties has { key='rk' and value='${esc(key)}' }`, parent ? `'${parent}' in parents` : null].filter(Boolean).join(' and ');
  const r = await api('GET', `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (r.files && r.files.length) return r.files[0].id;
  const meta = { name, mimeType: 'application/vnd.google-apps.folder', appProperties: { rk: key }, ...(parent ? { parents: [parent] } : {}) };
  const c = await api('POST', `${API}/files?fields=id`, { body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' } });
  return c.id;
}
// フォルダの中のファイル一覧 [{ id, name, modifiedTime(ms), size, appProperties }]
export async function list(parent, { extra = '' } = {}) {
  const out = []; let pageToken = '';
  do {
    const q = [`'${parent}' in parents`, 'trashed=false', extra].filter(Boolean).join(' and ');
    const r = await api('GET', `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,modifiedTime,size,appProperties)&pageSize=1000&spaces=drive${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const f of r.files || []) out.push({ ...f, modifiedTime: Date.parse(f.modifiedTime) || 0 });
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}
export async function readText(id) { return (await api('GET', `${API}/files/${id}?alt=media`, { raw: true })).text(); }
// 作る（id なし）か、中身を上書きする（id あり）
export async function write({ id = null, name, parent, data, mime = 'application/json', appProperties = null }) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (id) {
    const r = await api('PATCH', `${UP}/files/${id}?uploadType=media&fields=id,modifiedTime`, { body: blob, headers: { 'Content-Type': mime } });
    if (name || appProperties) await api('PATCH', `${API}/files/${id}`, { body: JSON.stringify({ ...(name ? { name } : {}), ...(appProperties ? { appProperties } : {}) }), headers: { 'Content-Type': 'application/json' } });
    return r;
  }
  const meta = { name, parents: [parent], mimeType: mime, ...(appProperties ? { appProperties } : {}) };
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  fd.append('file', blob);
  return api('POST', `${UP}/files?uploadType=multipart&fields=id,modifiedTime`, { body: fd });
}
export async function remove(id) { return api('DELETE', `${API}/files/${id}`); }
