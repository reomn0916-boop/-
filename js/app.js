import { llToXY, xyToLL, guessZone, toDMS, parseAngle, azimuth, ZONES, ZONE_AREAS } from './geo.js';
import { decodeText, parseDXF, toDXF, parseSIMA, toSIMA, parseCSV, toCSV, encodeSJIS } from './io.js';
import { buildAlignment, alignPoint, alignStation, alignStakes, fmtStation, intersect, fitTransform, applyTransform, invertTransform, orientation, offsetPolyline, extendFrom, transformEntity } from './cogo.js';
import { initCalc, reportHtml, reportsCSV } from './calc.js';
import { ICONS } from '../pc/icons.js';
import { makeTracker, packProject, unpackProject, mergeProjects, mergeSummary, EXT } from './sync.js';
import { explodeForDxf, dimLabel, hatchSegments, LTYPES } from './draft.js';
import { SCALES, defaultSheet, layout as sheetLayout, makeXf, fitRange, autoScale, renderSheet, makePdf, sheetFrameEntities, sheetInfo, inViewport, dimGeom, dimText } from './sheet.js';

// ============================================================
// 状態
// 座標はすべて {x: X(北), y: Y(東)} [m]
// ============================================================
const STORE_KEY = 'genbacad.project.v1';
const SETTINGS_KEY = 'genbacad.settings.v1';

const doc = {
  name: '無題',
  zone: null,         // 平面直角座標系の系番号（未設定 null）
  entities: [],
  seq: 1,             // 次の点番号
  nextId: 1,
  hiddenLayers: [],   // 非表示の画層
  reports: [],        // 計算書
  gpsCal: { mode: 'rigid', pairs: [] }, // GPS 基準点補正
  sheet: null,        // 施工図の設定
  pid: null,          // プロジェクト ID（パソコン版との連携用）
  layers: [],         // 画層の色など（パソコン版で設定）
  tomb: [],           // 削除した図形（差分取り込み用）
};
const tracker = makeTracker();
const view = { x: 0, y: 0, s: 10 }; // 画面中心のワールド座標と拡大率 (px/m)
const settings = { snap: true, onLine: true, showLen: true, showNames: true, dark: false, prefix: 'P', stakes: true, ptGrp: '位置出し', nigeMode: 'corner', nigeDist: '1', dimUnit: 'm', lineKind: 'line', measKind: 'measure' };

let tool = 'select';
let temp = [];          // 作図中の点
let selected = null;    // 選択中エンティティ id
let selPoint = null;    // 選択ツールでタップしたスナップ点
let result = null;      // 計測結果（距離・角度）
let hover = null;       // マウスホバー位置 / 最後のタップ位置（スナップ済み）
let overlay = null;     // 計算結果の表示 {lines, pts, align}
let picker = null;      // 図から点を選ぶモード {cb, multi, done}
let calTf = null;       // GPS 補正の変換
let nigePending = null; // 平行逃げ: 図形を選んだ後、側を待つ {e}

// 点の種別
const GROUPS = ['基準点', '位置出し', '逃げ', 'その他'];
const grpOf = (e) => (GROUPS.includes(e.grp) ? e.grp : 'その他');
const GRP_COLOR = { 基準点: '#2563eb', 逃げ: '#ea580c' };
const undoStack = [];
const redoLimit = 60;

// GPS
const gps = { watchId: null, fix: null, avg: null, follow: false };

// 画層
const layerOf = (e) => e.layer || '（作図）';
const visible = (e) => !doc.hiddenLayers.length || !doc.hiddenLayers.includes(layerOf(e));

// ============================================================
// DOM
// ============================================================
const $ = (s) => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;

let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  C = { grid: g('--line'), fg: g('--fg'), muted: g('--muted'), accent: g('--accent'), bg: g('--canvas') };
}

// ============================================================
// 保存・読み込み
// ============================================================
function save() {
  tracker.track(doc);
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ doc, view })); } catch { /* 容量不足など */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d && d.doc) { Object.assign(doc, d.doc); if (d.view) Object.assign(view, d.view); }
  } catch { /* 破損時は新規 */ }
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* */ }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* */ } }

function snapshot() {
  undoStack.push(JSON.stringify({ e: doc.entities, s: doc.seq, n: doc.nextId }));
  if (undoStack.length > redoLimit) undoStack.shift();
}
function undo() {
  if (temp.length) { temp.pop(); updateCmd(); draw(); return; }
  const s = undoStack.pop();
  if (!s) { toast('これ以上戻せません'); return; }
  const d = JSON.parse(s);
  doc.entities = d.e; doc.seq = d.s; doc.nextId = d.n;
  if (!getEnt(selected)) { selected = null; }
  changed();
  toast('元に戻しました');
}
function changed() { save(); renderPanel(); draw(); updateTitle(); }

function addEntity(e, { snap = true } = {}) {
  if (snap) snapshot();
  e.id = doc.nextId++;
  doc.entities.push(e);
  return e;
}
function getEnt(id) { return doc.entities.find((e) => e.id === id); }
function nextPointName(peek = false) {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  const pre = settings.prefix || 'P';
  let n = doc.seq, name;
  do { name = pre + n++; } while (used.has(name));
  if (!peek) doc.seq = n;
  return name;
}
function uniqueName(name) {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

// ============================================================
// 座標変換（ワールド ⇔ 画面）
// ============================================================
const toS = (p) => ({ sx: W / 2 + (p.y - view.y) * view.s, sy: H / 2 - (p.x - view.x) * view.s });
const toW = (sx, sy) => ({ x: view.x - (sy - H / 2) / view.s, y: view.y + (sx - W / 2) / view.s });

function resize() {
  const r = cv.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  draw();
}

function bounds(ents = doc.entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); };
  for (const e of ents) {
    if (!visible(e)) continue;
    if (e.type === 'align') { const g = alignGeom(e); if (g.poly) g.poly.forEach(add); continue; }
    if (e.type === 'circle' || e.type === 'arc') { add({ x: e.c.x - e.r, y: e.c.y - e.r }); add({ x: e.c.x + e.r, y: e.c.y + e.r }); }
    else for (const p of verts(e)) add(p);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
function fitAll() {
  const b = bounds();
  if (!b) {
    if (gps.fix) { centerOn(gps.fix.p, 2); return; }
    view.x = 0; view.y = 0; view.s = 10; draw(); return;
  }
  view.x = (b.minX + b.maxX) / 2; view.y = (b.minY + b.maxY) / 2;
  const w = Math.max(b.maxY - b.minY, 1e-3), h = Math.max(b.maxX - b.minX, 1e-3);
  view.s = Math.min((W - 60) / w, (H - 60) / h);
  if (!Number.isFinite(view.s) || view.s <= 0) view.s = 10;
  view.s = Math.min(view.s, 400);
  save(); draw();
}
function centerOn(p, minScale) {
  view.x = p.x; view.y = p.y;
  if (minScale && view.s < minScale) view.s = minScale;
  save(); draw();
}

// ============================================================
// 幾何ヘルパー
// ============================================================
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function verts(e) {
  switch (e.type) {
    case 'point': return [e.p];
    case 'line': case 'dim': case 'leader': return [e.a, e.b];
    case 'poly': case 'hatch': return e.pts;
    case 'circle': return [e.c];
    case 'arc': return [e.c, arcPt(e, e.a0), arcPt(e, e.a1)];
    case 'text': return [e.p];
    case 'align': return (alignGeom(e).keys || []).map((k) => k.p);
    default: return [];
  }
}

// 路線の形状（キャッシュ）
const geomCache = new WeakMap();
function alignGeom(e) {
  let g = geomCache.get(e);
  if (g) return g;
  try {
    const al = buildAlignment(e.ips, e.radii, e.s0 || 0);
    const poly = [];
    for (const el of al.elems) {
      const n = el.type === 'line' ? 1 : Math.max(6, Math.ceil(el.len / el.R / (Math.PI / 90)));
      for (let i = poly.length ? 1 : 0; i <= n; i++) poly.push(alignPoint(al, Math.min(el.s + (el.len * i) / n, al.sEnd)).p);
    }
    const pitch = e.pitch || 20;
    const keys = [{ p: alignPoint(al, al.s0).p, label: 'BP', s: al.s0 }];
    for (const c of al.curves) keys.push({ p: c.BC, label: `BC${c.ip}`, s: c.sBC }, { p: c.MC, label: `MC${c.ip}`, s: c.sMC }, { p: c.EC, label: `EC${c.ip}`, s: c.sEC });
    keys.push({ p: alignPoint(al, al.sEnd).p, label: 'EP', s: al.sEnd });
    g = { al, poly, keys, pitch };
  } catch (err) {
    g = { err: err.message };
  }
  geomCache.set(e, g);
  return g;
}
const lr = (w) => (Math.abs(w) < 5e-4 ? '中心' : `${w > 0 ? '右' : '左'} ${Math.abs(w).toFixed(3)} m`);
function stationRows(p) {
  const rows = [];
  const als = doc.entities.filter((e) => e.type === 'align' && visible(e));
  for (const e of als) {
    const g = alignGeom(e); if (g.err) continue;
    const r = alignStation(g.al, p, 0.5);
    if (r) rows.push([als.length > 1 ? `測点（${esc(e.name)}）` : '測点', `${fmtStation(r.s, g.pitch)}　${lr(r.w)}`, 'big']);
  }
  return rows;
}
// DXF の角度（東から反時計回り）で円弧上の点
function arcPt(e, angDeg) {
  const t = (angDeg * Math.PI) / 180;
  return { x: e.c.x + e.r * Math.sin(t), y: e.c.y + e.r * Math.cos(t) };
}
function segments(e) {
  if (e.type === 'line' || e.type === 'leader') return [[e.a, e.b]];
  if (e.type === 'dim') { const g = dimGeom(e); return [[g.a2, g.b2]]; }
  if (e.type === 'align') {
    const g = alignGeom(e); const s = [];
    if (g.poly) for (let i = 0; i + 1 < g.poly.length; i++) s.push([g.poly[i], g.poly[i + 1]]);
    return s;
  }
  if (e.type === 'poly' || e.type === 'hatch') {
    const s = [];
    for (let i = 0; i + 1 < e.pts.length; i++) s.push([e.pts[i], e.pts[i + 1]]);
    if ((e.closed || e.type === 'hatch') && e.pts.length > 2) s.push([e.pts[e.pts.length - 1], e.pts[0]]);
    return s;
  }
  return [];
}
function projectOnSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return { q: a, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return { q: { x: a.x + t * dx, y: a.y + t * dy }, t };
}
function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}
function polyLen(pts, closed) {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += dist(pts[i], pts[i + 1]);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
  return s;
}
function interiorAngle(a, o, b) {
  let t = Math.abs(azimuth(o, a) - azimuth(o, b));
  if (t > 180) t = 360 - t;
  return t;
}

// ============================================================
// スナップ
// ============================================================
const SNAP_PX = 24;
function snapAt(sx, sy, { ignoreTemp = false } = {}) {
  const w = toW(sx, sy);
  const tol = SNAP_PX / view.s;
  let best = null;
  const consider = (p, kind, pri) => {
    const d = dist(p, w);
    if (d > tol) return;
    const score = d - pri * tol * 0.25;
    if (!best || score < best.score) best = { p: { x: p.x, y: p.y }, kind, score };
  };
  if (settings.snap) {
    const nearSegs = [];
    for (const e of doc.entities) {
      if (!visible(e)) continue;
      if (e.type !== 'align' && nearSegs.length < 60) {
        for (const [a, b] of segments(e)) if (dist(projectOnSeg(w, a, b).q, w) <= tol) nearSegs.push([a, b]);
      }
      switch (e.type) {
        case 'align': for (const k of alignGeom(e).keys || []) consider(k.p, k.label, 2); break;
        case 'point': consider(e.p, '点', 2); break;
        case 'line':
          consider(e.a, '端点', 2); consider(e.b, '端点', 2); consider(mid(e.a, e.b), '中点', 1); break;
        case 'dim': case 'leader': consider(e.a, '端点', 1.5); consider(e.b, '端点', 1.5); break;
        case 'poly':
          e.pts.forEach((p) => consider(p, '頂点', 2));
          for (const [a, b] of segments(e)) consider(mid(a, b), '中点', 1);
          break;
        case 'circle': consider(e.c, '中心', 2); break;
        case 'arc': consider(e.c, '中心', 2); consider(arcPt(e, e.a0), '端点', 2); consider(arcPt(e, e.a1), '端点', 2); break;
        case 'text': consider(e.p, '文字', 0); break;
      }
    }
    // 交点
    const isEnd = (p, a, b) => dist(p, a) < 1e-7 || dist(p, b) < 1e-7;
    for (let i = 0; i < nearSegs.length; i++) {
      for (let j = i + 1; j < nearSegs.length; j++) {
        const [a, b] = nearSegs[i], [c, d] = nearSegs[j];
        const r = intersect(a, b, c, d);
        if (!r || r.t < -1e-9 || r.t > 1 + 1e-9 || r.u < -1e-9 || r.u > 1 + 1e-9) continue;
        if (isEnd(r.p, a, b) || isEnd(r.p, c, d)) continue;
        consider(r.p, '交点', 2.2);
      }
    }
    if (!ignoreTemp) temp.forEach((p) => consider(p, '作図点', 2));
    if (gps.fix) consider(gps.fix.p, 'GPS', 1.5);
  }
  if (!best && settings.onLine) {
    for (const e of doc.entities) {
      if (!visible(e)) continue;
      for (const [a, b] of segments(e)) {
        const { q } = projectOnSeg(w, a, b);
        const d = dist(q, w);
        if (d <= tol * 0.6 && (!best || d < best.score)) best = { p: q, kind: '線上', score: d };
      }
      if (e.type === 'circle') {
        const d = dist(w, e.c);
        if (d > 0 && Math.abs(d - e.r) <= tol * 0.6) {
          const q = { x: e.c.x + (w.x - e.c.x) * e.r / d, y: e.c.y + (w.y - e.c.y) * e.r / d };
          const dd = Math.abs(d - e.r);
          if (!best || dd < best.score) best = { p: q, kind: '円周上', score: dd };
        }
      }
    }
  }
  return best ? { p: best.p, kind: best.kind } : { p: w, kind: null };
}

