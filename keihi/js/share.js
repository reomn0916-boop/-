// 承認（ファイルで提出 → 承認者が承認・差し戻し → 結果を戻す）と、同期フォルダ（自動バックアップ・ほかの端末と同期）
// サーバーを使わないので、ファイルのやりとりと、Google ドライブ・OneDrive などの同期フォルダを使う
import { db, newId } from './db.js';
import { S, on, makeBackup, readBackup, mergeBackup, saveMany, kvGet, kvSet, todayISO, imageToBackup, putBackupImage, loadAll, saveSettings, tomb } from './store.js';
import * as gd from '../../lib/gdrive.js';
import { summarize } from './report.js';
import { policyIssues } from './policy.js';
import * as vault from './vault.js';

function blobToB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

// ---- 承認 -------------------------------------------------------------------

// 提出用に画像を小さくする（長い辺 1400px・JPEG）。メールに添付できる大きさにするため
async function shrink(blob, max = 1400, q = 0.7) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k); const h = Math.round(bmp.height * k);
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: q }) : await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    return out && out.size < blob.size ? out : blob;
  } catch (_) { return blob; }
}
export const SUBMISSION_WARN = 9 * 1024 * 1024; // これより大きいとメールで送れないことが多い

// 提出ファイル（精算の明細と領収書の画像）
export async function makeSubmission(rep) {
  const items = rep.ids.map((id) => S.expenses.find((e) => e.id === id)).filter(Boolean);
  const images = [];
  for (const e of items) if (e.imageId) { const r = await db.get('images', e.imageId); if (r) images.push({ id: r.id, blob: await blobToB64(await shrink(r.blob)) }); }
  const sum = summarize(items);
  const pol = S.settings.policy || null;
  const withIssues = items.map((e) => ({ ...e, issues: policyIssues(e, pol, todayISO()) }));
  const sub = { app: 'rakukeihi', kind: 'submission', id: newId('s'), reportId: rep.id, at: Date.now(), from: rep.from, to: rep.to, advance: rep.advance || 0,
    applicant: { name: S.settings.name, dept: S.settings.dept, company: S.settings.company, empNo: S.settings.empNo || '', bank: S.settings.myBank || null },
    policyName: (pol && pol.name) || '', sum: { reimb: sum.reimb, company: sum.company, count: sum.count }, items: withIssues, images };
  rep.approval = { status: 'submitted', at: Date.now(), submissionId: sub.id }; rep.updated = Date.now();
  S.reports = S.reports.map((r) => (r.id === rep.id ? rep : r));
  await db.put('reports', rep);
  return new Blob([JSON.stringify(sub)], { type: 'application/json' });
}

