// 現場CAD パソコン版
// 画面: リボン / スタイルバー / マルチボックス（左）/ 図面 / プロパティ・レイヤ（右）/ ステータスバー
// 座標は x = X(北), y = Y(東) [m]。図面は北が上。
import { decodeText, parseDXF, toDXF, parseSIMA, toSIMA, parseCSV, toCSV, encodeSJIS } from '../js/io.js';
import { toDMS, parseAngle, ZONES } from '../js/geo.js';
import { buildAlignment, alignPoint, alignStakes } from '../js/cogo.js';
import { initCalc, reportHtml, reportsCSV } from '../js/calc.js';
import { PAPERS, SCALES, defaultSheet, layout, makeXf, renderSheet, makePdf, sheetFrameEntities, drawPrims, buildPrims, sheetInfo } from '../js/sheet.js';
import { LTYPES, LWS, COLORS, HATCHES, hatchSegments, dimGeom, dimLabel, explodeForDxf } from '../js/draft.js';
import { makeTracker, packProject, unpackProject, EXT } from '../js/sync.js';
import * as G from './geom.js';
import { ICONS } from './icons.js';
import { commandDefs } from './commands.js';
import { civilDefs } from './civil.js';
import { initLink } from './link.js';

// ============================================================
// 定数・状態
// ============================================================
const GROUPS = ['基準点', '位置出し', '逃げ', 'その他'];
const grpOf = (e) => (GROUPS.includes(e.grp) ? e.grp : 'その他');
const GRP_COLOR = { 基準点: '#1d4ed8', 逃げ: '#c2410c' };
const SEL = '#1f6feb', GHOST = '#d6336c', SNAPC = '#e8590c';
const FONT = '"Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif';
const PREFS_KEY = 'genbacad.pc.prefs.v1';
const D2R = Math.PI / 180;

const blankDoc = () => ({
  name: '無題', pid: null, zone: null, entities: [], seq: 1, nextId: 1, hiddenLayers: [], reports: [],
  gpsCal: { mode: 'rigid', pairs: [] }, sheet: null, layers: [{ name: '0', color: '#000000', ltype: 'solid', lw: 0.25 }], tomb: [],
});
const doc = blankDoc();
const view = { x: 0, y: 0, s: 10 };
const prefs = {
  snap: { pt: true, end: true, mid: true, inter: true, cen: true, perp: false, near: false },
  ortho: false, grid: false, showLw: true, showNames: true, showSheet: true, dark: false,
  dimUnit: 'mm', inUnit: 'm', textH: 3.5, cur: { layer: '0', color: '', ltype: '', lw: 0 },
  prefix: 'P', ptGrp: '位置出し', recent: [], tab: '作図', term: 'tick', hatch: { pattern: 'line', pitch: 2, ang: 45 },
};
const tracker = makeTracker();
let sel = new Set();
let cmd = null;          // 実行中のコマンド
let lastCmdId = null;
let overlay = null;      // 計算結果の表示
let fileHandle = null, fileName = '';
let dirty = false;
let clip = null;         // コピーした図形
const undoStack = [], redoStack = [];

// ============================================================
// 小物
// ============================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  status(msg);
}
const status = (msg) => { $('#stMsg').textContent = msg; };

// ============================================================
// 保存（IndexedDB に自動保存）
// ============================================================
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('genbacad-pc', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const r = fn(t.objectStore('kv'));
      t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error);
    });
  };
  return { get: (k) => run('readonly', (s) => s.get(k)), set: (k, v) => run('readwrite', (s) => s.put(v, k)) };
})();
let saveTimer;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await idb.set('project', JSON.stringify(doc)); await idb.set('view', { ...view }); await idb.set('fileName', fileName); } catch { /* 容量など */ }
  }, 500);
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* */ } }
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const [k, v] of Object.entries(p)) prefs[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...prefs[k], ...v } : v;
  } catch { /* */ }
}
function setDirty(v) { dirty = v; $('#dirtyMark').hidden = !v; }
function updateTitle() {
  $('#docTitle').textContent = doc.name + (fileName ? `（${fileName}）` : '');
  document.title = `${doc.name} - 現場CAD PC`;
}

// ============================================================
// 元に戻す・確定
// ============================================================
const stateStr = () => JSON.stringify({ e: doc.entities, s: doc.seq, n: doc.nextId, l: doc.layers, h: doc.hiddenLayers });
function begin() {
  undoStack.push(stateStr());
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const d = JSON.parse(s);
  doc.entities = d.e; doc.seq = d.s; doc.nextId = d.n; doc.layers = d.l; doc.hiddenLayers = d.h;
}
function undo() {
  if (cmd?.onBack && cmd.canBack?.()) { cmd.onBack(); afterCmd(); return; }
  const s = undoStack.pop();
  if (!s) { toast('これ以上戻せません'); return; }
  redoStack.push(stateStr()); restore(s); commit(); toast('元に戻しました');
}
function redo() {
  const s = redoStack.pop();
  if (!s) { toast('やり直せる操作がありません'); return; }
  undoStack.push(stateStr()); restore(s); commit(); toast('やり直しました');
}
/** 図面を変更したあとに呼ぶ */
function commit(msg) {
  tracker.track(doc);
  clearCaches();
  ensureLayers();
  for (const id of [...sel]) if (!entById(id)) sel.delete(id);
  setDirty(true); autosave();
  baseDirty = true; draw();
  renderProps(); renderLayers(); renderNames();
  if (msg) toast(msg);
}