// ============================================================
// 当たり判定（選択）
// ============================================================
function hitTest(sx, sy, filter) {
  const w = toW(sx, sy);
  const tol = 18 / view.s;
  let best = null;
  const take = (e, d) => { if (d <= tol && (!best || d < best.d)) best = { e, d }; };
  for (const e of doc.entities) {
    if (!visible(e) || (filter && !filter(e))) continue;
    switch (e.type) {
      case 'point': take(e, dist(e.p, w) * 0.6); break; // 点は優先
      case 'text': take(e, dist(e.p, w)); break;
      case 'circle': take(e, Math.abs(dist(e.c, w) - e.r)); break;
      case 'arc': take(e, Math.abs(dist(e.c, w) - e.r)); break;
      default:
        for (const [a, b] of segments(e)) take(e, dist(projectOnSeg(w, a, b).q, w));
        if (e.type === 'poly' && e.closed && e.area && pointInPoly(w, e.pts) && !best) best = { e, d: tol };
    }
  }
  return best ? best.e : null;
}
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ============================================================
// 描画
// ============================================================
function niceStep(px) {
  const raw = px / view.s;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

let emptyOff = false;
function updateEmpty() { const el = $('#emptyState'); if (el) el.hidden = emptyOff || doc.entities.length > 0; }
function draw() {
  updateEmpty();
  if (!W) return;
  const dark = settings.dark;
  const ent = dark ? '#e8eef4' : '#1a2530';
  const sel = '#ff8a00';
  const tmpC = '#e0245e';

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // グリッド
  const step = niceStep(60);
  const tl = toW(0, 0), br = toW(W, H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) { const { sx } = toS({ x: 0, y }); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, H); }
  for (let x = Math.floor(br.x / step) * step; x <= tl.x; x += step) { const { sy } = toS({ x, y: 0 }); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(W, Math.round(sy) + 0.5); }
  ctx.stroke();

  // エンティティ
  ctx.font = '12px ui-monospace, Menlo, monospace';
  for (const e of doc.entities) {
    if (!visible(e)) continue;
    const isSel = e.id === selected;
    ctx.strokeStyle = isSel ? sel : (e.type === 'dim' ? C.accent : e.type === 'align' ? '#16a34a' : ent);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = isSel ? 3 : 1.5;
    ctx.setLineDash([]);
    drawEntity(e, isSel);
  }
  ctx.setLineDash([]);

  // 作図中
  if (temp.length) {
    ctx.strokeStyle = tmpC; ctx.fillStyle = tmpC; ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    temp.forEach((p, i) => { const s = toS(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
    if (hover && (tool === 'line' || tool === 'area' || tool === 'measure' || tool === 'angle')) {
      const s = toS(hover.p); ctx.lineTo(s.sx, s.sy);
    }
    if (tool === 'area' && temp.length > 1) { const s = toS(temp[0]); ctx.lineTo(s.sx, s.sy); }
    ctx.stroke();
    if (tool === 'circle' && hover) {
      const c = toS(temp[0]); ctx.beginPath(); ctx.arc(c.sx, c.sy, dist(temp[0], hover.p) * view.s, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    temp.forEach((p) => { const s = toS(p); ctx.fillRect(s.sx - 3, s.sy - 3, 6, 6); });
  }

  // 計測結果・計算結果
  if (result) drawResult(result, tmpC);
  if (overlay) drawOverlay(overlay);

  // 選択ツールのスナップ点
  if (selPoint) {
    const s = toS(selPoint.p);
    ctx.strokeStyle = sel; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 9, 0, Math.PI * 2); ctx.stroke();
  }

  // GPS
  if (gps.fix) {
    const s = toS(gps.fix.p);
    const r = gps.fix.acc * view.s;
    ctx.fillStyle = 'rgba(10,108,255,.12)'; ctx.strokeStyle = 'rgba(10,108,255,.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.sx, s.sy, Math.max(r, 0), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0a6cff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 選択点への誘導線
    const tgt = targetPoint();
    if (tgt) {
      const t = toS(tgt);
      ctx.strokeStyle = '#0a6cff'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(s.sx, s.sy); ctx.lineTo(t.sx, t.sy); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // スナップマーカー
  if (hover && hover.kind && tool !== 'select') {
    const s = toS(hover.p);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    ctx.strokeRect(s.sx - 7, s.sy - 7, 14, 14);
  }

  // 北矢印とスケール
  drawNorth(C);
  drawScale(C);
}

function label(text, sx, sy, color, align = 'left') {
  ctx.font = '12px ui-monospace, Menlo, monospace';
  const w = ctx.measureText(text).width;
  const x = align === 'center' ? sx - w / 2 : sx;
  ctx.fillStyle = settings.dark ? 'rgba(17,24,32,.8)' : 'rgba(255,255,255,.85)';
  ctx.fillRect(x - 2, sy - 11, w + 4, 15);
  ctx.fillStyle = color;
  ctx.fillText(text, x, sy);
}

function segLabel(a, b, color) {
  const s1 = toS(a), s2 = toS(b);
  const len = Math.hypot(s2.sx - s1.sx, s2.sy - s1.sy);
  if (len < 50) return;
  label(fmt(dist(a, b), 3), (s1.sx + s2.sx) / 2, (s1.sy + s2.sy) / 2 - 4, color, 'center');
}

const LT_PX = { dash: [8, 5], dot: [2, 4], chain: [14, 4, 2, 4], chain2: [14, 4, 2, 4, 2, 4] };
function drawEntity(e, isSel) {
  // パソコン版で付けた色・線種（画層の設定も含む）
  if (!isSel && e.type !== 'point') {
    const L = layerStyle(e);
    const c = e.color || L.color;
    if (c && !/^#(000000|000|ffffff|fff)$/i.test(c)) { ctx.strokeStyle = c; ctx.fillStyle = c; }
    const lt = e.dash ? null : (e.ltype || L.ltype);
    if (lt && LT_PX[lt]) ctx.setLineDash(LT_PX[lt]);
  }
  const color = ctx.strokeStyle;
  switch (e.type) {
    case 'point': {
      const s = toS(e.p);
      const g = grpOf(e);
      const col = isSel ? color : (GRP_COLOR[g] || color);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      if (g === '基準点') {
        ctx.beginPath(); ctx.moveTo(s.sx, s.sy - 8); ctx.lineTo(s.sx + 7, s.sy + 5); ctx.lineTo(s.sx - 7, s.sy + 5); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.sx, s.sy, 1.8, 0, Math.PI * 2); ctx.fill();
      } else if (g === '逃げ') {
        ctx.beginPath(); ctx.arc(s.sx, s.sy, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.sx - 3.5, s.sy - 3.5); ctx.lineTo(s.sx + 3.5, s.sy + 3.5); ctx.moveTo(s.sx + 3.5, s.sy - 3.5); ctx.lineTo(s.sx - 3.5, s.sy + 3.5); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(s.sx - 6, s.sy); ctx.lineTo(s.sx + 6, s.sy); ctx.moveTo(s.sx, s.sy - 6); ctx.lineTo(s.sx, s.sy + 6); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.sx, s.sy, 3, 0, Math.PI * 2); ctx.stroke();
      }
      if (settings.showNames && e.name) label(e.name, s.sx + 7, s.sy - 6, col);
      break;
    }
    case 'line': {
      const a = toS(e.a), b = toS(e.b);
      if (e.dash) { ctx.strokeStyle = isSel ? color : '#ea580c'; ctx.setLineDash([5, 4]); ctx.lineWidth = isSel ? 2.5 : 1.2; }
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      ctx.setLineDash([]);
      if (settings.showLen && !e.layer) segLabel(e.a, e.b, color);
      break;
    }
    case 'dim': {
      const g = dimGeom(e);
      const a = toS(g.ea), b = toS(g.eb), a2 = toS(g.a2), b2 = toS(g.b2);
      ctx.lineWidth = isSel ? 2.5 : 1;
      ctx.setLineDash([]);
      if (e.off || e.pa || e.pb) {
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(a2.sx, a2.sy); ctx.moveTo(b.sx, b.sy); ctx.lineTo(b2.sx, b2.sy); ctx.stroke();
      }
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.beginPath(); ctx.moveTo(a2.sx, a2.sy); ctx.lineTo(b2.sx, b2.sy); ctx.stroke();
      const d = Math.hypot(b2.sx - a2.sx, b2.sy - a2.sy) || 1, ux = (b2.sx - a2.sx) / d, uy = (b2.sy - a2.sy) / d;
      const tx = (ux - uy) * 5, ty = (uy + ux) * 5;
      for (const p of [a2, b2]) { ctx.beginPath(); ctx.moveTo(p.sx - tx, p.sy - ty); ctx.lineTo(p.sx + tx, p.sy + ty); ctx.stroke(); }
      label(dimLabel(e, settings.dimUnit), (a2.sx + b2.sx) / 2, (a2.sy + b2.sy) / 2 - 5, color, 'center');
      break;
    }
    case 'leader': {
      const a = toS(e.a), b = toS(e.b);
      const right = b.sx >= a.sx;
      ctx.lineWidth = isSel ? 2.5 : 1.2;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.lineTo(b.sx + (right ? 12 : -12), b.sy); ctx.stroke();
      ctx.beginPath(); ctx.arc(a.sx, a.sy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = `${Math.round((e.hmm || 2.5) * 4.5)}px sans-serif`;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(e.text, b.sx + (right ? 2 : -2), b.sy - 4);
      ctx.textAlign = 'left';
      break;
    }
    case 'poly': {
      if (e.pts.length < 2) break;
      ctx.beginPath();
      e.pts.forEach((p, i) => { const s = toS(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      if (e.closed) ctx.closePath();
      if (e.dash) { ctx.strokeStyle = isSel ? color : '#ea580c'; ctx.setLineDash([5, 4]); ctx.lineWidth = isSel ? 2.5 : 1.2; }
      if (e.area) {
        ctx.save(); ctx.globalAlpha = isSel ? 0.18 : 0.08; ctx.fill(); ctx.restore();
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (settings.showLen && !e.layer) for (const [a, b] of segments(e)) segLabel(a, b, color);
      if (e.area) {
        let cx = 0, cy = 0; e.pts.forEach((p) => { cx += p.x; cy += p.y; });
        const c = toS({ x: cx / e.pts.length, y: cy / e.pts.length });
        label(fmt(polyArea(e.pts), 2) + '㎡', c.sx, c.sy, color, 'center');
      }
      break;
    }
    case 'hatch': {
      if (e.pts.length < 3) break;
      ctx.beginPath();
      e.pts.forEach((p, i) => { const s = toS(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      ctx.closePath();
      ctx.save(); ctx.globalAlpha = e.pattern === 'solid' ? 0.35 : 0.12; ctx.fill(); ctx.restore();
      if (e.border !== false || isSel) ctx.stroke();
      if (e.pattern !== 'solid') {
        const segs = hatchSegments(e, doc.sheet?.scaleN || 100);
        if (segs.length < 3000) {
          ctx.save(); ctx.lineWidth = 0.8; ctx.setLineDash([]); ctx.beginPath();
          for (const [p, q] of segs) { const s1 = toS(p), s2 = toS(q); ctx.moveTo(s1.sx, s1.sy); ctx.lineTo(s2.sx, s2.sy); }
          ctx.stroke(); ctx.restore();
        }
      }
      break;
    }
    case 'circle': {
      const c = toS(e.c);
      ctx.beginPath(); ctx.arc(c.sx, c.sy, e.r * view.s, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'arc': {
      const c = toS(e.c);
      // 画面座標は y 下向きなので角度の符号を反転
      ctx.beginPath(); ctx.arc(c.sx, c.sy, e.r * view.s, -e.a0 * Math.PI / 180, -e.a1 * Math.PI / 180, true); ctx.stroke();
      break;
    }
    case 'align': {
      const g = alignGeom(e);
      if (g.err) break;
      ctx.lineWidth = isSel ? 3.5 : 2.5;
      ctx.beginPath();
      g.poly.forEach((p, i) => { const s = toS(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      ctx.stroke();
      ctx.lineWidth = 1.5;
      // No.杭
      const pitch = g.pitch, ppx = pitch * view.s;
      if (settings.stakes && ppx >= 10) {
        const every = ppx >= 45 ? 1 : ppx >= 18 ? 5 : 10;
        for (let k = Math.ceil(g.al.s0 / pitch - 1e-9); k * pitch <= g.al.sEnd + 1e-9; k++) {
          const { p, az } = alignPoint(g.al, k * pitch);
          const s = toS(p), r = (az * Math.PI) / 180;
          const big = k % every === 0;
          const L = big ? 7 : 4;
          ctx.beginPath(); ctx.moveTo(s.sx - Math.cos(r) * L, s.sy - Math.sin(r) * L); ctx.lineTo(s.sx + Math.cos(r) * L, s.sy + Math.sin(r) * L); ctx.stroke();
          if (big) label(`No.${k}`, s.sx + Math.cos(r) * 10, s.sy + Math.sin(r) * 10 + 4, color);
        }
      }
      for (const k of g.keys) {
        const s = toS(k.p);
        ctx.beginPath(); ctx.arc(s.sx, s.sy, 4, 0, Math.PI * 2); ctx.fill();
        label(k.label, s.sx - 8, s.sy - 8, color, 'center');
      }
      break;
    }
    case 'text': {
      const s = toS(e.p);
      if (e.hmm) {
        ctx.save(); ctx.translate(s.sx, s.sy); if (e.rot) ctx.rotate((-e.rot * Math.PI) / 180);
        ctx.font = `${Math.round(e.hmm * 4.5)}px sans-serif`; ctx.textAlign = e.align || 'left'; ctx.fillStyle = color;
        String(e.text).split('\n').forEach((l, i) => ctx.fillText(l, 0, i * e.hmm * 5.6));
        ctx.restore(); break;
      }
      // DXF の文字高さ（≒大文字の高さ）を実寸で。小さすぎるときは描かない
      const px = (e.h || 1) * view.s * 1.25;
      if (px < 3) break;
      ctx.save();
      ctx.translate(s.sx, s.sy);
      if (e.rot) ctx.rotate((-e.rot * Math.PI) / 180);
      ctx.font = `${Math.min(px, 400)}px sans-serif`;
      ctx.textAlign = e.align || 'left';
      ctx.fillStyle = color;
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      break;
    }
  }
}

function drawOverlay(ov) {
  const col = '#c026d3';
  if (ov.align) { ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2; drawEntity(ov.align, false); }
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2; ctx.setLineDash([7, 4]);
  for (const [a, b] of ov.lines || []) { const s1 = toS(a), s2 = toS(b); ctx.beginPath(); ctx.moveTo(s1.sx, s1.sy); ctx.lineTo(s2.sx, s2.sy); ctx.stroke(); }
  ctx.setLineDash([]);
  for (const q of ov.pts || []) {
    const s = toS(q.p);
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 2, 0, Math.PI * 2); ctx.fill();
    if (q.label) label(q.label, s.sx + 8, s.sy + 14, col);
  }
}

function drawResult(r, color) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  const pts = r.pts.map(toS);
  ctx.beginPath(); pts.forEach((s, i) => (i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy))); ctx.stroke();
  pts.forEach((s) => { ctx.beginPath(); ctx.arc(s.sx, s.sy, 4, 0, Math.PI * 2); ctx.fill(); });
  if (r.kind === 'measure') {
    label(fmt(r.d) + 'm', (pts[0].sx + pts[1].sx) / 2, (pts[0].sy + pts[1].sy) / 2 - 6, color, 'center');
  } else if (r.kind === 'angle') {
    label(toDMS(r.ang, 0), pts[1].sx + 8, pts[1].sy - 8, color);
  }
}

function drawNorth(C) {
  const x = 24, y = H - 62;
  ctx.fillStyle = C.fg; ctx.strokeStyle = C.fg; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y - 18); ctx.lineTo(x - 7, y + 4); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y - 18); ctx.lineTo(x + 7, y + 4); ctx.lineTo(x, y); ctx.closePath(); ctx.stroke();
  ctx.font = 'bold 12px sans-serif'; ctx.fillText('N', x - 4, y + 18);
}

function drawScale(C) {
  const step = niceStep(80);
  const px = step * view.s;
  const x = 12, y = H - 16;
  ctx.strokeStyle = C.fg; ctx.fillStyle = C.fg; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const t = step >= 1 ? `${+step.toPrecision(3)} m` : `${+(step * 100).toPrecision(3)} cm`;
  ctx.fillText(t, x + 4, y - 7);
}

// ============================================================
// HUD・パネル
// ============================================================
function updateHud(p, kind) {
  $('#hudXY').textContent = p ? `X ${fmt(p.x)}  Y ${fmt(p.y)}` : 'X — / Y —';
  $('#hudSnap').textContent = kind ? `▣ ${kind}` : '';
}

function kv(rows) {
  return '<dl class="kv">' + rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('') + '</dl>';
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function llRows(p) {
  if (!doc.zone) return [];
  const q = invertTransform(calTf, p); // 基準点補正中は GPS 側の座標へ戻してから換算
  const ll = xyToLL(q.x, q.y, doc.zone);
  if (!Number.isFinite(ll.lat) || Math.abs(ll.lat) > 90) return [];
  return [['緯度', toDMS(ll.lat, 2)], ['経度', toDMS(ll.lon, 2)]];
}

/** 選択中の点（GPS 誘導の目標） */
function targetPoint() {
  if (selPoint) return selPoint.p;
  const e = getEnt(selected);
  if (e && e.type === 'point') return e.p;
  return null;
}

function guideRows(p) {
  if (!gps.fix || !p) return stationRows(p);
  const g = gps.fix.p;
  const d = dist(g, p);
  const az = azimuth(g, p);
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  return [
    ['現在地から', `${fmt(d, 2)} m`, 'big'],
    ['方向', `${dirs[Math.round(az / 45) % 8]}（${toDMS(az, 0)}）`],
    ['ΔX / ΔY', `${fmt(p.x - g.x, 2)} / ${fmt(p.y - g.y, 2)}`],
    ['GPS精度', `±${fmt(gps.fix.acc, 1)} m`],
    ...stationRows(p),
  ];
}

function renderPanel() {
  const panel = $('#panel'), body = $('#panelBody');
  let html = '';

  if (result && result.kind === 'measure') {
    const [a, b] = result.pts;
    html = '<h4>距離計測</h4>' + kv([
      ['水平距離', fmt(result.d) + ' m', 'big'],
      ['方向角', toDMS(azimuth(a, b))],
      ['ΔX（北）', fmt(b.x - a.x)],
      ['ΔY（東）', fmt(b.y - a.y)],
      ['始点', `${fmt(a.x)}, ${fmt(a.y)}`],
      ['終点', `${fmt(b.x)}, ${fmt(b.y)}`],
    ]) + `<div class="panel-actions"><button class="btn primary" data-act="keepDim">寸法線として残す</button><button class="btn" data-act="clearResult">消す</button></div>`;
  } else if (result && result.kind === 'angle') {
    html = '<h4>角度計測</h4>' + kv([
      ['なす角', toDMS(result.ang), 'big'],
      ['（10進）', fmt(result.ang, 5) + '°'],
      ['補角', toDMS(360 - result.ang)],
    ]) + `<div class="panel-actions"><button class="btn" data-act="clearResult">消す</button></div>`;
  } else if (tool === 'select' && (selected || selPoint)) {
    const e = getEnt(selected);
    if (selPoint && (!e || e.type !== 'point')) {
      html += `<h4>スナップ点（${esc(selPoint.kind)}）</h4>` + kv([
        ['X（北）', fmt(selPoint.p.x), 'big'], ['Y（東）', fmt(selPoint.p.y), 'big'], ...llRows(selPoint.p), ...guideRows(selPoint.p),
      ]) + `<div class="panel-actions"><button class="btn" data-act="regPoint">この位置を点として登録</button></div>`;
    }
    if (e) html += entityInfo(e);
  }
  if (overlay && !html) {
    html = '<h4>計算結果を表示中</h4><div class="panel-actions"><button class="btn" data-act="openCalc">計算に戻る</button><button class="btn" data-act="clearOverlay">表示を消す</button></div>';
  }
  if (gps.fix) html = html ? html + '<hr>' + '<h4>GPS</h4>' + stationRowsHtml() + gpsActions() : gpsInfo();
  body.innerHTML = html;
  panel.hidden = !html;
}

function stationRowsHtml() {
  const r = stationRows(gps.fix.p);
  return r.length ? kv(r) : '';
}
function calSummary() {
  if (!calTf) return 'なし';
  const n = doc.gpsCal.pairs.filter((q) => q.zone === doc.zone).length;
  const mx = Math.max(...calTf.residuals.map((r) => r.d));
  return `基準点 ${n} 点` + (n > 1 ? `（最大残差 ${fmt(mx, 2)} m）` : '');
}
function gpsInfo() {
  const f = gps.fix;
  return '<h4>現在地（GPS）</h4>' + kv([
    ['X（北）', fmt(f.p.x), 'big'], ['Y（東）', fmt(f.p.y), 'big'], ...stationRows(f.p),
    ['系', `${doc.zone}系`], ['精度', `±${fmt(f.acc, 1)} m`], ['基準点補正', calSummary()],
    ['緯度', toDMS(f.lat, 2)], ['経度', toDMS(f.lon, 2)],
    ...(f.alt != null ? [['標高(参考)', fmt(f.alt, 1) + ' m']] : []),
  ]) + gpsActions();
}
function gpsActions() {
  const busy = gps.avg ? `${gps.avg.label || '平均中'}… ${gps.avg.samples.length}/${gps.avg.n}` : '平均して点を追加（10回）';
  return `<div class="panel-actions"><button class="btn primary" data-act="gpsAvg" ${gps.avg ? 'disabled' : ''}>${busy}</button><button class="btn" data-act="gpsAdd">今の位置で点を追加</button><button class="btn" data-act="openCal">基準点で補正</button></div>`;
}

function entityInfo(e) {
  const del = `<button class="btn danger" data-act="delete">削除</button>`;
  const layer = e.layer ? [['画層', esc(e.layer)]] : [];
  switch (e.type) {
    case 'point':
      return `<h4>点 ${esc(e.name || '')}<span class="tag g-${grpOf(e)}">${grpOf(e)}</span></h4>` + kv([
        ['X（北）', fmt(e.p.x), 'big'], ['Y（東）', fmt(e.p.y), 'big'], ['Z', fmt(e.z || 0)], ...llRows(e.p), ...guideRows(e.p), ...layer,
      ]) + `<div class="panel-actions"><button class="btn" data-act="editPoint">編集</button>${del}</div>`;
    case 'dim':
      return '<h4>寸法</h4>' + kv([
        ['寸法', dimText(dimGeom(e).L, settings.dimUnit) + (settings.dimUnit === 'mm' ? ' mm' : ' m'), 'big'], ['方向角', toDMS(azimuth(e.a, e.b))], ['離れ', fmt(e.off || 0) + ' m'],
      ]) + `<div class="panel-actions">${del}</div>`;
    case 'text': case 'leader':
      if (e.type === 'leader' || e.hmm) {
        return `<h4>${e.type === 'leader' ? '引出線' : '文字'}</h4>` + kv([['内容', esc(e.text)], ['大きさ', `${e.hmm || 2.5} mm`]]) +
          `<div class="panel-actions"><button class="btn" data-act="editText">文字を編集</button>${del}</div>`;
      }
      return '<h4>文字</h4>' + kv([['内容', esc(e.text)], ['位置', `${fmt(e.p.x)}, ${fmt(e.p.y)}`], ...layer]) + `<div class="panel-actions">${del}</div>`;
    case 'line':
      return '<h4>線</h4>' + kv([
        ['長さ', fmt(dist(e.a, e.b)) + ' m', 'big'], ['方向角', toDMS(azimuth(e.a, e.b))],
        ['始点', `${fmt(e.a.x)}, ${fmt(e.a.y)}`], ['終点', `${fmt(e.b.x)}, ${fmt(e.b.y)}`], ...layer,
      ]) + `<div class="panel-actions"><button class="btn" data-act="regVerts">端点を点登録</button><button class="btn" data-act="nigeExtSel">両端に延長逃げ</button>${del}</div>`;
    case 'poly': {
      const rows = [['頂点数', e.pts.length], ['延長', fmt(polyLen(e.pts, e.closed)) + ' m', e.closed ? '' : 'big']];
      if (e.closed) rows.unshift(['面積', fmt(polyArea(e.pts), 3) + ' ㎡', 'big']);
      if (e.closed) rows.push(['（坪）', fmt(polyArea(e.pts) / 3.305785, 2) + ' 坪']);
      return `<h4>${e.closed ? '閉じた図形' : '連続線'}</h4>` + kv([...rows, ...layer]) +
        `<div class="panel-actions">${e.closed ? '<button class="btn primary" data-act="areaTable">求積表</button>' : ''}<button class="btn" data-act="regVerts">頂点を点登録</button><button class="btn" data-act="nigeCornersSel">全部の角に逃げ</button>${del}</div>`;
    }
    case 'align': {
      const g = alignGeom(e);
      if (g.err) return `<h4>路線 ${esc(e.name)}</h4><p class="err">${esc(g.err)}</p><div class="panel-actions">${del}</div>`;
      return `<h4>路線 ${esc(e.name)}</h4>` + kv([
        ['路線延長', fmt(g.al.length) + ' m', 'big'], ['BP', fmtStation(g.al.s0, g.pitch)], ['EP', fmtStation(g.al.sEnd, g.pitch)],
        ['IP 数', e.ips.length - 2], ['曲線', g.al.curves.map((c) => `R${c.R}`).join(' / ') || 'なし'], ['杭間隔', `${g.pitch} m`],
      ]) + `<div class="panel-actions"><button class="btn primary" data-act="alignStation">測点⇔座標</button><button class="btn" data-act="alignStakes">中心杭を点登録</button><button class="btn" data-act="alignReport">測点表を計算書へ</button>${del}</div>`;
    }
    case 'circle':
      return '<h4>円</h4>' + kv([
        ['半径', fmt(e.r) + ' m', 'big'], ['直径', fmt(e.r * 2) + ' m'], ['円周', fmt(2 * Math.PI * e.r) + ' m'],
        ['面積', fmt(Math.PI * e.r * e.r) + ' ㎡'], ['中心', `${fmt(e.c.x)}, ${fmt(e.c.y)}`], ...layer,
      ]) + `<div class="panel-actions">${del}</div>`;
    case 'arc': {
      let sweep = e.a1 - e.a0; if (sweep < 0) sweep += 360;
      return '<h4>円弧</h4>' + kv([
        ['半径', fmt(e.r) + ' m', 'big'], ['弧長', fmt(e.r * sweep * Math.PI / 180) + ' m'],
        ['中心', `${fmt(e.c.x)}, ${fmt(e.c.y)}`], ...layer,
      ]) + `<div class="panel-actions">${del}</div>`;
    }
    case 'text':
      return '<h4>文字</h4>' + kv([['内容', esc(e.text)], ['位置', `${fmt(e.p.x)}, ${fmt(e.p.y)}`], ...layer]) +
        `<div class="panel-actions">${del}</div>`;
  }
  return '';
}

// ============================================================
// ツール
// ============================================================
const HINTS = {
  point: ['タップで点を追加', 'X,Y を入力（例 100.5,200）'],
  line: ['始点をタップ', '座標 X,Y / @ΔX,ΔY / @距離<方向角'],
  circle: ['中心をタップ', '中心 X,Y'],
  measure: ['始点をタップ', 'X,Y'],
  angle: ['1点目をタップ（頂点は2点目）', 'X,Y'],
  area: ['頂点を順にタップ → 完了', '座標 X,Y / @ΔX,ΔY / @距離<方向角'],
  nige: ['', ''],
  dimension: ['寸法の始点をタップ', 'X,Y'],
  text: ['文字を置く位置をタップ', 'X,Y'],
  leader: ['引出線が指す点をタップ', 'X,Y'],
};
// 1つのボタンにまとめたツール
const FAMILY = { line: 'line', circle: 'line', leader: 'line', measure: 'measure', angle: 'measure' };
const KINDS = {
  line: [['line', '線（連続）'], ['circle', '円'], ['leader', '引出線']],
  measure: [['measure', '距離'], ['angle', '角度']],
};
const NIGE_HINT = {
  corner: '角・交点をタップ → 各辺の延長上に逃げを作ります',
  ext: '線をタップ → 両端の延長上に逃げを作ります',
  par: '線・図形をタップ → 逃げる側をタップ（平行に逃がす）',
};

function setTool(t) {
  tool = t;
  temp = [];
  nigePending = null;
  result = null;
  if (t !== 'select') { selected = null; selPoint = null; }
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === (FAMILY[t] || t)));
  const fam = FAMILY[t];
  if (fam) {
    if (fam === 'line') settings.lineKind = t; else settings.measKind = t;
    $('#kindSel').innerHTML = KINDS[fam].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#kindSel').value = t;
  }
  updateCmd();
  renderPanel();
  draw();
}

function updateCmd() {
  const bar = $('#cmdbar');
  if (tool === 'select') { bar.hidden = true; return; }
  bar.hidden = false;
  const [h0, ph] = HINTS[tool];
  let hint = h0;
  if (tool === 'line' && temp.length) hint = `次の点をタップ（${temp.length}点目まで入力済み）`;
  if (tool === 'circle' && temp.length) hint = '円周上の点をタップ、または半径を入力';
  if (tool === 'measure' && temp.length) hint = '終点をタップ';
  if (tool === 'angle' && temp.length === 1) hint = '頂点（角の中心）をタップ';
  if (tool === 'angle' && temp.length === 2) hint = '3点目をタップ';
  if (tool === 'area' && temp.length) hint = `頂点 ${temp.length} 点・面積 ${fmt(temp.length > 2 ? polyArea(temp) : 0, 2)}㎡ → 完了で確定`;
  if (tool === 'nige') hint = nigePending ? '逃げる側（外側・内側）をタップ' : NIGE_HINT[settings.nigeMode];
  if (tool === 'dimension' && temp.length === 1) hint = '寸法の終点をタップ';
  if (tool === 'dimension' && temp.length === 2) hint = '寸法線を置く位置をタップ（または離れの距離 m を入力）';
  if (tool === 'leader' && temp.length === 1) hint = '文字を置く位置をタップ';
  $('#kindRow').hidden = !FAMILY[tool];
  $('#ptRow').hidden = tool !== 'point';
  $('#nigeRow').hidden = tool !== 'nige';
  $('#cmdRow').hidden = tool === 'nige';
  $('#cmdHint').textContent = hint;
  $('#cmd').placeholder = tool === 'circle' && temp.length ? '半径（m）' : tool === 'dimension' && temp.length === 2 ? '離れ m（右＋/左−）' : ph;
  $('#cmdUndoPt').hidden = !['line', 'area', 'angle', 'measure', 'circle', 'dimension', 'leader'].includes(tool);
  if (tool === 'nige') $('#cmdUndoPt').hidden = true;
  $('#cmdClose').hidden = tool !== 'line';
  $('#cmdDone').hidden = !['line', 'area'].includes(tool);
  $('#cmdBtns').hidden = $('#cmdUndoPt').hidden && $('#cmdDone').hidden;
}

function place(p, kind) {
  hover = { p, kind };
  switch (tool) {
    case 'point': {
      snapshot();
      const e = addEntity({ type: 'point', p, name: nextPointName(), z: 0, grp: settings.ptGrp }, { snap: false });
      toast(`${e.name}（${e.grp}）  X ${fmt(p.x)}  Y ${fmt(p.y)}`);
      save();
      break;
    }
    case 'line':
      if (temp.length) addEntity({ type: 'line', a: temp[temp.length - 1], b: p });
      temp.push(p);
      save();
      break;
    case 'circle':
      if (!temp.length) temp.push(p);
      else { finishCircle(dist(temp[0], p)); return; }
      break;
    case 'measure':
      if (temp.length === 0 || result) { result = null; temp = [p]; }
      else {
        result = { kind: 'measure', pts: [temp[0], p], d: dist(temp[0], p) };
        temp = [];
      }
      break;
    case 'angle':
      if (result) { result = null; temp = []; }
      temp.push(p);
      if (temp.length === 3) {
        result = { kind: 'angle', pts: temp.slice(), ang: interiorAngle(temp[0], temp[1], temp[2]) };
        temp = [];
      }
      break;
    case 'area':
      temp.push(p);
      break;
    case 'dimension':
      if (temp.length < 2) { temp.push(p); break; }
      addDim(temp[0], temp[1], perpOff(temp[0], temp[1], p));
      return;
    case 'text':
      openTextDialog('文字', '', 3.5, (text, hmm) => {
        addEntity({ type: 'text', p: { ...p }, text, hmm });
        changed();
      });
      break;
    case 'leader':
      if (!temp.length) { temp.push(p); break; }
      {
        const a = temp[0];
        temp = [];
        openTextDialog('引出線の文字', '', 2.5, (text, hmm) => {
          addEntity({ type: 'leader', a: { ...a }, b: { ...p }, text, hmm });
          changed();
        });
      }
      break;
  }
  updateCmd(); renderPanel(); draw();
}

/** 点 p の、線 a→b からの離れ（右 +） */
function perpOff(a, b, p) {
  const L = dist(a, b) || 1;
  return (-(p.x - a.x) * (b.y - a.y) + (p.y - a.y) * (b.x - a.x)) / L;
}
function addDim(a, b, off) {
  if (dist(a, b) < 1e-6) { toast('同じ点です'); temp = []; updateCmd(); return; }
  addEntity({ type: 'dim', a: { ...a }, b: { ...b }, off: Math.abs(off) < 1e-6 ? 0 : off });
  temp = [];
  toast(`寸法 ${dimText(dist(a, b), settings.dimUnit)}`);
  changed(); updateCmd();
}

// ---------- 文字の入力 ----------
let textCb = null;
function openTextDialog(title, text, size, cb) {
  $('#textTitle').textContent = title;
  $('#textVal').value = text;
  $('#textSize').value = String(size);
  textCb = cb;
  $('#textDialog').showModal();
  setTimeout(() => $('#textVal').focus(), 50);
}
function textOk() {
  const t = $('#textVal').value.trim();
  if (!t) { toast('文字を入力してください'); return; }
  $('#textDialog').close();
  const cb = textCb; textCb = null;
  cb?.(t, Number($('#textSize').value));
}
$('#textOk').addEventListener('click', textOk);
$('#textVal').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); textOk(); } });

function finishCircle(r) {
  if (!(r > 0)) { toast('半径が正しくありません'); return; }
  addEntity({ type: 'circle', c: temp[0], r });
  temp = [];
  toast(`円 半径 ${fmt(r)} m`);
  changed(); updateCmd();
}

function finish() {
  if (tool === 'area') {
    if (temp.length < 3) { toast('3点以上必要です'); return; }
    const e = addEntity({ type: 'poly', pts: temp.slice(), closed: true, area: true });
    temp = [];
    setTool('select');
    selected = e.id;
    changed();
    return;
  }
  temp = [];
  updateCmd(); draw();
}

function closeLine() {
  if (temp.length < 3) { toast('3点以上必要です'); return; }
  addEntity({ type: 'line', a: temp[temp.length - 1], b: temp[0] });
  temp = [];
  changed(); updateCmd();
}

/** 入力欄の解釈 */
function parseCmd(text) {
  const s = text.trim().replace(/，/g, ',').replace(/＜/g, '<').replace(/＠/g, '@').replace(/\s+/g, '');
  if (!s) return null;
  const last = temp[temp.length - 1];
  if (s.startsWith('@')) {
    if (!last) { toast('前の点がありません'); return null; }
    const body = s.slice(1);
    if (body.includes('<')) {
      const [L, A] = body.split('<');
      const d = Number(L), az = parseAngle(A);
      if (!Number.isFinite(d) || !Number.isFinite(az)) return null;
      const t = (az * Math.PI) / 180;
      return { x: last.x + d * Math.cos(t), y: last.y + d * Math.sin(t) };
    }
    const [dx, dy] = body.split(',').map(Number);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { x: last.x + dx, y: last.y + dy };
  }
  const parts = s.split(',');
  if (parts.length >= 2) {
    const x = Number(parts[0]), y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return null;
}

function submitCmd() {
  const inp = $('#cmd');
  const text = inp.value;
  if (tool === 'circle' && temp.length && /^\s*[\d.]+\s*$/.test(text)) {
    finishCircle(Number(text)); inp.value = ''; return;
  }
  if (tool === 'dimension' && temp.length === 2 && /^\s*-?[\d.]+\s*$/.test(text)) {
    inp.value = ''; addDim(temp[0], temp[1], Number(text)); return;
  }
  const p = parseCmd(text);
  if (!p) { toast('入力形式: X,Y / @ΔX,ΔY / @距離<方向角'); return; }
  inp.value = '';
  place(p, '入力');
  // 入力した位置が画面外なら移動
  const s = toS(p);
  if (s.sx < 0 || s.sx > W || s.sy < 0 || s.sy > H) centerOn(p);
}

// ============================================================
// タッチ・マウス操作
// ============================================================
const pointers = new Map();
let gesture = null;

cv.addEventListener('pointerdown', (ev) => {
  cv.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
  if (pointers.size === 1) {
    gesture = { type: 'tap', sx: ev.offsetX, sy: ev.offsetY, t: Date.now(), vx: view.x, vy: view.y, button: ev.button };
  } else if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    gesture = {
      type: 'pinch',
      d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
      c0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      s0: view.s,
      w0: toW((p1.x + p2.x) / 2, (p1.y + p2.y) / 2),
    };
  }
});

cv.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId)) {
    // マウスホバー（作図プレビュー）
    if (ev.pointerType === 'mouse') {
      const sn = snapAt(ev.offsetX, ev.offsetY);
      hover = sn; updateHud(sn.p, sn.kind); draw();
    }
    return;
  }
  pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    view.s = clampScale(gesture.s0 * (d / gesture.d0));
    // 指の中心にあったワールド点を指の中心に保つ
    view.x = gesture.w0.x + (c.y - H / 2) / view.s;
    view.y = gesture.w0.y - (c.x - W / 2) / view.s;
    draw();
  } else if (gesture.type === 'tap' || gesture.type === 'pan') {
    const dx = ev.offsetX - gesture.sx, dy = ev.offsetY - gesture.sy;
    if (gesture.type === 'tap' && Math.hypot(dx, dy) > 8) gesture.type = 'pan';
    if (gesture.type === 'pan') {
      view.x = gesture.vx + dy / view.s;
      view.y = gesture.vy - dx / view.s;
      draw();
    }
  }
});

function endPointer(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  if (!gesture) return;
  if (gesture.type === 'tap' && pointers.size === 0 && ev.type === 'pointerup') {
    if (gesture.button === 0 || gesture.button === undefined) onTap(gesture.sx, gesture.sy);
  }
  if (pointers.size === 0) { gesture = null; save(); }
  else if (gesture.type === 'pinch') gesture = { type: 'none' }; // 1本残っても誤タップさせない
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);

cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const w0 = toW(ev.offsetX, ev.offsetY);
  view.s = clampScale(view.s * Math.exp(-ev.deltaY * 0.0015));
  view.x = w0.x + (ev.offsetY - H / 2) / view.s;
  view.y = w0.y - (ev.offsetX - W / 2) / view.s;
  draw(); save();
}, { passive: false });

const clampScale = (s) => Math.min(Math.max(s, 1e-4), 5000);

function onTap(sx, sy) {
  if (picker && picker.ent) {
    // 点ではなく図形を選ぶ
    const e = hitTest(sx, sy, picker.filter);
    if (!e) { toast(picker.miss || '図形が見つかりません。線の上をタップしてください'); return; }
    picker.cb(e);
    endPick();
    return;
  }
  if (picker) {
    const sn = snapAt(sx, sy, { ignoreTemp: true });
    const tol = SNAP_PX / view.s;
    let pe = null, best = Infinity;
    for (const e of doc.entities) {
      if (e.type !== 'point' || !visible(e)) continue;
      const d = dist(e.p, sn.p);
      if (d < best && d <= tol) { best = d; pe = e; }
    }
    if (picker.raw) {
      hover = sn; updateHud(sn.p, sn.kind);
      picker.cb({ ...sn.p });
      picker.count = (picker.count || 0) + 1;
      if (picker.max && picker.count >= picker.max) endPick();
      else { $('#pickMsg').textContent = `${picker.count} 点目を指定しました → 次の点をタップ`; draw(); }
      return;
    }
    let val;
    if (pe) val = pe.name;
    else if (picker.multi) {
      const e = addEntity({ type: 'point', p: sn.p, name: nextPointName(), z: 0 });
      val = e.name; save();
    } else val = `${sn.p.x.toFixed(4)},${sn.p.y.toFixed(4)}`;
    hover = sn; updateHud(sn.p, sn.kind);
    picker.cb(val);
    if (picker.multi) { picker.count = (picker.count || 0) + 1; $('#pickMsg').textContent = `${picker.count} 点選択済み（${val}）→ 続けてタップ / 完了`; draw(); }
    else endPick();
    return;
  }
  if (tool === 'select') {
    const sn = snapAt(sx, sy, { ignoreTemp: true });
    const e = hitTest(sx, sy);
    selected = e ? e.id : null;
    selPoint = sn.kind && sn.kind !== '文字' ? sn : null;
    if (e && e.type === 'point') selPoint = null;
    updateHud(sn.p, sn.kind);
    renderPanel(); draw();
    return;
  }
  if (tool === 'nige') { nigeTap(sx, sy); return; }
  const sn = snapAt(sx, sy);
  updateHud(sn.p, sn.kind);
  place(sn.p, sn.kind);
}

// ============================================================
// 逃げ杭
// ============================================================
function nigeDistances() {
  const ds = String(settings.nigeDist || '1').split(/[,、\s]+/).filter(Boolean).map(Number);
  if (!ds.length || ds.some((d) => !Number.isFinite(d) || d === 0)) { toast('逃げ距離を数値で入力してください（例 1 または 1,2）'); return null; }
  return ds;
}
const EPS = 1e-4;
const GRP_RANK = { 位置出し: 0, その他: 1, 逃げ: 2, 基準点: 3 };
/** その位置にある点（重なっている場合は 位置出し > その他 > 逃げ > 基準点 の順） */
function pointEntAt(p) {
  let best = null;
  for (const e of doc.entities) {
    if (e.type !== 'point' || dist(e.p, p) >= EPS) continue;
    if (!best || GRP_RANK[grpOf(e)] < GRP_RANK[grpOf(best)]) best = e;
  }
  return best;
}
/** その位置の点名（なければ位置出し点として登録） */
function ensurePoint(p) {
  const e = pointEntAt(p);
  if (e) return e.name;
  return addEntity({ type: 'point', p: { x: p.x, y: p.y }, name: nextPointName(), z: 0, grp: '位置出し' }, { snap: false }).name;
}
function nigeName(base) {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  let i = 1;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function addNige(base, p) {
  if (pointEntAt(p)) return null; // 同じ位置に既にある
  return addEntity({ type: 'point', p: { x: p.x, y: p.y }, name: nigeName(base), z: 0, grp: '逃げ' }, { snap: false });
}
function addNigeLine(a, b) { addEntity({ type: 'line', a: { ...a }, b: { ...b }, layer: '逃げ', dash: true }, { snap: false }); }
/** 逃げ杭を作る元になる線分（逃げ・寸法・路線は除く） */
function baseSegments(only) {
  const out = [];
  for (const e of only ? [only] : doc.entities) {
    if (!visible(e) || e.layer === '逃げ' || e.type === 'dim' || e.type === 'align') continue;
    for (const s of segments(e)) if (dist(s[0], s[1]) > EPS) out.push(s);
  }
  return out;
}
/** 角・交点 P での逃げ方向（単位ベクトル）の一覧 */
function cornerDirs(P, segs) {
  const dirs = [];
  const add = (u) => { if (!dirs.some((v) => Math.abs(v.x - u.x) < 1e-6 && Math.abs(v.y - u.y) < 1e-6)) dirs.push(u); };
  for (const [a, b] of segs) {
    const L = dist(a, b), u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    if (dist(P, a) < EPS) add({ x: -u.x, y: -u.y });
    else if (dist(P, b) < EPS) add(u);
    else if (dist(projectOnSeg(P, a, b).q, P) < EPS) { add(u); add({ x: -u.x, y: -u.y }); }
  }
  return dirs;
}
function nigeCorner(P, segs, ds) {
  const dirs = cornerDirs(P, segs);
  if (!dirs.length) return 0;
  const base = ensurePoint(P);
  let n = 0;
  for (const u of dirs) {
    let far = null;
    for (const d of ds) {
      const q = { x: P.x + u.x * d, y: P.y + u.y * d };
      if (addNige(base, q)) n++;
      if (!far || Math.abs(d) > far.d) far = { q, d: Math.abs(d) };
    }
    addNigeLine(P, far.q);
  }
  return n;
}
function nigeExt(a, b, ds) {
  let n = 0;
  for (const [from, end] of [[b, a], [a, b]]) {
    const base = ensurePoint(end);
    let far = null;
    for (const d of ds) { const q = extendFrom(from, end, d); if (addNige(base, q)) n++; if (!far || Math.abs(d) > far.d) far = { q, d: Math.abs(d) }; }
    addNigeLine(end, far.q);
  }
  return n;
}
/** 平行逃げ: 図形 e を、tap 位置のある側へ d だけ */
function nigeParallel(e, tapW, ds) {
  let pts, closed;
  if (e.type === 'line') { pts = [e.a, e.b]; closed = false; }
  else if (e.type === 'poly') { pts = e.pts; closed = !!e.closed && e.pts.length > 2; }
  else { toast('線か連続線・多角形を選んでください'); return 0; }
  let side;
  if (closed) {
    const inside = pointInPoly(tapW, pts);
    const cw = orientation(pts) > 0; // 時計回りなら内側が右
    side = (inside === cw) ? 1 : -1;
  } else {
    // 一番近い辺に対してどちら側か
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const { q } = projectOnSeg(tapW, pts[i], pts[i + 1]);
      const d = dist(q, tapW);
      if (!best || d < best.d) best = { d, a: pts[i], b: pts[i + 1] };
    }
    const cr = -(tapW.x - best.a.x) * (best.b.y - best.a.y) + (tapW.y - best.a.y) * (best.b.x - best.a.x);
    side = cr >= 0 ? 1 : -1;
  }
  let n = 0;
  const bases = pts.map((p) => ensurePoint(p));
  for (const d of ds) {
    const off = offsetPolyline(pts, side * Math.abs(d), closed);
    off.forEach((q, i) => { if (addNige(bases[i], q)) n++; });
    if (closed) addEntity({ type: 'poly', pts: off, closed: true, layer: '逃げ', dash: true }, { snap: false });
    else addEntity({ type: 'poly', pts: off, closed: false, layer: '逃げ', dash: true }, { snap: false });
  }
  return n;
}
function nigeDone(n, what) {
  if (n) toast(`${what}：逃げ杭 ${n} 本を作りました`);
  else toast('作れる逃げがありませんでした（同じ位置に点があるか、線が見つかりません）');
  renderNames(); changed(); updateCmd();
}
function nigeTap(sx, sy) {
  const ds = nigeDistances(); if (!ds) return;
  const mode = settings.nigeMode;
  if (mode === 'corner') {
    const sn = snapAt(sx, sy, { ignoreTemp: true });
    if (!sn.kind || sn.kind === '線上' || sn.kind === '円周上') { toast('線の端点・角・交点をタップしてください'); return; }
    hover = sn; updateHud(sn.p, sn.kind);
    const segs = baseSegments();
    if (!cornerDirs(sn.p, segs).length) { toast('この点につながる線がありません'); return; }
    snapshot();
    nigeDone(nigeCorner(sn.p, segs, ds), '角・交点');
    return;
  }
  const e = hitTest(sx, sy);
  if (mode === 'ext') {
    if (!e || !['line', 'poly'].includes(e.type) || e.layer === '逃げ') { toast('線をタップしてください'); return; }
    const w = toW(sx, sy);
    let best = null;
    for (const [a, b] of segments(e)) { const d = dist(projectOnSeg(w, a, b).q, w); if (!best || d < best.d) best = { d, a, b }; }
    snapshot();
    nigeDone(nigeExt(best.a, best.b, ds), '線の延長');
    return;
  }
  // 平行
  if (!nigePending) {
    if (!e || !['line', 'poly'].includes(e.type) || e.layer === '逃げ') { toast('線・図形をタップしてください'); return; }
    nigePending = { id: e.id };
    selected = e.id;
    updateCmd(); draw();
    return;
  }
  const tgt = getEnt(nigePending.id);
  nigePending = null; selected = null;
  if (!tgt) { updateCmd(); return; }
  snapshot();
  nigeDone(nigeParallel(tgt, toW(sx, sy), ds), '平行');
}

// ============================================================
// GPS
// ============================================================
function toggleGps() {
  if (gps.watchId != null) {
    navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null; gps.fix = null; gps.avg = null;
    $('#btnGps').classList.remove('on');
    $('#gpsHud').hidden = true; $('#btnGoGps').hidden = true;
    renderPanel(); draw();
    return;
  }
  if (!('geolocation' in navigator)) { toast('この端末は位置情報に対応していません'); return; }
  if (!window.isSecureContext) { toast('位置情報は https で開いたときのみ使えます'); return; }
  $('#btnGps').classList.add('on');
  $('#gpsHud').hidden = false;
  $('#gpsHud').textContent = 'GPS 測位中…';
  gps.follow = true;
  gps.watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    const msg = { 1: '位置情報の利用が許可されていません（設定を確認）', 2: '位置を取得できません', 3: '測位がタイムアウトしました' }[err.code] || err.message;
    // 測位できている途中の一時的なエラーは控えめに（watch は継続する）
    if (err.code === 1 || !gps.fix) { toast(msg); $('#gpsHud').textContent = 'GPS: ' + msg; }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt } = pos.coords;
  if (!doc.zone) {
    doc.zone = guessZone(lat, lon);
    updateZoneChip(); save();
    toast(`座標系を ${doc.zone}系 に設定しました（右上で変更できます）`);
  }
  const raw = llToXY(lat, lon, doc.zone);
  const p = applyTransform(calTf, raw);
  gps.fix = { lat, lon, acc, alt, p, raw, t: pos.timestamp };
  $('#gpsHud').textContent = `GPS ±${fmt(acc, 1)}m${calTf ? '（補正）' : ''}\nX ${fmt(p.x, 2)}\nY ${fmt(p.y, 2)}`;
  $('#gpsHud').style.whiteSpace = 'pre';
  $('#btnGoGps').hidden = false;

  if (gps.avg) {
    gps.avg.samples.push({ lat, lon, acc, alt });
    if (gps.avg.samples.length >= gps.avg.n) {
      const a = gps.avg; gps.avg = null;
      a.onDone(averageFix(a.samples));
    }
  }
  if (gps.follow) { gps.follow = false; centerOn(gps.fix.p, Math.max(view.s, 2)); }
  renderPanel();
  draw();
}

