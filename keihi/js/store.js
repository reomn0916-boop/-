// 経費のデータ・学習・読み取りの順番待ち・精算の記録・バックアップ（スマホ版とパソコン版で共通）
// 画面には依存しない。画面は on() で変化を受け取って描き直す。
import { db, newId, persist } from './db.js';
import { prepareImage, readReceipt, canvasToBlob, rotateBlob } from './ocr.js';
import { DEFAULT_CATEGORIES, payeeKey, toISODate, parseReceipt } from './parse.js';
import { isPdf, readPdf } from './pdfin.js';

// ---- 小さな道具 --------------------------------------------------------------

export const todayISO = () => toISODate(new Date());
export const ymOf = (iso) => (iso || '').slice(0, 7);
export const addDays = (iso, k) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + k); return toISODate(d); };
export const addMonth = (ym, k) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const monthEnd = (ym) => toISODate(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0));
export const num = (v) => { const n = parseInt(String(v ?? '').normalize('NFKC').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
export const dec = (v) => { const n = parseFloat(String(v ?? '').normalize('NFKC').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };

// ---- 変化の通知 --------------------------------------------------------------

const listeners = new Map();
export function on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); }
function emit(ev, ...args) { (listeners.get(ev) || []).forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } }); }

// ---- 設定（localStorage） ---------------------------------------------------------

const LS = 'rakukeihi.';
function lsGet(k, def) { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : def; } catch (_) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (_) { emit('error', '設定を保存できませんでした（容量不足？）'); return false; } }

export const DEF_SETTINGS = {
  company: '', dept: '', name: '',
  ocrMode: 'device', apiKey: '', aiModel: 'claude-opus-5-5',
  defaultMethod: '現金', cardMethod: '個人カード',
  carRate: 15, carCategory: '旅費交通費',
  categories: DEFAULT_CATEGORIES.slice(),
  creditAccount: '未払金',
  advance: 0,
};
export const METHODS = ['現金', '個人カード', '電子マネー', '会社カード', '請求書払い'];

export const S = {
  expenses: [],
  reports: [],
  ledger: [],
  settings: { ...DEF_SETTINGS, ...lsGet('settings', {}) },
  learned: lsGet('learned', { payeeCat: {}, tnoPayee: {} }),
  templates: lsGet('templates', []),
  thumbs: new Map(),
  ocr: new Map(),
};
if (!S.learned.payeeCat) S.learned.payeeCat = {};
if (!S.learned.tnoPayee) S.learned.tnoPayee = {};

export const saveSettings = () => lsSet('settings', S.settings);
export const saveLearned = () => lsSet('learned', S.learned);
export const saveTemplates = () => lsSet('templates', S.templates);
export const byId = (id) => S.expenses.find((e) => e.id === id);
export const cats = () => (S.settings.categories && S.settings.categories.length ? S.settings.categories : DEFAULT_CATEGORIES);
export const isCompanyPaid = (e) => e.method === '会社カード' || e.method === '請求書払い';

// ---- 経費 ----------------------------------------------------------------

export async function loadAll() {
  S.expenses = (await db.all('expenses')) || [];
  S.reports = (await db.all('reports')) || [];
  S.ledger = (await db.all('ledger')) || [];
  emit('change');
}

export async function saveExpense(e, { quiet = false } = {}) {
  e.updated = Date.now();
  await db.put('expenses', e);
  const i = S.expenses.findIndex((x) => x.id === e.id);
  if (i >= 0) S.expenses[i] = e; else S.expenses.push(e);
  persist();
  if (!quiet) emit('change');
  return e;
}

export async function saveMany(list) {
  const t = Date.now();
  list.forEach((e) => { e.updated = t; });
  await db.putMany('expenses', list);
  for (const e of list) { const i = S.expenses.findIndex((x) => x.id === e.id); if (i >= 0) S.expenses[i] = e; else S.expenses.push(e); }
  persist();
  emit('change');
}

export function newExpense(over = {}) {
  return {
    id: newId('e'),
    kind: 'receipt',
    status: 'draft',
    date: todayISO(),
    amount: null,
    payee: '', category: '', site: recentSites()[0] || '',
    method: S.settings.defaultMethod || '現金',
    memo: '', invoiceNo: '', tax10: null, tax8: null,
    people: null, guests: '',
    route: null, fare: null, km: null, rate: null,
    imageId: null, ocr: null,
    auto: ['date', 'method'],
    created: Date.now(), updated: Date.now(),
    ...over,
  };
}