// ============================================================
// 図形
// ============================================================
const entById = (id) => doc.entities.find((e) => e.id === id);
const layerOf = (e) => e.layer || '0';
const visible = (e) => !doc.hiddenLayers.includes(layerOf(e));
const visibleEnts = () => doc.entities.filter(visible);
function curStyle() {
  const c = prefs.cur, s = { layer: c.layer || '0' };
  if (c.color) s.color = c.color;
  if (c.ltype) s.ltype = c.ltype;
  if (c.lw) s.lw = c.lw;
  return s;
}
function addEnt(e, { style = true } = {}) {
  if (style && e.type !== 'point') Object.assign(e, { ...curStyle(), ...e });
  e.id = doc.nextId++;
  doc.entities.push(e);
  return e;
}
function removeEnts(list) {
  const ids = new Set(list.map((e) => (typeof e === 'object' ? e.id : e)));
  doc.entities = doc.entities.filter((e) => !ids.has(e.id));
  for (const id of ids) sel.delete(id);
}
function replaceEnt(old, nw) {
  const id = old.id;
  for (const k of Object.keys(old)) delete old[k];
  Object.assign(old, nw, { id });
  return old;
}
function nextPointName(peek = false) {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  let n = doc.seq, name;
  do { name = (prefs.prefix || 'P') + n++; } while (used.has(name));
  if (!peek) doc.seq = n;
  return name;
}
function uniqueName(name) {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  if (!used.has(name)) return name;
  let i = 2; while (used.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}
const pointByName = (s) => {
  const pts = doc.entities.filter((e) => e.type === 'point');
  return pts.find((e) => e.name === s) || pts.find((e) => e.name.toLowerCase() === String(s).toLowerCase());
};
const GRP_RANK = { 位置出し: 0, その他: 1, 逃げ: 2, 基準点: 3 };
function pointAt(p) {
  let best = null;
  for (const e of doc.entities) {
    if (e.type !== 'point' || G.dist(e.p, p) >= 1e-4) continue;
    if (!best || GRP_RANK[grpOf(e)] < GRP_RANK[grpOf(best)]) best = e;
  }
  return best;
}
function ensurePoint(p, grp = '位置出し') {
  const e = pointAt(p);
  if (e) return e;
  return addEnt({ type: 'point', p: { x: p.x, y: p.y }, z: 0, name: nextPointName(), grp });
}

// 画層
function ensureLayers() {
  const have = new Set(doc.layers.map((l) => l.name));
  for (const e of doc.entities) {
    const n = layerOf(e);
    if (!have.has(n)) { doc.layers.push({ name: n, color: '#000000', ltype: 'solid', lw: 0.25 }); have.add(n); }
  }
  if (!have.has(prefs.cur.layer)) prefs.cur.layer = doc.layers[0]?.name || '0';
}
const layerDef = (n) => doc.layers.find((l) => l.name === n);
function styleOf(e) {
  const L = layerDef(layerOf(e)) || {};
  return {
    color: e.dash ? '#ea580c' : (e.color || L.color || '#000000'),
    ltype: e.dash ? 'dash' : (e.ltype || L.ltype || 'solid'),
    lw: e.lw || L.lw || 0.25,
  };
}

// キャッシュ
let geoCache = new Map(), alignCache = new WeakMap();
const hatchCache = new WeakMap();
function clearCaches() { geoCache = new Map(); alignCache = new WeakMap(); }
function alignGeom(e) {
  let g = alignCache.get(e);
  if (g) return g;
  try {
    const al = buildAlignment(e.ips, e.radii, e.s0 || 0);
    const poly = [];
    for (const el of al.elems) {
      const n = el.type === 'line' ? 1 : Math.max(6, Math.ceil(el.len / el.R / (Math.PI / 90)));
      for (let i = poly.length ? 1 : 0; i <= n; i++) poly.push(alignPoint(al, Math.min(el.s + (el.len * i) / n, al.sEnd)).p);
    }
    const keys = [{ p: alignPoint(al, al.s0).p, label: 'BP', s: al.s0 }];
    for (const c of al.curves) keys.push({ p: c.BC, label: `BC${c.ip}`, s: c.sBC }, { p: c.MC, label: `MC${c.ip}`, s: c.sMC }, { p: c.EC, label: `EC${c.ip}`, s: c.sEC });
    keys.push({ p: alignPoint(al, al.sEnd).p, label: 'EP', s: al.sEnd });
    g = { al, poly, keys, pitch: e.pitch || 20 };
  } catch (err) { g = { err: err.message }; }
  alignCache.set(e, g);
  return g;
}
function geo(e) {
  let c = geoCache.get(e);
  if (!c) { c = { g: G.geomOf(e, alignGeom), bb: null }; c.bb = G.bboxOf(e, alignGeom); geoCache.set(e, c); }
  return c;
}
function hatchSegs(e) {
  const key = `${sheet().scaleN}|${e.pattern}|${e.pitch}|${e.ang}|${JSON.stringify(e.pts)}`;
  let c = hatchCache.get(e);
  if (!c || c.key !== key) { c = { key, segs: hatchSegments(e, sheet().scaleN) }; hatchCache.set(e, c); }
  return c.segs;
}

// ============================================================
// 表示（ワールド ⇔ 画面）
// ============================================================
const cv = $('#cv');
const ctx = cv.getContext('2d');
const base = document.createElement('canvas');
let W = 0, H = 0, DPR = 1, baseDirty = true;
const toS = (p) => ({ x: W / 2 + (p.y - view.y) * view.s, y: H / 2 - (p.x - view.x) * view.s });
const toW = (sx, sy) => ({ x: view.x - (sy - H / 2) / view.s, y: view.y + (sx - W / 2) / view.s });
function resize() {
  const r = cv.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  for (const c of [cv, base]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  baseDirty = true; draw();
}
function sheet() {
  if (!doc.sheet) doc.sheet = { ...defaultSheet(doc.name), title: '平面図', table: false, scale: '100', scaleN: 100 };
  const s = doc.sheet;
  if (s.scale === 'auto' || !Number(s.scale)) s.scale = String(s.scaleN || 100);
  s.scaleN = Number(s.scale);
  if (!s.center) s.center = { x: view.x, y: view.y };
  return s;
}
const scaleN = () => sheet().scaleN;
const pxmm = () => (view.s * scaleN()) / 1000;
const mmToM = (mm) => (mm * scaleN()) / 1000;
function fitBox(x0, y0, x1, y1, pad = 40) {
  view.x = (x0 + x1) / 2; view.y = (y0 + y1) / 2;
  view.s = clamp(Math.min((W - 2 * pad) / Math.max(y1 - y0, 1e-3), (H - 2 * pad) / Math.max(x1 - x0, 1e-3)), 1e-4, 1e6);
  baseDirty = true; draw(); autosave();
}
function extents(list = visibleEnts()) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of list) { const b = geo(e).bb; if (!b) continue; x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
function zoomAll() {
  const b = extents();
  if (!b) { zoomPaper(); return; }
  fitBox(b.x0, b.y0, b.x1, b.y1);
}
function paperCorners() {
  const cfg = sheet(), L = layout(cfg), X = makeXf(cfg, L);
  return [[0, 0], [L.W, 0], [L.W, L.H], [0, L.H]].map(([x, y]) => X.toM({ x, y }));
}
function zoomPaper() {
  const cs = paperCorners();
  fitBox(Math.min(...cs.map((p) => p.x)), Math.min(...cs.map((p) => p.y)), Math.max(...cs.map((p) => p.x)), Math.max(...cs.map((p) => p.y)), 24);
}
function zoomAt(sx, sy, f) {
  const p = toW(sx, sy);
  view.s = clamp(view.s * f, 1e-4, 1e6);
  view.x = p.x + (sy - H / 2) / view.s; view.y = p.y - (sx - W / 2) / view.s;
  baseDirty = true; draw(); autosave();
}

// ============================================================
// 描画
// ============================================================
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(paint); }
const fg = () => (prefs.dark ? '#f2f4f7' : '#000000');
function dispColor(hex) {
  if (!hex) return fg();
  const h = hex.toLowerCase();
  if (prefs.dark && (h === '#000000' || h === '#000')) return '#f2f4f7';
  if (!prefs.dark && (h === '#ffffff' || h === '#fff')) return '#000000';
  return hex;
}

function drawBase() {
  const c = base.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = prefs.dark ? '#14181d' : '#9aa3ad';
  c.fillRect(0, 0, W, H);
  if (prefs.showSheet) drawPaper(c);
  else { c.fillStyle = prefs.dark ? '#0b0d10' : '#ffffff'; c.fillRect(0, 0, W, H); }
  const list = visibleEnts();
  const w0 = toW(0, H), w1 = toW(W, 0); // 画面範囲（ワールド）
  const inView = (e) => { if (e.type === 'text' || e.type === 'leader' || e.type === 'dim') return true; const b = geo(e).bb; return !b || !(b.x1 < w0.x || b.x0 > w1.x || b.y1 < w0.y || b.y0 > w1.y); };
  for (const e of list) if (e.type === 'hatch' && inView(e)) drawEnt(c, e, sel.has(e.id));
  for (const e of list) if (e.type !== 'hatch' && e.type !== 'point' && inView(e)) drawEnt(c, e, sel.has(e.id));
  for (const e of list) if (e.type === 'point' && inView(e)) drawEnt(c, e, sel.has(e.id));
}

function drawPaper(c) {
  const cfg = sheet(), L = layout(cfg), X = makeXf(cfg, L);
  const cs = [[0, 0], [L.W, 0], [L.W, L.H], [0, L.H]].map(([x, y]) => toS(X.toM({ x, y })));
  c.save();
  c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 10; c.shadowOffsetX = 2; c.shadowOffsetY = 3;
  c.fillStyle = prefs.dark ? '#0b0d10' : '#ffffff';
  c.beginPath(); cs.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.fill();
  c.restore();
  const o = toS(X.toM({ x: 0, y: 0 })), ex = toS(X.toM({ x: 1, y: 0 })), ey = toS(X.toM({ x: 0, y: 1 }));
  c.save();
  c.setTransform(DPR * (ex.x - o.x), DPR * (ex.y - o.y), DPR * (ey.x - o.x), DPR * (ey.y - o.y), DPR * o.x, DPR * o.y);
  if (prefs.grid) {
    c.strokeStyle = prefs.dark ? '#26313d' : '#dbe6f3'; c.lineWidth = 0.15;
    c.beginPath();
    for (let x = L.vp.x; x <= L.vp.x + L.vp.w + 1e-6; x += 10) { c.moveTo(x, L.vp.y); c.lineTo(x, L.vp.y + L.vp.h); }
    for (let y = L.vp.y; y <= L.vp.y + L.vp.h + 1e-6; y += 10) { c.moveTo(L.vp.x, y); c.lineTo(L.vp.x + L.vp.w, y); }
    c.stroke();
  }
  if (prefs.dark) {
    c.strokeStyle = '#6b7684'; c.lineWidth = 0.35;
    for (const r of [L.frame, L.vp, L.title, L.panel].filter(Boolean)) c.strokeRect(r.x, r.y, r.w, r.h);
  } else {
    try { drawPrims(c, buildPrims(cfg, L, sheetInfo(cfg, L, X, sheetData()))); } catch { /* 描けない枠は省く */ }
  }
  c.restore();
}

function strokeStyle(c, e, col, isSel) {
  const st = styleOf(e), k = pxmm();
  let w = prefs.showLw ? Math.max(1, st.lw * k) : 1;
  if (isSel) w = Math.max(w, 2.2);
  c.lineWidth = Math.min(w, 40);
  const pat = (LTYPES[st.ltype]?.pat || []).map((v) => v * k);
  c.setLineDash(pat.length && pat.reduce((a, b) => a + b, 0) > 5 ? pat : []);
  c.strokeStyle = col; c.fillStyle = col;
}
function pathOf(c, pts, closed) {
  c.beginPath();
  pts.forEach((p, i) => { const s = toS(p); i ? c.lineTo(s.x, s.y) : c.moveTo(s.x, s.y); });
  if (closed) c.closePath();
}
function textPx(e) { return e.hmm ? e.hmm * pxmm() : (e.h || 1) * view.s * 1.25; }
function textAng(e) { return e.hmm ? (e.rot || 0) - (sheet().rot || 0) : (e.rot || 0); }
const mctx = document.createElement('canvas').getContext('2d');
function textBoxS(e) {
  // 画面上の文字の四隅
  const px = textPx(e), s = toS(e.p), lines = String(e.text ?? '').split('\n');
  mctx.font = `${Math.max(px, 1)}px ${FONT}`;
  const w = Math.max(...lines.map((l) => mctx.measureText(l).width), px * 0.5);
  const x0 = e.align === 'center' ? -w / 2 : e.align === 'right' ? -w : 0;
  const y0 = -px * 0.92, y1 = px * 0.22 + (lines.length - 1) * px * 1.3;
  const a = -textAng(e) * D2R, cs = Math.cos(a), sn = Math.sin(a);
  return [[x0, y0], [x0 + w, y0], [x0 + w, y1], [x0, y1]].map(([x, y]) => ({ x: s.x + x * cs - y * sn, y: s.y + x * sn + y * cs }));
}
function drawText(c, e, col) {
  const px = textPx(e);
  const s = toS(e.p);
  if (px < 2) { c.fillStyle = col; c.fillRect(s.x, s.y - 1, Math.max(2, String(e.text).length * px), 1); return; }
  c.save();
  c.translate(s.x, s.y);
  const a = textAng(e); if (a) c.rotate(-a * D2R);
  c.font = `${Math.min(px, 3000)}px ${FONT}`;
  c.textAlign = e.align || 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = col;
  String(e.text ?? '').split('\n').forEach((l, i) => c.fillText(l, 0, i * px * 1.3));
  c.restore();
}
function label(c, t, x, y, col, align = 'left', size = 11) {
  c.font = `${size}px ${FONT}`; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.lineWidth = 3; c.strokeStyle = prefs.dark ? '#0b0d10' : '#ffffff'; c.setLineDash([]);
  c.strokeText(t, x, y); c.fillStyle = col; c.fillText(t, x, y);
}
function pointSym(c, g, s, col) {
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2; c.setLineDash([]);
  c.beginPath();
  if (g === '基準点') {
    c.moveTo(s.x, s.y - 7); c.lineTo(s.x + 6, s.y + 4); c.lineTo(s.x - 6, s.y + 4); c.closePath(); c.stroke();
    c.beginPath(); c.arc(s.x, s.y, 1.6, 0, 7); c.fill();
  } else if (g === '逃げ') {
    c.arc(s.x, s.y, 4.5, 0, 7); c.stroke();
    c.beginPath(); c.moveTo(s.x - 3, s.y - 3); c.lineTo(s.x + 3, s.y + 3); c.moveTo(s.x + 3, s.y - 3); c.lineTo(s.x - 3, s.y + 3); c.stroke();
  } else {
    c.moveTo(s.x - 5.5, s.y); c.lineTo(s.x + 5.5, s.y); c.moveTo(s.x, s.y - 5.5); c.lineTo(s.x, s.y + 5.5); c.stroke();
    c.beginPath(); c.arc(s.x, s.y, 2.6, 0, 7); c.stroke();
  }
}
function drawDim(c, e, col, isSel) {
  const g = dimGeom(e), k = pxmm();
  const a = toS(g.ea), b = toS(g.eb), a2 = toS(g.a2), b2 = toS(g.b2);
  c.setLineDash([]); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = isSel ? 2 : 1;
  const ext = (p, q) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < 1) return;
    const u = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
    c.beginPath(); c.moveTo(p.x + u.x * 0.8 * k, p.y + u.y * 0.8 * k); c.lineTo(q.x + u.x * 1.2 * k, q.y + u.y * 1.2 * k); c.stroke();
  };
  ext(a, a2); ext(b, b2);
  c.beginPath(); c.moveTo(a2.x, a2.y); c.lineTo(b2.x, b2.y); c.stroke();
  const d = Math.hypot(b2.x - a2.x, b2.y - a2.y) || 1, u = { x: (b2.x - a2.x) / d, y: (b2.y - a2.y) / d };
  if (e.term === 'arrow') {
    const L = Math.max(2.5 * k, 5), w = Math.max(0.6 * k, 1.5);
    for (const [p, s] of [[a2, 1], [b2, -1]]) {
      const q = { x: p.x + u.x * L * s, y: p.y + u.y * L * s };
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x - u.y * w, q.y + u.x * w); c.lineTo(q.x + u.y * w, q.y - u.x * w); c.closePath(); c.fill();
    }
  } else if (e.term === 'dot') {
    for (const p of [a2, b2]) { c.beginPath(); c.arc(p.x, p.y, Math.max(0.5 * k, 2), 0, 7); c.fill(); }
  } else {
    const t = Math.max(0.9 * k, 3);
    c.lineWidth = isSel ? 2.4 : 1.4;
    for (const p of [a2, b2]) { c.beginPath(); c.moveTo(p.x - (u.x - u.y) * t, p.y - (u.y + u.x) * t); c.lineTo(p.x + (u.x - u.y) * t, p.y + (u.y + u.x) * t); c.stroke(); }
  }
  const size = (e.hmm || 2.5) * k;
  if (size < 3) return;
  let ang = Math.atan2(-(b2.y - a2.y), b2.x - a2.x);
  if (ang > Math.PI / 2 + 1e-9) ang -= Math.PI; if (ang <= -Math.PI / 2 + 1e-9) ang += Math.PI;
  c.save();
  c.translate((a2.x + b2.x) / 2 - Math.sin(ang) * 0.8 * k, (a2.y + b2.y) / 2 - Math.cos(ang) * 0.8 * k);
  c.rotate(-ang);
  c.font = `${size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillStyle = col;
  c.fillText(dimLabel(e, prefs.dimUnit), 0, 0);
  c.restore();
}

function drawEnt(c, e, isSel, ghost = null) {
  const st = styleOf(e);
  const col = ghost || (isSel ? SEL : dispColor(st.color));
  strokeStyle(c, e, col, isSel);
  if (ghost) c.lineWidth = Math.max(1, Math.min(c.lineWidth, 2));
  const k = pxmm();
  switch (e.type) {
    case 'point': {
      const s = toS(e.p), g = grpOf(e);
      const pc = ghost || (isSel ? SEL : (e.color ? dispColor(e.color) : GRP_COLOR[g] || fg()));
      pointSym(c, g, s, pc);
      if (isSel) { c.strokeStyle = SEL; c.lineWidth = 1; c.strokeRect(s.x - 8, s.y - 8, 16, 16); }
      if (prefs.showNames && e.name) label(c, e.name, s.x + 7, s.y - 6, pc);
      break;
    }
    case 'line': pathOf(c, [e.a, e.b]); c.stroke(); break;
    case 'poly': {
      if (e.pts.length < 2) break;
      pathOf(c, e.pts, e.closed);
      if (e.area && e.closed) { c.save(); c.globalAlpha = isSel ? 0.16 : 0.07; c.fill(); c.restore(); }
      c.stroke();
      if (e.area && e.closed) {
        let cx = 0, cy = 0; e.pts.forEach((p) => { cx += p.x; cy += p.y; });
        const s = toS({ x: cx / e.pts.length, y: cy / e.pts.length });
        label(c, `${fmt(G.polyArea(e.pts), 2)} ㎡`, s.x, s.y, col, 'center', 12);
      }
      break;
    }
    case 'hatch': {
      if (e.pts.length < 3) break;
      if (e.pattern === 'solid') { pathOf(c, e.pts, true); c.save(); c.globalAlpha = 0.35; c.fill(); c.restore(); }
      else {
        c.save(); c.lineWidth = 1; c.setLineDash([]);
        if (isSel) c.strokeStyle = SEL;
        c.beginPath();
        for (const [a, b] of hatchSegs(e)) { const p = toS(a), q = toS(b); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); }
        c.stroke(); c.restore();
      }
      if (e.border !== false || isSel) { pathOf(c, e.pts, true); c.stroke(); }
      break;
    }
    case 'circle': { const s = toS(e.c); c.beginPath(); c.arc(s.x, s.y, e.r * view.s, 0, Math.PI * 2); c.stroke(); break; }
    case 'arc': { const s = toS(e.c); c.beginPath(); c.arc(s.x, s.y, e.r * view.s, -e.a0 * D2R, -e.a1 * D2R, true); c.stroke(); break; }
    case 'text': drawText(c, e, col); if (isSel) { const q = textBoxS(e); c.setLineDash([3, 2]); c.lineWidth = 1; c.beginPath(); q.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke(); c.setLineDash([]); } break;
    case 'dim': drawDim(c, e, col, isSel); break;
    case 'leader': {
      const a = toS(e.a), b = toS(e.b);
      const th = (sheet().rot || 0) * D2R, R = { x: Math.cos(th), y: Math.sin(th) };
      const right = (b.x - a.x) * R.x + (b.y - a.y) * R.y >= 0, sg = right ? 1 : -1;
      const sh = Math.max(2.5 * k, 8);
      c.setLineDash([]);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(b.x + R.x * sh * sg, b.y + R.y * sh * sg); c.stroke();
      c.beginPath(); c.arc(a.x, a.y, Math.max(0.6 * k, 2.2), 0, 7); c.fill();
      const px = (e.hmm || 2.5) * k;
      if (px >= 2) {
        c.save(); c.translate(b.x + R.x * 0.5 * k * sg + R.y * 0.8 * k, b.y + R.y * 0.5 * k * sg - R.x * 0.8 * k); c.rotate(th);
        c.font = `${px}px ${FONT}`; c.textAlign = right ? 'left' : 'right'; c.fillStyle = col; c.textBaseline = 'alphabetic';
        c.fillText(e.text, 0, 0); c.restore();
      }
      break;
    }
    case 'align': {
      const g = alignGeom(e); if (g.err) break;
      c.strokeStyle = ghost || (isSel ? SEL : '#15803d'); c.fillStyle = c.strokeStyle; c.setLineDash([]);
      c.lineWidth = isSel ? 3 : 2;
      pathOf(c, g.poly); c.stroke();
      c.lineWidth = 1;
      const ppx = g.pitch * view.s;
      if (ppx >= 8) {
        const every = ppx >= 45 ? 1 : ppx >= 18 ? 5 : 10;
        for (let n = Math.ceil(g.al.s0 / g.pitch - 1e-9); n * g.pitch <= g.al.sEnd + 1e-9; n++) {
          const { p, az } = alignPoint(g.al, n * g.pitch);
          const s = toS(p), r = az * D2R, L = n % every === 0 ? 7 : 4;
          c.beginPath(); c.moveTo(s.x - Math.cos(r) * L, s.y - Math.sin(r) * L); c.lineTo(s.x + Math.cos(r) * L, s.y + Math.sin(r) * L); c.stroke();
          if (n % every === 0) label(c, `No.${n}`, s.x + Math.cos(r) * 10, s.y + Math.sin(r) * 10 + 4, c.strokeStyle);
        }
      }
      for (const q of g.keys) { const s = toS(q.p); c.beginPath(); c.arc(s.x, s.y, 3.5, 0, 7); c.fill(); label(c, q.label, s.x - 6, s.y - 7, c.strokeStyle, 'center'); }
      break;
    }
  }
  c.setLineDash([]);
}

// 一時表示（コマンドの仮線）用の描画ヘルパー
function previewApi(c) {
  const set = () => { c.strokeStyle = GHOST; c.fillStyle = GHOST; c.lineWidth = 1; c.setLineDash([]); };
  return {
    line(a, b, dash) { set(); if (dash) c.setLineDash([5, 4]); pathOf(c, [a, b]); c.stroke(); c.setLineDash([]); },
    poly(pts, closed, dash) { if (pts.length < 2) return; set(); if (dash) c.setLineDash([5, 4]); pathOf(c, pts, closed); c.stroke(); c.setLineDash([]); },
    circle(cn, r, dash) { set(); if (dash) c.setLineDash([5, 4]); const s = toS(cn); c.beginPath(); c.arc(s.x, s.y, Math.abs(r) * view.s, 0, 7); c.stroke(); c.setLineDash([]); },
    mark(p) { set(); const s = toS(p); c.beginPath(); c.arc(s.x, s.y, 3, 0, 7); c.fill(); },
    text(p, t, dx = 10, dy = -10) { const s = toS(p); label(c, t, s.x + dx, s.y + dy, GHOST, 'left', 12); },
    ents(list) { for (const e of list) drawEnt(c, e, false, GHOST); },
  };
}

let hover = null;       // 現在のスナップ結果 {p, kind, label}
let mouse = null;       // 画面座標
let hoverEnt = null;    // 図形選択モードでカーソル下の図形
let winSel = null;      // 範囲選択 {x0,y0,x1,y1}
function paint() {
  raf = 0;
  if (baseDirty) { drawBase(); baseDirty = false; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 計算結果
  if (overlay) {
    ctx.strokeStyle = '#7c3aed'; ctx.fillStyle = '#7c3aed'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
    for (const [a, b] of overlay.lines || []) { pathOf(ctx, [a, b]); ctx.stroke(); }
    ctx.setLineDash([]);
    for (const q of overlay.pts || []) { const s = toS(q.p); ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 7); ctx.fill(); if (q.label) label(ctx, q.label, s.x + 7, s.y - 7, '#7c3aed'); }
  }
  if (hoverEnt && cmd && (cmd.mode === 'entity' || cmd.mode === 'select')) drawEnt(ctx, hoverEnt, true);
  else if (hoverEnt && !cmd) { ctx.save(); ctx.globalAlpha = 0.55; drawEnt(ctx, hoverEnt, true); ctx.restore(); }
  if (cmd?.preview && hover) { try { cmd.preview(previewApi(ctx), hover.p); } catch (err) { console.error(err); } }
  if (winSel) {
    const crossing = winSel.x1 < winSel.x0;
    ctx.fillStyle = crossing ? 'rgba(25,135,84,.10)' : 'rgba(31,111,235,.10)';
    ctx.strokeStyle = crossing ? '#198754' : SEL; ctx.lineWidth = 1; ctx.setLineDash(crossing ? [5, 3] : []);
    const x = Math.min(winSel.x0, winSel.x1), y = Math.min(winSel.y0, winSel.y1), w = Math.abs(winSel.x1 - winSel.x0), h = Math.abs(winSel.y1 - winSel.y0);
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  }
  // カーソル
  if (mouse) {
    const p = hover && wantsPoint() ? toS(hover.p) : mouse;
    ctx.strokeStyle = prefs.dark ? 'rgba(255,255,255,.55)' : 'rgba(30,40,55,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p.x - 18, p.y + 0.5); ctx.lineTo(p.x + 18, p.y + 0.5); ctx.moveTo(p.x + 0.5, p.y - 18); ctx.lineTo(p.x + 0.5, p.y + 18); ctx.stroke();
    if (!wantsPoint()) { ctx.strokeRect(mouse.x - 5, mouse.y - 5, 10, 10); }
    if (hover && hover.kind && wantsPoint()) snapMarker(ctx, p, hover);
  }
}
function snapMarker(c, s, h) {
  c.strokeStyle = SNAPC; c.fillStyle = SNAPC; c.lineWidth = 2; c.setLineDash([]);
  const r = 6;
  c.beginPath();
  switch (h.kind) {
    case '端点': c.rect(s.x - r, s.y - r, 2 * r, 2 * r); break;
    case '中点': c.moveTo(s.x, s.y - r); c.lineTo(s.x + r, s.y + r * 0.8); c.lineTo(s.x - r, s.y + r * 0.8); c.closePath(); break;
    case '交点': c.moveTo(s.x - r, s.y - r); c.lineTo(s.x + r, s.y + r); c.moveTo(s.x + r, s.y - r); c.lineTo(s.x - r, s.y + r); break;
    case '中心': c.arc(s.x, s.y, r, 0, 7); break;
    case '点': c.moveTo(s.x, s.y - r - 1); c.lineTo(s.x + r + 1, s.y); c.lineTo(s.x, s.y + r + 1); c.lineTo(s.x - r - 1, s.y); c.closePath(); break;
    case '垂点': c.moveTo(s.x - r, s.y + r); c.lineTo(s.x + r, s.y + r); c.moveTo(s.x, s.y + r); c.lineTo(s.x, s.y - r); break;
    case '線上': c.moveTo(s.x - r, s.y - r); c.lineTo(s.x + r, s.y - r); c.lineTo(s.x - r, s.y + r); c.lineTo(s.x + r, s.y + r); c.closePath(); break;
    case '直交': c.moveTo(s.x - r, s.y); c.lineTo(s.x + r, s.y); c.moveTo(s.x, s.y - r); c.lineTo(s.x, s.y + r); break;
    default: break;
  }
  c.stroke();
  label(c, h.label ? `${h.kind}  ${h.label}` : h.kind, s.x + 10, s.y + 20, SNAPC, 'left', 11);
}
const wantsPoint = () => !!cmd && (!cmd.mode || cmd.mode === 'point');

// ============================================================
// スナップ・図形の選択
// ============================================================
const SNAP_ORDER = { 点: 0, 端点: 1, 交点: 2, 中点: 3, 中心: 4, 垂点: 5, 線上: 6 };
function snapAt(sx, sy) {
  const p = toW(sx, sy), tol = 12 / view.s;
  const from = cmd?.lastPt || null;
  const S = prefs.snap;
  let best = null;
  const cand = (q, kind, lbl) => {
    const d = G.dist(p, q);
    if (d > tol) return;
    const r = SNAP_ORDER[kind];
    if (!best || r < best.r || (r === best.r && d < best.d)) best = { p: { x: q.x, y: q.y }, kind, label: lbl, r, d };
  };
  const nearGeo = [];
  for (const e of visibleEnts()) {
    const { g, bb } = geo(e);
    if (!bb || p.x < bb.x0 - tol || p.x > bb.x1 + tol || p.y < bb.y0 - tol || p.y > bb.y1 + tol) {
      // 円は外接矩形の外でも中心を拾えるようにしない（遠い）
      continue;
    }
    if (e.type === 'point') { if (S.pt || S.end) cand(e.p, '点', e.name); continue; }
    if (e.type === 'text') continue;
    if (S.end) for (const q of g.ends) cand(q, '端点');
    if (S.mid) for (const q of g.mids) cand(q, '中点');
    let near = false;
    for (const [a, b] of g.segs) { const { q } = G.projectOnSeg(p, a, b); if (G.dist(q, p) <= tol) { near = true; if (S.near) cand(q, '線上'); if (S.perp && from) { const f = G.projectOnSeg(from, a, b, false).q; cand(f, '垂点'); } } }
    for (const A of g.arcs) {
      const d = Math.abs(G.dist(A.c, p) - A.r);
      if (d <= tol && (A.full || G.inArc(G.angOf(A.c, p), A.a0, A.a1))) {
        near = true;
        // 円周の近くでは中心を候補にする（距離は円周までの距離で比べる）
        if (S.cen) { const r = SNAP_ORDER['中心']; if (!best || r < best.r || (r === best.r && d < best.d)) best = { p: { ...A.c }, kind: '中心', r, d }; }
        if (S.near) cand(G.arcPt(A.c, A.r, G.angOf(A.c, p)), '線上');
      }
      if (S.cen) cand(A.c, '中心');
    }
    if (near) nearGeo.push(g);
  }
  if (S.inter && nearGeo.length) {
    for (let i = 0; i < nearGeo.length; i++) {
      for (const q of G.intersections(nearGeo[i], nearGeo[i], false)) if (!nearGeo[i].ends.some((v) => G.dist(v, q) < 1e-9)) cand(q, '交点');
      for (let j = i + 1; j < nearGeo.length; j++) for (const q of G.intersections(nearGeo[i], nearGeo[j], false)) cand(q, '交点');
    }
  }
  if (best) return best;
  // 直交モード
  if (prefs.ortho && from) {
    const dx = Math.abs(p.x - from.x), dy = Math.abs(p.y - from.y);
    return { p: dx > dy ? { x: p.x, y: from.y } : { x: from.x, y: p.y }, kind: '直交' };
  }
  return { p, kind: null };
}

/** 画面上の点 (sx, sy) にある図形（filter を満たすもの） */
function hitEnt(sx, sy, filter) {
  const p = toW(sx, sy), tol = 6 / view.s;
  let best = null;
  const list = visibleEnts();
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (filter && !filter(e)) continue;
    let d = Infinity;
    if (e.type === 'text') {
      const q = textBoxS(e);
      if (G.pointInPoly({ x: sx, y: sy }, q.map((v) => ({ x: v.x, y: v.y })))) d = 0;
    } else {
      const { g, bb } = geo(e);
      if (!bb || p.x < bb.x0 - tol * 2 || p.x > bb.x1 + tol * 2 || p.y < bb.y0 - tol * 2 || p.y > bb.y1 + tol * 2) continue;
      if (e.type === 'point') d = G.dist(p, e.p) * 0.6;
      for (const [a, b] of g.segs) d = Math.min(d, G.segDist(p, a, b));
      for (const A of g.arcs) if (A.full || G.inArc(G.angOf(A.c, p), A.a0, A.a1)) d = Math.min(d, Math.abs(G.dist(A.c, p) - A.r));
      if (e.type === 'hatch' && d > tol && G.pointInPoly(p, e.pts)) d = tol * 0.95;
    }
    if (d <= tol * (e.type === 'point' ? 1.6 : 1) && (!best || d < best.d)) best = { e, d };
  }
  return best ? best.e : null;
}
/** 範囲選択。crossing = かかった図形も含む */
function entsInRect(r, crossing) {
  const out = [];
  const inR = (q) => q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1;
  for (const e of visibleEnts()) {
    let pts;
    if (e.type === 'text') pts = textBoxS(e).map((s) => toW(s.x, s.y));
    else {
      const { g } = geo(e);
      pts = [...g.pts, ...g.ends, ...g.segs.flat()];
      for (const A of g.arcs) pts.push(...G.arcPoly(A, 24));
    }
    if (!pts.length) continue;
    if (!crossing) { if (pts.every(inR)) out.push(e); continue; }
    if (pts.some(inR)) { out.push(e); continue; }
    const { g } = e.type === 'text' ? { g: { segs: [], arcs: [] } } : geo(e);
    let hit = g.segs.some(([a, b]) => G.segHitsRect(a, b, r));
    if (!hit) for (const A of g.arcs) { const pl = G.arcPoly(A, 24); for (let i = 0; i + 1 < pl.length && !hit; i++) hit = G.segHitsRect(pl[i], pl[i + 1], r); }
    if (!hit && e.type === 'text') { const q = pts; for (let i = 0; i < 4 && !hit; i++) hit = G.segHitsRect(q[i], q[(i + 1) % 4], r); }
    if (hit) out.push(e);
  }
  return out;
}
const selEnts = () => doc.entities.filter((e) => sel.has(e.id));
function setSel(list) {
  sel = new Set(list.map((e) => (typeof e === 'object' ? e.id : e)));
  baseDirty = true; draw(); renderProps(); refreshMB();
}

// ============================================================
// コマンド
// ============================================================
const K = {
  doc, view, prefs, G, GROUPS, grpOf, D2R,
  get sel() { return selEnts(); }, setSel, clearSel: () => setSel([]),
  ent: entById, visibleEnts, add: addEnt, remove: removeEnts, replace: replaceEnt,
  begin, commit, undo,
  style: curStyle, styleOf, textH: () => prefs.textH, scaleN, mm: mmToM, pxmm, sheet,
  inLen(v) { const n = Number(String(v).replace(/[，,]/g, '').trim()); return prefs.inUnit === 'mm' ? n / 1000 : n; },
  fmtLen(m) { return prefs.inUnit === 'mm' ? String(Math.round(m * 1000)) : fmt(m); },
  unitLabel: () => prefs.inUnit,
  nextPointName, uniqueName, pointByName, pointAt, ensurePoint,
  geo: (e) => geo(e).g, bbox: (e) => geo(e).bb, alignGeom, hitEnt, toS, toW,
  toast, fmt, esc, toDMS, parseAngle,
  refresh: () => afterCmd(), redraw: () => { baseDirty = true; draw(); },
  dialog, getPoint, startCmd: (id) => startCmd(id), endCmd: () => endCmd(),
  hover: () => hover, extents, fitBox, zoomAll,
  layers: () => doc.layers, layerDef,
  dimUnit: () => prefs.dimUnit,
  openCalc: (id) => calc.open(id),
  addReport, sheetData,
  markDirty: () => { setDirty(true); autosave(); },
  replaceDoc, renderAll, fileState: () => ({ fileHandle, fileName }),
  idb, sheetLib: { layout, makeXf },
};
const CMDS = { ...commandDefs(K), ...civilDefs(K) };
const link = initLink(K);

function startCmd(id) {
  closeMenu();
  const def = CMDS[id];
  if (!def) { console.warn('unknown command', id); return; }
  if (def.run) { endCmd(); def.run(); return; } // ダイアログなどすぐ終わるもの
  endCmd();
  cmd = def.start();
  cmd.id = id; cmd.title = cmd.title || def.title; cmd.icon = def.icon;
  cmd.o = cmd.o || {};
  for (const o of cmd.opts || []) if (cmd.o[o.k] === undefined) cmd.o[o.k] = typeof o.value === 'function' ? o.value() : o.value;
  lastCmdId = id;
  prefs.recent = [id, ...prefs.recent.filter((x) => x !== id)].slice(0, 8); savePrefs();
  if (def.needsSel) {
    const s = selEnts().filter(def.filter || (() => true));
    if (s.length) { cmd.selection = s; cmd.onSelected(s); } else { cmd.mode = 'select'; setSel([]); }
  }
  markRibbon();
  afterCmd();
  cv.focus();
}
function startAdhoc(obj) {
  endCmd();
  cmd = obj; cmd.o = cmd.o || {};
  for (const o of cmd.opts || []) if (cmd.o[o.k] === undefined) cmd.o[o.k] = o.value;
  markRibbon(); afterCmd();
}
function endCmd() {
  if (!cmd) return;
  const c = cmd; cmd = null;
  try { c.onEnd?.(); } catch (err) { console.error(err); }
  hoverEnt = null; winSel = null;
  markRibbon(); refreshMB(); draw();
}
function afterCmd() {
  if (cmd?.done) {
    const id = cmd.id, again = cmd.again;
    endCmd();
    if (again && CMDS[id]) startCmd(id);
  }
  refreshMB(); draw();
}
function confirmCmd() {
  if (!cmd) { if (lastCmdId) startCmd(lastCmdId); return; }
  if (cmd.mode === 'select') {
    const s = selEnts().filter(CMDS[cmd.id]?.filter || (() => true));
    if (!s.length) { toast('図形を選んでください'); return; }
    cmd.mode = 'point'; cmd.selection = s; cmd.onSelected(s); afterCmd(); return;
  }
  if (cmd.onEnter) { cmd.onEnter(); afterCmd(); } else endCmd();
}
/** 点を1つ指示してもらう（ダイアログから図の位置を選ぶときなど） */
function getPoint(msg, { preview } = {}) {
  return new Promise((resolve) => {
    let got = false;
    startAdhoc({
      title: '位置の指示', prompt: msg, preview,
      onPoint(p) { got = true; this.done = true; resolve(p); },
      onEnd() { if (!got) resolve(null); },
    });
  });
}

// マルチボックス
let renderedOpts = null;
function refreshMB() {
  const c = cmd;
  $('#mbIcon').innerHTML = c ? (ICONS[c.icon] || ICONS[c.id] || '') : ICONS.select;
  $('#mbTitle').textContent = c ? c.title : '選択';
  let pr;
  if (!c) pr = sel.size ? `${sel.size} 個の図形を選択中。右クリックで編集メニュー、Delete で削除。` : '図形をクリックで選択（Shift で追加）。ドラッグで範囲選択：左→右は囲んだ図形、右→左はかかった図形。';
  else if (c.mode === 'select') pr = `対象の図形を選んで［確定］（Enter・右クリック）。${sel.size ? `選択 ${sel.size} 個` : ''}`;
  else pr = typeof c.prompt === 'function' ? c.prompt() : c.prompt || '';
  $('#mbPrompt').textContent = pr;
  status(pr);
  const opts = c?.opts || null;
  if (opts !== renderedOpts) { renderOpts(c); renderedOpts = opts; }
  $('#mbOk').disabled = !c; $('#mbBack').disabled = !c; $('#mbEsc').disabled = !c;
  // 下の情報欄
  let info = '';
  if (c?.info) info = typeof c.info === 'function' ? c.info() : c.info;
  else if (!c) {
    if (overlay) info += '<div class="mb-result">計算結果を表示中 <button class="btn" data-mb="clearOverlay">消す</button></div>';
    if (prefs.recent.length) info += '<h4>最近のコマンド</h4><div class="recent">' + prefs.recent.filter((id) => CMDS[id]).map((id) => `<button data-cmd="${id}">${esc(CMDS[id].title)}</button>`).join('') + '</div>';
    info += '<h4>操作のこつ</h4>ホイール: 拡大縮小 ／ 中ボタンドラッグ: 移動<br>Enter: 直前のコマンド ／ Esc: 終了<br>F8: 直交 ／ Ctrl+Z: 元に戻す';
  }
  $('#mbInfo').innerHTML = info;
}
function renderOpts(c) {
  const box = $('#mbOpts');
  if (!c || !c.opts) { box.innerHTML = ''; return; }
  box.innerHTML = c.opts.map((o) => {
    const v = c.o[o.k];
    const id = `opt_${o.k}`;
    switch (o.type) {
      case 'check': return `<div class="opt chk"><label><input type="checkbox" id="${id}" data-k="${o.k}" ${v ? 'checked' : ''}> ${esc(o.label)}</label></div>`;
      case 'select': return `<label class="opt"><span>${esc(o.label)}</span><select id="${id}" data-k="${o.k}">${o.options.map(([val, l]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      case 'seg': return `<div class="opt"><span>${esc(o.label)}</span><div class="seg" data-k="${o.k}">${o.options.map(([val, l]) => `<button type="button" data-v="${esc(val)}" class="${String(val) === String(v) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
      case 'textarea': return `<label class="opt"><span>${esc(o.label)}</span><textarea id="${id}" data-k="${o.k}" rows="${o.rows || 2}">${esc(v ?? '')}</textarea></label>`;
      case 'btns': return `<div class="opt btns"><div>${o.buttons.map((b, i) => `<button type="button" class="btn" data-ob="${o.k}:${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
      default: return `<label class="opt"><span>${esc(o.label)}${o.unit ? `（${esc(typeof o.unit === 'function' ? o.unit() : o.unit)}）` : ''}</span><input type="text" id="${id}" data-k="${o.k}" value="${esc(v ?? '')}" autocomplete="off" spellcheck="false"></label>`;
    }
  }).join('');
}
function optChanged(k, raw) {
  const c = cmd; if (!c) return;
  const o = c.opts.find((q) => q.k === k); if (!o) return;
  let v = raw;
  if (o.type === 'num') { const n = Number(String(raw).replace(/，/g, '.')); v = Number.isFinite(n) ? n : c.o[k]; }
  c.o[k] = v;
  c.onOpt?.(k, v);
  afterCmd();
}
$('#mbOpts').addEventListener('change', (ev) => {
  const t = ev.target; if (!t.dataset.k) return;
  optChanged(t.dataset.k, t.type === 'checkbox' ? t.checked : t.value);
});
$('#mbOpts').addEventListener('input', (ev) => {
  const t = ev.target; if (!t.dataset.k || t.type === 'checkbox' || t.tagName === 'SELECT') return;
  const c = cmd; if (!c) return;
  const o = c.opts.find((q) => q.k === t.dataset.k);
  if (o?.type === 'num') { const n = Number(t.value.replace(/，/g, '.')); if (Number.isFinite(n)) c.o[o.k] = n; } else if (o) c.o[o.k] = t.value;
  draw();
});
$('#mbOpts').addEventListener('click', (ev) => {
  const b = ev.target.closest('.seg button');
  if (b) { const k = b.parentElement.dataset.k; $$('.seg button', b.parentElement).forEach((x) => x.classList.toggle('on', x === b)); optChanged(k, b.dataset.v); return; }
  const ob = ev.target.closest('[data-ob]');
  if (ob && cmd) { const [k, i] = ob.dataset.ob.split(':'); cmd.opts.find((q) => q.k === k)?.buttons[Number(i)]?.fn(); afterCmd(); }
});
$('#mbOpts').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA') { ev.preventDefault(); ev.target.blur(); optChanged(ev.target.dataset.k, ev.target.value); cv.focus(); }
});
$('#mbInfo').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-cmd]'); if (b) { startCmd(b.dataset.cmd); return; }
  const m = ev.target.closest('[data-mb]');
  if (m?.dataset.mb === 'clearOverlay') { overlay = null; refreshMB(); draw(); }
  if (m && cmd?.infoAct) { cmd.infoAct(m.dataset.mb, m); afterCmd(); }
});
$('#mbOk').addEventListener('click', confirmCmd);
$('#mbBack').addEventListener('click', () => { if (cmd?.onBack) { cmd.onBack(); afterCmd(); } });
$('#mbEsc').addEventListener('click', endCmd);