/** 精度で重み付けした平均位置 */
function averageFix(s) {
  let wsum = 0, la = 0, lo = 0;
  for (const q of s) { const w = 1 / Math.max(q.acc, 0.5) ** 2; wsum += w; la += q.lat * w; lo += q.lon * w; }
  const lat = la / wsum, lon = lo / wsum;
  const accs = s.map((q) => q.acc).sort((a, b) => a - b);
  const raw = llToXY(lat, lon, doc.zone);
  return { lat, lon, raw, p: applyTransform(calTf, raw), acc: accs[Math.floor(accs.length / 2)], n: s.length };
}
function startAvg(onDone, label, n = 10) {
  if (!gps.fix) { toast('GPS を ON にして測位を待ってください'); return; }
  gps.avg = { n, samples: [], onDone, label };
  toast('その場で静止してください（10回測位して平均します）');
  renderPanel();
}

// ---------- 基準点補正 ----------
function recomputeCal() {
  const pairs = doc.gpsCal.pairs.filter((q) => q.zone === doc.zone);
  calTf = pairs.length ? fitTransform(pairs, doc.gpsCal.mode) : null;
  if (gps.fix) { gps.fix.raw = llToXY(gps.fix.lat, gps.fix.lon, doc.zone); gps.fix.p = applyTransform(calTf, gps.fix.raw); }
}
function renderCal() {
  $('#calMode').value = doc.gpsCal.mode;
  const pairs = doc.gpsCal.pairs;
  const res = calTf ? calTf.residuals : [];
  let i = 0;
  $('#calPairs').innerHTML = pairs.length
    ? '<table><thead><tr><th>基準点</th><th>残差</th><th></th></tr></thead><tbody>' + pairs.map((q, k) => {
      const ok = q.zone === doc.zone;
      const r = ok ? res[i++] : null;
      return `<tr><td>${esc(q.name)}</td><td class="num">${ok ? (pairs.filter((x) => x.zone === doc.zone).length > 1 ? fmt(r.d, 3) + ' m' : '—') : '系が違う'}</td><td><button class="btn small-btn" data-caldel="${k}">✕</button></td></tr>`;
    }).join('') + '</tbody></table>'
    : '<p class="small">まだ基準点がありません。</p>';
  $('#calInfo').textContent = calTf
    ? `補正中：回転 ${toDMS(calTf.rot, 1)}・縮尺 ${calTf.scale.toFixed(6)}・移動 X ${fmt(calTf.tx, 3)} / Y ${fmt(calTf.ty, 3)}`
    : '補正なし（GPS の座標をそのまま使います）';
  $('#calStatus').textContent = gps.fix ? `GPS 測位中 ±${fmt(gps.fix.acc, 1)} m` : 'GPS が OFF です。先に GPS を ON にしてください。';
}
function openCal() {
  recomputeCal(); renderCal(); renderNames();
  $('#calDialog').showModal();
}