function recent(pick, limit) {
  const seen = new Set();
  [...S.expenses].sort((a, b) => (b.updated || 0) - (a.updated || 0)).forEach((e) => pick(e).forEach((v) => { if (v) seen.add(v); }));
  return [...seen].slice(0, limit);
}
export const recentSites = () => recent((e) => [e.site], 30);
export const recentPayees = () => recent((e) => [e.payee], 80);
export const recentPlaces = () => recent((e) => (e.route ? [e.route.from, e.route.to] : []), 40);

export function computeAmount(c) {
  if (c.kind === 'transit') return c.fare != null ? c.fare * (c.route && c.route.round ? 2 : 1) : c.amount;
  if (c.kind === 'car') {
    const rate = c.rate != null ? c.rate : S.settings.carRate;
    return c.km != null ? Math.round(c.km * (c.route && c.route.round ? 2 : 1) * rate) : c.amount;
  }
  return c.amount;
}

// ---- 画像 ----------------------------------------------------------------

export async function thumbURL(imageId) {
  if (S.thumbs.has(imageId)) return S.thumbs.get(imageId);
  const rec = await db.get('images', imageId);
  if (!rec) return '';
  const url = URL.createObjectURL(rec.thumb || rec.blob);
  S.thumbs.set(imageId, url);
  return url;
}
export const imageRecord = (id) => db.get('images', id);

// 画像を回して保存し直す（読み取りもやり直す）
export async function rotateImage(expenseId, deg = 90) {
  const e = byId(expenseId); if (!e || !e.imageId) return;
  const rec = await db.get('images', e.imageId); if (!rec) return;
  const r = await rotateBlob(rec.blob, deg);
  Object.assign(rec, { blob: r.blob, thumb: r.thumb, w: r.width, h: r.height });
  await db.put('images', rec);
  const old = S.thumbs.get(e.imageId); if (old) URL.revokeObjectURL(old);
  S.thumbs.delete(e.imageId);
  emit('image', e.imageId);
  reread(expenseId);
}

// まとめて変更（元に戻せるように変更前を返す）
export async function bulkUpdate(ids, patch) {
  const before = []; const list = [];
  for (const id of ids) {
    const e = byId(id); if (!e) continue;
    before.push(JSON.parse(JSON.stringify(e)));
    Object.assign(e, typeof patch === 'function' ? patch(e) : patch);
    e.auto = (e.auto || []).filter((k) => !(k in (typeof patch === 'function' ? {} : patch)));
    list.push(e);
  }
  if (list.length) await saveMany(list);
  list.forEach((e) => { if (e.status !== 'draft') learn(e); });
  return before;
}
export async function restoreVersions(before) {
  await db.putMany('expenses', before);
  for (const b of before) { const i = S.expenses.findIndex((x) => x.id === b.id); if (i >= 0) S.expenses[i] = b; else S.expenses.push(b); }
  emit('change');
}

export const isImportable = (f) => isPdf(f) || /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name || '');

// 画像・PDF を取り込んで「確認待ち」の経費にし、読み取りの順番に並べる
export async function importFiles(files, { onProgress } = {}) {
  const list = [...files].filter(isImportable);
  const made = []; const failed = [];
  let i = 0;
  for (const f of list) {
    onProgress && onProgress(i++, list.length, f.name);
    try {
      const imageId = newId('i');
      let rec;
      if (isPdf(f)) {
        const pdf = await readPdf(f);
        const img = await prepareImage(await canvasToBlob(pdf.canvas, 'image/jpeg', 0.9));
        rec = { id: imageId, blob: img.blob, thumb: img.thumb, w: img.width, h: img.height, orig: f.slice(0, f.size, 'application/pdf'), origName: f.name || 'receipt.pdf', origType: 'application/pdf', text: pdf.text, pages: pdf.pages };
      } else {
        const img = await prepareImage(f);
        rec = { id: imageId, blob: img.blob, thumb: img.thumb, w: img.width, h: img.height, origName: f.name || '' };
      }
      await db.put('images', rec);
      const e = newExpense({ imageId, kind: 'receipt', source: rec.origType ? 'pdf' : 'photo', fileName: f.name || '' });
      await saveExpense(e, { quiet: true });
      made.push(e);
      enqueue(e.id);
    } catch (err) {
      failed.push({ name: f.name || '', error: err.message || String(err) });
    }
  }
  onProgress && onProgress(list.length, list.length, '');
  emit('change');
  return { made, failed, skipped: files.length - list.length };
}

// ---- 読み取りの順番待ち ---------------------------------------------------------

const queue = [];
let running = false;
export const isReading = (id) => { const o = S.ocr.get(id); return !!o && (o.state === 'run' || o.state === 'wait'); };
export const readingCount = () => [...S.ocr.values()].filter((o) => o.state === 'run' || o.state === 'wait').length;

