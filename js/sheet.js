// 施工図: 図面枠・表題欄・座標表のレイアウト、描画、PDF / DXF 出力
// 用紙座標は mm（左上原点・下向き）。図面（モデル）座標は x = X(北), y = Y(東) [m]。
import { alignPoint, alignStakes } from './cogo.js';
import { dimGeom, dimText, dimLabel, LTYPES, hatchSegments } from './draft.js';

export { dimGeom, dimText };

export const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
export const SCALES = [10, 20, 25, 50, 100, 150, 200, 250, 300, 400, 500, 600, 1000, 1200, 1500, 2000, 2500, 3000, 5000, 10000];
const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans CJK JP","Yu Gothic",Meiryo,sans-serif';
const D2R = Math.PI / 180;
const GRP_COLOR = { 基準点: '#1d4ed8', 逃げ: '#c2410c' };

export function defaultSheet(name) {
  return {
    paper: 'A3', orient: 'landscape', scale: 'auto', scaleN: 100, rot: 0,
    center: null, range: null,
    koji: name || '', title: '位置出し・逃げ杭図', author: '',
    table: true, groups: ['基準点', '位置出し', '逃げ'], grid: false, len: true,
  };
}

// ------------------------------------------------------------
// レイアウトと座標変換
// ------------------------------------------------------------
export function layout(cfg) {
  let [W, H] = PAPERS[cfg.paper] || PAPERS.A3;
  if (cfg.orient === 'portrait') [W, H] = [H, W];
  const m = 10;
  const frame = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  const tbW = Math.min(120, frame.w * 0.55), tbH = 36;
  const title = { x: frame.x + frame.w - tbW, y: frame.y + frame.h - tbH, w: tbW, h: tbH };
  let vp, panel = null;
  if (W >= H) {
    if (cfg.table) { vp = { x: frame.x, y: frame.y, w: frame.w - tbW, h: frame.h }; panel = { x: title.x, y: frame.y, w: tbW, h: frame.h - tbH }; }
    else vp = { ...frame };
  } else {
    const stripH = cfg.table ? Math.min(100, frame.h * 0.32) : tbH;
    vp = { x: frame.x, y: frame.y, w: frame.w, h: frame.h - stripH };
    if (cfg.table) panel = { x: frame.x, y: vp.y + vp.h, w: frame.w - tbW, h: stripH };
  }
  return { W, H, frame, vp, panel, title };
}

/** モデル ⇔ 用紙 の変換。rot = 用紙の上に向ける方向角（度） */
export function makeXf(cfg, L) {
  const s = cfg.scaleN / 1000; // 用紙 1mm あたりの m
  const th = (cfg.rot || 0) * D2R;
  const U = { x: Math.cos(th), y: Math.sin(th) }, R = { x: -Math.sin(th), y: Math.cos(th) };
  const vc = { x: L.vp.x + L.vp.w / 2, y: L.vp.y + L.vp.h / 2 };
  const C = cfg.center || { x: 0, y: 0 };
  return {
    s, th, U, R, vc,
    toP(p) {
      const dx = p.x - C.x, dy = p.y - C.y;
      return { x: vc.x + (dx * R.x + dy * R.y) / s, y: vc.y - (dx * U.x + dy * U.y) / s };
    },
    toM(q) {
      const u = (q.x - vc.x) * s, v = -(q.y - vc.y) * s;
      return { x: C.x + u * R.x + v * U.x, y: C.y + u * R.y + v * U.y };
    },
  };
}

/** 範囲（モデル上の点群）に合わせて中心と縮尺を決める */
export function fitRange(cfg, pts) {
  if (!pts.length) return;
  const th = (cfg.rot || 0) * D2R;
  const U = { x: Math.cos(th), y: Math.sin(th) }, R = { x: -Math.sin(th), y: Math.cos(th) };
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) {
    const u = p.x * R.x + p.y * R.y, v = p.x * U.x + p.y * U.y;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  cfg.center = { x: uc * R.x + vc * U.x, y: uc * R.y + vc * U.y };
  cfg.range = { w: Math.max(u1 - u0, 0.5), h: Math.max(v1 - v0, 0.5) };
}