// 座標・数値入力
const z2h = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ').replace(/、/g, ',');
function parseInput(text) {
  const t = z2h(text).trim();
  if (!t) return null;
  const last = cmd?.lastPt;
  if (t.startsWith('@')) {
    if (!last) throw new Error('相対入力（@）は前の点があるときに使えます');
    const r = t.slice(1);
    if (r.includes('<')) {
      const [d, a] = r.split('<');
      const az = parseAngle(a); const L = K.inLen(d);
      if (!Number.isFinite(az) || !Number.isFinite(L)) throw new Error('「@距離<方向角」の形で入力してください（例 @5<45-30-00）');
      return G.polarAz(last, az, L);
    }
    const [a, b] = r.split(',').map((s) => K.inLen(s));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('「@ΔX,ΔY」の形で入力してください');
    return { x: last.x + a, y: last.y + b };
  }
  if (t.includes(',')) {
    const [a, b] = t.split(',').map((s) => Number(s.trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('「X,Y」の形で入力してください');
    return { x: a, y: b };
  }
  const pe = pointByName(t);
  if (pe) return { ...pe.p };
  const n = Number(t);
  if (Number.isFinite(n) && last && hover) {
    const d = G.dist(last, hover.p);
    if (d < 1e-9) throw new Error('方向が決まりません。カーソルを動かしてから入力してください');
    const L = K.inLen(n);
    return { x: last.x + ((hover.p.x - last.x) / d) * L, y: last.y + ((hover.p.y - last.y) / d) * L };
  }
  throw new Error(`「${text}」を点として読めません`);
}
function submitInput() {
  const inp = $('#mbInput');
  const text = inp.value.trim();
  if (!text) { confirmCmd(); return; }
  try {
    if (cmd?.onInput && cmd.onInput(z2h(text)) !== false) { inp.value = ''; afterCmd(); return; }
    if (!cmd) {
      const pe = pointByName(z2h(text));
      if (pe) { setSel([pe]); view.x = pe.p.x; view.y = pe.p.y; baseDirty = true; draw(); inp.value = ''; return; }
      const id = Object.keys(CMDS).find((k) => CMDS[k].title === text || k === text);
      if (id) { inp.value = ''; startCmd(id); return; }
      throw new Error('コマンドを選んでから入力してください（点名を入れるとその点へ移動します）');
    }
    if (!wantsPoint()) throw new Error('今は点の入力を受け付けていません');
    const p = parseInput(text);
    inp.value = '';
    cmd.onPoint(p, { kind: '入力' });
    afterCmd();
  } catch (err) { toast(err.message, 3500); }
}
$('#mbEnter').addEventListener('click', submitInput);
$('#mbInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); submitInput(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.target.value = ''; cv.focus(); }
});

// ============================================================
// マウス・キーボード
// ============================================================
let drag = null; // {kind:'pan'|'win'|'click', sx, sy, vx, vy}
let lastMid = 0;
cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
cv.addEventListener('mousedown', (ev) => {
  cv.focus();
  closeMenu();
  const r = cv.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  if (ev.button === 1) {
    ev.preventDefault();
    const now = Date.now();
    if (now - lastMid < 350) { zoomAll(); lastMid = 0; return; }
    lastMid = now;
    drag = { kind: 'pan', sx, sy, vx: view.x, vy: view.y };
    return;
  }
  if (ev.button === 2) { openCtxMenu(ev.clientX, ev.clientY); return; }
  if (ev.button !== 0) return;
  drag = { kind: 'click', sx, sy, shift: ev.shiftKey || ev.ctrlKey };
});
window.addEventListener('mousemove', (ev) => {
  const r = cv.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  if (drag?.kind === 'pan') {
    view.x = drag.vx + (sy - drag.sy) / view.s; view.y = drag.vy - (sx - drag.sx) / view.s;
    baseDirty = true; mouse = { x: sx, y: sy }; draw(); return;
  }
  if (ev.target !== cv && !drag) { if (mouse) { mouse = null; draw(); } return; }
  mouse = { x: sx, y: sy };
  if (drag?.kind === 'click' && Math.hypot(sx - drag.sx, sy - drag.sy) > 5 && (!cmd || cmd.mode === 'select')) drag.kind = 'win';
  if (drag?.kind === 'win') { winSel = { x0: drag.sx, y0: drag.sy, x1: sx, y1: sy }; draw(); return; }
  if (wantsPoint()) { hover = snapAt(sx, sy); cmd.onMove?.(hover.p); }
  else { hover = { p: toW(sx, sy), kind: null }; hoverEnt = hitEnt(sx, sy, cmd?.mode === 'entity' ? cmd.filter : (cmd?.mode === 'select' ? CMDS[cmd.id]?.filter : null)); }
  const p = hover.p;
  $('#stXY').textContent = `X= ${fmt(p.x)}  Y= ${fmt(p.y)}`;
  draw();
});
window.addEventListener('mouseup', (ev) => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'pan') { autosave(); return; }
  const r = cv.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  if (d.kind === 'win') {
    const a = toW(d.sx, d.sy), b = toW(sx, sy);
    const rect = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
    const crossing = sx < d.sx;
    let found = entsInRect(rect, crossing);
    const f = cmd?.mode === 'select' ? CMDS[cmd.id]?.filter : null;
    if (f) found = found.filter(f);
    winSel = null;
    if (cmd?.onWindow) { cmd.onWindow(rect, crossing); afterCmd(); return; }
    setSel(d.shift || cmd?.mode === 'select' ? [...selEnts(), ...found] : found);
    return;
  }
  onClick(sx, sy, d.shift);
});
function onClick(sx, sy, shift) {
  if (!cmd || cmd.mode === 'select') {
    const e = hitEnt(sx, sy, cmd ? CMDS[cmd.id]?.filter : null);
    if (!e) { if (!shift && !cmd) setSel([]); return; }
    if (shift || cmd) { if (sel.has(e.id)) sel.delete(e.id); else sel.add(e.id); setSel([...sel]); }
    else setSel([e]);
    return;
  }
  if (cmd.mode === 'entity') {
    const e = hitEnt(sx, sy, cmd.filter);
    if (!e) { toast(cmd.missMsg || '図形が見つかりません。線の上をクリックしてください'); return; }
    cmd.onPick(e, toW(sx, sy));
    afterCmd();
    return;
  }
  const h = snapAt(sx, sy);
  cmd.onPoint(h.p, h);
  afterCmd();
}
cv.addEventListener('dblclick', (ev) => {
  if (cmd) return;
  const r = cv.getBoundingClientRect();
  const e = hitEnt(ev.clientX - r.left, ev.clientY - r.top);
  if (!e) return;
  setSel([e]);
  const f = $('#props [data-p="text"], #props [data-p="name"]');
  if (f) { f.focus(); f.select?.(); }
});
cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = cv.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.pow(1.0015, -ev.deltaY));
}, { passive: false });
cv.addEventListener('mouseleave', () => { mouse = null; draw(); });

