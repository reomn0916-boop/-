// 座標計算（COGO）: すべて x = X(北), y = Y(東), 角度は方向角（北から時計回り・度）
import { azimuth } from './geo.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const norm360 = (d) => ((d % 360) + 360) % 360;
/** 方向角 az（度）の向きに d 進んだ点 */
export const polar = (o, azDeg, d) => ({ x: o.x + d * Math.cos(azDeg * D2R), y: o.y + d * Math.sin(azDeg * D2R) });
/** 進行方向 az に対して右向きの単位ベクトル */
const rightN = (azRad) => ({ x: -Math.sin(azRad), y: Math.cos(azRad) });

/** 逆計算（2点間） */
export function inverse(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const dz = (b.z ?? 0) - (a.z ?? 0);
  return { d, az: azimuth(a, b), dx, dy, dz, slope: d > 0 ? (dz / d) * 100 : NaN, sd: Math.hypot(d, dz) };
}

/** 放射計算: 器械点 o・後視点 bs（または方向角 bsAz）から夾角 ang・距離 d */
export function radial(o, { bs, bsAz }, ang, d) {
  const base = bs ? azimuth(o, bs) : bsAz;
  const az = norm360(base + ang);
  return { p: polar(o, az, d), az };
}

/** 杭打ち計算: 器械点 o・後視点 bs から各点への夾角（右回り）と距離 */
export function stakeout(o, bs, targets) {
  const base = azimuth(o, bs);
  return targets.map((t) => {
    const az = azimuth(o, t.p);
    return { name: t.name, ang: norm360(az - base), d: dist(o, t.p), az };
  });
}

/** 2直線 (a-b) (c-d) の交点。t,u は各線分上の位置（0〜1 なら線分内） */
export function intersect(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null; // 平行
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  return { p: { x: a.x + t * r.x, y: a.y + t * r.y }, t, u };
}

/** 距離交会: 点 a から距離 da、点 b から距離 db にある点（a→b の右側・左側の2解） */
export function distDist(a, da, b, db) {
  const D = dist(a, b);
  if (D === 0 || da + db < D - 1e-9 || Math.abs(da - db) > D + 1e-9) return null;
  const l = (da * da - db * db + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(da * da - l * l, 0));
  const az = azimuth(a, b) * D2R;
  const u = { x: Math.cos(az), y: Math.sin(az) };
  const n = rightN(az);
  const m = { x: a.x + l * u.x, y: a.y + l * u.y };
  return { right: { x: m.x + h * n.x, y: m.y + h * n.y }, left: { x: m.x - h * n.x, y: m.y - h * n.y } };
}

/** 垂線計算: 点 p から直線 a-b へ。s = a からの追加距離、w = 幅（右 +・左 −） */
export function perpendicular(a, b, p) {
  const L = dist(a, b);
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const v = { x: p.x - a.x, y: p.y - a.y };
  const s = v.x * u.x + v.y * u.y;
  const w = -v.x * u.y + v.y * u.x;
  return { foot: { x: a.x + s * u.x, y: a.y + s * u.y }, s, w, L, inside: s >= -1e-9 && s <= L + 1e-9 };
}

/** 幅杭・オフセット点: 直線 a-b 上の追加距離 s、幅 w（右 +）の点 */
export function offsetPoint(a, b, s, w) {
  const L = dist(a, b);
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  return { x: a.x + s * u.x - w * u.y, y: a.y + s * u.y + w * u.x };
}

/** 座標求積表（座標法）。行ごとに Xn+1 − Xn−1 と Yn × (Xn+1 − Xn−1) */
export function areaTable(pts) {
  const n = pts.length;
  let sum = 0;
  const rows = pts.map((p, i) => {
    const next = pts[(i + 1) % n], prev = pts[(i - 1 + n) % n];
    const dX = next.x - prev.x;
    const prod = p.y * dX;
    sum += prod;
    return { name: p.name, x: p.x, y: p.y, dX, prod };
  });
  let per = 0;
  for (let i = 0; i < n; i++) per += dist(pts[i], pts[(i + 1) % n]);
  return { rows, double: sum, area: Math.abs(sum) / 2, perimeter: per };
}

/** 単曲線要素: 半径 R、交角 IA（度） */
export function curveElements(R, IAdeg) {
  const ia = Math.abs(IAdeg) * D2R;
  return {
    TL: R * Math.tan(ia / 2),
    CL: R * ia,
    SL: R * (1 / Math.cos(ia / 2) - 1),
    M: R * (1 - Math.cos(ia / 2)),
    C: 2 * R * Math.sin(ia / 2),
  };
}