export function autoScale(cfg) {
  if (cfg.scale !== 'auto') { cfg.scaleN = Number(cfg.scale) || 100; return; }
  const L = layout(cfg);
  const r = cfg.range || { w: 20, h: 20 };
  const need = Math.max((r.w * 1000) / (L.vp.w - 16), (r.h * 1000) / (L.vp.h - 16));
  cfg.scaleN = SCALES.find((k) => k >= need) || SCALES[SCALES.length - 1];
}

const niceLen = (target) => {
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const k of [1, 2, 5, 10]) if (k * p >= target) return k * p;
  return 10 * p;
};


// ------------------------------------------------------------
// 枠・表題欄・座標表など（用紙上の図形 = prims）
// ------------------------------------------------------------
/** prims: {t:'line',a,b,w} {t:'rect',x,y,w,h,lw,fill} {t:'poly',pts,fill,lw} {t:'text',p,s,text,align,bold,mono} */
export function buildPrims(cfg, L, info) {
  const P = [];
  const line = (a, b, w = 0.18) => P.push({ t: 'line', a, b, w });
  const rect = (x, y, w, h, lw = 0.18, fill) => P.push({ t: 'rect', x, y, w, h, lw, fill });
  const text = (x, y, s, t, align = 'left', o = {}) => P.push({ t: 'text', p: { x, y }, s, text: String(t), align, ...o });

  rect(L.frame.x, L.frame.y, L.frame.w, L.frame.h, 0.5);
  rect(L.vp.x, L.vp.y, L.vp.w, L.vp.h, 0.25);

  // 表題欄
  const T = L.title;
  rect(T.x, T.y, T.w, T.h, 0.35, '#ffffff');
  const rows = [
    ['工事名', cfg.koji || ''],
    ['図面名', cfg.title || ''],
    ['縮尺', `1 : ${cfg.scaleN}（${cfg.paper}）`],
    ['作成日', info.date],
    ['作成者', cfg.author || ''],
    ['座標系', info.zoneText],
  ];
  const rh = T.h / rows.length, lw = 20;
  line({ x: T.x + lw, y: T.y }, { x: T.x + lw, y: T.y + T.h });
  rows.forEach(([k, v], i) => {
    const y = T.y + rh * i;
    if (i) line({ x: T.x, y }, { x: T.x + T.w, y });
    text(T.x + lw / 2, y + rh * 0.72, 2.6, k, 'center');
    text(T.x + lw + 2, y + rh * 0.72, i < 2 ? 3.2 : 2.8, v, 'left', { bold: i === 1 });
  });

  // 座標表・凡例
  if (L.panel && cfg.table) {
    const Pn = L.panel;
    const pts = info.tablePts;
    const legendH = 9;
    text(Pn.x + 2, Pn.y + 6, 3.4, '座標表', 'left', { bold: true });
    text(Pn.x + Pn.w - 2, Pn.y + 6, 2.3, info.zoneShort, 'right');
    const top = Pn.y + 9, rowH = 4.2, headH = 5;
    const blocks = Math.max(1, Math.floor(Pn.w / 92));
    const bw = Pn.w / blocks;
    const perBlock = Math.max(1, Math.floor((Pn.h - (top - Pn.y) - headH - legendH - 2) / rowH));
    const cap = perBlock * blocks;
    const shown = pts.length > cap ? pts.slice(0, cap - 1) : pts;
    for (let b = 0; b < blocks; b++) {
      const x0 = Pn.x + b * bw;
      const c1 = x0 + bw * 0.3, c2 = x0 + bw * 0.65;
      const part = shown.slice(b * perBlock, (b + 1) * perBlock);
      if (!part.length && b) break;
      rect(x0 + 0.5, top, bw - 1, headH + part.length * rowH, 0.18);
      line({ x: x0 + 0.5, y: top + headH }, { x: x0 + bw - 0.5, y: top + headH });
      line({ x: c1, y: top }, { x: c1, y: top + headH + part.length * rowH });
      line({ x: c2, y: top }, { x: c2, y: top + headH + part.length * rowH });
      text((x0 + c1) / 2, top + headH * 0.75, 2.4, '点名', 'center');
      text((c1 + c2) / 2, top + headH * 0.75, 2.4, 'X', 'center');
      text((c2 + x0 + bw) / 2, top + headH * 0.75, 2.4, 'Y', 'center');
      part.forEach((q, i) => {
        const y = top + headH + rowH * (i + 1) - 1.1;
        text(x0 + 1.5, y, 2.3, q.name, 'left', { color: GRP_COLOR[q.grp] });
        text(c2 - 1.2, y, 2.3, q.x.toFixed(3), 'right', { mono: true });
        text(x0 + bw - 1.7, y, 2.3, q.y.toFixed(3), 'right', { mono: true });
      });
    }
    if (pts.length > cap) text(Pn.x + 2, Pn.y + Pn.h - legendH - 1, 2.3, `ほか ${pts.length - shown.length} 点（SIMA / CSV を参照）`);
    // 凡例
    let lx = Pn.x + 3;
    const ly = Pn.y + Pn.h - 3.5;
    for (const g of info.legend) {
      P.push({ t: 'sym', grp: g, p: { x: lx + 1.5, y: ly - 1 } });
      text(lx + 4, ly, 2.3, g, 'left');
      lx += 6 + g.length * 2.6;
    }
  }

  // 方位記号（真北ではなく座標北）
  const na = { x: L.vp.x + L.vp.w - 12, y: L.vp.y + 14 };
  const b = 90 + (cfg.rot || 0); // 用紙上での北の向き（右から反時計回り）
  const dir = { x: Math.cos(b * D2R), y: -Math.sin(b * D2R) };
  const nrm = { x: -dir.y, y: dir.x };
  const tip = { x: na.x + dir.x * 7, y: na.y + dir.y * 7 };
  const tail = { x: na.x - dir.x * 5, y: na.y - dir.y * 5 };
  P.push({ t: 'poly', pts: [tip, { x: tail.x + nrm.x * 3, y: tail.y + nrm.y * 3 }, na], fill: '#000', lw: 0.25 });
  P.push({ t: 'poly', pts: [tip, { x: tail.x - nrm.x * 3, y: tail.y - nrm.y * 3 }, na], fill: null, lw: 0.25 });
  text(tip.x + dir.x * 3.5, tip.y + dir.y * 3.5 + 1.3, 3.2, 'N', 'center', { bold: true });

  // スケールバー
  const lenM = niceLen((40 * cfg.scaleN) / 1000);
  const lenP = (lenM * 1000) / cfg.scaleN;
  const sx = L.vp.x + 6, sy = L.vp.y + L.vp.h - 7;
  for (let i = 0; i < 4; i++) rect(sx + (lenP / 4) * i, sy - 1.2, lenP / 4, 1.2, 0.18, i % 2 ? '#ffffff' : '#000000');
  text(sx, sy - 2.4, 2.3, '0', 'center');
  text(sx + lenP, sy - 2.4, 2.3, lenM >= 1 ? `${lenM} m` : `${Math.round(lenM * 1000)} mm`, 'center');
  return P;
}

