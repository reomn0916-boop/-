// 作図の共通部品: 線種・色・線幅・ハッチング・寸法線の形・DXF 用の展開
// 座標は x = X(北), y = Y(東) [m]。角度は DXF 形式（東から反時計回り・度）。

const D2R = Math.PI / 180;

// ------------------------------------------------------------
// 線種（用紙上の mm）
// ------------------------------------------------------------
export const LTYPES = {
  solid: { name: '実線', dxf: 'CONTINUOUS', pat: [] },
  dash: { name: '破線', dxf: 'DASHED', pat: [3, 1.5] },
  dot: { name: '点線', dxf: 'DOT', pat: [0.4, 1] },
  chain: { name: '一点鎖線', dxf: 'CENTER', pat: [8, 1.5, 1, 1.5] },
  chain2: { name: '二点鎖線', dxf: 'PHANTOM', pat: [8, 1.5, 1, 1.5, 1, 1.5] },
};
export const LWS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0];

// ------------------------------------------------------------
// 色（DXF の色番号 ACI との対応）
// ------------------------------------------------------------
export const COLORS = [
  { name: '黒', hex: '#000000', aci: 7 },
  { name: '赤', hex: '#e00000', aci: 1 },
  { name: '黄', hex: '#c8a000', aci: 2 },
  { name: '緑', hex: '#008a00', aci: 3 },
  { name: '水色', hex: '#0096a8', aci: 4 },
  { name: '青', hex: '#0030e0', aci: 5 },
  { name: '紫', hex: '#a000a8', aci: 6 },
  { name: '灰', hex: '#808080', aci: 8 },
  { name: '橙', hex: '#e07000', aci: 30 },
  { name: '茶', hex: '#8b4513', aci: 34 },
];