/** 勾配 1:n、高さ H → 水平距離・法長・角度・％ */
export function slope(H, n) {
  return { L: n * H, len: H * Math.sqrt(1 + n * n), deg: Math.atan2(1, n) * R2D, pct: n ? 100 / n : Infinity };
}

// ============================================================
// 路線（IP 法・単曲線）
// ============================================================
/**
 * @param ips  [{x,y,name}] 先頭 = BP、末尾 = EP、間 = IP
 * @param radii 各 IP の曲線半径（0 は折れ点）
 * @param s0  BP の追加距離
 */
export function buildAlignment(ips, radii = [], s0 = 0) {
  if (ips.length < 2) throw new Error('BP と EP の2点以上が必要です');
  const elems = [];
  const curves = [];
  let cur = { x: ips[0].x, y: ips[0].y };
  let s = s0;
  for (let i = 1; i < ips.length - 1; i++) {
    const P = ips[i];
    const azIn = azimuth(ips[i - 1], P), azOut = azimuth(P, ips[i + 1]);
    let IA = azOut - azIn;
    if (IA > 180) IA -= 360;
    if (IA < -180) IA += 360;
    const R = Number(radii[i - 1]) || 0;
    const sign = IA >= 0 ? 1 : -1;
    const tl = R > 0 ? R * Math.tan((Math.abs(IA) * D2R) / 2) : 0;
    const BC = polar(P, azIn + 180, tl);
    const EC = polar(P, azOut, tl);
    // 直線部
    const lenL = dist(cur, BC);
    const dot = (BC.x - cur.x) * Math.cos(azIn * D2R) + (BC.y - cur.y) * Math.sin(azIn * D2R);
    if (dot < -1e-6) throw new Error(`IP${i} の曲線が${i === 1 ? ' BP' : '前の曲線'}と重なっています（半径を小さくしてください）`);
    if (lenL > 1e-9) { elems.push({ type: 'line', a: cur, az: azIn, len: lenL, s }); s += lenL; }
    if (R > 0 && Math.abs(IA) > 1e-9) {
      const azR = azIn * D2R;
      const n = rightN(azR);
      const c = { x: BC.x + sign * R * n.x, y: BC.y + sign * R * n.y };
      const CL = R * Math.abs(IA) * D2R;
      const curve = { ip: i, name: P.name || `IP${i}`, R, IA, TL: tl, CL, BC, EC, sBC: s, sEC: s + CL, c, sign, azIn };
      curves.push(curve);
      elems.push({ type: 'arc', a: BC, az: azIn, len: CL, s, c, R, sign, curve });
      s += CL;
      curve.MC = pointOnElem(elems[elems.length - 1], CL / 2).p;
      curve.sMC = curve.sBC + CL / 2;
    }
    cur = EC;
  }
  const EP = ips[ips.length - 1];
  const azOutLast = azimuth(ips[ips.length - 2], EP);
  if ((EP.x - cur.x) * Math.cos(azOutLast * D2R) + (EP.y - cur.y) * Math.sin(azOutLast * D2R) < -1e-6) {
    throw new Error(`IP${ips.length - 2} の曲線が EP を越えています（半径を小さくしてください）`);
  }
  const azLast = azimuth(cur, EP);
  const lenLast = dist(cur, EP);
  if (lenLast > 1e-9) { elems.push({ type: 'line', a: cur, az: azLast, len: lenLast, s }); s += lenLast; }
  return { elems, curves, s0, sEnd: s, length: s - s0 };
}

function pointOnElem(e, l) {
  if (e.type === 'line') return { p: polar(e.a, e.az, l), az: e.az };
  const az = e.az + (e.sign * l / e.R) * R2D;
  const n = rightN(az * D2R);
  return { p: { x: e.c.x - e.sign * e.R * n.x, y: e.c.y - e.sign * e.R * n.y }, az: norm360(az) };
}

/** 追加距離 s・幅 w（右 +）の座標と接線方向角 */
export function alignPoint(al, s, w = 0) {
  let e = al.elems[0];
  for (const q of al.elems) { if (s >= q.s - 1e-9) e = q; }
  const { p, az } = pointOnElem(e, s - e.s);
  if (!w) return { p, az };
  const n = rightN(az * D2R);
  return { p: { x: p.x + w * n.x, y: p.y + w * n.y }, az };
}