function inEditable(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
document.addEventListener('keydown', (ev) => {
  if (document.querySelector('dialog[open]')) return;
  const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl) {
    const map = { z: undo, y: redo, s: () => (ev.shiftKey ? saveAs() : save()), o: openFile, n: newDoc, c: copySel, x: cutSel, v: () => startCmd('paste'), a: () => setSel(visibleEnts()), p: openPrint };
    const f = map[k.toLowerCase()];
    if (f && !(inEditable(ev.target) && 'cxva'.includes(k.toLowerCase()))) { ev.preventDefault(); f(); }
    return;
  }
  if (k === 'F1') { ev.preventDefault(); showHelp(); return; }
  if (k === 'F8') { ev.preventDefault(); prefs.ortho = !prefs.ortho; savePrefs(); renderSnapBar(); toast(`直交モード ${prefs.ortho ? 'ON' : 'OFF'}`); return; }
  if (k === 'F3') { ev.preventDefault(); const on = !Object.values(prefs.snap).some(Boolean); for (const q of Object.keys(prefs.snap)) prefs.snap[q] = on && ['pt', 'end', 'mid', 'inter', 'cen'].includes(q); savePrefs(); renderSnapBar(); toast(`点スナップ ${on ? 'ON' : 'OFF'}`); return; }
  if (inEditable(ev.target)) return;
  if (k === 'Escape') { ev.preventDefault(); if (!$('#ctxmenu').hidden) closeMenu(); else if (cmd) endCmd(); else { overlay = null; setSel([]); } return; }
  if (k === 'Enter' || k === ' ') { ev.preventDefault(); confirmCmd(); return; }
  if (k === 'Delete') { ev.preventDefault(); deleteSel(); return; }
  if (k === 'Backspace') { ev.preventDefault(); if (cmd?.onBack) { cmd.onBack(); afterCmd(); } return; }
  if (k === 'Home') { ev.preventDefault(); zoomAll(); return; }
  if (k.length === 1 && /[0-9@.,\-A-Za-z０-９＠]/.test(k)) {
    const inp = $('#mbInput'); inp.focus(); inp.value += k; ev.preventDefault();
  }
});