// 承認者: 届いた提出ファイルを保存
export async function receiveSubmission(j) {
  if (vault.enabled() && !vault.unlocked()) throw new Error('総務の合言葉で開いてから取り込んでください');
  const { images = [], ...rest } = j;
  // 振込先は名簿（金庫）にだけ置き、受け取り箱には下 4 けただけ残す
  const ap = rest.applicant || {};
  const masked = { ...ap, bank: ap.bank && ap.bank.number ? { last4: String(ap.bank.number).slice(-4) } : null };
  const rec = { id: j.id, received: Date.now(), updated: Date.now(), status: 'pending', comment: '', itemComments: {}, sub: { ...rest, applicant: masked, images: [] } };
  const old = await db.get('approvals', j.id);
  if (old) { rec.status = old.status; rec.comment = old.comment; rec.itemComments = old.itemComments; rec.paid = old.paid || null; rec.received = old.received; }
  await db.put('apvimgs', { id: j.id, images });
  await db.put('approvals', rec);
  upsertRoster(j.applicant, j.id);
  return rec;
}
// ---- 総務: 社員の名簿（提出ファイルの名前・社員番号・振込先で自動で増える。総務が直せる） ----------------
export const personKey = (a) => (a && a.empNo ? `no:${String(a.empNo).trim()}` : `name:${String((a && a.name) || '').replace(/\s/g, '')}`);
// 振込先が同じか（銀行・支店・種類・口座番号・名義）
const kanaKey = (x) => String(x || '').normalize('NFKC').replace(/[\s　]/g, '').toUpperCase();
export const sameBank = (a, b) => !!a && !!b && ['bankCode', 'branchCode', 'number'].every((k) => String(a[k] || '').replace(/^0+/, '') === String(b[k] || '').replace(/^0+/, '')) && String(a.type || '1') === String(b.type || '1') && kanaKey(a.holder) === kanaKey(b.holder);
// 提出ファイルで届いた振込先は、そのまま使わない:
// - はじめての振込先 → 使うが「総務がまだ確かめていない」（bankOk: false）。振込の前に確認がいる
// - 前とちがう振込先 → 前の振込先のまま、変更の申し出（pendingBank）として止める
export function upsertRoster(a, subId = '') {
  if (!a || !(a.name || a.empNo)) return;
  const list = [...(S.settings.roster || [])];
  const k = personKey(a);
  const i = list.findIndex((p) => personKey(p) === k);
  const cur = i >= 0 ? list[i] : { name: '', dept: '', empNo: '', bank: null, bankOk: false, active: true };
  const next = { ...cur, name: a.name || cur.name, dept: a.dept || cur.dept, empNo: a.empNo || cur.empNo, active: cur.active !== false };
  const inc = a.bank && a.bank.number ? a.bank : null;
  if (inc) {
    if (!cur.bank) { next.bank = inc; next.bankOk = false; } else if (sameBank(cur.bank, inc)) { if (next.pendingBank && sameBank(next.pendingBank.bank, inc)) delete next.pendingBank; } else if (!next.pendingBank || !sameBank(next.pendingBank.bank, inc)) next.pendingBank = { bank: inc, at: Date.now(), subId };
  }
  if (i >= 0) list[i] = next; else list.push(next);
  S.settings.roster = list; saveSettings();
}
// 総務: 振込先を確かめた・変更を認める・認めない
export function resolveBank(key, action) {
  S.settings.roster = (S.settings.roster || []).map((p) => {
    if (personKey(p) !== key) return p;
    if (action === 'ok') return { ...p, bankOk: true };
    if (action === 'accept' && p.pendingBank) { const { pendingBank, ...rest } = p; return { ...rest, bank: pendingBank.bank, bankOk: true, bankChangedAt: Date.now() }; }
    if (action === 'reject') { const { pendingBank, ...rest } = p; void pendingBank; return rest; }
    return p;
  });
  saveSettings();
}
// 振り込めるか（はじめての振込先は確認済み・変更の申し出がない）
export const payBlock = (p) => (!p || !p.bank ? '振込先がありません' : p.pendingBank ? '振込先の変更の申し出があります（確かめてください）' : p.bankOk === false ? 'はじめての振込先です（確かめてください）' : '');
export async function setPaid(ids, paid) {
  for (const id of ids) { const r = await db.get('approvals', id); if (!r) continue; r.paid = paid; r.updated = Date.now(); await db.put('approvals', r); }
}
export async function removeApproval(id) { await db.del('approvals', id); await db.del('apvimgs', id); tomb('approval', id); }
// 社員をまたいだ二重申請: 同じ日・同じ金額・同じ支払先の経費が、ちがう提出に入っている
const pk = (s) => String(s || '').normalize('NFKC').replace(/\s|株式会社|\(株\)|㈱/g, '').toLowerCase();
export function duplicateIndex(recs) {
  const m = new Map();
  for (const r of recs) for (const e of r.sub.items || []) { const k = `${e.date}|${e.amount}|${pk(e.payee)}`; if (!e.amount) continue; if (!m.has(k)) m.set(k, []); m.get(k).push({ rec: r.id, item: e.id, who: r.sub.applicant.name }); }
  const dup = new Map();
  for (const list of m.values()) if (new Set(list.map((x) => x.rec)).size > 1) for (const x of list) dup.set(`${x.rec}|${x.item}`, list.filter((y) => y.rec !== x.rec).map((y) => y.who));
  return dup;
}
export async function listApprovals() {
  const list = (await db.all('approvals')) || [];
  // 前の版で画像を同じところに入れていた記録は、画像を別に移す
  for (const r of list) if (r.sub && r.sub.images && r.sub.images.length) { await db.put('apvimgs', { id: r.id, images: r.sub.images }); r.sub = { ...r.sub, images: [] }; await db.put('approvals', r); }
  return list.sort((a, b) => b.received - a.received);
}
// 届いた精算の画像: { 画像の id: Blob }
export async function approvalImages(rec) {
  const r = await db.get('apvimgs', rec.id);
  return Object.fromEntries(((r && r.images) || []).map((im) => [im.id, b64ToBlob(im.blob, 'image/jpeg')]));
}

