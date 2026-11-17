import { llToXY, xyToLL, guessZone, toDMS, parseAngle, azimuth, ZONES, ZONE_AREAS } from './geo.js';
import { decodeText, parseDXF, toDXF, parseSIMA, toSIMA, parseCSV, toCSV } from './io.js';

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
};
const view = { x: 0, y: 0, s: 10 }; // 画面中心のワールド座標と拡大率 (px/m)
const settings = { snap: true, onLine: true, showLen: true, showNames: true, dark: false };

let tool = 'select';
let temp = [];          // 作図中の点
let selected = null;    // 選択中エンティティ id
let selPoint = null;    // 選択ツールでタップしたスナップ点
let result = null;      // 計測結果（距離・角度）
let hover = null;       // マウスホバー位置 / 最後のタップ位置（スナップ済み）
const undoStack = [];
const redoLimit = 60;

// GPS
const gps = { watchId: null, fix: null, avg: null, follow: false };

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
function changed() { save(); renderPanel(); draw(); }

function addEntity(e, { snap = true } = {}) {
  if (snap) snapshot();
  e.id = doc.nextId++;
  doc.entities.push(e);
  return e;
}
function getEnt(id) { return doc.entities.find((e) => e.id === id); }
function nextPointName() {
  const used = new Set(doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
  let name;
  do { name = 'P' + doc.seq++; } while (used.has(name));
  return name;
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
    case 'line': case 'dim': return [e.a, e.b];
    case 'poly': return e.pts;
    case 'circle': return [e.c];
    case 'arc': return [e.c, arcPt(e, e.a0), arcPt(e, e.a1)];
    case 'text': return [e.p];
    default: return [];
  }
}
// DXF の角度（東から反時計回り）で円弧上の点
function arcPt(e, angDeg) {
  const t = (angDeg * Math.PI) / 180;
  return { x: e.c.x + e.r * Math.sin(t), y: e.c.y + e.r * Math.cos(t) };
}
function segments(e) {
  if (e.type === 'line' || e.type === 'dim') return [[e.a, e.b]];
  if (e.type === 'poly') {
    const s = [];
    for (let i = 0; i + 1 < e.pts.length; i++) s.push([e.pts[i], e.pts[i + 1]]);
    if (e.closed && e.pts.length > 2) s.push([e.pts[e.pts.length - 1], e.pts[0]]);
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
    for (const e of doc.entities) {
      switch (e.type) {
        case 'point': consider(e.p, '点', 2); break;
        case 'line': case 'dim':
          consider(e.a, '端点', 2); consider(e.b, '端点', 2); consider(mid(e.a, e.b), '中点', 1); break;
        case 'poly':
          e.pts.forEach((p) => consider(p, '頂点', 2));
          for (const [a, b] of segments(e)) consider(mid(a, b), '中点', 1);
          break;
        case 'circle': consider(e.c, '中心', 2); break;
        case 'arc': consider(e.c, '中心', 2); consider(arcPt(e, e.a0), '端点', 2); consider(arcPt(e, e.a1), '端点', 2); break;
        case 'text': consider(e.p, '文字', 0); break;
      }
    }
    if (!ignoreTemp) temp.forEach((p) => consider(p, '作図点', 2));
    if (gps.fix) consider(gps.fix.p, 'GPS', 1.5);
  }
  if (!best && settings.onLine) {
    for (const e of doc.entities) {
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
function hitTest(sx, sy) {
  const w = toW(sx, sy);
  const tol = 18 / view.s;
  let best = null;
  const take = (e, d) => { if (d <= tol && (!best || d < best.d)) best = { e, d }; };
  for (const e of doc.entities) {
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

function draw() {
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
    const isSel = e.id === selected;
    ctx.strokeStyle = isSel ? sel : (e.type === 'dim' ? C.accent : ent);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = isSel ? 3 : 1.5;
    drawEntity(e, isSel);
  }

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

  // 計測結果
  if (result) drawResult(result, tmpC);

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

function drawEntity(e, isSel) {
  const color = ctx.strokeStyle;
  switch (e.type) {
    case 'point': {
      const s = toS(e.p);
      ctx.beginPath(); ctx.moveTo(s.sx - 6, s.sy); ctx.lineTo(s.sx + 6, s.sy); ctx.moveTo(s.sx, s.sy - 6); ctx.lineTo(s.sx, s.sy + 6); ctx.stroke();
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 3, 0, Math.PI * 2); ctx.stroke();
      if (settings.showNames && e.name) label(e.name, s.sx + 7, s.sy - 6, color);
      break;
    }
    case 'line': {
      const a = toS(e.a), b = toS(e.b);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      if (settings.showLen && !e.layer) segLabel(e.a, e.b, color);
      break;
    }
    case 'dim': {
      const a = toS(e.a), b = toS(e.b);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      const ang = Math.atan2(b.sy - a.sy, b.sx - a.sx) + Math.PI / 2;
      for (const p of [a, b]) {
        ctx.beginPath(); ctx.moveTo(p.sx + Math.cos(ang) * 6, p.sy + Math.sin(ang) * 6); ctx.lineTo(p.sx - Math.cos(ang) * 6, p.sy - Math.sin(ang) * 6); ctx.stroke();
      }
      label(fmt(dist(e.a, e.b)) + 'm', (a.sx + b.sx) / 2, (a.sy + b.sy) / 2 - 5, color, 'center');
      break;
    }
    case 'poly': {
      if (e.pts.length < 2) break;
      ctx.beginPath();
      e.pts.forEach((p, i) => { const s = toS(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      if (e.closed) ctx.closePath();
      if (e.area) {
        ctx.save(); ctx.globalAlpha = isSel ? 0.18 : 0.08; ctx.fill(); ctx.restore();
      }
      ctx.stroke();
      if (settings.showLen && !e.layer) for (const [a, b] of segments(e)) segLabel(a, b, color);
      if (e.area) {
        let cx = 0, cy = 0; e.pts.forEach((p) => { cx += p.x; cy += p.y; });
        const c = toS({ x: cx / e.pts.length, y: cy / e.pts.length });
        label(fmt(polyArea(e.pts), 2) + '㎡', c.sx, c.sy, color, 'center');
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
    case 'text': {
      const s = toS(e.p);
      const px = Math.max(9, Math.min(48, (e.h || 1) * view.s));
      if (px < 6) break;
      ctx.font = `${px}px sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(e.text, s.sx, s.sy);
      break;
    }
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
  const ll = xyToLL(p.x, p.y, doc.zone);
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
  if (!gps.fix || !p) return [];
  const g = gps.fix.p;
  const d = dist(g, p);
  const az = azimuth(g, p);
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  return [
    ['現在地から', `${fmt(d, 2)} m`, 'big'],
    ['方向', `${dirs[Math.round(az / 45) % 8]}（${toDMS(az, 0)}）`],
    ['ΔX / ΔY', `${fmt(p.x - g.x, 2)} / ${fmt(p.y - g.y, 2)}`],
    ['GPS精度', `±${fmt(gps.fix.acc, 1)} m`],
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
  if (gps.fix) html = html ? html + '<hr>' + '<h4>GPS</h4>' + gpsActions() : gpsInfo();
  body.innerHTML = html;
  panel.hidden = !html;
}

function gpsInfo() {
  const f = gps.fix;
  return '<h4>現在地（GPS）</h4>' + kv([
    ['X（北）', fmt(f.p.x), 'big'], ['Y（東）', fmt(f.p.y), 'big'],
    ['系', `${doc.zone}系`], ['精度', `±${fmt(f.acc, 1)} m`],
    ['緯度', toDMS(f.lat, 2)], ['経度', toDMS(f.lon, 2)],
    ...(f.alt != null ? [['標高(参考)', fmt(f.alt, 1) + ' m']] : []),
  ]) + gpsActions();
}
function gpsActions() {
  const busy = gps.avg ? `平均中… ${gps.avg.samples.length}/${gps.avg.n}` : '平均して点を追加（10回）';
  return `<div class="panel-actions"><button class="btn primary" data-act="gpsAvg" ${gps.avg ? 'disabled' : ''}>${busy}</button><button class="btn" data-act="gpsAdd">今の位置で点を追加</button></div>`;
}

function entityInfo(e) {
  const del = `<button class="btn danger" data-act="delete">削除</button>`;
  const layer = e.layer ? [['画層', esc(e.layer)]] : [];
  switch (e.type) {
    case 'point':
      return `<h4>点 ${esc(e.name || '')}</h4>` + kv([
        ['X（北）', fmt(e.p.x), 'big'], ['Y（東）', fmt(e.p.y), 'big'], ['Z', fmt(e.z || 0)], ...llRows(e.p), ...guideRows(e.p), ...layer,
      ]) + `<div class="panel-actions"><button class="btn" data-act="editPoint">編集</button>${del}</div>`;
    case 'line': case 'dim':
      return `<h4>${e.type === 'dim' ? '寸法線' : '線'}</h4>` + kv([
        ['長さ', fmt(dist(e.a, e.b)) + ' m', 'big'], ['方向角', toDMS(azimuth(e.a, e.b))],
        ['始点', `${fmt(e.a.x)}, ${fmt(e.a.y)}`], ['終点', `${fmt(e.b.x)}, ${fmt(e.b.y)}`], ...layer,
      ]) + `<div class="panel-actions"><button class="btn" data-act="regVerts">端点を点登録</button>${del}</div>`;
    case 'poly': {
      const rows = [['頂点数', e.pts.length], ['延長', fmt(polyLen(e.pts, e.closed)) + ' m', e.closed ? '' : 'big']];
      if (e.closed) rows.unshift(['面積', fmt(polyArea(e.pts), 3) + ' ㎡', 'big']);
      if (e.closed) rows.push(['（坪）', fmt(polyArea(e.pts) / 3.305785, 2) + ' 坪']);
      return `<h4>${e.closed ? '閉じた図形' : '連続線'}</h4>` + kv([...rows, ...layer]) +
        `<div class="panel-actions"><button class="btn" data-act="regVerts">頂点を点登録</button>${del}</div>`;
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
};

function setTool(t) {
  tool = t;
  temp = [];
  result = null;
  if (t !== 'select') { selected = null; selPoint = null; }
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
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
  $('#cmdHint').textContent = hint;
  $('#cmd').placeholder = tool === 'circle' && temp.length ? '半径（m）' : ph;
  $('#cmdUndoPt').hidden = !['line', 'area', 'angle', 'measure', 'circle'].includes(tool);
  $('#cmdClose').hidden = tool !== 'line';
  $('#cmdDone').hidden = !['line', 'area'].includes(tool);
  $('#cmdBtns').hidden = $('#cmdUndoPt').hidden && $('#cmdDone').hidden;
}

function place(p, kind) {
  hover = { p, kind };
  switch (tool) {
    case 'point': {
      snapshot();
      const e = addEntity({ type: 'point', p, name: nextPointName(), z: 0 }, { snap: false });
      toast(`${e.name}  X ${fmt(p.x)}  Y ${fmt(p.y)}`);
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
  }
  updateCmd(); renderPanel(); draw();
}

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
  const sn = snapAt(sx, sy);
  updateHud(sn.p, sn.kind);
  place(sn.p, sn.kind);
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
    toast(msg);
    $('#gpsHud').textContent = 'GPS: ' + msg;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt } = pos.coords;
  if (!doc.zone) {
    doc.zone = guessZone(lat, lon);
    updateZoneChip(); save();
    toast(`座標系を ${doc.zone}系 に設定しました（右上で変更できます）`);
  }
  const p = llToXY(lat, lon, doc.zone);
  gps.fix = { lat, lon, acc, alt, p, t: pos.timestamp };
  $('#gpsHud').textContent = `GPS ±${fmt(acc, 1)}m\nX ${fmt(p.x, 2)}\nY ${fmt(p.y, 2)}`;
  $('#gpsHud').style.whiteSpace = 'pre';
  $('#btnGoGps').hidden = false;

  if (gps.avg) {
    gps.avg.samples.push({ lat, lon, acc, alt });
    if (gps.avg.samples.length >= gps.avg.n) finishAvg();
  }
  if (gps.follow) { gps.follow = false; centerOn(p, Math.max(view.s, 2)); }
  renderPanel();
  draw();
}

function finishAvg() {
  const s = gps.avg.samples;
  gps.avg = null;
  // 精度で重み付け平均
  let wsum = 0, la = 0, lo = 0;
  for (const q of s) { const w = 1 / Math.max(q.acc, 0.5) ** 2; wsum += w; la += q.lat * w; lo += q.lon * w; }
  const lat = la / wsum, lon = lo / wsum;
  const p = llToXY(lat, lon, doc.zone);
  const accs = s.map((q) => q.acc).sort((a, b) => a - b);
  const e = addEntity({ type: 'point', p, name: nextPointName(), z: 0, gps: { acc: accs[Math.floor(accs.length / 2)], n: s.length } });
  toast(`${e.name} を登録（${s.length}回平均・精度目安 ±${fmt(e.gps.acc, 1)}m）`);
  changed();
}

// ============================================================
// ファイル
// ============================================================
function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
      if (e.type === 'point' && !e.name) e.name = nextPointName();
      addEntity(e, { snap: false });
    }
    if (doc.name === '無題') { doc.name = f.name.replace(/\.dxf$/i, ''); updateTitle(); }
    changed(); fitAll();
    toast(`${entities.length} 個の図形を読み込みました` + (skipped.length ? `（未対応: ${skipped.join(', ')}）` : ''));
  } catch (err) { toast('DXF を読み込めませんでした: ' + err.message); }
});

$('#filePts').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  const pts = /\.sim$/i.test(f.name) || /^A01,/m.test(f.text) ? parseSIMA(f.text) : parseCSV(f.text);
  if (!pts.length) { toast('座標が見つかりませんでした'); return; }
  snapshot();
  for (const q of pts) addEntity({ type: 'point', p: { x: q.x, y: q.y }, z: q.z, name: q.name || nextPointName() }, { snap: false });
  changed(); fitAll();
  toast(`${pts.length} 点を読み込みました`);
});

$('#fileJson').addEventListener('change', async (ev) => {
  const f = await readFile(ev.target); if (!f) return;
  try {
    const d = JSON.parse(f.text);
    if (!Array.isArray(d.entities)) throw new Error('形式が違います');
    snapshot();
    Object.assign(doc, { name: d.name || '無題', zone: d.zone || null, entities: d.entities, seq: d.seq || 1, nextId: d.nextId || 1 });
    doc.nextId = Math.max(doc.nextId, ...doc.entities.map((e) => (e.id || 0) + 1), 1);
    doc.entities.forEach((e) => { if (!e.id) e.id = doc.nextId++; });
    updateTitle(); updateZoneChip(); changed(); fitAll();
  } catch (err) { toast('読み込めませんでした: ' + err.message); }
});

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
function updateTitle() { $('#title').textContent = doc.name; document.title = `${doc.name} - 現場CAD`; }
function updateZoneChip() { $('#btnZone').textContent = doc.zone ? `${doc.zone}系` : '系: 未設定'; }

function openPointDialog(e) {
  $('#ptName').value = e.name || '';
  $('#ptX').value = e.p.x.toFixed(3);
  $('#ptY').value = e.p.y.toFixed(3);
  $('#ptZ').value = (e.z || 0).toFixed(3);
  $('#ptOk').onclick = () => {
    const x = Number($('#ptX').value), y = Number($('#ptY').value), z = Number($('#ptZ').value || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { toast('数値を入力してください'); return; }
    snapshot();
    e.name = $('#ptName').value.trim(); e.p = { x, y }; e.z = Number.isFinite(z) ? z : 0;
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
  if (gps.fix) gps.fix.p = llToXY(gps.fix.lat, gps.fix.lon, doc.zone);
  $('#zoneDialog').close(); renderPanel(); draw();
});

function renderList() {
  const pts = doc.entities.filter((e) => e.type === 'point');
  $('#listInfo').textContent = `${pts.length} 点` + (doc.zone ? ` ・ ${doc.zone}系` : '');
  $('#ptList').innerHTML = pts.length
    ? '<table><thead><tr><th>点名</th><th>X（北）</th><th>Y（東）</th></tr></thead><tbody>' +
      pts.map((e) => `<tr data-id="${e.id}"><td>${esc(e.name)}</td><td class="num">${fmt(e.p.x)}</td><td class="num">${fmt(e.p.y)}</td></tr>`).join('') +
      '</tbody></table>'
    : '<p class="small">まだ点がありません。「点」ツールや GPS で追加できます。</p>';
}
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
    Object.assign(doc, { name: '無題', entities: [], seq: 1, nextId: 1 });
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
  saveDxf() { download(safeName() + '.dxf', toDXF(doc.entities), 'application/dxf'); },
  saveSima() {
    const pts = pointList(); if (!pts.length) { toast('点がありません'); return; }
    download(safeName() + '.sim', toSIMA(pts, doc.name));
  },
  saveCsv() {
    const pts = pointList(); if (!pts.length) { toast('点がありません'); return; }
    download(safeName() + '.csv', toCSV(pts, doc.zone), 'text/csv');
  },
  saveJson() { download(safeName() + '.json', JSON.stringify(doc), 'application/json'); },
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
    const e = addEntity({ type: 'point', p: selPoint.p, name: nextPointName(), z: 0 });
    selected = e.id; selPoint = null; toast(`${e.name} を登録しました`); changed();
  },
  regVerts() {
    const e = getEnt(selected); if (!e) return;
    const existing = doc.entities.filter((q) => q.type === 'point');
    const pts = verts(e).filter((p) => !existing.some((q) => dist(q.p, p) < 1e-4));
    if (!pts.length) { toast('すべて登録済みです'); return; }
    snapshot();
    for (const p of pts) addEntity({ type: 'point', p: { ...p }, name: nextPointName(), z: 0 }, { snap: false });
    toast(`${pts.length} 点を登録しました`); changed();
  },
  keepDim() {
    if (!result || result.kind !== 'measure') return;
    addEntity({ type: 'dim', a: result.pts[0], b: result.pts[1] });
    result = null; changed();
  },
  clearResult() { result = null; temp = []; updateCmd(); renderPanel(); draw(); },
  gpsAvg() {
    if (!gps.fix) return;
    gps.avg = { n: 10, samples: [] };
    toast('その場で静止してください（10回測位して平均します）');
    renderPanel();
  },
  gpsAdd() {
    if (!gps.fix) return;
    const e = addEntity({ type: 'point', p: { ...gps.fix.p }, name: nextPointName(), z: 0, gps: { acc: gps.fix.acc, n: 1 } });
    toast(`${e.name} を登録（精度目安 ±${fmt(gps.fix.acc, 1)}m）`); changed();
  },
};

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-act]');
  if (a) {
    const sheet = a.closest('dialog.sheet');
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

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#btnGps').addEventListener('click', toggleGps);
$('#btnUndo').addEventListener('click', undo);
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

// 設定
const optMap = { optSnap: 'snap', optOnLine: 'onLine', optLen: 'showLen', optNames: 'showNames', optDark: 'dark' };
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
  else if (ev.key === 'Escape') { temp = []; result = null; updateCmd(); renderPanel(); draw(); }
  else if (ev.key === 'Delete' || ev.key === 'Backspace') actions.delete();
});

// ============================================================
// 起動
// ============================================================
load();
applyTheme();
updateTitle();
updateZoneChip();
new ResizeObserver(resize).observe($('#stage'));
resize();
if (!doc.entities.length && !localStorage.getItem(STORE_KEY)) setTimeout(() => $('#helpDialog').showModal(), 300);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト・デバッグ用
window.__genbacad = { doc, view, settings, setTool, place, parseCmd };