// 右クリックメニュー
function closeMenu() { $('#ctxmenu').hidden = true; }
function openMenu(x, y, items) {
  const m = $('#ctxmenu');
  m.innerHTML = items.map((it, i) => {
    if (it === '-') return '<hr>';
    if (it.head) return `<div class="mh">${esc(it.head)}</div>`;
    return `<button data-i="${i}" ${it.disabled ? 'disabled' : ''} class="${it.checked ? 'chk' : ''}"><span>${esc(it.label)}</span><span class="k">${esc(it.key || '')}</span></button>`;
  }).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  m.onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; closeMenu(); items[Number(b.dataset.i)].fn(); };
}
document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('#ctxmenu')) closeMenu(); });
function snapItems() {
  const S = prefs.snap;
  const t = (k, l) => ({ label: l, checked: S[k], fn: () => { S[k] = !S[k]; savePrefs(); renderSnapBar(); } });
  return [{ head: '点の指示（スナップ）' }, t('pt', '点（測点）'), t('end', '端点'), t('mid', '中点'), t('inter', '交点'), t('cen', '中心点'), t('perp', '垂点'), t('near', '線上点'),
    { label: '直交モード', key: 'F8', checked: prefs.ortho, fn: () => { prefs.ortho = !prefs.ortho; savePrefs(); renderSnapBar(); } }];
}
function openCtxMenu(x, y) {
  let items;
  if (cmd) {
    items = [
      { label: cmd.mode === 'select' ? '選択を確定' : '確定', key: 'Enter', fn: confirmCmd },
      { label: '1つ戻る', key: 'BS', disabled: !cmd.onBack, fn: () => { cmd.onBack(); afterCmd(); } },
      { label: 'コマンドを終了', key: 'Esc', fn: endCmd },
      '-', ...snapItems(),
    ];
  } else if (sel.size) {
    items = [
      { label: '移動', fn: () => startCmd('move') }, { label: '複写', fn: () => startCmd('copy') },
      { label: '回転', fn: () => startCmd('rotate') }, { label: '反転', fn: () => startCmd('mirror') }, { label: '拡大・縮小', fn: () => startCmd('scale') },
      '-',
      { label: '切り取り', key: 'Ctrl+X', fn: cutSel }, { label: 'コピー', key: 'Ctrl+C', fn: copySel },
      { label: '削除', key: 'Delete', fn: deleteSel },
      '-',
      { label: '選択を解除', key: 'Esc', fn: () => setSel([]) },
    ];
  } else {
    items = [
      { label: lastCmdId ? `直前のコマンド（${CMDS[lastCmdId]?.title}）` : '直前のコマンド', key: 'Enter', disabled: !lastCmdId, fn: () => startCmd(lastCmdId) },
      { label: '元に戻す', key: 'Ctrl+Z', disabled: !undoStack.length, fn: undo }, { label: 'やり直し', key: 'Ctrl+Y', disabled: !redoStack.length, fn: redo },
      { label: '貼り付け', key: 'Ctrl+V', disabled: !clip, fn: () => startCmd('paste') },
      '-',
      { label: '全体表示', key: 'Home', fn: zoomAll }, { label: '用紙全体を表示', fn: zoomPaper },
      { label: 'すべて選択', key: 'Ctrl+A', fn: () => setSel(visibleEnts()) },
      '-', ...snapItems(),
    ];
  }
  openMenu(x, y, items);
}

// 編集の基本
function deleteSel() {
  const s = selEnts(); if (!s.length) { toast('削除する図形を選んでください'); return; }
  begin(); removeEnts(s); commit(`${s.length} 個の図形を削除しました`);
}
function copySel() {
  const s = selEnts(); if (!s.length) { toast('コピーする図形を選んでください'); return; }
  clip = JSON.parse(JSON.stringify(s));
  try { navigator.clipboard?.writeText(JSON.stringify({ genbacadClip: clip })); } catch { /* */ }
  toast(`${s.length} 個の図形をコピーしました（Ctrl+V で貼り付け）`);
}
function cutSel() { const s = selEnts(); if (!s.length) return; copySel(); begin(); removeEnts(s); commit(); }
K.clip = () => clip;

// ============================================================
// プロパティ
// ============================================================
const colorOpts = (v, withLayer = true) => (withLayer ? `<option value="" ${!v ? 'selected' : ''}>レイヤ色</option>` : '') +
  COLORS.map((c) => `<option value="${c.hex}" ${v === c.hex ? 'selected' : ''} style="color:${c.hex}">■ ${c.name}</option>`).join('') +
  (v && !COLORS.some((c) => c.hex === v) ? `<option value="${v}" selected style="color:${v}">■ ${v}</option>` : '');
const ltOpts = (v, withLayer = true) => (withLayer ? `<option value="" ${!v ? 'selected' : ''}>レイヤ線種</option>` : '') + Object.entries(LTYPES).map(([k, t]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${t.name}</option>`).join('');
const lwOpts = (v, withLayer = true) => (withLayer ? `<option value="0" ${!v ? 'selected' : ''}>レイヤ線幅</option>` : '') + LWS.map((w) => `<option value="${w}" ${Number(v) === w ? 'selected' : ''}>${w} mm</option>`).join('');
const layerOpts = (v) => doc.layers.map((l) => `<option ${l.name === v ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
const TYPE_NAME = { point: '点', line: '線', poly: '連続線', circle: '円', arc: '円弧', text: '文字', dim: '寸法線', leader: '引出線', hatch: 'ハッチング', align: '路線' };
function prow(label, html) { return `<label class="prow"><span>${esc(label)}</span>${html}</label>`; }
const pin = (k, v, num = true) => `<input data-p="${k}" class="${num ? 'num' : ''}" value="${esc(v)}">`;
const pout = (v) => `<output>${esc(v)}</output>`;
function renderProps() {
  const s = selEnts();
  const box = $('#props');
  if (!s.length) {
    const ex = extents();
    box.innerHTML = `<div class="empty">図形を選ぶと、ここで属性を確認・変更できます。<br>図形 ${doc.entities.length} 個${ex ? `<br>範囲 X ${fmt(ex.x0, 1)}〜${fmt(ex.x1, 1)}<br>　　 Y ${fmt(ex.y0, 1)}〜${fmt(ex.y1, 1)}` : ''}<br>座標系: ${doc.zone ? `第${doc.zone}系` : '未設定'}</div>`;
    return;
  }
  const e = s[0], one = s.length === 1;
  const same = (k) => (s.every((q) => (q[k] ?? '') === (e[k] ?? '')) ? e[k] ?? '' : null);
  let h = `<div class="ptype">${one ? TYPE_NAME[e.type] || e.type : `${s.length} 個の図形（${[...new Set(s.map((q) => TYPE_NAME[q.type] || q.type))].join('・')}）`}</div>`;
  const lay = same('layer');
  h += prow('レイヤ', `<select data-p="layer">${lay === null ? '<option value="" selected>（混在）</option>' : ''}${layerOpts(lay || '0')}</select>`);
  if (s.some((q) => q.type !== 'point')) {
    const c = same('color'), lt = same('ltype'), lw = same('lw');
    h += prow('色', `<select data-p="color">${c === null ? '<option value="*" selected>（混在）</option>' : ''}${colorOpts(c || '')}</select>`);
    h += prow('線種', `<select data-p="ltype">${lt === null ? '<option value="*" selected>（混在）</option>' : ''}${ltOpts(lt || '')}</select>`);
    h += prow('線幅', `<select data-p="lw">${lw === null ? '<option value="*" selected>（混在）</option>' : ''}${lwOpts(lw || 0)}</select>`);
  }
  if (one) {
    switch (e.type) {
      case 'point':
        h += prow('点名', pin('name', e.name, false)) + prow('X', pin('px', fmt(e.p.x))) + prow('Y', pin('py', fmt(e.p.y))) + prow('Z（標高）', pin('z', fmt(e.z || 0)));
        h += prow('種別', `<select data-p="grp">${GROUPS.map((g) => `<option ${grpOf(e) === g ? 'selected' : ''}>${g}</option>`).join('')}</select>`);
        break;
      case 'line':
        h += prow('始点 X', pin('ax', fmt(e.a.x))) + prow('始点 Y', pin('ay', fmt(e.a.y))) + prow('終点 X', pin('bx', fmt(e.b.x))) + prow('終点 Y', pin('by', fmt(e.b.y)));
        h += prow('長さ', pin('len', fmt(G.dist(e.a, e.b)))) + prow('方向角', pout(toDMS(G.azim(e.a, e.b))));
        break;
      case 'poly':
        h += prow('頂点数', pout(e.pts.length)) + prow('延長', pout(fmt(G.polyLen(e.pts, e.closed)) + ' m'));
        if (e.closed) h += prow('面積', pout(fmt(G.polyArea(e.pts), 3) + ' ㎡'));
        h += `<label class="prow"><span>閉じる</span><input type="checkbox" data-p="closed" ${e.closed ? 'checked' : ''}></label>`;
        h += `<label class="prow"><span>面積表示</span><input type="checkbox" data-p="area" ${e.area ? 'checked' : ''}></label>`;
        break;
      case 'circle':
        h += prow('中心 X', pin('cx', fmt(e.c.x))) + prow('中心 Y', pin('cy', fmt(e.c.y))) + prow('半径', pin('r', fmt(e.r))) + prow('面積', pout(fmt(Math.PI * e.r * e.r, 3) + ' ㎡'));
        break;
      case 'arc':
        h += prow('中心 X', pin('cx', fmt(e.c.x))) + prow('中心 Y', pin('cy', fmt(e.c.y))) + prow('半径', pin('r', fmt(e.r)));
        h += prow('開始角', pin('a0', fmt(e.a0, 4))) + prow('終了角', pin('a1', fmt(e.a1, 4))) + prow('弧長', pout(fmt((G.norm360(e.a1 - e.a0) * D2R) * e.r)));
        break;
      case 'text':
        h += prow('文字', `<textarea data-p="text" rows="2">${esc(e.text)}</textarea>`);
        h += e.hmm ? prow('文字高 mm', pin('hmm', e.hmm)) : prow('文字高 m', pin('h', fmt(e.h || 1)));
        h += prow('角度', pin('rot', fmt(e.rot || 0, 2))) + prow('基点', `<select data-p="align">${[['left', '左'], ['center', '中'], ['right', '右']].map(([v, l]) => `<option value="${v}" ${(e.align || 'left') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
        break;
      case 'dim':
        h += prow('寸法値', pout(dimLabel({ ...e, txt: '' }, prefs.dimUnit))) + prow('表示文字', pin('txt', e.txt || '', false)) + prow('文字高 mm', pin('hmm', e.hmm || 2.5));
        h += prow('端末', `<select data-p="term">${[['tick', '斜線'], ['arrow', '矢印'], ['dot', '黒丸']].map(([v, l]) => `<option value="${v}" ${(e.term || 'tick') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
        break;
      case 'leader':
        h += prow('文字', pin('text', e.text, false)) + prow('文字高 mm', pin('hmm', e.hmm || 2.5));
        break;
      case 'hatch':
        h += prow('模様', `<select data-p="pattern">${Object.entries(HATCHES).map(([v, l]) => `<option value="${v}" ${(e.pattern || 'line') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
        h += prow('間隔 mm', pin('pitch', e.pitch || 2)) + prow('角度', pin('ang', e.ang ?? 45)) + prow('面積', pout(fmt(G.polyArea(e.pts), 3) + ' ㎡'));
        h += `<label class="prow"><span>外形線</span><input type="checkbox" data-p="border" ${e.border !== false ? 'checked' : ''}></label>`;
        break;
      case 'align':
        h += prow('路線名', pin('name', e.name, false)) + prow('杭間隔 m', pin('pitch', e.pitch || 20));
        { const g = alignGeom(e); if (!g.err) h += prow('延長', pout(fmt(g.al.sEnd - g.al.s0) + ' m')); else h += `<p class="err">${esc(g.err)}</p>`; }
        break;
    }
  }
  h += '<div class="pbtns"><button class="btn" data-pa="move">移動</button><button class="btn" data-pa="copy">複写</button><button class="btn" data-pa="delete">削除</button>' +
    (one && ['line', 'poly'].includes(e.type) ? '<button class="btn" data-pa="regverts">頂点を点登録</button>' : '') +
    (one && e.type === 'poly' && e.closed ? '<button class="btn" data-pa="areatbl">求積表</button>' : '') + '</div>';
  box.innerHTML = h;
}
$('#props').addEventListener('change', (ev) => applyProp(ev.target));
$('#props').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); ev.target.blur(); } });
$('#props').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-pa]'); if (!b) return;
  if (b.dataset.pa === 'delete') deleteSel(); else startCmd(b.dataset.pa);
});
function applyProp(t) {
  const k = t.dataset.p; if (!k) return;
  const s = selEnts(); if (!s.length) return;
  const v = t.type === 'checkbox' ? t.checked : t.value;
  const num = Number(String(v).replace(/，/g, '.'));
  const e = s[0];
  begin();
  try {
    if (k === 'layer') { if (v) s.forEach((q) => { q.layer = v; }); }
    else if (k === 'color') { if (v !== '*') s.forEach((q) => { if (v) q.color = v; else delete q.color; }); }
    else if (k === 'ltype') { if (v !== '*') s.forEach((q) => { delete q.dash; if (v) q.ltype = v; else delete q.ltype; }); }
    else if (k === 'lw') { if (v !== '*') s.forEach((q) => { if (Number(v)) q.lw = Number(v); else delete q.lw; }); }
    else {
      const need = () => { if (!Number.isFinite(num)) throw new Error('数値を入力してください'); return num; };
      switch (k) {
        case 'name': if (e.type === 'point') { const n = String(v).trim(); if (!n) throw new Error('点名を入力してください'); if (n !== e.name && pointByName(n)) throw new Error(`点名「${n}」は使われています`); e.name = n; } else e.name = v; break;
        case 'px': e.p.x = need(); break; case 'py': e.p.y = need(); break; case 'z': e.z = need(); break; case 'grp': e.grp = v; break;
        case 'ax': e.a.x = need(); break; case 'ay': e.a.y = need(); break; case 'bx': e.b.x = need(); break; case 'by': e.b.y = need(); break;
        case 'len': { const L = need(), d = G.dist(e.a, e.b); if (L <= 0 || d === 0) throw new Error('長さは正の数で'); e.b = { x: e.a.x + ((e.b.x - e.a.x) / d) * L, y: e.a.y + ((e.b.y - e.a.y) / d) * L }; break; }
        case 'cx': e.c.x = need(); break; case 'cy': e.c.y = need(); break; case 'r': e.r = Math.abs(need()); break;
        case 'a0': e.a0 = G.norm360(need()); break; case 'a1': e.a1 = G.norm360(need()); break;
        case 'closed': e.closed = v; if (!v) e.area = false; break; case 'area': e.area = v; if (v) e.closed = true; break;
        case 'text': e.text = v; break; case 'hmm': e.hmm = Math.abs(need()); break; case 'h': e.h = Math.abs(need()); break;
        case 'rot': e.rot = need(); break; case 'align': e.align = v; break;
        case 'txt': e.txt = v; break; case 'term': e.term = v; break;
        case 'pattern': e.pattern = v; break; case 'pitch': if (e.type === 'align') e.pitch = need(); else e.pitch = Math.max(0.2, need()); break;
        case 'ang': e.ang = need(); break; case 'border': e.border = v; break;
      }
    }
  } catch (err) { undoStack.pop(); toast(err.message); renderProps(); return; }
  commit();
}

// ============================================================
// レイヤ
// ============================================================
function renderLayers() {
  const counts = new Map();
  for (const e of doc.entities) counts.set(layerOf(e), (counts.get(layerOf(e)) || 0) + 1);
  $('#layers').innerHTML = doc.layers.map((l) => `<div class="lay ${l.name === prefs.cur.layer ? 'cur' : ''}" data-l="${esc(l.name)}" title="クリック: 現在のレイヤにする ／ 右クリック: メニュー">
    <input type="checkbox" data-vis ${doc.hiddenLayers.includes(l.name) ? '' : 'checked'} title="表示">
    <span class="sw" style="background:${esc(l.color || '#000')}"></span><span class="lname">${esc(l.name)}</span><span class="cnt">${counts.get(l.name) || 0}</span></div>`).join('');
  renderStylebar();
}
$('#layers').addEventListener('click', (ev) => {
  const row = ev.target.closest('.lay'); if (!row) return;
  const n = row.dataset.l;
  if (ev.target.matches('[data-vis]')) {
    doc.hiddenLayers = ev.target.checked ? doc.hiddenLayers.filter((q) => q !== n) : [...new Set([...doc.hiddenLayers, n])];
    if (!ev.target.checked) setSel(selEnts().filter(visible));
    setDirty(true); autosave(); clearCaches(); baseDirty = true; draw(); return;
  }
  prefs.cur.layer = n; savePrefs(); renderLayers();
});
$('#layers').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const row = ev.target.closest('.lay'); if (!row) return;
  const n = row.dataset.l, L = layerDef(n);
  openMenu(ev.clientX, ev.clientY, [
    { head: `レイヤ「${n}」` },
    { label: '現在のレイヤにする', fn: () => { prefs.cur.layer = n; savePrefs(); renderLayers(); } },
    { label: 'このレイヤの図形を選択', fn: () => setSel(doc.entities.filter((e) => layerOf(e) === n && visible(e))) },
    { label: 'このレイヤだけ表示', fn: () => { doc.hiddenLayers = doc.layers.map((l) => l.name).filter((q) => q !== n); commit(); } },
    { label: 'すべて表示', fn: () => { doc.hiddenLayers = []; commit(); } },
    '-',
    { label: '名前・色・線種を変更…', fn: () => editLayer(L) },
    { label: '削除（図形がないとき）', disabled: doc.entities.some((e) => layerOf(e) === n) || doc.layers.length < 2, fn: () => { begin(); doc.layers = doc.layers.filter((l) => l !== L); commit(); } },
  ]);
});
async function editLayer(L) {
  const isNew = !L;
  const cur = L || { name: '', color: '#000000', ltype: 'solid', lw: 0.25 };
  const r = await dialog({
    title: isNew ? 'レイヤの追加' : `レイヤ「${cur.name}」`,
    body: `<div class="form"><label>名前 <input id="lyName" value="${esc(cur.name)}"></label>
      <div class="grid3"><label>色 <select id="lyColor">${colorOpts(cur.color, false)}</select></label>
      <label>線種 <select id="lyLt">${ltOpts(cur.ltype, false)}</select></label>
      <label>線幅 <select id="lyLw">${lwOpts(cur.lw, false)}</select></label></div></div>`,
    buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
    onButton(v, root) {
      if (v !== 'ok') return true;
      const n = $('#lyName', root).value.trim();
      if (!n) { toast('名前を入力してください'); return false; }
      if (n !== cur.name && layerDef(n)) { toast('同じ名前のレイヤがあります'); return false; }
      begin();
      const def = { name: n, color: $('#lyColor', root).value, ltype: $('#lyLt', root).value, lw: Number($('#lyLw', root).value) };
      if (isNew) doc.layers.push(def);
      else {
        for (const e of doc.entities) if (layerOf(e) === cur.name) e.layer = n;
        doc.hiddenLayers = doc.hiddenLayers.map((q) => (q === cur.name ? n : q));
        if (prefs.cur.layer === cur.name) prefs.cur.layer = n;
        Object.assign(L, def);
      }
      if (isNew) prefs.cur.layer = n;
      commit();
      return true;
    },
  });
  return r;
}
$('#layAdd').addEventListener('click', () => editLayer(null));