function setOcr(id, o) { if (o) S.ocr.set(id, o); else S.ocr.delete(id); emit('ocr', id, o); }

export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  setOcr(id, { p: 0, msg: '順番待ち', state: 'wait' });
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    const e = byId(id);
    if (!e || !e.imageId) { setOcr(id, null); continue; }
    setOcr(id, { p: 0.02, msg: '準備しています', state: 'run' });
    try {
      const rec = await db.get('images', e.imageId);
      if (!rec) throw new Error('画像がありません');
      let r;
      const ai = S.settings.ocrMode === 'ai' && S.settings.apiKey;
      if (rec.text && rec.text.replace(/\s/g, '').length > 10 && !ai) {
        // 文字のある PDF: 文字をそのまま読む（OCR より正確）
        r = { fields: parseReceipt(rec.text, { learned: S.learned, categories: cats() }), engine: 'pdf' };
      } else {
        r = await readReceipt(rec.blob, {
          settings: S.settings, learned: S.learned, categories: cats(),
          onProgress: (p, msg) => setOcr(id, { p, msg, state: 'run' }),
        });
      }
      setOcr(id, { p: 1, msg: r.warning || '', state: 'done', engine: r.engine });
      await applyOcr(id, r);
    } catch (err) {
      setOcr(id, { p: 1, msg: `読み取れませんでした（${err.message || err}）。手で入れてください`, state: 'error' });
      emit('change');
    }
    setTimeout(() => { const o = S.ocr.get(id); if (o && o.state === 'done') setOcr(id, null); }, 4000);
  }
  running = false;
}

export const OCR_FIELDS = ['amount', 'date', 'payee', 'category', 'memo', 'invoiceNo', 'tax10', 'tax8', 'method'];

// 読み取った値を入れる。空の欄と「初期値のままの欄（auto）」だけ。touched（自分で触った欄）は変えない
export function fillFromOcr(target, f, engine, touched = null) {
  const filled = [];
  for (const k of OCR_FIELDS) {
    const v = f[k];
    if (v == null || v === '') continue;
    if (touched && touched.has(k)) continue;
    const cur = target[k];
    const auto = (target.auto || []).includes(k);
    if (cur == null || cur === '' || auto) { target[k] = v; filled.push(k); }
  }
  target.auto = (target.auto || []).filter((k) => !filled.includes(k));
  target.ocr = { engine, sure: f.sure || {}, notReceipt: !!f.notReceipt, at: Date.now(), filled };
  return filled;
}

async function applyOcr(id, r) {
  const f = { ...r.fields };
  if (f.payment) f.method = f.payment === 'カード' ? S.settings.cardMethod : f.payment;
  const e = byId(id);
  if (e) { fillFromOcr(e, f, r.engine); await saveExpense(e, { quiet: true }); }
  emit('ocr-result', id, f, r.engine);
  emit('change');
}

// 読み直す: 読み取りで入る欄をすべて初期値扱いに戻してから並べる
export function reread(id) {
  const e = byId(id);
  if (!e) return;
  e.auto = OCR_FIELDS.slice();
  enqueue(id);
}

// ---- 学習・重複 --------------------------------------------------------------

export function learn(e) {
  const k = payeeKey(e.payee);
  if (k && e.category) S.learned.payeeCat[k] = e.category;
  if (e.invoiceNo && e.payee) S.learned.tnoPayee[e.invoiceNo] = e.payee;
  saveLearned();
}

export function findDup(e) {
  if (!e.amount || !e.date) return null;
  return S.expenses.find((x) => x.id !== e.id && x.amount === e.amount && x.date === e.date && (!e.payee || !x.payee || payeeKey(x.payee) === payeeKey(e.payee) || x.imageId)) || null;
}

// 保存の前の確認。問題があれば文言を返す
export function validate(c) {
  if (c.kind !== 'receipt') c.amount = computeAmount(c);
  if (c.kind === 'car' && c.rate == null) c.rate = S.settings.carRate;
  if (!c.amount || c.amount <= 0) return { field: c.kind === 'receipt' ? 'amount' : c.kind === 'transit' ? 'fare' : 'km', msg: isReading(c.id) ? '読み取り中です。少し待つか、金額を入れてください' : '金額を入れてください' };
  if (!c.date) return { field: 'date', msg: '日付を入れてください' };
  if (c.kind === 'car' && !c.payee) c.payee = '自家用車';
  if (c.kind === 'transit' && !c.payee) c.payee = '電車・バス';
  if (!c.category) c.category = c.kind === 'car' ? S.settings.carCategory : c.kind === 'transit' ? '旅費交通費' : '';
  if (!c.category) return { field: 'category', msg: '勘定科目を選んでください' };
  return null;
}