const hsv = (h, s, v) => {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
};
/** ACI → 16進の色（白・黒の 7 は黒として扱う） */
export function aciToHex(aci) {
  const c = COLORS.find((q) => q.aci === aci);
  if (c) return c.hex;
  if (aci === 9) return '#c0c0c0';
  if (aci >= 250 && aci <= 255) { const g = Math.round(51 + (aci - 250) * 40.8); return '#' + g.toString(16).padStart(2, '0').repeat(3); }
  if (aci >= 10 && aci <= 249) {
    const h = Math.floor((aci - 10) / 10) * 15, k = aci % 10;
    const v = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k], s = k % 2 ? 0.5 : 1;
    return hsv(h, s, v);
  }
  return '#000000';
}
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** 16進の色 → いちばん近い ACI */
export function hexToAci(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 7;
  const c = COLORS.find((q) => q.hex.toLowerCase() === hex.toLowerCase());
  if (c) return c.aci;
  const [r, g, b] = rgb(hex);
  let best = 7, bd = Infinity;
  for (let a = 1; a <= 255; a++) {
    const [r2, g2, b2] = rgb(aciToHex(a));
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
/** DXF の 420（真の色 24bit 整数）→ 16進 */
export const trueColorHex = (n) => '#' + (Number(n) & 0xffffff).toString(16).padStart(6, '0');

// ------------------------------------------------------------
// ハッチング
// ------------------------------------------------------------
/**
 * 多角形 pts の内側に平行線を引く。ang = 線の向き（度）、pitch = 線の間隔 [m]
 * @returns [[a, b], ...] 線分の配列
 */
export function hatchLines(pts, ang, pitch) {
  if (!(pitch > 0) || pts.length < 3) return [];
  const t = ang * D2R;
  const d = { x: Math.sin(t), y: Math.cos(t) };      // 線の向き
  const n = { x: Math.cos(t), y: -Math.sin(t) };     // 線に直交
  const dot = (p, v) => p.x * v.x + p.y * v.y;
  let s0 = Infinity, s1 = -Infinity;
  for (const p of pts) { const s = dot(p, n); s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
  if ((s1 - s0) / pitch > 4000) pitch = (s1 - s0) / 4000; // 描きすぎ防止
  const out = [];
  for (let s = Math.ceil(s0 / pitch) * pitch; s <= s1; s += pitch) {
    const ts = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const sp = dot(p, n), sq = dot(q, n);
      if ((sp <= s) === (sq <= s)) continue;
      const k = (s - sp) / (sq - sp);
      ts.push(dot(p, d) + k * (dot(q, d) - dot(p, d)));
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      out.push([{ x: n.x * s + d.x * ts[i], y: n.y * s + d.y * ts[i] }, { x: n.x * s + d.x * ts[i + 1], y: n.y * s + d.y * ts[i + 1] }]);
    }
  }
  return out;
}
export const HATCHES = { line: '斜線', cross: '格子', solid: '塗りつぶし' };
/** ハッチ図形 e の線分。scaleN: 縮尺の分母（間隔 e.pitch は用紙 mm） */
export function hatchSegments(e, scaleN) {
  if (e.pattern === 'solid') return [];
  const pitch = ((e.pitch || 2) * scaleN) / 1000;
  const a = e.ang ?? 45;
  const out = hatchLines(e.pts, a, pitch);
  if (e.pattern === 'cross') out.push(...hatchLines(e.pts, a + 90, pitch));
  return out;
}

// ------------------------------------------------------------
// 寸法線
// ------------------------------------------------------------
export function dimText(d, unit) {
  return unit === 'mm' ? Math.round(d * 1000).toLocaleString('en-US') : d.toFixed(3);
}
/**
 * 寸法線の形。a-b が寸法を測る基準（平行）、off = 離れ（a→b の右 +）。
 * pa / pb があれば、補助線はそこから引く（水平・垂直寸法）。
 */
export function dimGeom(e) {
  const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) || 1;
  const n = { x: -(e.b.y - e.a.y) / L, y: (e.b.x - e.a.x) / L };
  const off = e.off || 0;
  return {
    L, n,
    a2: { x: e.a.x + n.x * off, y: e.a.y + n.y * off },
    b2: { x: e.b.x + n.x * off, y: e.b.y + n.y * off },
    ea: e.pa || e.a, eb: e.pb || e.b,
  };
}
export const dimLabel = (e, unit) => (e.txt != null && e.txt !== '' ? e.txt : dimText((dimGeom(e).L), unit));

// ------------------------------------------------------------
// DXF 用に図形を線・円弧・文字へ展開する
// ------------------------------------------------------------
/**
 * @param ents 図形
 * @param o {scaleN, sheetRot, unit, alignGeom, alignPoint, alignStakes}
 */
export function explodeForDxf(ents, o) {
  const out = [];
  const scaleN = o.scaleN || 100, sheetRot = o.sheetRot || 0;
  const angDxf = (c, p) => (Math.atan2(p.x - c.x, p.y - c.y) * 180) / Math.PI;
  const k = scaleN / 1000; // 用紙 mm → m
  const textAng = (a, b) => { let t = angDxf(a, b) + sheetRot; t = ((t % 360) + 360) % 360; if (t > 90 && t <= 270) t -= 180; if (t > 270) t -= 360; return t - sheetRot; };
  const annRot = -sheetRot; // 注記は用紙に水平
  const th = (sheetRot * Math.PI) / 180, Rv = { x: -Math.sin(th), y: Math.cos(th) }; // 用紙の右方向
  const up = { x: Math.cos(th), y: Math.sin(th) };
  for (const e of ents) {
    const st = { color: e.color, ltype: e.ltype };
    if (e.type === 'dim') {
      const g = dimGeom(e), layer = e.layer || '寸法';
      const L = (a, b) => out.push({ type: 'line', layer, a, b, color: e.color });
      if (Math.hypot(g.ea.x - g.a2.x, g.ea.y - g.a2.y) > 1e-6) L(g.ea, g.a2);
      if (Math.hypot(g.eb.x - g.b2.x, g.eb.y - g.b2.y) > 1e-6) L(g.eb, g.b2);
      L(g.a2, g.b2);
      const u = { x: (g.b2.x - g.a2.x) / g.L, y: (g.b2.y - g.a2.y) / g.L };
      if (e.term === 'arrow') {
        const al = 2.5 * k, aw = 0.6 * k;
        for (const [p, s] of [[g.a2, 1], [g.b2, -1]]) {
          const q = { x: p.x + u.x * al * s, y: p.y + u.y * al * s };
          L(p, { x: q.x + g.n.x * aw, y: q.y + g.n.y * aw }); L(p, { x: q.x - g.n.x * aw, y: q.y - g.n.y * aw });
        }
      } else {
        const t = 0.9 * k, v = { x: (u.x + g.n.x) * t, y: (u.y + g.n.y) * t };
        for (const p of [g.a2, g.b2]) L({ x: p.x - v.x, y: p.y - v.y }, { x: p.x + v.x, y: p.y + v.y });
      }
      const m = { x: (g.a2.x + g.b2.x) / 2, y: (g.a2.y + g.b2.y) / 2 };
      const ta = textAng(g.a2, g.b2), r = (ta * Math.PI) / 180;
      const h = (e.hmm || 2.5) * 0.8;
      out.push({ type: 'text', layer, color: e.color, p: { x: m.x + Math.cos(r) * 0.8 * k, y: m.y - Math.sin(r) * 0.8 * k }, h: h * k, text: dimLabel(e, o.unit), rot: ta, align: 'center' });
      continue;
    }
    if (e.type === 'leader') {
      const layer = e.layer || '注記';
      const right = (e.b.x - e.a.x) * Rv.x + (e.b.y - e.a.y) * Rv.y >= 0;
      out.push({ type: 'line', layer, a: e.a, b: e.b, ...st });
      out.push({ type: 'text', layer, color: e.color, p: { x: e.b.x + up.x * 0.8 * k, y: e.b.y + up.y * 0.8 * k }, h: (e.hmm || 2.5) * 0.8 * k, text: e.text, align: right ? 'left' : 'right', rot: annRot });
      continue;
    }
    if (e.type === 'text' && e.hmm) { out.push({ ...e, layer: e.layer || '注記', h: e.hmm * 0.8 * k, rot: annRot + (e.rot || 0) }); continue; }
    if (e.type === 'hatch') {
      const layer = e.layer || 'ハッチ';
      out.push({ type: 'poly', layer, pts: e.pts, closed: true, ...st });
      for (const [a, b] of hatchSegments(e, scaleN)) out.push({ type: 'line', layer, a, b, color: e.color });
      continue;
    }
    if (e.type !== 'align') { out.push(e); continue; }
    const g = o.alignGeom(e); if (g.err) continue;
    const layer = `路線_${e.name}`;
    for (const el of g.al.elems) {
      if (el.type === 'line') out.push({ type: 'line', layer, a: el.a, b: o.alignPoint(g.al, el.s + el.len).p });
      else {
        const end = el.curve.EC, a0 = angDxf(el.c, el.sign > 0 ? end : el.a), a1 = angDxf(el.c, el.sign > 0 ? el.a : end);
        out.push({ type: 'arc', layer, c: el.c, r: el.R, a0: (a0 + 360) % 360, a1: (a1 + 360) % 360 });
      }
    }
    for (const q of o.alignStakes(g.al, { pitch: g.pitch })) out.push({ type: 'text', layer, p: q.p, h: 1, text: q.station + (q.label ? ` ${q.label}` : '') });
  }
  return out;
}