// ============================================================
// スタイルバー
// ============================================================
function buildStylebar() {
  $('#stColor').innerHTML = colorOpts(prefs.cur.color);
  $('#stLtype').innerHTML = ltOpts(prefs.cur.ltype);
  $('#stLw').innerHTML = lwOpts(prefs.cur.lw);
  $('#stTextH').innerHTML = [1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 10, 14].map((v) => `<option value="${v}">${v} mm</option>`).join('');
  $('#stScale').innerHTML = SCALES.map((v) => `<option value="${v}">${v}</option>`).join('');
  $('#stPaper').innerHTML = Object.keys(PAPERS).flatMap((p) => [`<option value="${p}|landscape">${p} 横</option>`, `<option value="${p}|portrait">${p} 縦</option>`]).join('');
}
function renderStylebar() {
  $('#stLayer').innerHTML = layerOpts(prefs.cur.layer);
  $('#stColor').value = prefs.cur.color || '';
  $('#stLtype').value = prefs.cur.ltype || '';
  $('#stLw').value = String(prefs.cur.lw || 0);
  $('#stTextH').value = String(prefs.textH);
  const s = sheet();
  if (![...$('#stScale').options].some((o) => o.value === String(s.scaleN))) $('#stScale').insertAdjacentHTML('beforeend', `<option value="${s.scaleN}">${s.scaleN}</option>`);
  $('#stScale').value = String(s.scaleN);
  $('#stPaper').value = `${s.paper}|${s.orient}`;
  $('#stInUnit').value = prefs.inUnit; $('#stDimUnit').value = prefs.dimUnit;
  $('#stInfo').textContent = `1:${s.scaleN}　${s.paper}${s.orient === 'portrait' ? '縦' : '横'}　${doc.zone ? `第${doc.zone}系` : '系 未設定'}`;
  $('#mbHint').textContent = `X,Y ／ @ΔX,ΔY ／ @距離<方向角 ／ 長さ ／ 点名（長さの単位: ${prefs.inUnit}）`;
}
function styleChanged(key, val) {
  const s = selEnts().filter((e) => e.type !== 'point');
  if (s.length && key !== 'layer') {
    begin();
    for (const e of s) { if (key === 'lw') { if (val) e.lw = val; else delete e.lw; } else if (val) { e[key] = val; if (key === 'ltype') delete e.dash; } else delete e[key]; }
    commit(`選択した ${s.length} 個の図形に適用しました`);
  } else if (s.length && key === 'layer') {
    begin(); for (const e of selEnts()) e.layer = val; commit(`選択した図形をレイヤ「${val}」へ移しました`);
  }
}
$('#stLayer').addEventListener('change', (ev) => { prefs.cur.layer = ev.target.value; savePrefs(); styleChanged('layer', ev.target.value); renderLayers(); });
$('#stColor').addEventListener('change', (ev) => { prefs.cur.color = ev.target.value; savePrefs(); styleChanged('color', ev.target.value); });
$('#stLtype').addEventListener('change', (ev) => { prefs.cur.ltype = ev.target.value; savePrefs(); styleChanged('ltype', ev.target.value); });
$('#stLw').addEventListener('change', (ev) => { prefs.cur.lw = Number(ev.target.value); savePrefs(); styleChanged('lw', Number(ev.target.value)); });
$('#stTextH').addEventListener('change', (ev) => { prefs.textH = Number(ev.target.value); savePrefs(); });
$('#stScale').addEventListener('change', (ev) => {
  const s = sheet(); s.scale = ev.target.value; s.scaleN = Number(ev.target.value);
  setDirty(true); autosave(); clearCaches(); renderStylebar(); baseDirty = true; draw();
  toast(`縮尺を 1:${s.scaleN} にしました（文字・寸法の大きさは用紙上の mm で保たれます）`);
});
$('#stPaper').addEventListener('change', (ev) => {
  const [p, o] = ev.target.value.split('|'); const s = sheet(); s.paper = p; s.orient = o;
  setDirty(true); autosave(); renderStylebar(); baseDirty = true; draw();
});
$('#stInUnit').addEventListener('change', (ev) => { prefs.inUnit = ev.target.value; savePrefs(); renderStylebar(); afterCmd(); });
$('#stDimUnit').addEventListener('change', (ev) => { prefs.dimUnit = ev.target.value; savePrefs(); baseDirty = true; draw(); renderProps(); });

// スナップの切り替え（ステータスバー）
function renderSnapBar() {
  const S = prefs.snap;
  const b = (k, l, on) => `<button data-s="${k}" class="${on ? 'on' : ''}">${l}</button>`;
  $('#snapBar').innerHTML = b('pt', '点', S.pt) + b('end', '端点', S.end) + b('mid', '中点', S.mid) + b('inter', '交点', S.inter) + b('cen', '中心', S.cen) + b('perp', '垂点', S.perp) + b('near', '線上', S.near) +
    '<span class="sep"></span>' + b('ortho', '直交 F8', prefs.ortho) + b('grid', 'グリッド', prefs.grid);
}
$('#snapBar').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-s]'); if (!b) return;
  const k = b.dataset.s;
  if (k === 'ortho') prefs.ortho = !prefs.ortho;
  else if (k === 'grid') { prefs.grid = !prefs.grid; baseDirty = true; draw(); }
  else prefs.snap[k] = !prefs.snap[k];
  savePrefs(); renderSnapBar(); markRibbon();
});