// ============================================================
// ファイル
// ============================================================
function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** DXF 用: 寸法線・引出線・ハッチング・路線を線・円弧・文字に展開 */
function exportEntities(ents = doc.entities, scaleN = doc.sheet?.scaleN || 100, sheetRot = 0) {
  return explodeForDxf(ents, { scaleN, sheetRot, unit: settings.dimUnit, alignGeom, alignPoint, alignStakes });
}
const safeName = () => (doc.name || 'genbacad').replace(/[\\/:*?"<>|]/g, '_');
const pointList = () => doc.entities.filter((e) => e.type === 'point').map((e) => ({ name: e.name, x: e.p.x, y: e.p.y, z: e.z || 0 }));

async function readFile(input) {
  const f = input.files[0];
  input.value = '';
  if (!f) return null;
  return { name: f.name, text: decodeText(await f.arrayBuffer()) };
}

$('#fileDxf').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  try {
    const { entities, skipped } = parseDXF(f.text);
    if (!entities.length) { toast('読み込める図形がありませんでした'); return; }
    snapshot();
    for (const e of entities) {
      if (e.type === 'point') { if (!e.name) e.name = nextPointName(); e.grp = 'その他'; }
      addEntity(e, { snap: false });
    }
    if (doc.name === '無題') { doc.name = f.name.replace(/\.dxf$/i, ''); updateTitle(); }
    changed(); fitAll();
    toast(`${entities.length} 個の図形を読み込みました` + (skipped.length ? `（未対応: ${skipped.join(', ')}）` : ''));
  } catch (err) { toast('DXF を読み込めませんでした: ' + err.message); }
});

