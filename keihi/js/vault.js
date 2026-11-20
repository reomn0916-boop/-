// 総務の合言葉: 社員の振込先・振込元（会社の口座）を暗号化して保存し、合言葉を入れたときだけ開く
// - 合言葉そのものは保存しない（PBKDF2 で作った鍵で AES-GCM 暗号化。確かめ用の小さな暗号文だけ残す）
// - 開いている間だけ、S.settings.roster / payer にふつうの形で置く。15 分さわらないと閉じる
// - ブラウザの中だけの仕組みなので、パソコンを使える人が開発者ツールでプログラムを書き換えることまでは防げない（それにはサーバー版）
import { S, saveSettings, setSettingsHooks, logEvent } from './store.js';

export const SECRET_KEYS = ['roster', 'payer'];
const ITER = 250000;
const te = new TextEncoder(); const td = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const V = { key: null, at: 0, last: 0 };

export const enabled = () => !!(S.settings.soumuLock && S.settings.soumuLock.salt);
export const unlocked = () => enabled() && !!V.key;

async function derive(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function enc(key, obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))); return { iv: b64(iv), data: b64(ct) }; }
async function dec(key, box) { const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data)); return JSON.parse(td.decode(pt)); }

// 合言葉を決める（いまの振込先・振込元を暗号化する）
export async function setup(pass) {
  if (!pass || pass.length < 6) throw new Error('合言葉は 6 文字以上にしてください');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(pass, salt, ITER);
  S.settings.soumuLock = { salt: b64(salt), iter: ITER, check: await enc(key, { ok: 'rakukeihi' }), at: Date.now() };
  V.key = key; V.at = Date.now(); V.last = Date.now();
  await seal();
  logEvent('総務の合言葉を決めた');
}
// 開く
export async function unlock(pass) {
  const L = S.settings.soumuLock; if (!L) return true;
  let key;
  try { key = await derive(pass, unb64(L.salt), L.iter || ITER); const c = await dec(key, L.check); if (c.ok !== 'rakukeihi') throw new Error(); } catch (_) { logEvent('総務の合言葉をまちがえた'); return false; }
  V.key = key; V.at = Date.now(); V.last = Date.now();
  await openVault();
  logEvent('総務の画面を開いた');
  return true;
}
// 閉じる（振込先を画面から消す）
export function lock() { if (!V.key) return; V.key = null; for (const k of SECRET_KEYS) delete S.settings[k]; }
export const touch = () => { V.last = Date.now(); };
export const idleMinutes = () => (Date.now() - V.last) / 60000;

async function openVault() {
  const box = S.settings.vault;
  if (box && box.data) { try { const o = await dec(V.key, box); for (const k of SECRET_KEYS) S.settings[k] = o[k] ?? (k === 'roster' ? [] : null); } catch (_) { /* 別の合言葉の金庫（ほかのパソコンで変えた）*/ V.key = null; throw new Error('保存されている振込先を開けませんでした（ほかのパソコンで合言葉を変えましたか？）'); } }
}
// 暗号化して保存（設定を保存するたびに呼ばれる）
let sealing = null;
export async function seal() {
  if (!V.key) return;
  const o = Object.fromEntries(SECRET_KEYS.map((k) => [k, S.settings[k] ?? null]));
  S.settings.vault = { ...(await enc(V.key, o)), at: Date.now() };
  saveSettings();
}
// 合言葉を変える
export async function change(oldPass, newPass) {
  if (!(await unlock(oldPass))) throw new Error('いまの合言葉がちがいます');
  await setup(newPass);
  logEvent('総務の合言葉を変えた');
}
// 合言葉を忘れた: 振込先・振込元を消して、はじめからにする
export function reset() {
  delete S.settings.soumuLock; delete S.settings.vault; for (const k of SECRET_KEYS) delete S.settings[k];
  V.key = null; saveSettings(); logEvent('総務の合言葉を消した（振込先・振込元も消した）');
}

// 設定の保存・同期とつなぐ: 金庫があるときは、振込先・振込元をふつうの形で書かない
setSettingsHooks({
  omit: () => (enabled() ? SECRET_KEYS : []),
  after: () => { if (V.key && !sealing) { sealing = Promise.resolve().then(() => seal()).finally(() => { sealing = null; }); } },
  merged: async () => { if (V.key) { try { await openVault(); } catch (_) { lock(); } } else for (const k of SECRET_KEYS) if (enabled()) delete S.settings[k]; },
});
