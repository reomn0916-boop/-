// パソコン版: 図形の幾何（スナップ・選択・編集に使う）
// 座標は x = X(北), y = Y(東)。円弧の角度は DXF 形式（東から反時計回り・度）。
import { dimGeom } from '../js/draft.js';

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const norm360 = (d) => ((d % 360) + 360) % 360;
/** 点 c から見た p の角度（DXF 形式） */
export const angOf = (c, p) => norm360(Math.atan2(p.x - c.x, p.y - c.y) * R2D);
export const arcPt = (c, r, a) => ({ x: c.x + r * Math.sin(a * D2R), y: c.y + r * Math.cos(a * D2R) });
/** 方向角（北から時計回り・度） */
export const azim = (a, b) => norm360(Math.atan2(b.y - a.y, b.x - a.x) * R2D);
export const polarAz = (o, az, d) => ({ x: o.x + d * Math.cos(az * D2R), y: o.y + d * Math.sin(az * D2R) });

/** 角度 a が円弧 a0→a1（反時計回り）の範囲にあるか */
export function inArc(a, a0, a1) {
  const s = norm360(a1 - a0), t = norm360(a - a0);
  return t <= s + 1e-9;
}

export function projectOnSeg(p, a, b, clamp = true) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return { q: { ...a }, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  if (clamp) t = Math.max(0, Math.min(1, t));
  return { q: { x: a.x + t * dx, y: a.y + t * dy }, t };
}
export const segDist = (p, a, b) => dist(p, projectOnSeg(p, a, b).q);

/** 2直線の交点（t, u は各線分上の比率） */
export function lineX(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return { p: { x: a.x + t * r.x, y: a.y + t * r.y }, t, u };
}
/** 直線（a-b の延長を含む）と円の交点 */
export function lineCircle(a, b, c, r) {
  const d = sub(b, a), f = sub(a, c);
  const A = d.x * d.x + d.y * d.y, B = 2 * (f.x * d.x + f.y * d.y), C = f.x * f.x + f.y * f.y - r * r;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map((t) => ({ p: { x: a.x + t * d.x, y: a.y + t * d.y }, t }));
}
export function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m = { x: c1.x + (a * (c2.x - c1.x)) / d, y: c1.y + (a * (c2.y - c1.y)) / d };
  const ox = (h * (c2.y - c1.y)) / d, oy = (h * (c2.x - c1.x)) / d;
  return [{ x: m.x + ox, y: m.y - oy }, { x: m.x - ox, y: m.y + oy }];
}

export function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}
export function polyLen(pts, closed) {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += dist(pts[i], pts[i + 1]);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
  return s;
}
export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 図形の基本要素。
 * segs: 線分 [[a,b]]、arcs: 円弧 {c,r,a0,a1,full}、ends: 端点、mids: 中点、cens: 中心、pts: 点
 */
export function geomOf(e, alignGeom) {
  const g = { segs: [], arcs: [], ends: [], mids: [], cens: [], pts: [] };
  const seg = (a, b) => { g.segs.push([a, b]); g.mids.push(mid(a, b)); };
  switch (e.type) {
    case 'point': g.pts.push(e.p); break;
    case 'line': seg(e.a, e.b); g.ends.push(e.a, e.b); break;
    case 'poly': case 'hatch': {
      const n = e.pts.length, closed = e.type === 'hatch' || e.closed;
      for (let i = 0; i + 1 < n; i++) seg(e.pts[i], e.pts[i + 1]);
      if (closed && n > 2) seg(e.pts[n - 1], e.pts[0]);
      g.ends.push(...e.pts);
      break;
    }
    case 'circle': g.arcs.push({ c: e.c, r: e.r, a0: 0, a1: 360, full: true }); g.cens.push(e.c); break;
    case 'arc': {
      g.arcs.push({ c: e.c, r: e.r, a0: e.a0, a1: e.a1 });
      g.cens.push(e.c);
      const p0 = arcPt(e.c, e.r, e.a0), p1 = arcPt(e.c, e.r, e.a1);
      g.ends.push(p0, p1);
      g.mids.push(arcPt(e.c, e.r, e.a0 + norm360(e.a1 - e.a0) / 2));
      break;
    }
    case 'dim': {
      const d = dimGeom(e);
      g.segs.push([d.a2, d.b2], [d.ea, d.a2], [d.eb, d.b2]);
      g.ends.push(d.a2, d.b2); g.mids.push(mid(d.a2, d.b2));
      break;
    }
    case 'leader': seg(e.a, e.b); g.ends.push(e.a, e.b); break;
    case 'text': g.pts.push(e.p); break;
    case 'align': {
      const ag = alignGeom ? alignGeom(e) : null;
      if (ag && ag.poly) {
        for (let i = 0; i + 1 < ag.poly.length; i++) g.segs.push([ag.poly[i], ag.poly[i + 1]]);
        g.ends.push(...ag.keys.map((k) => k.p));
      }
      break;
    }
  }
  return g;
}