let scAfterSima = false;
$('#filePts').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  const isSima = /\.sim$/i.test(f.name) || /^\s*A01\s*,/m.test(f.text);
  const pts = isSima ? parseSIMA(f.text) : parseCSV(f.text);
  if (!pts.length) {
    toast(isSima ? 'SIMA の座標（A01 の行）が見つかりませんでした。座標データの SIMA か確かめてください'
      : /^\s*0\s*$/m.test(f.text) && /SECTION/.test(f.text) ? 'これは DXF（図面）です。「図面を読み込む」から入れてください'
        : '座標が見つかりませんでした。SIMA（.sim）か「点名,X,Y」の CSV を選んでください');
    return;
  }
  snapshot();
  for (const q of pts) addEntity({ type: 'point', p: { x: q.x, y: q.y }, z: q.z, name: q.name || nextPointName(), grp: '基準点' }, { snap: false });
  changed(); fitAll();
  if (scAfterSima) { scAfterSima = false; openScaleCoord(); toast(`${pts.length} 点を読み込みました。図面上の点と対応させてください`); return; }
  const hasDrawing = doc.entities.some((e) => e.type !== 'point');
  toast(`${pts.length} 点を「基準点」として読み込みました` + (hasDrawing ? '。図面を合わせるときは ☰ →「縮尺合わせ」→「座標（SIMA）で」' : '（座標一覧で種別を変更できます）'));
});

/** プロジェクト（.gcad / .json）で今の図面を置き換える */
function openProject(d) {
  snapshot();
  for (const k of Object.keys(doc)) delete doc[k];
  Object.assign(doc, {
    name: d.name || '無題', zone: d.zone || null, entities: d.entities, seq: d.seq || 1, nextId: d.nextId || 1,
    hiddenLayers: d.hiddenLayers || [], reports: d.reports || [], gpsCal: d.gpsCal || { mode: 'rigid', pairs: [] }, sheet: d.sheet || null,
    pid: d.pid || null, layers: d.layers || [], tomb: d.tomb || [],
  });
  tracker.reset(doc);
  recomputeCal();
  selected = null; selPoint = null; result = null; temp = [];
  updateTitle(); updateZoneChip(); renderNames(); changed(); fitAll();
}
$('#fileJson').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  try { openProject(unpackProject(f.text).doc); toast(`「${f.name}」を開きました`); } catch (err) { toast('読み込めませんでした: ' + err.message); }
});

// パソコン連携: 受け取ったプロジェクトを開く or 差分で取り込む
let incoming = null;
$('#fileGcad').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  try { incoming = { ...unpackProject(f.text), file: f.name }; } catch (err) { toast('読み込めませんでした: ' + err.message); return; }
  const d = incoming.doc;
  if (!doc.entities.length) { openProject(d); toast(`「${f.name}」を開きました（図形 ${d.entities.length}）`); incoming = null; return; }
  const same = d.pid && d.pid === doc.pid;
  $('#linkMsg').innerHTML = `<b>${esc(f.name)}</b>（図形 ${d.entities.length}）<br>` + (same
    ? '今の図面と同じ現場のデータです。「取り込む」を選ぶと、現場で作った点を残したまま、パソコンで変えたところだけ更新します。'
    : '今の図面とは別のデータです。「開く」で置き換えるか、「取り込む」で今の図面に追加します。');
  $('#linkDialog').showModal();
});
$('#linkOpen').addEventListener('click', () => {
  $('#linkDialog').close();
  if (!incoming) return;
  openProject(incoming.doc); toast(`「${incoming.file}」を開きました`); incoming = null;
});
$('#linkMerge').addEventListener('click', () => {
  $('#linkDialog').close();
  if (!incoming) return;
  snapshot();
  const r = mergeProjects(doc, incoming.doc);
  recomputeCal(); renderNames(); updateZoneChip(); changed();
  toast('取り込みました: ' + mergeSummary(r));
  incoming = null;
});
async function sendPc() {
  const name = safeName() + EXT;
  const data = JSON.stringify(packProject(doc, 'mobile'));
  save();
  const file = new File([data], name, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); toast('送りました。パソコン版の［現場データ取込］で取り込めます'); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  download(name, new Blob([data], { type: 'application/octet-stream' }));
  toast('保存しました。メールやクラウドでパソコンへ送ってください');
}

// ============================================================
// UI 操作
// ============================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function updateTitle() {
  $('#title').textContent = doc.name; document.title = `${doc.name} - 現場CAD`;
  const n = doc.entities.length, pts = doc.entities.filter((e) => e.type === 'point').length;
  $('#subTitle').textContent = n ? `図形 ${n} ・ 点 ${pts}` : '現場CAD';
}
function updateZoneChip() { $('#btnZone').textContent = doc.zone ? `${doc.zone}系` : '系: 未設定'; }

function openPointDialog(e) {
  $('#ptName').value = e.name || '';
  $('#ptX').value = e.p.x.toFixed(3);
  $('#ptY').value = e.p.y.toFixed(3);
  $('#ptZ').value = (e.z || 0).toFixed(3);
  $('#ptGrpEdit').value = grpOf(e);
  $('#ptOk').onclick = () => {
    const x = Number($('#ptX').value), y = Number($('#ptY').value), z = Number($('#ptZ').value || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { toast('数値を入力してください'); return; }
    snapshot();
    e.name = $('#ptName').value.trim(); e.p = { x, y }; e.z = Number.isFinite(z) ? z : 0; e.grp = $('#ptGrpEdit').value;
    $('#ptDialog').close(); changed();
  };
  $('#ptDialog').showModal();
}

function openZoneDialog() {
  const sel = $('#zoneSel');
  sel.innerHTML = Object.keys(ZONES).map((z) => `<option value="${z}">${z}系 — ${ZONE_AREAS[z]}</option>`).join('');
  sel.value = doc.zone || 9;
  $('#zoneGuess').textContent = gps.fix ? `現在地からの推定: ${guessZone(gps.fix.lat, gps.fix.lon)}系（県境付近は要確認）` : '';
  $('#zoneDialog').showModal();
}
$('#zoneOk').addEventListener('click', () => {
  doc.zone = Number($('#zoneSel').value);
  updateZoneChip(); save();
  recomputeCal();
  $('#zoneDialog').close(); renderPanel(); draw();
});

let listGrp = '';
function renderList() {
  const all = doc.entities.filter((e) => e.type === 'point');
  const pts = listGrp ? all.filter((e) => grpOf(e) === listGrp) : all;
  document.querySelectorAll('#listFilter [data-grp]').forEach((b) => b.classList.toggle('active', b.dataset.grp === listGrp));
  $('#listInfo').textContent = `${pts.length} 点` + (listGrp ? `（全 ${all.length} 点）` : '') + (doc.zone ? ` ・ ${doc.zone}系` : '');
  $('#ptList').innerHTML = pts.length
    ? '<table><thead><tr><th>点名</th><th>X（北）</th><th>Y（東）</th></tr></thead><tbody>' +
      pts.map((e) => `<tr data-id="${e.id}"><td>${esc(e.name)}<span class="tag g-${grpOf(e)}">${grpOf(e).slice(0, 2)}</span></td><td class="num">${fmt(e.p.x)}</td><td class="num">${fmt(e.p.y)}</td></tr>`).join('') +
      '</tbody></table>'
    : '<p class="small">まだ点がありません。「点」ツールや GPS で追加できます。</p>';
}
$('#listFilter').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-grp]'); if (!b) return;
  listGrp = b.dataset.grp; renderList();
});
$('#ptList').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-id]'); if (!tr) return;
  const e = getEnt(Number(tr.dataset.id)); if (!e) return;
  $('#listSheet').close();
  setTool('select');
  selected = e.id; selPoint = null;
  centerOn(e.p, Math.max(view.s, 20)); renderPanel();
});