// 承認者: 承認・差し戻しを決めて、結果ファイルを作る
export async function decide(rec, { status, comment = '', itemComments = {}, by = '' }) {
  Object.assign(rec, { status, comment, itemComments, decided: Date.now(), by, updated: Date.now() });
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
export const syncState = { handle: null, permission: 'none', lastWrite: 0, lastRead: 0, busy: false, error: '', mode: 'none', progress: '' };
// どちらで同期しているか: Google ドライブ（一度つないだ）> 同期フォルダ > なし
export const syncMode = () => (gd.drive.used ? 'drive' : syncState.handle ? 'folder' : 'none');
export { gd };

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
export async function syncNow() { return syncMode() === 'drive' ? syncDrive() : syncFolder(); }
async function syncFolder() {
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

// ---- Google ドライブ（スマホでも動く。サーバーなし） ---------------------------------------
// マイドライブ/ラク経費/ に、端末ごとのデータ（画像なし）と日ごとの控え。画像は ラク経費/画像/ に 1 枚ずつ（一度送れば次からは送らない）
export async function syncDrive() {
  if (!gd.connected()) return { ok: false, auth: true, error: gd.needsReconnect() ? 'Google ドライブとのつながりが切れました。「つなぎ直す」を押してください' : 'Google ドライブにつないでいません' };
  if (syncState.busy) return { ok: false, busy: true };
  syncState.busy = true; syncState.error = ''; syncState.progress = '';
  let merged = 0; let imgDown = 0; let imgUp = 0;
  try {
    const root = await gd.folder('ラク経費', { key: 'rakukeihi' });
    const imgDir = await gd.folder('画像', { parent: root, key: 'rakukeihi-images' });
    const files = await gd.list(root);
    const me = `ラク経費_同期_${deviceId()}.json`;
    const seen = (await kvGet('driveSeen')) || {};
    for (const f of files) {
      if (!/^ラク経費_同期_.+\.json$/.test(f.name) || f.name === me) continue;
      if (seen[f.id] && seen[f.id] >= f.modifiedTime) continue;
      syncState.progress = `${f.name.replace(/^ラク経費_同期_|\.json$/g, '')} の変更を読んでいます`;
      let j; try { j = JSON.parse(await gd.readText(f.id)); } catch (_) { continue; }
      if (j && j.app === 'rakukeihi') merged += await mergeBackup(j, { takeSettings: false, sync: true });
      seen[f.id] = f.modifiedTime;
    }
    await kvSet('driveSeen', seen);
    // 画像: ないものをもらい、まだ送っていないものを送る
    const remote = new Map((await gd.list(imgDir)).map((f) => [f.name.replace(/\.json$/, ''), f.id]));
    const local = new Set(await db.keys('images'));
    const need = [...new Set(S.expenses.map((e) => e.imageId).filter((id) => id && !local.has(id) && remote.has(id)))];
    for (const id of need) { syncState.progress = `画像を受け取っています（${++imgDown} / ${need.length}）`; try { await putBackupImage(JSON.parse(await gd.readText(remote.get(id)))); } catch (_) { /* 次の同期でまた */ } }
    // 総務の受け取り箱の画像（提出 1 件ずつ）
    const apvLocal = new Set(await db.keys('apvimgs'));
    for (const r of (await db.all('approvals')) || []) {
      const name = `apv_${r.id}`;
      if (!apvLocal.has(r.id) && remote.has(name)) { try { await db.put('apvimgs', JSON.parse(await gd.readText(remote.get(name)))); } catch (_) { /* 次回 */ } }
    }
    for (const id of apvLocal) if (!remote.has(`apv_${id}`)) { const rec = await db.get('apvimgs', id); if (rec && rec.images && rec.images.length) await gd.write({ name: `apv_${id}.json`, parent: imgDir, data: JSON.stringify(rec) }); }
    const send = [...local].filter((id) => !remote.has(id));
    for (const id of send) { syncState.progress = `画像を送っています（${++imgUp} / ${send.length}）`; const o = await imageToBackup(id); if (o) await gd.write({ name: `${id}.json`, parent: imgDir, data: JSON.stringify(o) }); }
    // 自分のデータ（画像なし）と、日ごとの控え（14 日分）
    syncState.progress = 'データを送っています';
    const data = await makeBackup({ images: false });
    const mine = files.find((f) => f.name === me);
    await gd.write({ id: mine ? mine.id : null, name: me, parent: root, data });
    const day = `ラク経費_控え_${todayISO()}.json`;
    const today = files.find((f) => f.name === day);
    await gd.write({ id: today ? today.id : null, name: day, parent: root, data });
    const lim = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    for (const f of files) { const m = f.name.match(/^ラク経費_控え_(\d{4}-\d{2}-\d{2})\.json$/); if (m && m[1] < lim) { try { await gd.remove(f.id); } catch (_) { /* 次回 */ } } }
    if (imgDown) await loadAll();
    syncState.lastWrite = Date.now(); await kvSet('syncLastWrite', syncState.lastWrite);
    return { ok: true, merged, imgDown, imgUp };
  } catch (e) {
    syncState.error = e.message || String(e);
    return { ok: false, auth: e instanceof gd.DriveAuthError, error: syncState.error };
  } finally { syncState.busy = false; syncState.progress = ''; }
}

// 変更があったら少し待って同期、10 分ごとにも同期
let timer = null;
let started = false;
export function startAutoSync(onDone) {
  if (started) return; started = true;
  const run = async () => { if (syncMode() === 'none') return; const r = await syncNow(); if (onDone) onDone(r); };
  // 自分の同期で起きた変更では、もう一度同期しない
  on('change', () => { if (syncState.busy) return; clearTimeout(timer); timer = setTimeout(run, 20000); });
  setInterval(run, 10 * 60000);
  // スマホ: アプリに戻ってきたとき
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - syncState.lastWrite > 60000) run(); });
}