// 確定して保存（確認待ち → 未精算）
export async function commit(c) {
  if (c.status === 'draft') c.status = 'ok';
  c.auto = [];
  await saveExpense(c);
  learn(c);
  return c;
}

// ---- 削除・取り消し ------------------------------------------------------------

export async function removeExpenses(ids) {
  const snap = [];
  for (const id of ids) {
    const e = byId(id); if (!e) continue;
    const img = e.imageId ? await db.get('images', e.imageId) : null;
    await db.del('expenses', id);
    if (img) await db.del('images', img.id);
    S.expenses = S.expenses.filter((x) => x.id !== id);
    S.ocr.delete(id);
    snap.push({ e, img });
  }
  emit('change');
  return snap;
}
export async function restoreSnapshot(snap) {
  for (const { e, img } of snap) { if (img) await db.put('images', img); await db.put('expenses', e); S.expenses.push(e); }
  emit('change');
}

// ---- よく使う -------------------------------------------------------------------

export function templateFrom(c) {
  const amount = computeAmount(c);
  const parts = [];
  if (c.kind !== 'receipt' && c.route && (c.route.from || c.route.to)) parts.push(`${c.route.from || ''}→${c.route.to || ''}${c.route.round ? ' 往復' : ''}`);
  else parts.push(c.payee || c.memo || c.category);
  return {
    id: newId('t'),
    label: parts.join(' ').trim() || '経費',
    kind: c.kind, payee: c.payee, amount, fare: c.fare, km: c.km, rate: c.rate, route: c.route ? { ...c.route } : null,
    category: c.category || (c.kind === 'car' ? S.settings.carCategory : c.kind === 'transit' ? '旅費交通費' : ''),
    site: c.site, method: c.method, memo: c.memo,
  };
}
export function addTemplate(t) { S.templates.unshift(t); S.templates = S.templates.slice(0, 30); saveTemplates(); emit('change'); }
export function removeTemplate(id) { S.templates = S.templates.filter((x) => x.id !== id); saveTemplates(); emit('change'); }
export function expenseFromTemplate(t, date = todayISO()) {
  return newExpense({
    kind: t.kind, payee: t.payee || (t.kind === 'car' ? '自家用車' : t.kind === 'transit' ? '電車・バス' : ''), amount: t.amount,
    fare: t.fare ?? null, km: t.km ?? null, rate: t.rate ?? null, route: t.route ? { ...t.route } : null,
    category: t.category, site: t.site || '', method: t.method || S.settings.defaultMethod, memo: t.memo || '',
    date, status: 'ok', auto: [],
  });
}

// ---- 精算の記録 ----------------------------------------------------------------

export async function createReport(items, { from, to, advance = 0, sum }) {
  const rep = { id: newId('r'), created: Date.now(), from, to, ids: items.map((e) => e.id), reimb: sum.reimb, company: sum.company, advance };
  await db.put('reports', rep);
  S.reports.push(rep);
  const changed = [];
  for (const e of items) { const x = byId(e.id); if (x && x.status === 'ok') { x.status = 'done'; x.reportId = rep.id; changed.push(x); } }
  if (changed.length) await saveMany(changed); else emit('change');
  return rep;
}

export async function undoReport(id) {
  const rep = S.reports.find((r) => r.id === id); if (!rep) return;
  const changed = [];
  for (const eid of rep.ids) { const x = byId(eid); if (x && x.reportId === id) { x.status = 'ok'; x.reportId = null; changed.push(x); } }
  if (changed.length) await saveMany(changed);
  await db.del('reports', id);
  S.reports = S.reports.filter((r) => r.id !== id);
  emit('change');
}

// ---- 帳簿（売上・収入・振替伝票） ----------------------------------------------------

export async function saveLedger(l) {
  if (!l.id) l.id = newId(l.type === 'income' ? 'n' : 'j');
  if (!l.created) l.created = Date.now();
  l.updated = Date.now();
  await db.put('ledger', l);
  const i = S.ledger.findIndex((x) => x.id === l.id);
  if (i >= 0) S.ledger[i] = l; else S.ledger.push(l);
  persist();
  emit('change');
  return l;
}
export async function removeLedger(id) {
  const l = S.ledger.find((x) => x.id === id); if (!l) return null;
  await db.del('ledger', id);
  S.ledger = S.ledger.filter((x) => x.id !== id);
  emit('change');
  return l;
}

// ---- バックアップ・取り込み ----------------------------------------------------------

function blobToB64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