const actions = {
  new() {
    if (doc.entities.length && !confirm('今の図面を消して新規作成しますか？（必要なら先に保存してください）')) return;
    snapshot();
    Object.assign(doc, { name: '無題', entities: [], seq: 1, nextId: 1, pid: null, tomb: [], layers: [] });
    tracker.reset(doc);
    selected = null; selPoint = null; result = null; temp = [];
    updateTitle(); changed(); fitAll();
  },
  rename() {
    const n = prompt('図面の名前', doc.name);
    if (n != null && n.trim()) { doc.name = n.trim(); updateTitle(); save(); }
  },
  openDxf() { $('#fileDxf').click(); },
  openPts() { $('#filePts').click(); },
  openJson() { $('#fileJson').click(); },
  sendPc() { sendPc(); },
  recvPc() { $('#fileGcad').click(); },
  saveDxf() { download(safeName() + '.dxf', encodeSJIS(toDXF(exportEntities(), { layers: doc.layers, scaleN: doc.sheet?.scaleN || 100 })), 'application/dxf'); },
  openSima() { openSima(); },
  openSheet() { openSheet(true); },
  editText() {
    const e = getEnt(selected); if (!e) return;
    openTextDialog(e.type === 'leader' ? '引出線の文字' : '文字', e.text, e.hmm || 2.5, (text, hmm) => {
      snapshot(); e.text = text; e.hmm = hmm; changed();
    });
  },
  openFit() { openFit(); },
  openScale() { openScale(); },
  toolNige() { setTool('nige'); },
  nigeCornersSel() {
    const e = getEnt(selected); const ds = nigeDistances(); if (!e || !ds) return;
    const segs = baseSegments(e);
    snapshot();
    let n = 0;
    const verts = e.type === 'poly' ? e.pts : [e.a, e.b];
    for (const p of verts) n += nigeCorner(p, segs, ds);
    nigeDone(n, `全部の角（${verts.length}）`);
  },
  nigeExtSel() {
    const e = getEnt(selected); const ds = nigeDistances(); if (!e || !ds || e.type !== 'line') return;
    snapshot();
    nigeDone(nigeExt(e.a, e.b, ds), '線の延長');
  },
  saveCsv() {
    const pts = pointList(); if (!pts.length) { toast('点がありません'); return; }
    download(safeName() + '.csv', toCSV(pts, doc.zone), 'text/csv');
  },
  saveJson() { save(); download(safeName() + EXT, JSON.stringify(packProject(doc, 'mobile')), 'application/octet-stream'); },
  help() { $('#helpDialog').showModal(); },
  delete() {
    const e = getEnt(selected); if (!e) return;
    snapshot();
    doc.entities = doc.entities.filter((q) => q.id !== e.id);
    selected = null; selPoint = null; changed();
  },
  editPoint() { const e = getEnt(selected); if (e) openPointDialog(e); },
  regPoint() {
    if (!selPoint) return;
    const e = addEntity({ type: 'point', p: selPoint.p, name: nextPointName(), z: 0, grp: settings.ptGrp });
    selected = e.id; selPoint = null; toast(`${e.name} を登録しました`); changed();
  },
  regVerts() {
    const e = getEnt(selected); if (!e) return;
    const existing = doc.entities.filter((q) => q.type === 'point');
    const pts = verts(e).filter((p) => !existing.some((q) => dist(q.p, p) < 1e-4));
    if (!pts.length) { toast('すべて登録済みです'); return; }
    snapshot();
    for (const p of pts) addEntity({ type: 'point', p: { ...p }, name: nextPointName(), z: 0, grp: settings.ptGrp }, { snap: false });
    toast(`${pts.length} 点を登録しました`); changed();
  },
  keepDim() {
    if (!result || result.kind !== 'measure') return;
    addEntity({ type: 'dim', a: result.pts[0], b: result.pts[1] });
    result = null; changed();
  },
  clearResult() { result = null; temp = []; updateCmd(); renderPanel(); draw(); },
  gpsAvg() {
    startAvg((r) => {
      const e = addEntity({ type: 'point', p: r.p, name: nextPointName(), z: 0, grp: 'その他', gps: { acc: r.acc, n: r.n } });
      toast(`${e.name} を登録（${r.n}回平均・精度目安 ±${fmt(r.acc, 1)}m）`);
      changed();
    }, '平均中');
  },
  gpsAdd() {
    if (!gps.fix) return;
    const e = addEntity({ type: 'point', p: { ...gps.fix.p }, name: nextPointName(), z: 0, grp: 'その他', gps: { acc: gps.fix.acc, n: 1 } });
    toast(`${e.name} を登録（精度目安 ±${fmt(gps.fix.acc, 1)}m）`); changed();
  },
  openCal() { openCal(); },
  openCalc() { renderNames(); calc.open(); },
  openReports() { renderReports(); $('#reportSheet').showModal(); },
  openLayers() { renderLayers(); $('#layerSheet').showModal(); },
  clearOverlay() { overlay = null; renderPanel(); draw(); },
  areaTable() { renderNames(); calc.openWith('area', { pts: '選択' }); },
  alignStation() {
    const e = getEnt(selected); if (!e) return;
    renderNames(); calc.open('station');
    const sel = document.querySelector('#calcBody [data-k="al"]'); if (sel) sel.value = String(e.id);
  },
  alignStakes() {
    const e = getEnt(selected); const g = e && alignGeom(e); if (!g || g.err) return;
    const st = alignStakes(g.al, { pitch: g.pitch, widths: e.widths || [] });
    addPoints([
      ...st.map((q) => ({ p: q.p, name: q.label ? `${q.station}(${q.label})` : q.station })),
      ...st.flatMap((q) => q.wp.map((w) => ({ p: w.p, name: `${q.station} ${w.w < 0 ? '左' : '右'}${Math.abs(w.w)}` }))),
    ]);
  },
  alignReport() {
    const e = getEnt(selected); const g = e && alignGeom(e); if (!g || g.err) return;
    const st = alignStakes(g.al, { pitch: g.pitch });
    addReport({
      title: `路線計算 ${e.name}`, time: new Date().toLocaleString('ja-JP'),
      inputs: [['BP・IP・EP', e.ips.map((q) => q.name || '').join(', ')], ['曲線半径', (e.radii || []).join(', ')], ['杭間隔', `${g.pitch} m`]],
      rows: [['路線延長', fmt(g.al.length) + ' m'], ...g.al.curves.map((c) => [c.name, `R=${c.R} IA=${toDMS(Math.abs(c.IA), 0)} TL=${fmt(c.TL)} CL=${fmt(c.CL)}`])],
      table: { head: ['測点', '追加距離', 'X', 'Y'], rows: st.map((q) => [q.station + (q.label ? ` ${q.label}` : ''), fmt(q.s), fmt(q.p.x), fmt(q.p.y)]) },
    });
  },
  exportReportsCsv() {
    if (!doc.reports.length) { toast('計算書がありません'); return; }
    download(safeName() + '_計算書.csv', reportsCSV(doc.reports), 'text/csv');
  },
  printReports() {
    if (!doc.reports.length) { toast('計算書がありません'); return; }
    $('#printArea').innerHTML = `<h1>${esc(doc.name)} 計算書</h1><p>${doc.zone ? `平面直角座標系 ${doc.zone}系　` : ''}出力 ${new Date().toLocaleString('ja-JP')}</p>` + doc.reports.map(reportHtml).join('');
    window.print();
  },
  clearReports() {
    if (!doc.reports.length || !confirm('計算書をすべて削除しますか？')) return;
    doc.reports = []; save(); renderReports();
  },
};

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-act]');
  if (a) {
    const sheet = a.closest('#menu');
    if (sheet) sheet.close();
    actions[a.dataset.act]?.();
    return;
  }
  const c = ev.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
});
// シートの外側（背景）タップで閉じる
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (ev) => {
  if (ev.target !== d) return;
  const r = d.getBoundingClientRect();
  if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) d.close();
}));

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  setTool(t === 'line' ? settings.lineKind || 'line' : t === 'measure' ? settings.measKind || 'measure' : t);
}));
$('#kindSel').addEventListener('change', () => { setTool($('#kindSel').value); saveSettings(); });
$('#btnGps').addEventListener('click', toggleGps);
$('#btnUndo').addEventListener('click', undo);
$('#btnCalc').addEventListener('click', () => actions.openCalc());
$('#btnFit').addEventListener('click', fitAll);
$('#btnGoGps').addEventListener('click', () => gps.fix && centerOn(gps.fix.p, Math.max(view.s, 5)));
$('#btnMenu').addEventListener('click', () => $('#menu').showModal());
$('#btnList').addEventListener('click', () => { renderList(); $('#listSheet').showModal(); });
$('#btnZone').addEventListener('click', openZoneDialog);
$('#cmdOk').addEventListener('click', submitCmd);
$('#cmd').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitCmd(); } });
$('#cmdDone').addEventListener('click', finish);
$('#cmdClose').addEventListener('click', closeLine);
$('#cmdUndoPt').addEventListener('click', () => { if (result) { result = null; } else temp.pop(); updateCmd(); renderPanel(); draw(); });

// 図から点を選ぶ
function pick(cb, multi, done, opt = {}) {
  picker = { cb, multi, done, count: 0, ...opt };
  $('#pickMsg').textContent = opt.msg || (multi ? '点を順にタップ → 完了' : '図面上の点をタップ');
  $('#pickDone').hidden = !multi || !!opt.max;
  $('#pickBar').hidden = false;
}
function endPick() {
  const d = picker && picker.done;
  picker = null;
  $('#pickBar').hidden = true;
  // タップの後に届く click が、開き直したダイアログのボタンに当たらないよう少し待つ
  if (d) setTimeout(d, 350);
}
$('#pickDone').addEventListener('click', endPick);
$('#pickCancel').addEventListener('click', endPick);

// 点名の候補（入力補完）
function renderNames() {
  $('#ptNames').innerHTML = doc.entities.filter((e) => e.type === 'point').map((e) => `<option value="${esc(e.name)}">`).join('');
}

// 計算から呼ぶ機能
function resolvePt(str) {
  const s = String(str).trim();
  const pts = doc.entities.filter((e) => e.type === 'point');
  const pe = pts.find((e) => e.name === s) || pts.find((e) => e.name.toLowerCase() === s.toLowerCase());
  if (pe) return { p: { ...pe.p }, z: pe.z || 0, label: pe.name };
  if (/^(gps|現在地)$/i.test(s)) {
    if (!gps.fix) throw new Error('GPS が測位されていません');
    return { p: { ...gps.fix.p }, z: 0, label: '現在地' };
  }
  const m = s.replace(/[，、]/g, ',').split(',').map((t) => Number(t.trim()));
  if (m.length === 2 && m.every(Number.isFinite)) return { p: { x: m[0], y: m[1] }, z: 0, label: `(${fmt(m[0])},${fmt(m[1])})` };
  throw new Error(`点「${s}」が見つかりません`);
}
function addPoints(list) {
  if (!list.length) return;
  snapshot();
  let first = null;
  for (const q of list) {
    const e = addEntity({ type: 'point', p: { x: q.p.x, y: q.p.y }, z: q.z || 0, name: uniqueName(q.name || nextPointName()), grp: q.grp || 'その他' }, { snap: false });
    first = first || e;
  }
  toast(list.length === 1 ? `${first.name} を登録しました` : `${list.length} 点を登録しました`);
  renderNames(); changed();
}
function addReport(r) {
  doc.reports.push({ ...r, id: Date.now() });
  save();
  toast('計算書に追加しました（メニュー → 計算書）');
}
function setOverlay(ov) { overlay = ov; draw(); }
function showOverlay(ov) {
  overlay = ov;
  const pts = [...(ov.lines || []).flat(), ...(ov.pts || []).map((q) => q.p)];
  if (ov.align) { const g = alignGeom(ov.align); if (g.poly) pts.push(...g.poly); }
  if (pts.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    view.x = (minX + maxX) / 2; view.y = (minY + maxY) / 2;
    view.s = Math.min(400, (W - 80) / Math.max(maxY - minY, 1e-3), (H - 80) / Math.max(maxX - minX, 1e-3));
  }
  setTool('select');
  renderPanel(); draw();
}
const calc = initCalc({
  resolve: resolvePt,
  allPoints: (grp) => doc.entities.filter((e) => e.type === 'point' && visible(e) && (!grp || grpOf(e) === grp)).map((e) => ({ p: { ...e.p }, z: e.z || 0, label: e.name })),
  selectedVerts: () => {
    const e = getEnt(selected);
    if (!e || e.type !== 'poly') return null;
    const pts = doc.entities.filter((q) => q.type === 'point');
    return e.pts.map((p, i) => {
      const n = pts.find((q) => dist(q.p, p) < 1e-4);
      return { p: { ...p }, z: 0, label: n ? n.name : `V${i + 1}` };
    });
  },
  nextName: () => nextPointName(true),
  nextAlignName: () => `路線${doc.entities.filter((e) => e.type === 'align').length + 1}`,
  addPoints,
  addArea: (pts) => { const e = addEntity({ type: 'poly', pts: pts.map((p) => ({ ...p })), closed: true, area: true }); toast('面積図形を追加しました'); changed(); return e; },
  addAlign: (ent) => {
    const e = addEntity(JSON.parse(JSON.stringify(ent)));
    toast(`路線「${e.name}」を追加しました`);
    overlay = null; changed();
  },
  aligns: () => doc.entities.filter((e) => e.type === 'align'),
  alignGeom: (e) => { const g = alignGeom(e); if (g.err) throw new Error(g.err); return g.al; },
  addReport,
  setOverlay,
  showOverlay,
  pick,
});

// 画層
function renderLayers() {
  const counts = new Map();
  for (const e of doc.entities) counts.set(layerOf(e), (counts.get(layerOf(e)) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  $('#layerList').innerHTML = names.length
    ? names.map((n) => `<label class="toggle"><input type="checkbox" data-layer="${esc(n)}" ${doc.hiddenLayers.includes(n) ? '' : 'checked'}> ${esc(n)} <span class="small">（${counts.get(n)}）</span></label>`).join('')
    : '<p class="small">図形がありません。</p>';
}
$('#layerList').addEventListener('change', (ev) => {
  const n = ev.target.dataset.layer; if (n == null) return;
  doc.hiddenLayers = doc.hiddenLayers.filter((q) => q !== n);
  if (!ev.target.checked) doc.hiddenLayers.push(n);
  const e = getEnt(selected); if (e && !visible(e)) selected = null;
  save(); renderPanel(); draw();
});
$('#layerAll').addEventListener('click', () => { doc.hiddenLayers = []; save(); renderLayers(); draw(); });

// 計算書
function renderReports() {
  $('#reportList').innerHTML = doc.reports.length
    ? doc.reports.map((r, i) => `<div class="report-wrap">${reportHtml(r)}<button class="btn small-btn danger" data-repdel="${i}">削除</button></div>`).join('')
    : '<p class="small">まだ計算書がありません。計算の結果画面で「計算書に追加」を押すと、ここに溜まります。</p>';
}
$('#reportList').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-repdel]'); if (!b) return;
  doc.reports.splice(Number(b.dataset.repdel), 1); save(); renderReports();
});

// 基準点補正ダイアログ
$('#calMode').addEventListener('change', () => { doc.gpsCal.mode = $('#calMode').value; recomputeCal(); save(); renderCal(); renderPanel(); draw(); });
$('#calPairs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-caldel]'); if (!b) return;
  doc.gpsCal.pairs.splice(Number(b.dataset.caldel), 1); recomputeCal(); save(); renderCal(); renderPanel(); draw();
});
$('#calPick').addEventListener('click', () => {
  $('#calDialog').close();
  pick((v) => { $('#calPt').value = v; }, false, () => { renderCal(); $('#calDialog').showModal(); });
});
$('#calAdd').addEventListener('click', () => {
  let ref;
  try { ref = resolvePt($('#calPt').value); } catch (err) { toast(err.message); return; }
  if (!gps.fix) { toast('GPS を ON にして測位を待ってください'); return; }
  $('#calDialog').close();
  startAvg((r) => {
    doc.gpsCal.pairs = doc.gpsCal.pairs.filter((q) => !(q.name === ref.label && q.zone === doc.zone));
    doc.gpsCal.pairs.push({ name: ref.label, dst: ref.p, src: r.raw, zone: doc.zone, acc: r.acc });
    recomputeCal(); save();
    gps.follow = true; // 補正後の現在地へ画面を移動
    toast(`基準点 ${ref.label} で補正しました`);
    renderPanel(); draw(); renderCal(); $('#calDialog').showModal();
  }, `基準点 ${ref.label} 取得中`);
});
$('#calClear').addEventListener('click', () => {
  if (!doc.gpsCal.pairs.length || !confirm('基準点補正をすべて解除しますか？')) return;
  doc.gpsCal.pairs = []; recomputeCal(); save(); renderCal(); renderPanel(); draw();
});