// ============================================================
// リボン
// ============================================================
const A = (id, label, icon, fn, opt = {}) => ({ id, label, icon, fn, ...opt });
const C = (id, label) => ({ id, label, cmd: id });
function toggle(id, label, icon, get, set) { return { id, label, icon, toggle: get, fn: () => { set(!get()); savePrefs(); baseDirty = true; draw(); markRibbon(); renderSnapBar(); } }; }
const RIBBON = [
  { tab: 'ファイル', cls: 'file-tab', groups: [
    { name: 'ファイル', items: [A('new', '新規', 'new', () => newDoc()), A('open', '開く', 'open', () => openFile()), A('save', '上書き保存', 'save', () => save()), A('saveas', '名前を付けて保存', 'saveas', () => saveAs())] },
    { name: '読み込み（追加）', items: [A('impDxf', 'DXF 図面', 'import', () => importFile('dxf')), A('impPts', '座標 SIMA・CSV', 'sima', () => importFile('pts'))] },
    { name: '書き出し', items: [A('expDxf', 'DXF', 'export', () => exportDxf()), A('expSima', 'SIMA', 'sima', () => exportPoints('sima')), A('expCsv', 'CSV', 'export', () => exportPoints('csv')), A('expPng', '画像', 'image', () => exportPng())] },
    { name: '印刷', items: [A('print', '印刷・PDF', 'print', () => openPrint())] },
    { name: 'プロジェクト', items: [A('rename', '名前・座標系', 'zone', () => projectSettings())] },
  ] },
  { tab: 'ホーム', groups: [
    { name: '元に戻す', items: [A('undo', '元に戻す', 'undo', undo), A('redo', 'やり直し', 'redo', redo)] },
    { name: 'クリップボード', items: [A('cut', '切り取り', 'cut', cutSel), A('copyclip', 'コピー', 'copy', copySel), C('paste', '貼り付け'), A('del', '削除', 'delete', deleteSel)] },
    { name: '選択', items: [A('selall', 'すべて選択', 'selall', () => setSel(visibleEnts())), C('selattr', '属性で選択'), A('selnone', '選択解除', 'selnone', () => setSel([]))] },
    { name: '表示', items: [A('zoomall', '全体表示', 'zoomall', zoomAll), A('zoompaper', '用紙全体', 'zoompaper', zoomPaper), C('zoomwin', '範囲拡大')] },
  ] },
  { tab: '作図', groups: [
    { name: '線', items: [C('line', '単線'), C('pline', '連続線'), C('rect', '矩形'), C('offset', '平行線')] },
    { name: '円・円弧', items: [C('circle', '円'), C('circle3', '3点円'), C('arc', '円弧'), C('arc3', '3点円弧')] },
    { name: '点', items: [C('point', '点'), C('divide', '等分点')] },
    { name: '文字', items: [C('text', '文字'), C('leader', '引出線')] },
    { name: '寸法', items: [C('dim', '平行寸法'), C('dimh', '水平寸法'), C('dimv', '垂直寸法'), C('dimser', '直列寸法'), C('dimr', '半径寸法'), C('dimang', '角度寸法')] },
    { name: 'その他', items: [C('hatch', 'ハッチング'), C('areafig', '求積図形'), C('north', '方位記号')] },
  ] },
  { tab: '図形編集', groups: [
    { name: '移動複写', items: [C('move', '移動'), C('copy', '複写'), C('rotate', '回転'), C('mirror', '反転'), C('scale', '拡大縮小'), C('array', '配列複写')] },
    { name: '修正', items: [C('erase', '削除'), C('stretch', '伸縮'), C('trim', '部分消去'), C('corner', '角作成'), C('chamfer', '面取り'), C('fillet', 'R面取り'), C('break', '分割'), C('join', '結合'), C('explode', '分解')] },
    { name: '計測', items: [C('mdist', '距離'), C('mangle', '角度'), C('marea', '面積'), C('mcoord', '座標')] },
  ] },
  { tab: '土木', groups: [
    { name: '座標', items: [C('ptable', '座標一覧'), C('regverts', '頂点を点登録'), C('fit', '座標合わせ')] },
    { name: '作図', items: [C('xsec', '横断図'), C('profile', '縦断図'), C('areatbl', '求積表')] },
    { name: '位置出し', items: [C('nige', '逃げ杭'), C('stakeTable', '杭打ち表')] },
  ] },
  { tab: '測量計算', groups: [
    { name: '座標計算', items: [A('c_inverse', '逆計算', 'inverse', () => calc.open('inverse')), A('c_radial', '放射計算', 'radial', () => calc.open('radial')), A('c_stakeout', '杭打ち計算', 'stake', () => calc.open('stakeout')), A('c_intersect', '交点計算', 'intersect', () => calc.open('intersect')), A('c_distdist', '距離交会', 'intersect', () => calc.open('distdist')), A('c_perp', '垂線計算', 'mcoord', () => calc.open('perp')), A('c_offset', '幅杭計算', 'offset', () => calc.open('offset'))] },
    { name: '面積', items: [A('c_area', '座標求積', 'marea', () => calc.open('area'))] },
    { name: '路線', items: [A('c_align', '路線計算', 'align', () => calc.open('align')), A('c_station', '測点⇔座標', 'station', () => calc.open('station')), A('c_curve', '曲線要素', 'arc', () => calc.open('curve')), A('c_slope', '勾配・法長', 'mangle', () => calc.open('slope'))] },
    { name: '計算書', items: [A('reports', '計算書', 'report', () => openReports()), A('calcmenu', '計算一覧', 'calc', () => calc.open())] },
  ] },
  { tab: '現場連携', groups: [
    { name: 'スマホへ', items: [A('l_send', '現場へ送る', 'send', () => link.send()), A('l_sima', 'SIMA で送る', 'sima', () => exportPoints('sima'))] },
    { name: 'スマホから', items: [A('l_recv', '現場データ取込', 'recv', () => link.receive())] },
    { name: '連携フォルダ', items: [A('l_folder', 'フォルダ設定', 'folder', () => link.setupFolder()), A('l_check', '新着を確認', 'sync', () => link.check(true))] },
    { name: 'スマホ版', items: [A('l_phone', 'スマホ版の開き方', 'phone', () => link.phoneInfo())] },
  ] },
  { tab: '表示', groups: [
    { name: '画面', items: [A('v_all', '全体表示', 'zoomall', zoomAll), A('v_paper', '用紙全体', 'zoompaper', zoomPaper), C('zoomwin', '範囲拡大'), C('movesheet', '用紙枠の移動')] },
    { name: '表示の切り替え', items: [
      toggle('t_sheet', '用紙枠', 'paper', () => prefs.showSheet, (v) => { prefs.showSheet = v; }),
      toggle('t_grid', 'グリッド', 'grid', () => prefs.grid, (v) => { prefs.grid = v; }),
      toggle('t_lw', '線幅表示', 'lw', () => prefs.showLw, (v) => { prefs.showLw = v; }),
      toggle('t_names', '点名表示', 'names', () => prefs.showNames, (v) => { prefs.showNames = v; }),
      toggle('t_dark', '黒背景', 'dark', () => prefs.dark, (v) => { prefs.dark = v; }),
    ] },
    { name: 'レイヤ', items: [A('v_layer', 'レイヤ追加', 'layer', () => editLayer(null))] },
    { name: 'ヘルプ', items: [A('help', '使い方', 'help', () => showHelp())] },
  ] },
];
function buildRibbon() {
  $('#ribbonTabs').innerHTML = RIBBON.map((t) => `<button role="tab" class="${t.cls || ''}" data-tab="${t.tab}">${t.tab}</button>`).join('');
  showTab(prefs.tab);
}
function showTab(name) {
  const t = RIBBON.find((q) => q.tab === name) || RIBBON[2];
  prefs.tab = t.tab; savePrefs();
  $$('#ribbonTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t.tab)));
  $('#ribbon').innerHTML = t.groups.map((g, gi) => `<div class="rgroup"><div class="ritems">${g.items.map((it, ii) => {
    const title = it.cmd ? CMDS[it.cmd]?.title || it.label : it.label;
    const icon = ICONS[it.icon || (it.cmd && CMDS[it.cmd]?.icon) || it.cmd] || ICONS.select;
    return `<button class="rbtn" data-g="${gi}" data-i="${ii}" data-id="${it.id}" title="${esc(CMDS[it.cmd]?.tip || title)}">${icon}<span>${esc(it.label)}</span></button>`;
  }).join('')}</div><div class="rlabel">${esc(g.name)}</div></div>`).join('');
  markRibbon();
}
function markRibbon() {
  const t = RIBBON.find((q) => q.tab === prefs.tab); if (!t) return;
  $$('#ribbon .rbtn').forEach((b) => {
    const it = t.groups[b.dataset.g].items[b.dataset.i];
    b.classList.toggle('active', !!(it.cmd && cmd && cmd.id === it.cmd));
    b.classList.toggle('on', !!(it.toggle && it.toggle()));
  });
}
$('#ribbonTabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
$('#ribbon').addEventListener('click', (ev) => {
  const b = ev.target.closest('.rbtn'); if (!b) return;
  const t = RIBBON.find((q) => q.tab === prefs.tab);
  const it = t.groups[b.dataset.g].items[b.dataset.i];
  if (it.cmd) startCmd(it.cmd); else it.fn();
  if (!it.cmd) cv.focus();
});

// ============================================================
// 汎用ダイアログ
// ============================================================
let dlgResolve = null;
function dialog({ title, body, buttons = [{ label: '閉じる', value: 'cancel' }], onOpen, onButton, wide }) {
  const d = $('#dlg');
  // 前のダイアログの約束は「キャンセル」で終わらせる
  if (dlgResolve) { const r = dlgResolve; dlgResolve = null; r('cancel'); }
  if (d.open) d.close('cancel');
  $('#dlgTitle').textContent = title;
  const b = $('#dlgBody');
  b.innerHTML = '';
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  $('.dlg-frame', d).classList.toggle('wide', !!wide);
  $('#dlgBtns').innerHTML = buttons.map((x) => `<button value="${esc(x.value)}" class="${x.primary ? 'primary' : ''}" ${x.formnovalidate ? 'formnovalidate' : ''}>${esc(x.label)}</button>`).join('');
  $('#dlgBtns').onclick = (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    if (onButton && onButton(btn.value, b) === false) ev.preventDefault();
  };
  return new Promise((resolve) => {
    dlgResolve = resolve;
    // close イベントは後から届くので、次のダイアログが開いていれば古いものとして無視する
    d.onclose = () => { if (d.open) return; const r = dlgResolve; dlgResolve = null; r?.(d.returnValue); };
    d.returnValue = '';
    d.showModal();
    onOpen?.(b);
  });
}
document.addEventListener('click', (ev) => { const x = ev.target.closest('[data-close]'); if (x) x.closest('dialog')?.close(); });

// ============================================================
// ファイル
// ============================================================
const safeName = (s = doc.name) => (s || 'genbacad').replace(/[\\/:*?"<>|]/g, '_');
const hasFS = () => 'showSaveFilePicker' in window;
async function saveBlob(name, blob, types) {
  if (hasFS()) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return h;
    } catch (err) { if (err.name === 'AbortError') return null; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'download';
}
K.saveBlob = saveBlob;
const GCAD_TYPES = [{ description: '現場CAD プロジェクト', accept: { 'application/octet-stream': [EXT] } }];
function projectBlob() { return new Blob([JSON.stringify(packProject(doc, 'pc'))], { type: 'application/octet-stream' }); }
K.projectBlob = projectBlob;
async function save() {
  if (fileHandle && fileHandle.createWritable) {
    try {
      if ((await fileHandle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') await fileHandle.requestPermission?.({ mode: 'readwrite' });
      const w = await fileHandle.createWritable(); await w.write(projectBlob()); await w.close();
      setDirty(false); toast(`上書き保存しました（${fileName}）`); return;
    } catch (err) { if (err.name === 'AbortError') return; toast('上書きできませんでした。名前を付けて保存します'); }
  }
  await saveAs();
}
async function saveAs() {
  const h = await saveBlob(safeName() + EXT, projectBlob(), GCAD_TYPES);
  if (!h) return;
  if (h !== 'download') { fileHandle = h; fileName = h.name; try { await idb.set('fileHandle', h); } catch { /* */ } }
  else fileName = safeName() + EXT;
  setDirty(false); updateTitle(); autosave();
  toast(`保存しました（${fileName}）`);
}
async function confirmDiscard() {
  if (!dirty || !doc.entities.length) return true;
  const r = await dialog({ title: '確認', body: '<p>保存していない変更があります。破棄してよろしいですか？</p>', buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '保存する', value: 'save' }, { label: '破棄する', value: 'discard', primary: true }] });
  if (r === 'save') { await save(); return !dirty; }
  return r === 'discard';
}
async function newDoc() {
  if (!(await confirmDiscard())) return;
  replaceDoc(blankDoc(), '');
  view.x = 0; view.y = 0;
  sheet().center = { x: 0, y: 0 };
  zoomPaper();
  toast('新しい図面を作りました');
}
function replaceDoc(d, name, handle = null) {
  for (const k of Object.keys(doc)) delete doc[k];
  Object.assign(doc, blankDoc(), d);
  if (!doc.layers?.length) doc.layers = blankDoc().layers;
  fileHandle = handle; fileName = name || '';
  undoStack.length = 0; redoStack.length = 0; sel = new Set(); overlay = null;
  tracker.reset(doc); clearCaches(); ensureLayers();
  idb.set('fileHandle', handle).catch(() => {});
  setDirty(false); updateTitle(); renderAll(); autosave();
}
async function openFile() {
  if (!(await confirmDiscard())) return;
  if ('showOpenFilePicker' in window) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: '図面・座標・プロジェクト', accept: { 'application/octet-stream': [EXT, '.json', '.dxf', '.sim', '.csv', '.txt'] } }] });
      const f = await h.getFile();
      await loadFile(f, /\.(gcad|json)$/i.test(f.name) ? h : null);
    } catch (err) { if (err.name !== 'AbortError') toast('開けませんでした: ' + err.message); }
    return;
  }
  $('#fileOpen').click();
}
$('#fileOpen').addEventListener('change', async (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) await loadFile(f, null); });
async function loadFile(f, handle) {
  const buf = await f.arrayBuffer();
  const text = decodeText(buf);
  const n = f.name;
  try {
    if (/\.(gcad|json)$/i.test(n)) {
      const { doc: d } = unpackProject(text);
      replaceDoc(d, n, handle);
      if (!doc.sheet?.center) zoomAll(); else zoomAll();
      toast(`「${n}」を開きました（図形 ${doc.entities.length} 個）`);
    } else if (/\.dxf$/i.test(n)) {
      const d = blankDoc(); d.name = n.replace(/\.dxf$/i, '');
      replaceDoc(d, '');
      importDxfText(text, n, false);
      zoomAll(); sheet().center = { x: view.x, y: view.y };
      autoScaleToExtents();
      setDirty(true);
    } else {
      const d = blankDoc(); d.name = n.replace(/\.\w+$/, '');
      replaceDoc(d, '');
      importPointsText(text, n);
      zoomAll(); sheet().center = { x: view.x, y: view.y }; autoScaleToExtents(); setDirty(true);
    }
  } catch (err) { toast('開けませんでした: ' + err.message, 4000); }
}
function autoScaleToExtents() {
  const b = extents(); if (!b) return;
  const s = sheet(), L = layout(s);
  const need = Math.max(((b.y1 - b.y0) * 1000) / (L.vp.w - 10), ((b.x1 - b.x0) * 1000) / (L.vp.h - 10));
  s.scaleN = SCALES.find((k) => k >= need) || SCALES[SCALES.length - 1]; s.scale = String(s.scaleN);
  s.center = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  renderStylebar(); baseDirty = true; draw();
}
function importDxfText(text, name, undoable = true) {
  const { entities, skipped, layers } = parseDXF(text);
  if (!entities.length) { toast('読み込める図形がありませんでした'); return 0; }
  if (undoable) begin();
  for (const L of layers || []) {
    const d = layerDef(L.name);
    if (!d) doc.layers.push({ name: L.name, color: L.color || '#000000', ltype: L.ltype || 'solid', lw: 0.25 });
    if (L.hidden && !doc.hiddenLayers.includes(L.name)) doc.hiddenLayers.push(L.name);
  }
  for (const e of entities) {
    if (e.type === 'point') { e.name = e.name ? uniqueName(e.name) : nextPointName(); e.grp = 'その他'; }
    addEnt(e, { style: false });
  }
  commit(`${entities.length} 個の図形を読み込みました` + (skipped.length ? `（未対応: ${skipped.join(', ')}）` : ''));
  return entities.length;
}
function importPointsText(text, name) {
  const pts = /\.sim$/i.test(name) || /^A01,/m.test(text) ? parseSIMA(text) : parseCSV(text);
  if (!pts.length) { toast('座標が見つかりませんでした'); return 0; }
  begin();
  let upd = 0;
  for (const q of pts) {
    const ex = q.name ? pointByName(q.name) : null;
    if (ex && G.dist(ex.p, q) < 5e-4) { upd++; continue; }
    addEnt({ type: 'point', p: { x: q.x, y: q.y }, z: q.z || 0, name: q.name ? uniqueName(q.name) : nextPointName(), grp: '基準点' });
  }
  commit(`${pts.length - upd} 点を「基準点」として読み込みました` + (upd ? `（同じ点 ${upd} 点は省略）` : ''));
  return pts.length;
}
K.importDxfText = importDxfText; K.importPointsText = importPointsText;
let importKind = 'dxf';
function importFile(kind) { importKind = kind; $('#fileImport').accept = kind === 'dxf' ? '.dxf' : '.sim,.csv,.txt'; $('#fileImport').click(); }
$('#fileImport').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  const text = decodeText(await f.arrayBuffer());
  if (importKind === 'dxf' || /\.dxf$/i.test(f.name)) importDxfText(text, f.name); else importPointsText(text, f.name);
  zoomAll();
});
// ドラッグ＆ドロップ
document.addEventListener('dragover', (ev) => { ev.preventDefault(); });
document.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer.files[0]; if (!f) return;
  if (/\.(gcad|json)$/i.test(f.name)) {
    const r = doc.entities.length ? await dialog({ title: f.name, body: '<p>このプロジェクトをどうしますか？</p>', buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '今の図面に取り込む（差分）', value: 'merge' }, { label: '開く（置き換え）', value: 'open', primary: true }] }) : 'open';
    if (r === 'open') { if (await confirmDiscard()) await loadFile(f, null); } else if (r === 'merge') link.mergeFile(f);
    return;
  }
  const text = decodeText(await f.arrayBuffer());
  if (/\.dxf$/i.test(f.name)) importDxfText(text, f.name); else importPointsText(text, f.name);
  zoomAll();
});