export async function makeBackup() {
  const images = await db.all('images');
  const { apiKey, ...settings } = S.settings; void apiKey;
  const parts = [`{"app":"rakukeihi","version":3,"exportedAt":${JSON.stringify(new Date().toISOString())},"settings":${JSON.stringify(settings)},"learned":${JSON.stringify(S.learned)},"templates":${JSON.stringify(S.templates)},"expenses":${JSON.stringify(S.expenses)},"reports":${JSON.stringify(S.reports)},"ledger":${JSON.stringify(S.ledger)},"images":[`];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    const o = { id: im.id, w: im.w, h: im.h, blob: await blobToB64(im.blob), thumb: im.thumb ? await blobToB64(im.thumb) : '' };
    if (im.orig) Object.assign(o, { orig: await blobToB64(im.orig), origType: im.origType, origName: im.origName });
    if (im.text) o.text = im.text;
    parts.push(`${i ? ',' : ''}${JSON.stringify(o)}`);
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

export async function readBackup(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch (_) { throw new Error('バックアップのファイルを読めませんでした'); }
  if (!j || j.app !== 'rakukeihi') throw new Error('ラク経費のバックアップではありません');
  const have = new Map(S.expenses.map((e) => [e.id, e]));
  const incoming = j.expenses || [];
  const added = incoming.filter((e) => !have.has(e.id)).length;
  const updated = incoming.filter((e) => have.has(e.id) && (e.updated || 0) > (have.get(e.id).updated || 0)).length;
  const led = new Set(S.ledger.map((l) => l.id));
  const ledgerAdded = (j.ledger || []).filter((l) => !led.has(l.id)).length;
  return { j, total: incoming.length, added, updated, ledgerAdded };
}

// 取り込む（同じ経費は新しい方を残す。ほかの経費は消さない）
export async function mergeBackup(j, { takeSettings = true } = {}) {
  const have = new Map(S.expenses.map((e) => [e.id, e]));
  const put = (j.expenses || []).filter((e) => !have.has(e.id) || (e.updated || 0) > (have.get(e.id).updated || 0));
  const needImg = new Set(put.map((e) => e.imageId).filter(Boolean));
  for (const im of j.images || []) {
    if (!needImg.has(im.id)) continue;
    const rec = { id: im.id, w: im.w, h: im.h, blob: b64ToBlob(im.blob, 'image/jpeg'), thumb: im.thumb ? b64ToBlob(im.thumb, 'image/jpeg') : null };
    if (im.orig) Object.assign(rec, { orig: b64ToBlob(im.orig, im.origType || 'application/pdf'), origType: im.origType, origName: im.origName });
    if (im.text) rec.text = im.text;
    await db.put('images', rec);
  }
  if (put.length) await db.putMany('expenses', put);
  const reps = new Set(S.reports.map((r) => r.id));
  const newReps = (j.reports || []).filter((r) => !reps.has(r.id));
  if (newReps.length) await db.putMany('reports', newReps);
  const led = new Map(S.ledger.map((l) => [l.id, l]));
  const putLed = (j.ledger || []).filter((l) => !led.has(l.id) || (l.updated || 0) > (led.get(l.id).updated || 0));
  if (putLed.length) await db.putMany('ledger', putLed);
  if (takeSettings && j.settings) { S.settings = { ...DEF_SETTINGS, ...j.settings, ...pickFilled(S.settings), apiKey: S.settings.apiKey }; saveSettings(); }
  S.learned = { payeeCat: { ...(j.learned?.payeeCat || {}), ...S.learned.payeeCat }, tnoPayee: { ...(j.learned?.tnoPayee || {}), ...S.learned.tnoPayee } }; saveLearned();
  const tids = new Set(S.templates.map((t) => t.id));
  S.templates = [...S.templates, ...(j.templates || []).filter((t) => !tids.has(t.id))]; saveTemplates();
  await loadAll();
  return put.length;
}
// 自分の端末で入れた名前などは残す
function pickFilled(st) { const o = {}; ['company', 'dept', 'name'].forEach((k) => { if (st[k]) o[k] = st[k]; }); return o; }

export async function wipeAll() {
  await db.clear('expenses'); await db.clear('images'); await db.clear('reports'); await db.clear('ledger');
  S.expenses = []; S.reports = []; S.ledger = []; S.templates = []; saveTemplates();
  S.learned = { payeeCat: {}, tnoPayee: {} }; saveLearned();
  emit('change');
}

// 読み取りの途中で閉じた下書きは、もう一度読む
export function resumePending() {
  S.expenses.filter((e) => e.status === 'draft' && e.imageId && !e.ocr).forEach((e) => enqueue(e.id));
}