// ------------------------------------------------------------
// Canvas への描画
// ------------------------------------------------------------
export function symbol(ctx, g, p, k = 1) {
  ctx.save();
  ctx.lineWidth = 0.2;
  ctx.strokeStyle = GRP_COLOR[g] || '#000'; ctx.fillStyle = ctx.strokeStyle;
  const r = 1.1 * k;
  ctx.beginPath();
  if (g === '基準点') {
    ctx.moveTo(p.x, p.y - r * 1.4); ctx.lineTo(p.x + r * 1.2, p.y + r * 0.8); ctx.lineTo(p.x - r * 1.2, p.y + r * 0.8); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 0.25, 0, 7); ctx.fill();
  } else if (g === '逃げ') {
    ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x - r * 0.7, p.y - r * 0.7); ctx.lineTo(p.x + r * 0.7, p.y + r * 0.7); ctx.moveTo(p.x + r * 0.7, p.y - r * 0.7); ctx.lineTo(p.x - r * 0.7, p.y + r * 0.7); ctx.stroke();
  } else {
    ctx.arc(p.x, p.y, r * 0.75, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x - r * 1.5, p.y); ctx.lineTo(p.x + r * 1.5, p.y); ctx.moveTo(p.x, p.y - r * 1.5); ctx.lineTo(p.x, p.y + r * 1.5); ctx.stroke();
  }
  ctx.restore();
}