function exportEnts() {
  const cfg = sheet();
  return explodeForDxf(visibleEnts(), { scaleN: cfg.scaleN, sheetRot: cfg.rot || 0, unit: prefs.dimUnit, alignGeom, alignPoint, alignStakes });
}
async function exportDxf() {
  const data = encodeSJIS(toDXF(exportEnts(), { layers: doc.layers, scaleN: scaleN() }));
  const h = await saveBlob(safeName() + '.dxf', new Blob([data], { type: 'application/dxf' }), [{ description: 'DXF', accept: { 'application/dxf': ['.dxf'] } }]);
  if (h) toast('DXF を書き出しました');
}
const pointList = (grps) => doc.entities.filter((e) => e.type === 'point' && (!grps || grps.includes(grpOf(e)))).map((e) => ({ name: e.name, x: e.p.x, y: e.p.y, z: e.z || 0 }));
async function exportPoints(kind) {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, doc.entities.filter((e) => e.type === 'point' && grpOf(e) === g).length]));
  const r = await dialog({
    title: kind === 'sima' ? 'SIMA で書き出す' : 'CSV で書き出す',
    body: `<div class="form"><p class="small">書き出す点の種別を選んでください。</p>${GROUPS.map((g) => `<label class="chk"><input type="checkbox" data-g="${g}" ${g !== 'その他' || !counts['位置出し'] ? 'checked' : ''} ${counts[g] ? '' : 'disabled'}> ${g}（${counts[g]} 点）</label>`).join('')}
      ${kind === 'sima' ? '<label class="chk"><input type="checkbox" id="exArea"> 面積図形（区画）も入れる</label>' : ''}</div>`,
    buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '書き出す', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  const grps = $$('#dlgBody [data-g]').filter((c) => c.checked).map((c) => c.dataset.g);
  const pts = pointList(grps);
  if (!pts.length) { toast('書き出す点がありません'); return; }
  if (kind === 'sima') {
    const areas = $('#dlgBody #exArea')?.checked ? doc.entities.filter((e) => e.type === 'poly' && e.closed && e.area).map((e, i) => ({ name: `区画${i + 1}`, pts: e.pts.map((p) => { const q = pointAt(p); return q ? q.name : null; }) })).filter((a) => a.pts.every(Boolean)) : [];
    const h = await saveBlob(safeName() + '.sim', new Blob([encodeSJIS(toSIMA(pts, doc.name, areas))], { type: 'application/octet-stream' }), [{ description: 'SIMA', accept: { 'application/octet-stream': ['.sim'] } }]);
    if (h) toast(`SIMA を書き出しました（${pts.length} 点）`);
  } else {
    const h = await saveBlob(safeName() + '.csv', new Blob([toCSV(pts, doc.zone)], { type: 'text/csv' }), [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]);
    if (h) toast(`CSV を書き出しました（${pts.length} 点）`);
  }
}
async function exportPng() {
  const c = document.createElement('canvas');
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(base, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const h = await saveBlob(safeName() + '.png', blob, [{ description: 'PNG', accept: { 'image/png': ['.png'] } }]);
  if (h) toast('画面を画像で保存しました');
}
async function projectSettings() {
  const r = await dialog({
    title: '名前・座標系',
    body: `<div class="form"><label>図面（プロジェクト）の名前 <input id="psName" value="${esc(doc.name)}"></label>
      <label>平面直角座標系 <select id="psZone"><option value="">未設定</option>${Object.keys(ZONES).map((z) => `<option value="${z}" ${String(doc.zone) === z ? 'selected' : ''}>第${z}系</option>`).join('')}</select></label>
      <label>点名の頭文字 <input id="psPrefix" value="${esc(prefs.prefix)}"></label></div>`,
    buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  doc.name = $('#psName').value.trim() || '無題';
  doc.zone = Number($('#psZone').value) || null;
  prefs.prefix = $('#psPrefix').value.trim() || 'P'; savePrefs();
  if (doc.sheet && !doc.sheet.koji) doc.sheet.koji = doc.name;
  setDirty(true); autosave(); updateTitle(); renderStylebar(); baseDirty = true; draw();
}

// ============================================================
// 印刷・PDF
// ============================================================
function sheetData(color = true) {
  return {
    entities: visibleEnts(), alignGeom, grpOf, zone: doc.zone, unit: prefs.dimUnit,
    style: (e) => { const s = styleOf(e); return { color: color ? (s.color === '#ffffff' ? '#000' : s.color) : '#000', lw: s.lw, ltype: s.ltype }; },
  };
}
function fillPrintForm() {
  const s = sheet();
  $('#prPaper').innerHTML = Object.keys(PAPERS).map((p) => `<option ${s.paper === p ? 'selected' : ''}>${p}</option>`).join('');
  $('#prScale').innerHTML = SCALES.map((v) => `<option ${s.scaleN === v ? 'selected' : ''}>${v}</option>`).join('');
  $('#prOrient').value = s.orient; $('#prRot').value = s.rot || 0;
  $('#prKoji').value = s.koji || doc.name; $('#prTitle').value = s.title || ''; $('#prAuthor').value = s.author || '';
  $('#prTable').checked = !!s.table; $('#prGrid').checked = !!s.grid;
}
function readPrintForm() {
  const s = sheet();
  s.paper = $('#prPaper').value; s.orient = $('#prOrient').value; s.scale = $('#prScale').value; s.scaleN = Number(s.scale);
  s.rot = Number($('#prRot').value) || 0;
  s.koji = $('#prKoji').value; s.title = $('#prTitle').value; s.author = $('#prAuthor').value;
  s.table = $('#prTable').checked; s.grid = $('#prGrid').checked;
  setDirty(true); autosave();
}
function renderPrintPreview() {
  readPrintForm();
  const s = sheet(), L = layout(s);
  const c = $('#prCv');
  const px = Math.min(1.6, 900 / L.W);
  renderSheet(c, s, sheetData($('#prColor').checked), px);
}
function openPrint() {
  fillPrintForm();
  $('#printDlg').showModal();
  renderPrintPreview();
}
$('.print-form').addEventListener('change', () => { renderPrintPreview(); renderStylebar(); clearCaches(); baseDirty = true; draw(); });
async function printCanvas() {
  const s = sheet(), L = layout(s);
  const dpi = Number($('#prDpi').value) || 300;
  let px = dpi / 25.4;
  const maxPx = 40e6;
  if (L.W * L.H * px * px > maxPx) px = Math.sqrt(maxPx / (L.W * L.H));
  const c = document.createElement('canvas');
  renderSheet(c, s, sheetData($('#prColor').checked), px);
  return { c, L };
}
const sheetFile = (ext) => `${safeName()}_${safeName(sheet().title || '図面')}.${ext}`;
$('#prPdf').addEventListener('click', async () => {
  readPrintForm();
  toast('PDF を作っています…');
  const { c, L } = await printCanvas();
  const jpg = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92))).arrayBuffer());
  const pdf = makePdf(jpg, c.width, c.height, L.W, L.H);
  const h = await saveBlob(sheetFile('pdf'), new Blob([pdf], { type: 'application/pdf' }), [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]);
  if (h) toast('PDF を保存しました');
});
$('#prPng').addEventListener('click', async () => {
  readPrintForm();
  const { c } = await printCanvas();
  const h = await saveBlob(sheetFile('png'), await new Promise((res) => c.toBlob(res, 'image/png')), [{ description: 'PNG', accept: { 'image/png': ['.png'] } }]);
  if (h) toast('画像を保存しました');
});
$('#prPrint').addEventListener('click', async () => {
  readPrintForm();
  const { c, L } = await printCanvas();
  const url = c.toDataURL('image/jpeg', 0.92);
  const area = $('#printArea');
  area.innerHTML = `<style>@page { size: ${L.W}mm ${L.H}mm; margin: 0; }</style><img src="${url}" style="width:${L.W}mm;height:${L.H}mm">`;
  $('#printDlg').close();
  setTimeout(() => { window.print(); }, 200);
});
$('#prDxf').addEventListener('click', async () => {
  readPrintForm();
  const s = sheet();
  const { entities: frame } = sheetFrameEntities(s, sheetData());
  const data = encodeSJIS(toDXF([...exportEnts(), ...frame], { layers: doc.layers, scaleN: s.scaleN }));
  const h = await saveBlob(sheetFile('dxf'), new Blob([data], { type: 'application/dxf' }), [{ description: 'DXF', accept: { 'application/dxf': ['.dxf'] } }]);
  if (h) toast('図面枠付きの DXF を保存しました');
});

// ============================================================
// 測量計算（スマホ版と共通）
// ============================================================
function resolvePt(str) {
  const s = z2h(str).trim();
  const pe = pointByName(s);
  if (pe) return { p: { ...pe.p }, z: pe.z || 0, label: pe.name };
  const m = s.split(',').map((t) => Number(t.trim()));
  if (m.length === 2 && m.every(Number.isFinite)) return { p: { x: m[0], y: m[1] }, z: 0, label: `(${fmt(m[0])},${fmt(m[1])})` };
  throw new Error(`点「${s}」が見つかりません`);
}
function addPoints(list) {
  if (!list.length) return;
  begin();
  let first = null;
  for (const q of list) {
    const e = addEnt({ type: 'point', p: { x: q.p.x, y: q.p.y }, z: q.z || 0, name: uniqueName(q.name || nextPointName()), grp: q.grp || 'その他' });
    first = first || e;
  }
  commit(list.length === 1 ? `${first.name} を登録しました` : `${list.length} 点を登録しました`);
}
K.addPoints = addPoints;
function addReport(r) { doc.reports.push({ ...r, id: Date.now() }); setDirty(true); autosave(); toast('計算書に追加しました（測量計算 → 計算書）'); }
function showOverlay(ov) {
  overlay = ov;
  const pts = [...(ov.lines || []).flat(), ...(ov.pts || []).map((q) => q.p)];
  if (pts.length) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    fitBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 80);
  }
  refreshMB(); draw();
}
function pickForCalc(cb, multi, done, opt = {}) {
  let count = 0;
  startAdhoc({
    title: '点の指示', icon: 'point',
    prompt: () => (opt.msg || (multi ? '点を順にクリック → ［確定］で計算に戻る' : '図面上の点をクリック')) + (count ? `（${count} 点）` : ''),
    onPoint(p, h) {
      let name;
      if (h?.kind === '点' && h.label) name = h.label;
      else if (opt.raw) name = `${fmt(p.x)},${fmt(p.y)}`;
      else { const e = pointAt(p) || (begin(), addEnt({ type: 'point', p: { ...p }, z: 0, name: nextPointName(), grp: 'その他' })); name = e.name; commit(); }
      cb(name); count++;
      if (!multi || (opt.max && count >= opt.max)) this.done = true;
    },
    onEnter() { this.done = true; },
    onEnd() { done?.(); },
  });
}
const calc = initCalc({
  resolve: resolvePt,
  allPoints: (grp) => doc.entities.filter((e) => e.type === 'point' && visible(e) && (!grp || grpOf(e) === grp)).map((e) => ({ p: { ...e.p }, z: e.z || 0, label: e.name })),
  selectedVerts: () => {
    const e = selEnts().find((q) => q.type === 'poly');
    if (!e) return null;
    return e.pts.map((p, i) => { const n = pointAt(p); return { p: { ...p }, z: 0, label: n ? n.name : `V${i + 1}` }; });
  },
  nextName: () => nextPointName(true),
  nextAlignName: () => `路線${doc.entities.filter((e) => e.type === 'align').length + 1}`,
  addPoints,
  addArea: (pts) => { begin(); addEnt({ type: 'poly', pts: pts.map((p) => ({ ...p })), closed: true, area: true }); commit('面積図形を追加しました'); },
  addAlign: (ent) => { begin(); const e = addEnt(JSON.parse(JSON.stringify(ent))); overlay = null; commit(`路線「${e.name}」を追加しました`); },
  aligns: () => doc.entities.filter((e) => e.type === 'align'),
  alignGeom: (e) => { const g = alignGeom(e); if (g.err) throw new Error(g.err); return g.al; },
  addReport,
  setOverlay: (ov) => { overlay = ov; draw(); },
  showOverlay,
  pick: pickForCalc,
});
function renderNames() {
  $('#ptNames').innerHTML = doc.entities.filter((e) => e.type === 'point').slice(0, 3000).map((e) => `<option value="${esc(e.name)}">`).join('');
}
async function openReports() {
  const list = doc.reports || [];
  const r = await dialog({
    title: `計算書（${list.length} 件）`, wide: true,
    body: list.length ? list.map(reportHtml).join('') : '<p class="small">計算メニューの結果から［計算書に追加］すると、ここにたまります。</p>',
    buttons: [{ label: '全部削除', value: 'clear' }, { label: 'CSV', value: 'csv' }, { label: '印刷・PDF', value: 'print', primary: true }, { label: '閉じる', value: 'cancel' }],
  });
  if (r === 'print' && list.length) {
    $('#printArea').innerHTML = `<style>@page { size: A4 portrait; margin: 15mm; }</style><h2>計算書　${esc(doc.name)}</h2>` + list.map(reportHtml).join('');
    setTimeout(() => window.print(), 100);
  } else if (r === 'csv' && list.length) {
    saveBlob(`${safeName()}_計算書.csv`, new Blob([reportsCSV(list)], { type: 'text/csv' }), [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]);
  } else if (r === 'clear' && list.length) {
    doc.reports = []; setDirty(true); autosave(); toast('計算書を削除しました');
  }
}

// ============================================================
// ヘルプ
// ============================================================
function showHelp() {
  dialog({
    title: '使い方', wide: true,
    body: `<div class="help cols"><div>
      <h4>画面</h4><ul>
      <li>上の<b>リボン</b>でコマンドを選びます（作図・図形編集・土木・測量計算・現場連携）。</li>
      <li>左の<b>マルチボックス</b>に、今のコマンドの指示・設定・数値入力欄が出ます。</li>
      <li>右の<b>プロパティ</b>で選んだ図形の座標・色・線種などを直接変えられます。<b>レイヤ</b>は表示の切り替えと現在レイヤの選択。</li>
      <li>白い紙が<b>用紙枠</b>（印刷範囲）です。縮尺と用紙は上のスタイルバーで変えます。</li></ul>
      <h4>マウス</h4><ul>
      <li>左クリック: 点の指示・図形の選択。ドラッグで範囲選択（左→右: 囲んだ図形／右→左: かかった図形）</li>
      <li>右クリック: メニュー（確定・1つ戻る・終了・スナップ切替）</li>
      <li>ホイール: 拡大縮小 ／ 中ボタンドラッグ: 画面移動 ／ 中ボタン2回: 全体表示</li></ul>
      <h4>点の指示</h4><ul>
      <li>カーソルが端点・中点・交点・中心・点に近づくと吸着します（下のステータスバーで切替）。</li>
      <li>キーボードで入力: <code>X,Y</code>（絶対座標）、<code>@ΔX,ΔY</code>（前の点から）、<code>@距離&lt;方向角</code>、<code>長さ</code>（カーソルの方向へ）、<code>点名</code></li>
      <li>方向角は北から右回り（例 <code>45-30-00</code> = 45°30′00″）。</li></ul>
    </div><div>
      <h4>キー操作</h4><table>
      <tr><td>Enter / Space</td><td>確定・直前のコマンドを再実行</td></tr>
      <tr><td>Esc</td><td>コマンド終了・選択解除</td></tr>
      <tr><td>Backspace</td><td>1つ戻る</td></tr>
      <tr><td>Delete</td><td>選んだ図形を削除</td></tr>
      <tr><td>F8 / F3</td><td>直交モード / スナップ全体の ON・OFF</td></tr>
      <tr><td>Home</td><td>全体表示</td></tr>
      <tr><td>Ctrl+Z / Ctrl+Y</td><td>元に戻す / やり直し</td></tr>
      <tr><td>Ctrl+C / X / V</td><td>コピー / 切り取り / 貼り付け</td></tr>
      <tr><td>Ctrl+S / Ctrl+O / Ctrl+P</td><td>保存 / 開く / 印刷</td></tr></table>
      <h4>スマホ版との連動</h4><ul>
      <li>［現場連携］→［現場へ送る］で .gcad ファイルを作り、LINE・メール・Google ドライブなどでスマホへ。</li>
      <li>スマホ版のメニュー［パソコン連携］→［パソコンから受け取る］で開きます。</li>
      <li>現場で作った位置出し点・逃げ杭は、スマホ版の［パソコンへ送る］→ パソコン版の［現場データ取込］で、<b>差分だけ</b>取り込めます（同じ図形は新しい方が残ります）。</li>
      <li>［連携フォルダ］を Google ドライブや OneDrive の同期フォルダにすると、スマホから保存した新しいファイルを知らせます。</li></ul>
    </div></div>`,
  });
}
$('#btnHelp').addEventListener('click', showHelp);

// ============================================================
// 起動
// ============================================================
function renderAll() {
  ensureLayers(); renderLayers(); renderProps(); renderStylebar(); renderSnapBar(); refreshMB(); renderNames(); updateTitle();
  baseDirty = true; draw();
}
window.addEventListener('resize', resize);
window.addEventListener('beforeunload', (ev) => { if (dirty && fileHandle) { ev.preventDefault(); ev.returnValue = ''; } });
async function boot() {
  loadPrefs();
  let restored = false;
  try {
    const s = await idb.get('project');
    if (s) {
      const { doc: d } = unpackProject(s);
      Object.assign(doc, blankDoc(), d);
      const v = await idb.get('view'); if (v) Object.assign(view, v);
      fileName = (await idb.get('fileName')) || '';
      fileHandle = (await idb.get('fileHandle')) || null;
      restored = true;
    }
  } catch { /* 初回 */ }
  tracker.reset(doc);
  buildStylebar(); buildRibbon();
  resize();
  renderAll();
  if (!restored) { sheet().center = { x: 0, y: 0 }; zoomPaper(); }
  link.init();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
}
boot();

// 動作確認用
window.__pc = { doc, view, prefs, K, CMDS, startCmd, endCmd, get cmd() { return cmd; }, get sel() { return selEnts(); }, toS, toW, snapAt, parseInput, submitInput, commit, setSel, calc, link, sheet, loadFile, importDxfText };