/** 任意の点 → 追加距離と幅（右 +）。路線外なら null */
export function alignStation(al, p, tolOut = 1e-6) {
  let best = null;
  for (const e of al.elems) {
    let l, w, foot;
    if (e.type === 'line') {
      const u = { x: Math.cos(e.az * D2R), y: Math.sin(e.az * D2R) };
      const v = { x: p.x - e.a.x, y: p.y - e.a.y };
      l = v.x * u.x + v.y * u.y;
      w = -v.x * u.y + v.y * u.x;
    } else {
      const v = { x: p.x - e.c.x, y: p.y - e.c.y };
      const r = Math.hypot(v.x, v.y);
      if (r < 1e-9) continue;
      const n = { x: -e.sign * v.x / r, y: -e.sign * v.y / r }; // = 右向き法線
      const az = Math.atan2(-n.x, n.y) * R2D;
      let dA = az - e.az;
      dA = ((dA + 540) % 360) - 180;
      l = e.sign * dA * D2R * e.R;
      w = -e.sign * (r - e.R);
    }
    const inside = l >= -tolOut && l <= e.len + tolOut;
    if (!inside) continue;
    if (!best || Math.abs(w) < Math.abs(best.w)) best = { s: e.s + l, w };
  }
  return best;
}

/** 測点表記: No.3+12.35（pitch m ごと） */
export function fmtStation(s, pitch = 20, digits = 2) {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  let no = Math.floor(a / pitch + 1e-9);
  let rest = a - no * pitch;
  if (rest > pitch - 0.5 * 10 ** -digits) { no += 1; rest = 0; }
  const r = rest.toFixed(digits);
  return Number(r) === 0 ? `${sign}No.${no}` : `${sign}No.${no}+${r}`;
}