export function ptext(ctx, t, x, y, size, { align = 'left', bold = false, mono = false, color = '#000', angle = 0, bg = false } = {}) {
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(-angle);
  ctx.font = `${bold ? '700 ' : ''}${size}px ${mono ? 'ui-monospace,Menlo,Consolas,monospace' : FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  if (bg) {
    const w = ctx.measureText(t).width;
    const x0 = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    ctx.fillStyle = '#fff'; ctx.fillRect(x0 - 0.4, -size * 0.85, w + 0.8, size * 1.05);
  }
  ctx.fillStyle = color;
  ctx.fillText(t, 0, 0);
  ctx.restore();
}

export function drawPrims(ctx, prims) {
  for (const q of prims) {
    ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
    switch (q.t) {
      case 'line': ctx.lineWidth = q.w; ctx.beginPath(); ctx.moveTo(q.a.x, q.a.y); ctx.lineTo(q.b.x, q.b.y); ctx.stroke(); break;
      case 'rect':
        if (q.fill) { ctx.fillStyle = q.fill; ctx.fillRect(q.x, q.y, q.w, q.h); }
        ctx.lineWidth = q.lw; ctx.strokeRect(q.x, q.y, q.w, q.h); break;
      case 'poly':
        ctx.beginPath(); q.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
        if (q.fill) { ctx.fillStyle = q.fill; ctx.fill(); }
        ctx.lineWidth = q.lw; ctx.stroke(); break;
      case 'text': ptext(ctx, q.text, q.p.x, q.p.y, q.s, q); break;
      case 'sym': symbol(ctx, q.grp, q.p); break;
    }
  }
}

/** 図面（モデル）部分を描く。ctx は mm 単位 */
function drawModel(ctx, cfg, L, X, data) {
  const { entities, alignGeom, grpOf, unit } = data;
  const mm = (m) => (m * 1000) / cfg.scaleN;
  ctx.save();
  ctx.beginPath(); ctx.rect(L.vp.x, L.vp.y, L.vp.w, L.vp.h); ctx.clip();

  // 座標グリッド
  if (cfg.grid) {
    const step = niceLen((40 * cfg.scaleN) / 1000);
    const cs = [X.toM({ x: L.vp.x, y: L.vp.y }), X.toM({ x: L.vp.x + L.vp.w, y: L.vp.y }), X.toM({ x: L.vp.x, y: L.vp.y + L.vp.h }), X.toM({ x: L.vp.x + L.vp.w, y: L.vp.y + L.vp.h })];
    const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 0.13; ctx.setLineDash([1.5, 1]);
    const lbl = [];
    for (let v = Math.ceil(Math.min(...xs) / step) * step; v <= Math.max(...xs); v += step) {
      const a = X.toP({ x: v, y: Math.min(...ys) }), b = X.toP({ x: v, y: Math.max(...ys) });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); lbl.push(['X=' + v.toFixed(0), a, b]);
    }
    for (let v = Math.ceil(Math.min(...ys) / step) * step; v <= Math.max(...ys); v += step) {
      const a = X.toP({ x: Math.min(...xs), y: v }), b = X.toP({ x: Math.max(...xs), y: v });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); lbl.push(['Y=' + v.toFixed(0), a, b]);
    }
    ctx.setLineDash([]);
    for (const [t, a, b] of lbl) {
      // 線が枠に入る位置にラベル
      const q = clipSeg(a, b, L.vp);
      if (q) ptext(ctx, t, q.x + 1, q.y - 0.8, 2, { color: '#6b7280', mono: true });
    }
  }

  const lineW = 0.3;
  for (const e of entities) {
    // 色・線幅・線種（data.style があればそれに従う）
    const st = data.style ? data.style(e) : {};
    const col = st.color || e.color || '#000';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = st.lw || e.lw || lineW; ctx.setLineDash(LTYPES[st.ltype || e.ltype]?.pat || []);
    if (e.dash) { ctx.strokeStyle = '#c2410c'; ctx.lineWidth = 0.18; ctx.setLineDash([1.6, 1]); }
    switch (e.type) {
      case 'point': break; // 点は最後（上に重ねる）
      case 'line': {
        const a = X.toP(e.a), b = X.toP(e.b);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        if (cfg.len && !e.layer) segLen(ctx, e.a, e.b, X, unit);
        break;
      }
      case 'poly': {
        if (e.pts.length < 2) break;
        ctx.beginPath(); e.pts.forEach((p, i) => { const q = X.toP(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        if (e.closed) ctx.closePath();
        ctx.stroke();
        if (cfg.len && !e.layer) for (let i = 0; i < e.pts.length - (e.closed ? 0 : 1); i++) segLen(ctx, e.pts[i], e.pts[(i + 1) % e.pts.length], X, unit);
        if (e.area) {
          let cx = 0, cy = 0; e.pts.forEach((p) => { cx += p.x; cy += p.y; });
          const c = X.toP({ x: cx / e.pts.length, y: cy / e.pts.length });
          ptext(ctx, `${areaOf(e.pts).toFixed(2)} ㎡`, c.x, c.y, 2.5, { align: 'center', bg: true });
        }
        break;
      }
      case 'circle': { const c = X.toP(e.c); ctx.beginPath(); ctx.arc(c.x, c.y, mm(e.r), 0, Math.PI * 2); ctx.stroke(); break; }
      case 'arc': {
        const c = X.toP(e.c), th = cfg.rot || 0;
        ctx.beginPath(); ctx.arc(c.x, c.y, mm(e.r), -(th + e.a0) * D2R, -(th + e.a1) * D2R, true); ctx.stroke(); break;
      }
      case 'text': {
        const p = X.toP(e.p);
        const size = e.hmm || mm(e.h || 1) * 1.25;
        if (size < 0.6) break;
        ptext(ctx, e.text, p.x, p.y, size, { angle: (e.hmm ? (e.rot || 0) : (cfg.rot || 0) + (e.rot || 0)) * D2R, align: e.align || 'left', color: col });
        break;
      }
      case 'dim': ctx.setLineDash([]); drawDim(ctx, e, X, unit, col); break;
      case 'hatch': {
        if (e.pts.length < 3) break;
        const path = () => { ctx.beginPath(); e.pts.forEach((q, i) => { const t = X.toP(q); i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y); }); ctx.closePath(); };
        if (e.pattern === 'solid') { path(); ctx.save(); ctx.globalAlpha = 0.35; ctx.fill(); ctx.restore(); }
        ctx.setLineDash([]); ctx.lineWidth = 0.13;
        ctx.beginPath();
        for (const [a, b] of hatchSegments(e, cfg.scaleN)) { const p = X.toP(a), q = X.toP(b); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
        ctx.stroke();
        if (e.border !== false) { ctx.lineWidth = st.lw || e.lw || 0.18; path(); ctx.stroke(); }
        break;
      }
      case 'leader': {
        const a = X.toP(e.a), b = X.toP(e.b);
        ctx.lineWidth = 0.18;
        const right = b.x >= a.x;
        const sh = { x: b.x + (right ? 1 : -1) * 2.5, y: b.y };
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(sh.x, sh.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(a.x, a.y, 0.6, 0, 7); ctx.fill();
        ptext(ctx, e.text, right ? b.x + 0.5 : b.x - 0.5, b.y - 0.8, e.hmm || 2.5, { align: right ? 'left' : 'right', color: col });
        break;
      }
      case 'align': {
        const gm = alignGeom(e); if (gm.err) break;
        ctx.strokeStyle = '#15803d'; ctx.lineWidth = 0.35;
        ctx.beginPath(); gm.poly.forEach((p, i) => { const q = X.toP(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
        ctx.lineWidth = 0.18;
        for (const st of alignStakes(gm.al, { pitch: gm.pitch })) {
          const q = X.toP(st.p);
          const r = (st.az + 90 - (cfg.rot || 0)) * D2R; // 用紙上の接線に直交
          const n = { x: Math.sin(r), y: -Math.cos(r) };
          ctx.beginPath(); ctx.moveTo(q.x - n.x * 1.5, q.y - n.y * 1.5); ctx.lineTo(q.x + n.x * 1.5, q.y + n.y * 1.5); ctx.stroke();
          ptext(ctx, st.station + (st.label ? ` ${st.label}` : ''), q.x + n.x * 2.2, q.y + n.y * 2.2, 2, { color: '#15803d' });
        }
        break;
      }
    }
  }
  ctx.setLineDash([]);
  // 点（記号と点名）
  for (const e of entities) {
    if (e.type !== 'point') continue;
    const p = X.toP(e.p);
    symbol(ctx, grpOf(e), p);
    if (e.name) ptext(ctx, e.name, p.x + 1.6, p.y - 1.2, 2.2, { color: GRP_COLOR[grpOf(e)] || '#000', bg: true });
  }
  ctx.restore();
}

function areaOf(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}

/** 用紙上の線分を読みやすい向きで、線の上に長さを書く */
function segLen(ctx, a, b, X, unit) {
  const p = X.toP(a), q = X.toP(b);
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  if (L < 12) return;
  let ang = Math.atan2(-(q.y - p.y), q.x - p.x);
  if (ang > Math.PI / 2) ang -= Math.PI; if (ang <= -Math.PI / 2) ang += Math.PI;
  const m = { x: (p.x + q.x) / 2 - Math.sin(ang) * 0.8, y: (p.y + q.y) / 2 - Math.cos(ang) * 0.8 };
  ptext(ctx, dimText(Math.hypot(b.x - a.x, b.y - a.y), unit), m.x, m.y, 2.2, { align: 'center', angle: ang });
}


function drawDim(ctx, e, X, unit, col = '#000') {
  const g = dimGeom(e);
  const a = X.toP(g.ea), b = X.toP(g.eb), a2 = X.toP(g.a2), b2 = X.toP(g.b2);
  ctx.lineWidth = 0.18; ctx.strokeStyle = col; ctx.fillStyle = col;
  const ext = (p, q) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < 0.5) return;
    const u = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
    ctx.beginPath(); ctx.moveTo(p.x + u.x * 0.8, p.y + u.y * 0.8); ctx.lineTo(q.x + u.x * 1.2, q.y + u.y * 1.2); ctx.stroke();
  };
  ext(a, a2); ext(b, b2);
  ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
  const d = Math.hypot(b2.x - a2.x, b2.y - a2.y) || 1, u = { x: (b2.x - a2.x) / d, y: (b2.y - a2.y) / d };
  if (e.term === 'arrow') {
    // 矢印（塗り）
    for (const [p, s] of [[a2, 1], [b2, -1]]) {
      const q = { x: p.x + u.x * 2.5 * s, y: p.y + u.y * 2.5 * s }, nx = -u.y * 0.6, ny = u.x * 0.6;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x + nx, q.y + ny); ctx.lineTo(q.x - nx, q.y - ny); ctx.closePath(); ctx.fill();
    }
  } else if (e.term === 'dot') {
    for (const p of [a2, b2]) { ctx.beginPath(); ctx.arc(p.x, p.y, 0.5, 0, 7); ctx.fill(); }
  } else {
    // 端部の斜線
    const t = { x: (u.x - u.y) * 0.9, y: (u.y + u.x) * 0.9 };
    ctx.lineWidth = 0.3;
    for (const p of [a2, b2]) { ctx.beginPath(); ctx.moveTo(p.x - t.x, p.y - t.y); ctx.lineTo(p.x + t.x, p.y + t.y); ctx.stroke(); }
  }
  let ang = Math.atan2(-(b2.y - a2.y), b2.x - a2.x);
  if (ang > Math.PI / 2) ang -= Math.PI; if (ang <= -Math.PI / 2) ang += Math.PI;
  const m = { x: (a2.x + b2.x) / 2 - Math.sin(ang) * 0.8, y: (a2.y + b2.y) / 2 - Math.cos(ang) * 0.8 };
  ptext(ctx, dimLabel(e, unit), m.x, m.y, e.hmm || 2.5, { align: 'center', angle: ang, color: col });
}

/** 線分 a-b が矩形 r に入る最初の点 */
function clipSeg(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const chk = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (chk(-dx, a.x - r.x) && chk(dx, r.x + r.w - a.x) && chk(-dy, a.y - r.y) && chk(dy, r.y + r.h - a.y)) {
    return { x: a.x + t0 * dx, y: a.y + t0 * dy };
  }
  return null;
}

/** 施工図を canvas に描く（pxPerMm: 1mm あたりのピクセル） */
export function renderSheet(canvas, cfg, data, pxPerMm) {
  const L = layout(cfg);
  canvas.width = Math.round(L.W * pxPerMm);
  canvas.height = Math.round(L.H * pxPerMm);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pxPerMm, 0, 0, pxPerMm, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, L.W, L.H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const X = makeXf(cfg, L);
  drawModel(ctx, cfg, L, X, data);
  drawPrims(ctx, buildPrims(cfg, L, sheetInfo(cfg, L, X, data)));
  return { L, X };
}

/** 表題欄・座標表に入れる情報 */
export function sheetInfo(cfg, L, X, data) {
  const inVp = (p) => { const q = X.toP(p); return q.x >= L.vp.x && q.x <= L.vp.x + L.vp.w && q.y >= L.vp.y && q.y <= L.vp.y + L.vp.h; };
  const order = { 位置出し: 0, 逃げ: 1, 基準点: 2, その他: 3 };
  const tablePts = data.entities
    .filter((e) => e.type === 'point' && cfg.groups.includes(data.grpOf(e)) && inVp(e.p))
    .map((e) => ({ name: e.name, x: e.p.x, y: e.p.y, grp: data.grpOf(e) }))
    .sort((a, b) => order[a.grp] - order[b.grp] || a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const legend = ['基準点', '位置出し', '逃げ'].filter((g) => data.entities.some((e) => e.type === 'point' && data.grpOf(e) === g && inVp(e.p)));
  const d = new Date();
  return {
    tablePts, legend,
    date: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    zoneText: data.zone ? `平面直角座標系 第${data.zone}系` : '任意座標',
    zoneShort: data.zone ? `第${data.zone}系・単位 m` : '単位 m',
  };
}

// ------------------------------------------------------------
// PDF（JPEG 画像 1 枚のページ）
// ------------------------------------------------------------
export function makePdf(jpeg, imgW, imgH, Wmm, Hmm) {
  const pt = (mm) => ((mm * 72) / 25.4).toFixed(2);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(Wmm)} ${pt(Hmm)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
  const content = `q ${pt(Wmm)} 0 0 ${pt(Hmm)} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

// ------------------------------------------------------------
// DXF 用: 枠・表をモデル座標の図形に
// ------------------------------------------------------------
export function sheetFrameEntities(cfg, data) {
  const L = layout(cfg);
  const X = makeXf(cfg, L);
  const s = X.s;
  const layer = '図枠';
  const out = [];
  const M = (p) => X.toM(p);
  const rotDxf = -(cfg.rot || 0);
  for (const q of buildPrims(cfg, L, sheetInfo(cfg, L, X, data))) {
    if (q.t === 'line') out.push({ type: 'line', layer, a: M(q.a), b: M(q.b) });
    else if (q.t === 'rect') out.push({ type: 'poly', layer, closed: true, pts: [M({ x: q.x, y: q.y }), M({ x: q.x + q.w, y: q.y }), M({ x: q.x + q.w, y: q.y + q.h }), M({ x: q.x, y: q.y + q.h })] });
    else if (q.t === 'poly') out.push({ type: 'poly', layer, closed: true, pts: q.pts.map(M) });
    else if (q.t === 'text' && q.text) out.push({ type: 'text', layer, p: M(q.p), h: q.s * s * 0.8, text: q.text, rot: rotDxf, align: q.align });
  }
  return { entities: out, L, X };
}

/** 用紙の枠内（ビューポート）にかかる図形か */
export function inViewport(e, L, X, verts) {
  const vs = verts(e);
  if (!vs.length) return false;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of vs) { const q = X.toP(p); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const v = L.vp;
  return !(x1 < v.x || x0 > v.x + v.w || y1 < v.y || y0 > v.y + v.h);
}

export { alignPoint };