// ---------- SIMA 出力 ----------
function simaData() {
  const groups = [...document.querySelectorAll('#simaGroups input:checked')].map((i) => i.value);
  const ents = doc.entities.filter((e) => e.type === 'point' && groups.includes(grpOf(e)));
  const pts = ents.map((e) => ({ name: e.name, x: e.p.x, y: e.p.y, z: e.z || 0 }));
  const areas = [];
  if ($('#simaArea').checked) {
    let k = 0;
    for (const e of doc.entities) {
      if (e.type !== 'poly' || !e.closed || e.layer === '逃げ' || !visible(e)) continue;
      k++;
      const idx = e.pts.map((p, i) => {
        let j = pts.findIndex((q) => Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS);
        if (j < 0) { pts.push({ name: `区画${k}-${i + 1}`, x: p.x, y: p.y, z: 0 }); j = pts.length - 1; }
        return j;
      });
      areas.push({ name: `区画${k}`, idx });
    }
  }
  return { pts, areas };
}
function updateSimaInfo() {
  const { pts, areas } = simaData();
  $('#simaInfo').textContent = `${pts.length} 点` + (areas.length ? `・区画 ${areas.length}` : '') + ' を Shift_JIS で書き出します。';
}
function openSima() {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  for (const e of doc.entities) if (e.type === 'point') counts[grpOf(e)]++;
  $('#simaGroups').innerHTML = GROUPS.map((g) => `<label class="toggle"><input type="checkbox" value="${g}" ${counts[g] ? 'checked' : ''}> <span class="tag g-${g}">${g}</span> ${counts[g]} 点</label>`).join('');
  $('#simaName').value = safeName();
  $('#simaShare').hidden = !(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.sim', { type: 'text/plain' })] }));
  updateSimaInfo();
  $('#simaDialog').showModal();
}
function simaFile() {
  const { pts, areas } = simaData();
  if (!pts.length) { toast('書き出す点がありません'); return null; }
  const name = ($('#simaName').value.trim() || safeName()).replace(/[\\/:*?"<>|]/g, '_').replace(/\.sim$/i, '') + '.sim';
  return new File([encodeSJIS(toSIMA(pts, doc.name, areas))], name, { type: 'text/plain' });
}
$('#simaGroups').addEventListener('change', updateSimaInfo);
$('#simaArea').addEventListener('change', updateSimaInfo);
$('#simaSave').addEventListener('click', () => { const f = simaFile(); if (f) { download(f.name, f); toast(`${f.name} を保存しました`); } });
$('#simaShare').addEventListener('click', async () => {
  const f = simaFile(); if (!f) return;
  try { await navigator.share({ files: [f], title: f.name }); } catch (err) { if (err.name !== 'AbortError') toast('共有できませんでした: ' + err.message); }
});

// ---------- 図面の位置合わせ ----------
const fitState = [{ src: '', dst: '' }, { src: '', dst: '' }];
function renderFit() {
  $('#fitPairs').innerHTML = fitState.map((q, i) => `
    <div class="fit-pair"><h4>${i + 1}組目${i ? '（向きを合わせる）' : '（移動の基準）'}</h4>
      <label class="field"><span>図面上の点</span><div class="in"><input data-fit="${i}" data-side="src" value="${esc(q.src)}" list="ptNames" autocomplete="off" autocapitalize="off" placeholder="点名 / X,Y"><button class="pick" data-fpick="${i}" data-side="src">📍</button></div></label>
      <label class="field"><span>現場の点（座標が分かっている点・GPS）</span><div class="in"><input data-fit="${i}" data-side="dst" value="${esc(q.dst)}" list="ptNames" autocomplete="off" autocapitalize="off" placeholder="点名 / X,Y / GPS"><button class="pick" data-fpick="${i}" data-side="dst">📍</button></div></label>
    </div>`).join('');
}
function fitCompute() {
  const pairs = [];
  for (const q of fitState) {
    if (!q.src.trim() && !q.dst.trim()) continue;
    if (!q.src.trim() || !q.dst.trim()) throw new Error('図面上の点と現場の点を組で入力してください');
    pairs.push({ src: resolvePt(q.src).p, dst: resolvePt(q.dst).p, sl: q.src, dl: q.dst });
  }
  if (!pairs.length) throw new Error('1組以上入力してください');
  const tf = fitTransform(pairs, pairs.length < 2 ? 'shift' : $('#fitScale').checked ? 'helmert' : 'rigid');
  const shift = applyTransform(tf, pairs[0].src);
  let html = `1組目の移動量：ΔX ${fmt(shift.x - pairs[0].src.x)} / ΔY ${fmt(shift.y - pairs[0].src.y)} m`;
  if (pairs.length >= 2) {
    const dS = dist(pairs[0].src, pairs[1].src), dD = dist(pairs[0].dst, pairs[1].dst);
    html += `<br>回転：${toDMS(tf.rot, 1)}${$('#fitScale').checked ? `・縮尺 ${tf.scale.toFixed(6)}` : ''}`;
    html += `<br>2点間の距離：図面 ${fmt(dS)} m ／ 現場 ${fmt(dD)} m（差 <b>${fmt(Math.round((dD - dS) * 1000) || 0, 0)} mm</b>）`;
    html += `<br>合わせた後のずれ：${tf.residuals.map((r, i) => `${i + 1}組目 ${fmt(Math.round(r.d * 1000) || 0, 0)} mm`).join('・')}`;
  }
  return { tf, html };
}
function openFit() { renderNames(); renderFit(); $('#fitResult').innerHTML = ''; $('#fitDialog').showModal(); }
$('#fitPairs').addEventListener('input', (ev) => {
  const i = ev.target.dataset.fit; if (i == null) return;
  fitState[Number(i)][ev.target.dataset.side] = ev.target.value;
});
$('#fitPairs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-fpick]'); if (!b) return;
  ev.preventDefault();
  const i = Number(b.dataset.fpick), side = b.dataset.side;
  $('#fitDialog').close();
  pick((v) => { fitState[i][side] = v; }, false, () => { renderFit(); $('#fitDialog').showModal(); });
});
$('#fitCheck').addEventListener('click', () => {
  try { $('#fitResult').innerHTML = fitCompute().html; } catch (err) { $('#fitResult').innerHTML = `<span class="err">${esc(err.message)}</span>`; }
});
$('#fitApply').addEventListener('click', () => {
  let r;
  try { r = fitCompute(); } catch (err) { $('#fitResult').innerHTML = `<span class="err">${esc(err.message)}</span>`; return; }
  snapshot();
  let n = 0;
  for (const e of doc.entities) {
    if (e.type === 'point' && (grpOf(e) === '基準点' || e.gps)) continue;
    transformEntity(e, r.tf); n++;
  }
  // 形状キャッシュはオブジェクト単位なので、路線は作り直す
  doc.entities = doc.entities.map((e) => (e.type === 'align' ? { ...e } : e));
  fitState.forEach((q) => { q.src = ''; q.dst = ''; });
  $('#fitDialog').close();
  changed(); fitAll();
  toast(`図面を現場の座標に合わせました（${n} 個の図形・元に戻す可）`);
});

$('#fitToScale').addEventListener('click', (ev) => { ev.preventDefault(); $('#fitDialog').close(); openScale(); });

// ---------- 縮尺合わせ（寸法で） ----------
const scState = { mode: 'pts', a: '', b: '', ent: null, real: '', unit: '', pairs: [{ src: '', dst: '' }, { src: '', dst: '' }] };
const simaPts = () => doc.entities.filter((e) => e.type === 'point' && grpOf(e) === '基準点');
/** 文字の数値と単位（小数点がなければ mm とみなす: 5,000 → 5000 mm、5.000 → 5 m） */
function lengthFromText(t) {
  const m = String(t ?? '').replace(/[,，\s]/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  return { v: m[0], unit: m[0].includes('.') ? 'm' : 'mm' };
}
const scTarget = (e) => !(e.type === 'point' && (grpOf(e) === '基準点' || e.gps));
function renderScale() {
  document.querySelectorAll('#scMode [data-scmode]').forEach((b) => b.classList.toggle('active', b.dataset.scmode === scState.mode));
  $('#scPts').hidden = scState.mode !== 'pts';
  $('#scDim').hidden = scState.mode !== 'dim';
  $('#scCoord').hidden = scState.mode !== 'coord';
  $('#scRealRow').hidden = scState.mode === 'coord';
  if (scState.mode === 'coord') renderScPairs();
  $('#scPts').innerHTML = [['a', '1点目（動かない基準点）'], ['b', '2点目']].map(([k, l]) => `
    <label class="field"><span>${l}</span><div class="in"><input data-sc="${k}" value="${esc(scState[k])}" list="ptNames" autocomplete="off" autocapitalize="off" placeholder="点名 / X,Y"><button class="pick" data-scpick="${k}">📍</button></div></label>`).join('');
  const e = scState.ent != null ? getEnt(scState.ent) : null;
  $('#scDimInfo').innerHTML = e ? `選んだ${{ dim: '寸法線', line: '線' }[e.type] || '図形'}：今の長さ <b>${fmt(dist(e.a, e.b))} m</b>${e.txt ? `（寸法値「${esc(e.txt)}」）` : ''}` : 'まだ選んでいません';
  $('#scReal').value = scState.real;
  $('#scUnit').value = scState.unit || (settings.dimUnit === 'mm' ? 'mm' : 'm');
}
function renderScPairs() {
  const sp = simaPts();
  if (!sp.length) {
    $('#scPairs').innerHTML = '<p class="small err">「基準点」の点がありません。先に ☰ →「座標を読み込む（SIMA）」で SIMA を読み込んでください。</p><button class="btn wide" id="scLoadSima">SIMA を読み込む</button>';
    $('#scAddPair').hidden = true;
    return;
  }
  $('#scAddPair').hidden = scState.pairs.length >= 8;
  const opts = (v) => '<option value="">― 選ぶ ―</option>' + sp.map((e) => `<option value="${esc(e.name)}" ${e.name === v ? 'selected' : ''}>${esc(e.name)}（${fmt(e.p.x)}, ${fmt(e.p.y)}）</option>`).join('');
  $('#scPairs').innerHTML = scState.pairs.map((q, i) => `
    <div class="fit-pair"><h4>${i + 1}組目${i > 1 ? ` <button class="link-btn" data-scdel="${i}">削除</button>` : ''}</h4>
      <label class="field"><span>図面上の点</span><div class="in"><input data-scp="${i}" value="${esc(q.src)}" list="ptNames" autocomplete="off" autocapitalize="off" placeholder="📍で図面をタップ"><button class="pick" data-scppick="${i}">📍</button></div></label>
      <label class="field"><span>SIMA の点（正しい座標）</span><div class="in"><select data-scd="${i}" class="sc-sel">${opts(q.dst)}</select><button class="pick" data-scdpick="${i}">📍</button></div></label>
    </div>`).join('');
}
function scCoordCompute() {
  const pairs = [];
  scState.pairs.forEach((q, i) => {
    if (!q.src.trim() && !q.dst) return;
    if (!q.src.trim() || !q.dst) throw new Error(`${i + 1}組目：図面上の点と SIMA の点を両方指定してください`);
    pairs.push({ src: resolvePt(q.src).p, dst: resolvePt(q.dst).p, dl: q.dst });
  });
  if (pairs.length < 2) throw new Error('縮尺を求めるには2組以上必要です');
  if (dist(pairs[0].src, pairs[1].src) < 1e-9) throw new Error('図面上の点が同じ位置です');
  let tf;
  if ($('#scRot').checked) tf = fitTransform(pairs, 'helmert');
  else {
    // 回転しない: 縮尺と移動だけ（最小二乗）
    const n = pairs.length, sc = { x: 0, y: 0 }, dc = { x: 0, y: 0 };
    for (const q of pairs) { sc.x += q.src.x / n; sc.y += q.src.y / n; dc.x += q.dst.x / n; dc.y += q.dst.y / n; }
    let num = 0, den = 0;
    for (const q of pairs) { const sx = q.src.x - sc.x, sy = q.src.y - sc.y; num += sx * (q.dst.x - dc.x) + sy * (q.dst.y - dc.y); den += sx * sx + sy * sy; }
    const k = num / den;
    tf = { a: k, b: 0, tx: dc.x - k * sc.x, ty: dc.y - k * sc.y, scale: k, rot: 0 };
    tf.residuals = pairs.map((q) => { const p = applyTransform(tf, q.src); return { d: dist(p, q.dst) }; });
  }
  const dS = dist(pairs[0].src, pairs[1].src), dD = dist(pairs[0].dst, pairs[1].dst);
  const html = `1組目〜2組目の距離：図面 ${fmt(dS)} m → SIMA ${fmt(dD)} m<br>倍率 <b>${tf.scale.toFixed(6)}</b>` +
    (Math.abs(tf.scale - 0.001) < 1e-5 ? '（mm で描かれた図面を m に直します）' : '') +
    ($('#scRot').checked ? `・回転 ${toDMS(Math.abs(tf.rot), 1)} ${tf.rot >= 0 ? '右回り' : '左回り'}` : '') +
    `<br>合わせた後のずれ：${tf.residuals.map((r, i) => `${i + 1}組目 ${fmt(Math.round(r.d * 1000) || 0, 0)} mm`).join('・')}` +
    `<br>${doc.entities.filter(scTarget).length} 個の図形が対象（基準点は動きません）`;
  const worst = Math.max(...tf.residuals.map((r) => r.d));
  const warn = worst > Math.max(0.05, dD * 0.01)
    ? `<br><span class="err">ずれが大きすぎます（最大 ${fmt(worst)} m）。${$('#scRot').checked ? '組の対応（図面の点と SIMA の点）が合っているか確かめてください' : '図面の向きが違うようです。「向きと位置も合わせる」をオンにしてください'}</span>` : '';
  return { tf, html: html + warn };
}
function scaleCompute() {
  if (scState.mode === 'coord') return scCoordCompute();
  let base, L;
  if (scState.mode === 'pts') {
    if (!scState.a.trim() || !scState.b.trim()) throw new Error('長さの両端の2点を入力してください');
    const A = resolvePt(scState.a).p, B = resolvePt(scState.b).p;
    base = A; L = dist(A, B);
  } else {
    const e = scState.ent != null ? getEnt(scState.ent) : null;
    if (!e) throw new Error('寸法線か線を選んでください');
    base = e.pa || e.a; L = dist(e.a, e.b);
  }
  if (!(L > 1e-9)) throw new Error('2点が同じ位置です');
  const v = Number(String(scState.real).replace(/[,，\s]/g, ''));
  if (!(v > 0)) throw new Error('正しい長さを入力してください');
  const unit = $('#scUnit').value;
  const R = unit === 'mm' ? v / 1000 : v;
  const k = R / L;
  const html = `今の長さ ${fmt(L)} m → 正しい長さ ${fmt(R)} m<br>倍率 <b>${k.toFixed(6)}</b>` +
    (Math.abs(k - 0.001) < 1e-7 ? '（mm で描かれた図面を m に直します）' : '') +
    `<br>${doc.entities.filter(scTarget).length} 個の図形が対象`;
  return { base, k, L, R, html };
}
function openScale() {
  renderNames();
  if (!scState.unit) scState.unit = settings.dimUnit === 'mm' ? 'mm' : 'm';
  // 選択中の寸法線・線があれば使う
  const sel = getEnt(selected);
  if (scState.mode !== 'coord' && sel && (sel.type === 'dim' || sel.type === 'line')) { scState.mode = 'dim'; scState.ent = sel.id; const t = lengthFromText(sel.txt); if (t) { scState.real = t.v; scState.unit = t.unit; } }
  renderScale();
  $('#scResult').innerHTML = '';
  $('#scaleDialog').showModal();
}
$('#scMode').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-scmode]'); if (!b) return;
  scState.mode = b.dataset.scmode; renderScale(); $('#scResult').innerHTML = '';
});
$('#scPts').addEventListener('input', (ev) => { const k = ev.target.dataset.sc; if (k) scState[k] = ev.target.value; });
$('#scReal').addEventListener('input', (ev) => { scState.real = ev.target.value; });
$('#scUnit').addEventListener('change', (ev) => { scState.unit = ev.target.value; });
$('#scPts').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-scpick]'); if (!b) return;
  ev.preventDefault();
  const k = b.dataset.scpick;
  $('#scaleDialog').close();
  pick((v) => { scState[k] = v; }, false, () => { renderScale(); $('#scaleDialog').showModal(); }, { msg: k === 'a' ? '長さの1点目（動かない点）をタップ' : '長さの2点目をタップ' });
});
$('#scPickDim').addEventListener('click', (ev) => {
  ev.preventDefault();
  $('#scaleDialog').close();
  pick((e) => {
    if (e.type === 'text') {
      // 数字の文字: 値を正しい長さに入れて、2点の指定へ
      const t = lengthFromText(e.text);
      if (t) { scState.real = t.v; scState.unit = t.unit; }
      scState.mode = 'pts';
      toast(`「${e.text}」を正しい長さに入れました。長さの両端の2点を指定してください`);
      return;
    }
    scState.ent = e.id;
    const t = lengthFromText(e.txt);
    if (t) { scState.real = t.v; scState.unit = t.unit; }
  }, false, () => { renderScale(); $('#scaleDialog').showModal(); }, {
    ent: true, msg: '寸法線・線、または寸法値の文字をタップ', miss: '寸法線・線・数字の文字が見つかりません',
    filter: (e) => e.type === 'dim' || e.type === 'line' || (e.type === 'text' && !!lengthFromText(e.text)),
  });
});
$('#scCheck').addEventListener('click', () => {
  try { $('#scResult').innerHTML = scaleCompute().html; } catch (err) { $('#scResult').innerHTML = `<span class="err">${esc(err.message)}</span>`; }
});
$('#scApply').addEventListener('click', () => {
  let r;
  try { r = scaleCompute(); } catch (err) { $('#scResult').innerHTML = `<span class="err">${esc(err.message)}</span>`; return; }
  snapshot();
  const tf = r.tf || { a: r.k, b: 0, tx: r.base.x * (1 - r.k), ty: r.base.y * (1 - r.k), scale: r.k };
  let n = 0;
  for (const e of doc.entities) { if (!scTarget(e)) continue; transformEntity(e, tf); n++; }
  doc.entities = doc.entities.map((e) => (e.type === 'align' ? { ...e } : e)); // 路線の形状を作り直す
  Object.assign(scState, { a: '', b: '', ent: null, real: '', pairs: [{ src: '', dst: '' }, { src: '', dst: '' }] });
  $('#scaleDialog').close();
  changed(); fitAll();
  toast(`倍率 ${tf.scale.toFixed(6)} で縮尺を合わせました（${n} 個の図形・元に戻す可）`);
});
$('#scCoord').addEventListener('input', (ev) => { const i = ev.target.dataset.scp; if (i != null) scState.pairs[Number(i)].src = ev.target.value; });
$('#scCoord').addEventListener('change', (ev) => { const i = ev.target.dataset.scd; if (i != null) scState.pairs[Number(i)].dst = ev.target.value; });
$('#scCoord').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-scppick],[data-scdpick],[data-scdel],#scLoadSima,#scAddPair'); if (!t) return;
  ev.preventDefault();
  if (t.id === 'scLoadSima') { $('#scaleDialog').close(); scAfterSima = true; $('#filePts').click(); return; }
  if (t.id === 'scAddPair') { scState.pairs.push({ src: '', dst: '' }); renderScPairs(); return; }
  if (t.dataset.scdel != null) { scState.pairs.splice(Number(t.dataset.scdel), 1); renderScPairs(); return; }
  const back = () => { renderScale(); $('#scaleDialog').showModal(); };
  $('#scaleDialog').close();
  if (t.dataset.scppick != null) {
    const i = Number(t.dataset.scppick);
    pick((v) => { scState.pairs[i].src = v; }, false, back, { msg: `${i + 1}組目：図面上の点（建物の角・杭など）をタップ` });
  } else {
    const i = Number(t.dataset.scdpick);
    pick((e) => { scState.pairs[i].dst = e.name; }, false, back, {
      ent: true, msg: `${i + 1}組目：対応する SIMA の点（基準点）をタップ`, miss: '基準点が見つかりません',
      filter: (e) => e.type === 'point' && grpOf(e) === '基準点',
    });
  }
});
/** 座標で縮尺合わせ（SIMA 取り込み直後の案内からも使う） */
function openScaleCoord() { scState.mode = 'coord'; openScale(); }
$('#scToFit').addEventListener('click', (ev) => { ev.preventDefault(); $('#scaleDialog').close(); $('#fitScale').checked = true; openFit(); });

