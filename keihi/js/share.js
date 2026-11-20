// 承認（ファイルで提出 → 承認者が承認・差し戻し → 結果を戻す）と、同期フォルダ（自動バックアップ・ほかの端末と同期）
// サーバーを使わないので、ファイルのやりとりと、Google ドライブ・OneDrive などの同期フォルダを使う
import { db, newId } from './db.js';
import { S, on, makeBackup, readBackup, mergeBackup, saveMany, kvGet, kvSet, todayISO } from './store.js';
import { summarize } from './report.js';

function blobToB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

// ---- 承認 -------------------------------------------------------------------

// 提出ファイル（精算の明細と領収書の画像）
export async function makeSubmission(rep) {
  const items = rep.ids.map((id) => S.expenses.find((e) => e.id === id)).filter(Boolean);
  const images = [];
  for (const e of items) if (e.imageId) { const r = await db.get('images', e.imageId); if (r) images.push({ id: r.id, blob: await blobToB64(r.blob) }); }
  const sum = summarize(items);
  const sub = { app: 'rakukeihi', kind: 'submission', id: newId('s'), reportId: rep.id, at: Date.now(), from: rep.from, to: rep.to, advance: rep.advance || 0,
    applicant: { name: S.settings.name, dept: S.settings.dept, company: S.settings.company }, sum: { reimb: sum.reimb, company: sum.company, count: sum.count }, items, images };
  rep.approval = { status: 'submitted', at: Date.now(), submissionId: sub.id }; rep.updated = Date.now();
  await db.put('reports', rep);
  return new Blob([JSON.stringify(sub)], { type: 'application/json' });
}

// 承認者: 届いた提出ファイルを保存
export async function receiveSubmission(j) {
  const rec = { id: j.id, received: Date.now(), status: 'pending', comment: '', itemComments: {}, sub: j };
  const old = await db.get('approvals', j.id);
  if (old) { rec.status = old.status; rec.comment = old.comment; rec.itemComments = old.itemComments; }
  await db.put('approvals', rec);
  return rec;
}
export const listApprovals = async () => ((await db.all('approvals')) || []).sort((a, b) => b.received - a.received);
export const approvalImage = (rec, imageId) => { const im = rec.sub.images.find((x) => x.id === imageId); return im ? b64ToBlob(im.blob, 'image/jpeg') : null; };

// 承認者: 承認・差し戻しを決めて、結果ファイルを作る
export async function decide(rec, { status, comment = '', itemComments = {}, by = '' }) {
  Object.assign(rec, { status, comment, itemComments, decided: Date.now(), by });
  await db.put('approvals', rec);
  const res = { app: 'rakukeihi', kind: 'decision', submissionId: rec.id, reportId: rec.sub.reportId, status, comment, itemComments, by, at: rec.decided };
  return new Blob([JSON.stringify(res)], { type: 'application/json' });
}

// 申請者: 結果ファイルを取り込む（結果と経費ごとのコメントを残す。直すときは「未精算に戻す」で戻して出し直す）
export async function applyDecision(j) {
  const rep = S.reports.find((r) => r.id === j.reportId);
  if (!rep) throw new Error('この端末にない精算の結果です');
  rep.approval = { status: j.status, comment: j.comment, itemComments: j.itemComments || {}, by: j.by, at: j.at, submissionId: j.submissionId }; rep.updated = Date.now();
  await db.put('reports', rep);
  const changed = [];
  for (const [id, c] of Object.entries(j.itemComments || {})) { const e = S.expenses.find((x) => x.id === id); if (e && c) { e.reviewComment = c; changed.push(e); } }
  if (changed.length) await saveMany(changed);
  return rep;
}

// ---- 同期フォルダ（File System Access API: Chrome・Edge） ----------------------------------
export const syncSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const deviceId = () => { let d = localStorage.getItem('rakukeihi.device'); if (!d) { d = `${/Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'pc'}-${Math.random().toString(36).slice(2, 6)}`; localStorage.setItem('rakukeihi.device', d); } return d; };
export const syncState = { handle: null, permission: 'none', lastWrite: 0, lastRead: 0, busy: false, error: '' };

export async function loadSyncFolder() {
  syncState.handle = (await kvGet('syncDir')) || null;
  syncState.lastWrite = (await kvGet('syncLastWrite')) || 0;
  if (syncState.handle) syncState.permission = await syncState.handle.queryPermission({ mode: 'readwrite' });
  return syncState;
}
export async function chooseSyncFolder() {
  const h = await window.showDirectoryPicker({ id: 'rakukeihi-sync', mode: 'readwrite' });
  await kvSet('syncDir', h);
  syncState.handle = h; syncState.permission = 'granted';
  return h;
}
export async function reconnectSync() {
  if (!syncState.handle) return false;
  syncState.permission = await syncState.handle.requestPermission({ mode: 'readwrite' });
  return syncState.permission === 'granted';
}
export async function forgetSync() { await kvSet('syncDir', null); syncState.handle = null; syncState.permission = 'none'; }

// 自分のファイルを書き、ほかの端末のファイルで新しいものを取り込む
export async function syncNow() {
  const h = syncState.handle;
  if (!h || syncState.permission !== 'granted' || syncState.busy) return { ok: false };
  syncState.busy = true; syncState.error = '';
  let merged = 0;
  try {
    const me = `ラク経費_同期_${deviceId()}.json`;
    const seen = (await kvGet('syncSeen')) || {};
    for await (const [name, fh] of h.entries()) {
      if (fh.kind !== 'file' || !/^ラク経費_同期_.+\.json$/.test(name) || name === me) continue;
      const f = await fh.getFile();
      if (seen[name] && seen[name] >= f.lastModified) continue;
      const info = await readBackup(f);
      merged += await mergeBackup(info.j, { takeSettings: false, sync: true });
      seen[name] = f.lastModified;
    }
    await kvSet('syncSeen', seen);
    const w = await (await h.getFileHandle(me, { create: true })).createWritable();
    await w.write(await makeBackup()); await w.close();
    // 日ごとの控え（7 日分）
    const day = todayISO();
    const bw = await (await h.getFileHandle(`ラク経費_控え_${day}.json`, { create: true })).createWritable();
    await bw.write(await makeBackup()); await bw.close();
    const olds = [];
    for await (const [name] of h.entries()) { const m = name.match(/^ラク経費_控え_(\d{4}-\d{2}-\d{2})\.json$/); if (m && m[1] < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) olds.push(name); }
    for (const n of olds) await h.removeEntry(n);
    syncState.lastWrite = Date.now(); await kvSet('syncLastWrite', syncState.lastWrite);
    return { ok: true, merged };
  } catch (e) {
    syncState.error = e.message || String(e);
    return { ok: false, error: syncState.error };
  } finally { syncState.busy = false; }
}

// 変更があったら少し待って同期、10 分ごとにも同期
let timer = null;
export function startAutoSync(onDone) {
  on('change', () => { clearTimeout(timer); timer = setTimeout(async () => { const r = await syncNow(); if (onDone) onDone(r); }, 20000); });
  setInterval(async () => { const r = await syncNow(); if (onDone) onDone(r); }, 10 * 60000);
}