/** 測点表記 → 追加距離（"No.3+12.35" / "3+12.35" / "72.35"） */
export function parseStation(str, pitch = 20) {
  const s = String(str).trim().replace(/^no\.?/i, '').replace(/[＋]/g, '+');
  const m = s.match(/^(-?\d+)\+(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * pitch + Number(m[2]);
  if (/^No/i.test(String(str).trim()) && /^-?\d+$/.test(s)) return Number(s) * pitch;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/** 中心杭・主要点・追加測点の一覧 */
export function alignStakes(al, { pitch = 20, extra = [], widths = [] } = {}) {
  const list = [];
  const add = (s, label) => {
    if (s < al.s0 - 1e-6 || s > al.sEnd + 1e-6) return;
    if (list.some((q) => Math.abs(q.s - s) < 1e-4)) {
      const q = list.find((q2) => Math.abs(q2.s - s) < 1e-4);
      if (label && !q.label.includes(label)) q.label += '・' + label;
      return;
    }
    list.push({ s, label: label || '' });
  };
  add(al.s0, 'BP');
  for (const c of al.curves) { add(c.sBC, `BC${c.ip}`); add(c.sMC, `MC${c.ip}`); add(c.sEC, `EC${c.ip}`); }
  add(al.sEnd, 'EP');
  const first = Math.ceil((al.s0 - 1e-6) / pitch) * pitch;
  for (let s = first; s <= al.sEnd + 1e-6; s += pitch) add(s, '');
  for (const s of extra) add(s, '');
  list.sort((a, b) => a.s - b.s);
  return list.map((q) => {
    const c = alignPoint(al, q.s);
    const row = { ...q, station: fmtStation(q.s, pitch), p: c.p, az: c.az, wp: [] };
    for (const w of widths) row.wp.push({ w, p: alignPoint(al, q.s, w).p });
    return row;
  });
}

// ============================================================
// GPS の基準点補正（平行移動 / 回転 / ヘルマート）
// ============================================================
/**
 * pairs: [{src:{x,y}, dst:{x,y}}]  src = GPS から求めた座標, dst = 既知座標
 * mode: 'shift' | 'rigid'（回転＋移動・縮尺1） | 'helmert'（縮尺も）
 */
export function fitTransform(pairs, mode = 'rigid') {
  const n = pairs.length;
  if (!n) return null;
  const sc = { x: 0, y: 0 }, dc = { x: 0, y: 0 };
  for (const q of pairs) { sc.x += q.src.x; sc.y += q.src.y; dc.x += q.dst.x; dc.y += q.dst.y; }
  sc.x /= n; sc.y /= n; dc.x /= n; dc.y /= n;
  let a = 1, b = 0;
  if (n >= 2 && mode !== 'shift') {
    let num1 = 0, num2 = 0, den = 0;
    for (const q of pairs) {
      const s = { x: q.src.x - sc.x, y: q.src.y - sc.y };
      const d = { x: q.dst.x - dc.x, y: q.dst.y - dc.y };
      num1 += s.x * d.x + s.y * d.y;
      num2 += s.x * d.y - s.y * d.x;
      den += s.x * s.x + s.y * s.y;
    }
    if (den > 1e-12) {
      a = num1 / den; b = num2 / den;
      if (mode === 'rigid') { const k = Math.hypot(a, b) || 1; a /= k; b /= k; }
    }
  }
  const t = { x: dc.x - (a * sc.x - b * sc.y), y: dc.y - (b * sc.x + a * sc.y) };
  const tf = { a, b, tx: t.x, ty: t.y, mode, scale: Math.hypot(a, b), rot: Math.atan2(b, a) * R2D };
  tf.residuals = pairs.map((q) => { const p = applyTransform(tf, q.src); return { dx: q.dst.x - p.x, dy: q.dst.y - p.y, d: dist(p, q.dst) }; });
  return tf;
}

export function applyTransform(tf, p) {
  if (!tf) return p;
  return { x: tf.a * p.x - tf.b * p.y + tf.tx, y: tf.b * p.x + tf.a * p.y + tf.ty };
}

/** 逆変換（既知座標 → GPS 由来の座標） */
export function invertTransform(tf, p) {
  if (!tf) return p;
  const k = tf.a * tf.a + tf.b * tf.b;
  const x = p.x - tf.tx, y = p.y - tf.ty;
  return { x: (tf.a * x + tf.b * y) / k, y: (-tf.b * x + tf.a * y) / k };
}

// ============================================================
// 逃げ（オフセット）
// ============================================================
/** 多角形の向き: 正 = 時計回り（図面上で右回り＝内側が右） */
export function orientation(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

/**
 * 連続線・多角形を w（進行方向の右 +・左 −）だけ平行移動した頂点列。
 * 角は隣り合う辺の平行線の交点（留め）にする。
 */
export function offsetPolyline(pts, w, closed = false) {
  const n = pts.length;
  const segs = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = dist(a, b);
    if (L < 1e-12) { segs.push(null); continue; }
    const nr = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
    segs.push({ a: { x: a.x + w * nr.x, y: a.y + w * nr.y }, b: { x: b.x + w * nr.x, y: b.y + w * nr.y } });
  }
  const out = [];
  for (let j = 0; j < n; j++) {
    const prev = closed ? segs[(j - 1 + m) % m] : segs[j - 1];
    const next = closed ? segs[j % m] : segs[j];
    let p = null;
    if (prev && next) {
      const r = intersect(prev.a, prev.b, next.a, next.b);
      p = r ? r.p : next.a;
    } else if (next) p = next.a;
    else if (prev) p = prev.b;
    out.push(p || { ...pts[j] });
  }
  return out;
}

/** 点 p から、方向 from→p の延長上に d 進んだ点 */
export function extendFrom(from, p, d) {
  const L = dist(from, p);
  return { x: p.x + ((p.x - from.x) / L) * d, y: p.y + ((p.y - from.y) / L) * d };
}

/** 変換を図形に適用（位置合わせ用）。角度は DXF 形式（東から反時計回り・度） */
export function transformEntity(e, tf) {
  const T = (p) => { const q = applyTransform(tf, p); return { ...p, x: q.x, y: q.y }; };
  const k = tf.scale ?? Math.hypot(tf.a, tf.b);
  const rot = Math.atan2(tf.b, tf.a) * R2D;
  switch (e.type) {
    case 'point': e.p = T(e.p); break;
    case 'line': case 'leader': e.a = T(e.a); e.b = T(e.b); break;
    case 'dim': e.a = T(e.a); e.b = T(e.b); if (e.pa) e.pa = T(e.pa); if (e.pb) e.pb = T(e.pb); if (e.off) e.off *= k; break;
    case 'poly': e.pts = e.pts.map(T); break;
    case 'hatch': e.pts = e.pts.map(T); e.ang = norm360((e.ang ?? 45) - rot); break;
    case 'circle': e.c = T(e.c); e.r *= k; break;
    case 'arc': e.c = T(e.c); e.r *= k; e.a0 = norm360(e.a0 - rot); e.a1 = norm360(e.a1 - rot); break;
    case 'text':
      e.p = T(e.p);
      // 実寸の文字（DXF）は図面と一緒に拡大・回転。用紙基準の文字（hmm）は大きさ・向きを保つ
      if (!e.hmm) { if (e.h) e.h *= k; if (Math.abs(rot) > 1e-12) e.rot = norm360((e.rot || 0) - rot); }
      break;
    case 'align': e.ips = e.ips.map(T); e.radii = (e.radii || []).map((r) => r * k); break;
  }
  return e;
}