// ---------- 施工図 ----------
function sheetCfg() {
  if (!doc.sheet) doc.sheet = defaultSheet(doc.name);
  return doc.sheet;
}
const layerStyle = (e) => (doc.layers || []).find((l) => l.name === e.layer) || {};
const sheetData = () => ({
  entities: doc.entities.filter(visible), alignGeom, grpOf, zone: doc.zone, unit: settings.dimUnit,
  style: (e) => { const L = layerStyle(e); return { color: e.color || L.color, lw: e.lw || L.lw, ltype: e.ltype || L.ltype }; },
});
function rangeFromView(cfg) { fitRange(cfg, (cfg.rangePts = [toW(0, 0), toW(W, 0), toW(0, H), toW(W, H)])); }
function setRange(cfg, pts) { if (!pts.length) { toast('範囲にする図形がありません'); return false; } cfg.rangePts = pts.map((p) => ({ x: p.x, y: p.y })); fitRange(cfg, cfg.rangePts); return true; }
function entityExtent(e) {
  if (e.type === 'circle' || e.type === 'arc') return [{ x: e.c.x - e.r, y: e.c.y - e.r }, { x: e.c.x + e.r, y: e.c.y + e.r }];
  if (e.type === 'align') return alignGeom(e).poly || [];
  if (e.type === 'dim') { const g = dimGeom(e); return [e.a, e.b, g.a2, g.b2]; }
  return verts(e);
}
function openSheet(resetRange) {
  const cfg = sheetCfg();
  if (resetRange || !cfg.center) rangeFromView(cfg);
  if (!cfg.koji) cfg.koji = doc.name;
  $('#shShare').hidden = !(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] }));
  fillSheetForm();
  $('#sheetDialog').showModal();
  renderSheetPreview();
}
function fillSheetForm() {
  const cfg = sheetCfg();
  $('#shScale').innerHTML = `<option value="auto">自動</option>` + SCALES.map((k) => `<option value="${k}">1 : ${k}</option>`).join('');
  $('#shPaper').value = cfg.paper; $('#shOrient').value = cfg.orient; $('#shScale').value = String(cfg.scale);
  $('#shRot').value = String(+(cfg.rot || 0).toFixed(4));
  $('#shKoji').value = cfg.koji || ''; $('#shTitle').value = cfg.title || ''; $('#shAuthor').value = cfg.author || '';
  $('#shTable').checked = cfg.table; $('#shLen').checked = cfg.len; $('#shGrid').checked = cfg.grid;
  $('#shGroups').innerHTML = GROUPS.map((g) => `<label><input type="checkbox" value="${g}" ${cfg.groups.includes(g) ? 'checked' : ''}> <span class="tag g-${g}">${g}</span></label>`).join('');
  $('#shGroups').hidden = !cfg.table;
}
function readSheetForm() {
  const cfg = sheetCfg();
  const oldRot = cfg.rot;
  cfg.paper = $('#shPaper').value; cfg.orient = $('#shOrient').value; cfg.scale = $('#shScale').value;
  const r = Number($('#shRot').value);
  cfg.rot = Number.isFinite(r) ? r : 0;
  cfg.koji = $('#shKoji').value; cfg.title = $('#shTitle').value; cfg.author = $('#shAuthor').value;
  cfg.table = $('#shTable').checked; cfg.len = $('#shLen').checked; cfg.grid = $('#shGrid').checked;
  cfg.groups = [...document.querySelectorAll('#shGroups input:checked')].map((i) => i.value);
  $('#shGroups').hidden = !cfg.table;
  if (cfg.rot !== oldRot && cfg.rangePts) fitRange(cfg, cfg.rangePts);
}
let sheetTimer = null;
function renderSheetPreview() {
  const cfg = sheetCfg();
  autoScale(cfg);
  const cvs = $('#sheetCv');
  const L = sheetLayout(cfg);
  const wpx = Math.max(200, cvs.parentElement.clientWidth - 16);
  renderSheet(cvs, cfg, sheetData(), Math.min(6, (wpx * (window.devicePixelRatio || 1)) / L.W));
  const X = makeXf(cfg, L);
  const info = sheetInfo(cfg, L, X, sheetData());
  $('#sheetInfo').textContent = `${cfg.paper}・${cfg.orient === 'portrait' ? '縦' : '横'}・縮尺 1:${cfg.scaleN}${cfg.scale === 'auto' ? '（自動）' : ''}・座標表 ${info.tablePts.length} 点`;
  save();
}
function scheduleSheet() { clearTimeout(sheetTimer); sheetTimer = setTimeout(() => { readSheetForm(); renderSheetPreview(); }, 120); }
$('#sheetDialog').addEventListener('input', (ev) => { if (ev.target.closest('.form')) scheduleSheet(); });
$('#sheetDialog').addEventListener('change', (ev) => { if (ev.target.closest('.form')) scheduleSheet(); });
$('#shRangeView').addEventListener('click', () => {
  // ダイアログの裏の画面（今の表示範囲）
  rangeFromView(sheetCfg()); renderSheetPreview();
});
$('#shRangeAll').addEventListener('click', () => {
  const pts = doc.entities.filter(visible).flatMap(entityExtent);
  if (setRange(sheetCfg(), pts)) renderSheetPreview();
});
$('#shRangeSel').addEventListener('click', () => {
  const e = getEnt(selected);
  if (!e) { toast('先に「選択」ツールで図形を選んでください'); return; }
  if (setRange(sheetCfg(), entityExtent(e))) renderSheetPreview();
});
$('#shRangePick').addEventListener('click', () => {
  const pts = [];
  $('#sheetDialog').close();
  pick((p) => pts.push(p), true, () => {
    if (pts.length === 2) setRange(sheetCfg(), pts);
    openSheet(false);
  }, { raw: true, max: 2, msg: '施工図にする範囲の角を2点タップ' });
});
$('#shRotSel').addEventListener('click', () => {
  const e = getEnt(selected);
  let seg = null;
  if (e && (e.type === 'line' || e.type === 'dim')) seg = [e.a, e.b];
  else if (e && e.type === 'poly') {
    for (const [a, b] of segments(e)) if (!seg || dist(a, b) > dist(seg[0], seg[1])) seg = [a, b];
  }
  if (!seg) { toast('先に「選択」ツールで線か図形を選んでください'); return; }
  let az = azimuth(seg[0], seg[1]) % 180; // 上向きに近い方
  if (az > 90) az -= 180;
  $('#shRot').value = String(+az.toFixed(4));
  readSheetForm(); renderSheetPreview();
});
$('#shRot0').addEventListener('click', () => { $('#shRot').value = '0'; readSheetForm(); renderSheetPreview(); });

/** 出力用の高解像度キャンバス（端末のメモリに収まる解像度） */
function sheetCanvas() {
  const cfg = sheetCfg(); autoScale(cfg);
  const L = sheetLayout(cfg);
  const ppm = Math.min(300 / 25.4, Math.sqrt(12e6 / (L.W * L.H)));
  const c = document.createElement('canvas');
  renderSheet(c, cfg, sheetData(), ppm);
  return { c, L, cfg };
}
const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
const sheetFileName = (ext) => `${safeName()}_${(sheetCfg().title || '施工図').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
async function sheetPdf() {
  const { c, L } = sheetCanvas();
  const jpg = new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.92)).arrayBuffer());
  return new File([makePdf(jpg, c.width, c.height, L.W, L.H)], sheetFileName('pdf'), { type: 'application/pdf' });
}
$('#shPdf').addEventListener('click', async () => {
  const f = await sheetPdf(); download(f.name, f); toast(`${f.name} を保存しました`);
});
$('#shShare').addEventListener('click', async () => {
  const f = await sheetPdf();
  try { await navigator.share({ files: [f], title: f.name }); } catch (err) { if (err.name !== 'AbortError') toast('共有できませんでした: ' + err.message); }
});
$('#shPng').addEventListener('click', async () => {
  const { c } = sheetCanvas();
  const b = await toBlob(c, 'image/png');
  download(sheetFileName('png'), b); toast('画像を保存しました');
});
$('#shPrint').addEventListener('click', () => {
  const { c, L } = sheetCanvas();
  let st = document.getElementById('pageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
  st.textContent = `@page { size: ${L.W}mm ${L.H}mm; margin: 0; }`;
  $('#printArea').innerHTML = `<img src="${c.toDataURL('image/jpeg', 0.92)}" style="width:${L.W}mm;height:${L.H}mm">`;
  setTimeout(() => window.print(), 100);
});
$('#shDxf').addEventListener('click', () => {
  const cfg = sheetCfg(); autoScale(cfg);
  const { entities: frame, L, X } = sheetFrameEntities(cfg, sheetData());
  const ents = doc.entities.filter((e) => visible(e) && inViewport(e, L, X, entityExtent));
  const out = [...exportEntities(ents, cfg.scaleN, cfg.rot || 0), ...frame];
  download(sheetFileName('dxf'), encodeSJIS(toDXF(out)), 'application/dxf');
  toast(`DXF（縮尺 1:${cfg.scaleN}・${ents.length} 図形＋図枠）を保存しました`);
});
$('#btnSheet').addEventListener('click', () => openSheet(true));

// ---------- 点ツール・逃げツールの設定 ----------
$('#ptGrp').value = settings.ptGrp;
$('#ptGrp').addEventListener('change', () => { settings.ptGrp = $('#ptGrp').value; saveSettings(); });
$('#ptPrefix').value = settings.prefix || 'P';
$('#ptPrefix').addEventListener('change', () => { settings.prefix = $('#ptPrefix').value.trim() || 'P'; $('#optPrefix').value = settings.prefix; saveSettings(); });
$('#nigeMode').value = settings.nigeMode;
$('#nigeMode').addEventListener('change', () => { settings.nigeMode = $('#nigeMode').value; nigePending = null; selected = null; saveSettings(); updateCmd(); draw(); });
$('#nigeDist').value = settings.nigeDist;
$('#nigeDist').addEventListener('change', () => { settings.nigeDist = $('#nigeDist').value.trim() || '1'; saveSettings(); });

// 設定
$('#optDimUnit').value = settings.dimUnit;
$('#optDimUnit').addEventListener('change', () => { settings.dimUnit = $('#optDimUnit').value; saveSettings(); renderPanel(); draw(); });
$('#optPrefix').value = settings.prefix || 'P';
$('#optPrefix').addEventListener('change', () => { settings.prefix = $('#optPrefix').value.trim() || 'P'; $('#ptPrefix').value = settings.prefix; saveSettings(); });
const optMap = { optSnap: 'snap', optOnLine: 'onLine', optLen: 'showLen', optNames: 'showNames', optDark: 'dark', optStakes: 'stakes' };
for (const [id, key] of Object.entries(optMap)) {
  const el = document.getElementById(id);
  el.checked = !!settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); applyTheme(); draw(); });
}
function applyTheme() { document.documentElement.classList.toggle('dark', settings.dark); readColors(); }

// PC 用ショートカット
document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, select, textarea')) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
  else if (ev.key === 'Escape') { if (picker) { endPick(); return; } temp = []; result = null; updateCmd(); renderPanel(); draw(); }
  else if (ev.key === 'Delete' || ev.key === 'Backspace') actions.delete();
});

// ============================================================
// 起動
// ============================================================
load();
tracker.reset(doc);
recomputeCal();
applyTheme();
updateTitle();
updateZoneChip();
new ResizeObserver(resize).observe($('#stage'));
resize();
document.querySelectorAll('i[data-ic]').forEach((i) => { i.innerHTML = ICONS[i.dataset.ic] || ''; });
document.querySelectorAll('#menu .menu-group > button[data-act]').forEach((b) => {
  const MI = { new: 'new', rename: 'zone', sendPc: 'send', recvPc: 'recv', openFit: 'fit', openScale: 'scalefit', toolNige: 'nige', openSima: 'sima', openSheet: 'sheetdoc', openCalc: 'calc', openReports: 'report', openCal: 'gps', openLayers: 'layer', openDxf: 'import', openPts: 'sima', openJson: 'open', saveDxf: 'export', saveCsv: 'export', saveJson: 'save', help: 'help' };
  const ic = ICONS[MI[b.dataset.act]]; if (ic && !b.querySelector('svg')) b.insertAdjacentHTML('afterbegin', `<i class="mi">${ic}</i>`);
});
$('#emptyState').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-es]'); if (!b) return;
  const a = b.dataset.es;
  if (a === 'blank') { emptyOff = true; updateEmpty(); setTool('point'); toast('図面をタップすると点を置けます。下のボタンで道具を変えられます'); return; }
  actions[a]?.();
});
updateEmpty();

const APP_VERSION = 'v14（PC の画面移動を改善）';
$('#appVer').textContent = APP_VERSION;
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}

// テスト・デバッグ用
window.__genbacad = { doc, view, settings, setTool, place, parseCmd, actions, alignGeom, get calTf() { return calTf; } };