/** 図形の外接矩形 {x0,y0,x1,y1}（文字は位置のみ） */
export function bboxOf(e, alignGeom) {
  const g = geomOf(e, alignGeom);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const inc = (p) => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); };
  for (const [a, b] of g.segs) { inc(a); inc(b); }
  for (const a of g.arcs) {
    if (a.full) { inc({ x: a.c.x - a.r, y: a.c.y - a.r }); inc({ x: a.c.x + a.r, y: a.c.y + a.r }); continue; }
    inc(arcPt(a.c, a.r, a.a0)); inc(arcPt(a.c, a.r, a.a1));
    for (const q of [0, 90, 180, 270]) if (inArc(q, a.a0, a.a1)) inc(arcPt(a.c, a.r, q));
  }
  for (const p of g.pts) inc(p);
  for (const p of g.ends) inc(p);
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** 円弧を折れ線に（選択・交差判定用） */
export function arcPoly(a, n = 32) {
  const span = a.full ? 360 : norm360(a.a1 - a.a0) || 360;
  const k = Math.max(4, Math.ceil((n * span) / 360));
  const out = [];
  for (let i = 0; i <= k; i++) out.push(arcPt(a.c, a.r, a.a0 + (span * i) / k));
  return out;
}

/** 要素同士の交点 */
export function intersections(g1, g2, extend = false) {
  const out = [];
  for (const [a, b] of g1.segs) {
    for (const [c, d] of g2.segs) {
      const r = lineX(a, b, c, d);
      if (r && (extend || (r.t >= -1e-9 && r.t <= 1 + 1e-9 && r.u >= -1e-9 && r.u <= 1 + 1e-9))) out.push(r.p);
    }
    for (const A of g2.arcs) for (const r of lineCircle(a, b, A.c, A.r)) if ((extend || (r.t >= -1e-9 && r.t <= 1 + 1e-9)) && (A.full || inArc(angOf(A.c, r.p), A.a0, A.a1))) out.push(r.p);
  }
  for (const A of g1.arcs) {
    for (const [c, d] of g2.segs) for (const r of lineCircle(c, d, A.c, A.r)) if ((extend || (r.t >= -1e-9 && r.t <= 1 + 1e-9)) && (A.full || inArc(angOf(A.c, r.p), A.a0, A.a1))) out.push(r.p);
    for (const B of g2.arcs) for (const p of circleCircle(A.c, A.r, B.c, B.r)) if ((A.full || inArc(angOf(A.c, p), A.a0, A.a1)) && (B.full || inArc(angOf(B.c, p), B.a0, B.a1))) out.push(p);
  }
  return out;
}

/** 線分が矩形と交わるか */
export function segHitsRect(a, b, r) {
  const inR = (p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  if (inR(a) || inR(b)) return true;
  const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  for (let i = 0; i < 4; i++) {
    const q = lineX(a, b, c[i], c[(i + 1) % 4]);
    if (q && q.t >= 0 && q.t <= 1 && q.u >= 0 && q.u <= 1) return true;
  }
  return false;
}

// ------------------------------------------------------------
// 図形の変換（移動・回転・反転・拡大）
// ------------------------------------------------------------
/** 点の変換 f を図形に適用した新しい図形。kind: 'move'|'rot'|'mirror'|'scale'、info: {ang, k} */
export function mapEntity(e, f, info = {}) {
  const n = JSON.parse(JSON.stringify(e));
  const P = (p) => (p ? { ...p, ...f(p) } : p);
  const k = info.k ?? 1, rot = info.ang ?? 0, mir = !!info.mirror;
  switch (n.type) {
    case 'point': case 'text': n.p = P(n.p); break;
    case 'line': case 'leader': n.a = P(n.a); n.b = P(n.b); break;
    case 'dim':
      n.a = P(n.a); n.b = P(n.b); if (n.pa) n.pa = P(n.pa); if (n.pb) n.pb = P(n.pb);
      n.off = (n.off || 0) * k * (mir ? -1 : 1); break;
    case 'poly': case 'hatch': n.pts = n.pts.map(P); break;
    case 'circle': n.c = P(n.c); n.r *= k; break;
    case 'arc': {
      const p0 = P(arcPt(e.c, e.r, e.a0)), p1 = P(arcPt(e.c, e.r, e.a1));
      n.c = P(n.c); n.r *= k;
      if (mir) { n.a0 = angOf(n.c, p1); n.a1 = angOf(n.c, p0); } else { n.a0 = angOf(n.c, p0); n.a1 = angOf(n.c, p1); }
      break;
    }
    case 'align': n.ips = n.ips.map(P); n.radii = (n.radii || []).map((r) => r * k); break;
  }
  if (n.type === 'text') {
    if (n.h) n.h *= k;
    if (rot) n.rot = norm360((n.rot || 0) + rot);
    if (mir && info.axisAng != null) n.rot = norm360(2 * info.axisAng - (n.rot || 0));
  }
  if (n.type === 'hatch' && rot) n.ang = norm360((n.ang ?? 45) + rot);
  return n;
}
export const fMove = (dx, dy) => (p) => ({ x: p.x + dx, y: p.y + dy });
/** 中心 c まわりに ang 度（反時計回り＝画面で左回り） */
export function fRotate(c, ang) {
  const t = ang * D2R, cs = Math.cos(t), sn = Math.sin(t);
  // 画面の反時計回り = (東, 北) 平面の反時計回り。x=北, y=東 なので符号に注意
  return (p) => { const dy = p.y - c.y, dx = p.x - c.x; return { y: c.y + dy * cs - dx * sn, x: c.x + dy * sn + dx * cs }; };
}
export function fScale(c, k) { return (p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }); }
/** a-b を軸に反転 */
export function fMirror(a, b) {
  return (p) => { const { q } = projectOnSeg(p, a, b, false); return { x: 2 * q.x - p.x, y: 2 * q.y - p.y }; };
}
