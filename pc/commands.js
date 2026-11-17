// パソコン版: 作図・寸法・文字・図形編集・計測のコマンド
// 各コマンドは start() でコマンドのオブジェクトを返す。
//   mode: 'point'（既定）| 'entity'（図形を選ぶ）| 'select'（対象の選択）
//   onPoint(p, snap) / onPick(e, p) / onSelected(list) / onEnter() / onBack() / preview(R, cursor)
//   prompt / opts（マルチボックスの設定）/ info（下の欄）/ lastPt（相対入力と直交の基準）
import { offsetPolyline, orientation } from '../js/cogo.js';
import { LTYPES, HATCHES, explodeForDxf, dimText } from '../js/draft.js';
import { alignPoint, alignStakes } from '../js/cogo.js';
import { xyToLL, toDMS } from '../js/geo.js';

export function commandDefs(K) {
  const G = K.G;
  const fmt = K.fmt;
  const lenU = () => K.unitLabel();
  const txt = (p, text, extra = {}) => ({ type: 'text', p: { x: p.x, y: p.y }, text, hmm: K.textH(), ...extra });
  const dimOpts = () => [
    { k: 'term', label: '端末', type: 'seg', value: () => K.prefs.term || 'tick', options: [['tick', '斜線'], ['arrow', '矢印'], ['dot', '黒丸']] },
    { k: 'hmm', label: '文字高 mm', type: 'num', value: () => Math.min(K.textH(), 3) },
  ];
  const dimStyle = (o) => { K.prefs.term = o.term; return { term: o.term, hmm: Number(o.hmm) || 2.5 }; };
  const isLine = (e) => e.type === 'line';
  const isCurve = (e) => ['line', 'poly', 'circle', 'arc'].includes(e.type);
  const showLen = (a, b) => `L=${K.fmtLen(G.dist(a, b))} ${lenU()}  方向角 ${toDMS(G.azim(a, b))}`;
  const closedPts = (e) => {
    if (e.type === 'poly' && e.closed && e.pts.length > 2) return e.pts;
    if (e.type === 'hatch') return e.pts;
    if (e.type === 'circle') return Array.from({ length: 72 }, (_, i) => G.arcPt(e.c, e.r, i * 5));
    return null;
  };

  // ------------------------------------------------------------
  // 作図
  // ------------------------------------------------------------
  function line() {
    const c = {
      pts: [],
      opts: [{ k: 'cont', label: '終点から続けて引く', type: 'check', value: false }],
      prompt: () => (c.pts.length ? `終点を指示（数値で長さ・@距離<方向角 も可）` : '始点を指示'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) {
        if (!c.pts.length) { c.pts.push(p); return; }
        if (G.dist(c.pts[0], p) < 1e-9) return;
        K.begin(); K.add({ type: 'line', a: { ...c.pts[0] }, b: { ...p } }); K.commit();
        c.pts = c.o.cont ? [p] : [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { if (c.pts.length) c.pts = []; else c.done = true; },
      preview(R, h) { if (c.pts.length) { R.line(c.pts[0], h); R.text(h, showLen(c.pts[0], h)); } },
    };
    return c;
  }
  function pline() {
    const c = {
      pts: [],
      opts: [{ k: 'closed', label: '閉じる（多角形）', type: 'check', value: false }],
      prompt: () => (c.pts.length ? `次の点を指示（${c.pts.length} 点）。［確定］で終了、C で閉じて終了` : '始点を指示'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) { if (c.pts.length && G.dist(c.lastPt, p) < 1e-9) return; c.pts.push(p); },
      onInput(t) { if (/^(c|閉)$/i.test(t)) { c.finish(true); return true; } return false; },
      finish(close) {
        if (c.pts.length >= 2) {
          K.begin(); K.add({ type: 'poly', pts: c.pts.map((p) => ({ ...p })), closed: !!close || (!!c.o.closed && c.pts.length > 2) });
          K.commit(`連続線（${c.pts.length} 点）を作図しました`);
        }
        c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { if (c.pts.length) c.finish(false); else c.done = true; },
      preview(R, h) { if (c.pts.length) { R.poly([...c.pts, h], c.o.closed); R.text(h, showLen(c.lastPt, h)); } },
    };
    return c;
  }
  function rect() {
    const c = {
      pts: [],
      opts: [{ k: 'w', label: '幅（東西）', type: 'num', value: '', unit: lenU }, { k: 'h', label: '高さ（南北）', type: 'num', value: '', unit: lenU }],
      prompt: () => (c.pts.length ? '対角の点を指示' : (Number(c.o.w) && Number(c.o.h) ? '左下の点を指示（幅・高さの矩形を置きます）' : '1つ目の角を指示')),
      get lastPt() { return c.pts[0] || null; },
      corners(a, b) { return [{ x: a.x, y: a.y }, { x: a.x, y: b.y }, { x: b.x, y: b.y }, { x: b.x, y: a.y }]; },
      make(a, b) { if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) return; K.begin(); K.add({ type: 'poly', pts: c.corners(a, b), closed: true }); K.commit(); },
      onPoint(p) {
        const w = Number(c.o.w), h = Number(c.o.h);
        if (!c.pts.length && w && h) { c.make(p, { x: p.x + K.inLen(h), y: p.y + K.inLen(w) }); return; }
        if (!c.pts.length) { c.pts.push(p); return; }
        c.make(c.pts[0], p); c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts = []; },
      onEnter() { c.done = true; },
      preview(R, h) {
        const w = Number(c.o.w), hh = Number(c.o.h);
        if (c.pts.length) R.poly(c.corners(c.pts[0], h), true);
        else if (w && hh) R.poly(c.corners(h, { x: h.x + K.inLen(hh), y: h.y + K.inLen(w) }), true, true);
      },
    };
    return c;
  }
  /** 図形 e を、点 p のある側へ d だけ平行移動した図形 */
  function offsetEnt(e, p, d) {
    if (e.type === 'line') {
      const L = G.dist(e.a, e.b), n = { x: -(e.b.y - e.a.y) / L, y: (e.b.x - e.a.x) / L };
      const s = Math.sign((p.x - e.a.x) * n.x + (p.y - e.a.y) * n.y) || 1;
      return { ...e, a: { x: e.a.x + n.x * d * s, y: e.a.y + n.y * d * s }, b: { x: e.b.x + n.x * d * s, y: e.b.y + n.y * d * s } };
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const inside = G.dist(e.c, p) < e.r;
      const r = e.r + (inside ? -d : d);
      if (r <= 0) return null;
      return { ...e, r };
    }
    if (e.type === 'poly') {
      const closed = !!e.closed && e.pts.length > 2;
      let side;
      if (closed) side = (G.pointInPoly(p, e.pts) === orientation(e.pts) > 0) ? 1 : -1;
      else {
        let best = null;
        for (let i = 0; i + 1 < e.pts.length; i++) { const dd = G.segDist(p, e.pts[i], e.pts[i + 1]); if (!best || dd < best.d) best = { d: dd, a: e.pts[i], b: e.pts[i + 1] }; }
        side = -(p.x - best.a.x) * (best.b.y - best.a.y) + (p.y - best.a.y) * (best.b.x - best.a.x) >= 0 ? 1 : -1;
      }
      return { ...e, pts: offsetPolyline(e.pts, side * d, closed) };
    }
    return null;
  }
  function offset() {
    const c = {
      mode: 'entity', filter: isCurve, src: null,
      opts: [{ k: 'd', label: '間隔', type: 'num', value: 1, unit: lenU }, { k: 'thru', label: '通過点で指示（間隔を使わない）', type: 'check', value: false }],
      prompt: () => (c.src ? '平行線を作る側をクリック' : '元になる線・連続線・円をクリック'),
      onPick(e) { c.src = e; c.mode = 'point'; },
      dist(p) {
        if (!c.o.thru) return K.inLen(c.o.d);
        const e = c.src;
        if (e.type === 'circle' || e.type === 'arc') return Math.abs(G.dist(e.c, p) - e.r);
        let m = Infinity; for (const [a, b] of K.geo(e).segs) m = Math.min(m, G.segDist(p, a, b)); return m;
      },
      onPoint(p) {
        const d = c.dist(p);
        if (!(d > 0)) { K.toast('間隔を正の数で入力してください'); return; }
        const n = offsetEnt(c.src, p, d);
        if (!n) { K.toast('この大きさでは作れません'); return; }
        delete n.id; delete n.uid;
        K.begin(); K.add(n, { style: false }); K.commit();
        c.src = null; c.mode = 'entity';
      },
      canBack: () => !!c.src, onBack() { c.src = null; c.mode = 'entity'; },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.src && c.mode === 'point') { const n = offsetEnt(c.src, h, c.dist(h)); if (n) R.ents([n]); } },
    };
    return c;
  }
  function circle() {
    const c = {
      pts: [],
      opts: [{ k: 'r', label: '半径（空欄はクリックで）', type: 'num', value: '', unit: lenU }],
      prompt: () => (c.pts.length ? '円周上の点を指示（数値で半径）' : (Number(c.o.r) ? '中心を指示（半径は設定値）' : '中心を指示')),
      get lastPt() { return c.pts[0] || null; },
      add(cn, r) { if (!(r > 0)) return; K.begin(); K.add({ type: 'circle', c: { ...cn }, r }); K.commit(); c.pts = []; },
      onPoint(p) {
        if (!c.pts.length) { if (Number(c.o.r)) c.add(p, K.inLen(c.o.r)); else c.pts.push(p); return; }
        c.add(c.pts[0], G.dist(c.pts[0], p));
      },
      onInput(t) { const n = Number(t); if (c.pts.length && Number.isFinite(n)) { c.add(c.pts[0], K.inLen(n)); return true; } return false; },
      canBack: () => c.pts.length > 0, onBack() { c.pts = []; },
      onEnter() { c.done = true; },
      preview(R, h) {
        if (c.pts.length) { R.circle(c.pts[0], G.dist(c.pts[0], h)); R.line(c.pts[0], h, true); R.text(h, `R=${K.fmtLen(G.dist(c.pts[0], h))}`); }
        else if (Number(c.o.r)) R.circle(h, K.inLen(c.o.r), true);
      },
    };
    return c;
  }
  function circum(a, b, d) {
    const bx = b.y - a.y, by = b.x - a.x, cx = d.y - a.y, cy = d.x - a.x;
    const D = 2 * (bx * cy - by * cx);
    if (Math.abs(D) < 1e-12) return null;
    const ux = (cy * (bx * bx + by * by) - by * (cx * cx + cy * cy)) / D;
    const uy = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / D;
    const cn = { x: a.x + uy, y: a.y + ux };
    return { c: cn, r: G.dist(cn, a) };
  }
  function circle3() {
    const c = {
      pts: [],
      prompt: () => `円周上の ${c.pts.length + 1} 点目を指示`,
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) {
        c.pts.push(p);
        if (c.pts.length < 3) return;
        const cc = circum(...c.pts);
        c.pts = [];
        if (!cc) { K.toast('3点が一直線上にあります'); return; }
        K.begin(); K.add({ type: 'circle', c: cc.c, r: cc.r }); K.commit();
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length === 2) { const cc = circum(c.pts[0], c.pts[1], h); if (cc) R.circle(cc.c, cc.r); } else if (c.pts.length === 1) R.line(c.pts[0], h, true); },
    };
    return c;
  }
  function arc() {
    const c = {
      pts: [],
      opts: [{ k: 'dir', label: '向き', type: 'seg', value: 'ccw', options: [['ccw', '左回り'], ['cw', '右回り']] }],
      prompt: () => ['中心を指示', '始点を指示（半径が決まります）', '終点の方向を指示'][c.pts.length],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      make(h) {
        const [cn, s] = c.pts, r = G.dist(cn, s);
        let a0 = G.angOf(cn, s), a1 = G.angOf(cn, h);
        if (c.o.dir === 'cw') [a0, a1] = [a1, a0];
        return { type: 'arc', c: { ...cn }, r, a0, a1 };
      },
      onPoint(p) {
        if (c.pts.length < 2) { if (c.pts.length === 1 && G.dist(c.pts[0], p) < 1e-9) return; c.pts.push(p); return; }
        K.begin(); K.add(c.make(p)); K.commit(); c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) {
        if (c.pts.length === 1) { R.line(c.pts[0], h, true); R.circle(c.pts[0], G.dist(c.pts[0], h), true); }
        if (c.pts.length === 2) { R.ents([c.make(h)]); R.line(c.pts[0], h, true); }
      },
    };
    return c;
  }
  function arcFrom3(p1, p2, p3) {
    const cc = circum(p1, p2, p3); if (!cc) return null;
    const a1 = G.angOf(cc.c, p1), a2 = G.angOf(cc.c, p2), a3 = G.angOf(cc.c, p3);
    return G.inArc(a2, a1, a3) ? { type: 'arc', c: cc.c, r: cc.r, a0: a1, a1: a3 } : { type: 'arc', c: cc.c, r: cc.r, a0: a3, a1: a1 };
  }
  function arc3() {
    const c = {
      pts: [],
      prompt: () => ['始点を指示', '通過点を指示', '終点を指示'][c.pts.length],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) {
        c.pts.push(p);
        if (c.pts.length < 3) return;
        const a = arcFrom3(...c.pts); c.pts = [];
        if (!a) { K.toast('3点が一直線上にあります'); return; }
        K.begin(); K.add(a); K.commit();
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length === 2) { const a = arcFrom3(c.pts[0], c.pts[1], h); if (a) R.ents([a]); } else if (c.pts.length === 1) R.line(c.pts[0], h, true); },
    };
    return c;
  }
  const grpOpt = () => ({ k: 'grp', label: '種別', type: 'select', value: () => K.prefs.ptGrp || '位置出し', options: K.GROUPS.map((g) => [g, g]) });
  function point() {
    const c = {
      opts: [grpOpt(), { k: 'name', label: '点名（空欄は自動）', type: 'text', value: '' }, { k: 'z', label: '標高 Z', type: 'num', value: 0 }],
      prompt: () => `点の位置を指示（次の点名 ${c.o.name || K.nextPointName(true)}）。座標は「X,Y」で入力`,
      info: () => '<p>測点（位置出し・逃げ・基準点など）を置きます。SIMA で TS に送れます。</p>',
      onPoint(p) {
        const name = c.o.name ? K.uniqueName(c.o.name) : K.nextPointName();
        K.prefs.ptGrp = c.o.grp;
        K.begin(); K.add({ type: 'point', p: { ...p }, z: Number(c.o.z) || 0, name, grp: c.o.grp }); K.commit(`点 ${name} を置きました`);
        if (c.o.name) { const m = c.o.name.match(/^(.*?)(\d+)$/); c.o.name = m ? m[1] + (Number(m[2]) + 1) : ''; c.opts = [...c.opts]; }
      },
      onEnter() { c.done = true; },
    };
    return c;
  }
  /** 図形上の位置（曲線長 s）にある点 */
  function pathOf(e) {
    if (e.type === 'line') return { pts: [e.a, e.b], closed: false };
    if (e.type === 'poly') return { pts: e.pts, closed: !!e.closed };
    if (e.type === 'arc') { const span = G.norm360(e.a1 - e.a0) || 360; const n = 360; return { pts: Array.from({ length: n + 1 }, (_, i) => G.arcPt(e.c, e.r, e.a0 + (span * i) / n)), closed: false }; }
    if (e.type === 'circle') return { pts: Array.from({ length: 361 }, (_, i) => G.arcPt(e.c, e.r, i)), closed: false };
    return null;
  }
  function divide() {
    const c = {
      mode: 'entity', filter: isCurve,
      opts: [{ k: 'n', label: '分割数', type: 'num', value: 4 }, grpOpt()],
      prompt: '等分点を付ける線・円弧・連続線をクリック',
      onPick(e) {
        const n = Math.round(Number(c.o.n));
        if (!(n >= 2 && n <= 1000)) { K.toast('分割数は 2〜1000'); return; }
        const out = [];
        if (e.type === 'circle') for (let i = 0; i < n; i++) out.push(G.arcPt(e.c, e.r, (360 * i) / n));
        else if (e.type === 'arc') { const span = G.norm360(e.a1 - e.a0) || 360; for (let i = 1; i < n; i++) out.push(G.arcPt(e.c, e.r, e.a0 + (span * i) / n)); }
        else {
          const { pts, closed } = pathOf(e);
          const all = closed ? [...pts, pts[0]] : pts;
          const L = G.polyLen(all, false);
          for (let i = 1; i < n; i++) out.push(atLen(all, (L * i) / n));
        }
        K.begin();
        for (const p of out) if (!K.pointAt(p)) K.add({ type: 'point', p, z: 0, name: K.nextPointName(), grp: c.o.grp });
        K.commit(`等分点を ${out.length} 点置きました`);
      },
      onEnter() { c.done = true; },
    };
    return c;
  }
  function atLen(pts, s) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const L = G.dist(pts[i], pts[i + 1]);
      if (s <= L + 1e-12) { const t = L ? s / L : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; }
      s -= L;
    }
    return { ...pts[pts.length - 1] };
  }
  function text() {
    const c = {
      opts: [
        { k: 'text', label: '文字', type: 'textarea', value: '' },
        { k: 'hmm', label: '文字高 mm', type: 'num', value: () => K.textH() },
        { k: 'rot', label: '角度（度）', type: 'num', value: 0 },
        { k: 'align', label: '基点', type: 'seg', value: 'left', options: [['left', '左'], ['center', '中'], ['right', '右']] },
      ],
      prompt: () => (String(c.o.text || '').trim() ? '文字を置く位置を指示' : '左の欄に文字を入力して、置く位置を指示'),
      onPoint(p) {
        const t = String(c.o.text || '').trim();
        if (!t) { K.toast('先に文字を入力してください'); document.getElementById('opt_text')?.focus(); return; }
        K.begin(); K.add(txt(p, t, { hmm: Number(c.o.hmm) || K.textH(), rot: Number(c.o.rot) || 0, align: c.o.align })); K.commit();
      },
      onEnter() { c.done = true; },
      preview(R, h) { const t = String(c.o.text || '').trim(); if (t) R.ents([txt(h, t, { hmm: Number(c.o.hmm) || K.textH(), rot: Number(c.o.rot) || 0, align: c.o.align, layer: K.style().layer })]); },
    };
    setTimeout(() => document.getElementById('opt_text')?.focus(), 0);
    return c;
  }
  function leader() {
    const c = {
      pts: [],
      opts: [{ k: 'text', label: '文字', type: 'text', value: '' }, { k: 'hmm', label: '文字高 mm', type: 'num', value: () => K.textH() }],
      prompt: () => (c.pts.length ? '文字を書く位置（旗の位置）を指示' : '引き出す先（矢じりの点）を指示'),
      get lastPt() { return c.pts[0] || null; },
      onPoint(p) {
        if (!c.pts.length) { c.pts.push(p); return; }
        const t = String(c.o.text || '').trim();
        if (!t) { K.toast('文字を入力してください'); document.getElementById('opt_text')?.focus(); return; }
        K.begin(); K.add({ type: 'leader', a: { ...c.pts[0] }, b: { ...p }, text: t, hmm: Number(c.o.hmm) || 2.5 }); K.commit();
        c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts = []; },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length) R.ents([{ type: 'leader', a: c.pts[0], b: h, text: c.o.text || '（文字）', hmm: Number(c.o.hmm) || 2.5 }]); },
    };
    return c;
  }

  // 寸法
  function dimAligned() {
    const c = {
      pts: [], opts: dimOpts(),
      prompt: () => ['寸法の始点を指示', '寸法の終点を指示', '寸法線の位置を指示'][c.pts.length],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      make(h) {
        const [a, b] = c.pts, L = G.dist(a, b), n = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
        return { type: 'dim', a: { ...a }, b: { ...b }, off: (h.x - a.x) * n.x + (h.y - a.y) * n.y, ...dimStyle(c.o) };
      },
      onPoint(p) {
        if (c.pts.length === 1 && G.dist(c.pts[0], p) < 1e-9) return;
        if (c.pts.length < 2) { c.pts.push(p); return; }
        K.begin(); K.add(c.make(p)); K.commit(); c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length === 1) R.line(c.pts[0], h, true); if (c.pts.length === 2) R.ents([c.make(h)]); },
    };
    return c;
  }
  /** 水平（東西）・垂直（南北）寸法。axis: 'h' | 'v' */
  function dimHV(axis) {
    const c = {
      pts: [], opts: dimOpts(),
      prompt: () => ['寸法の始点を指示', '寸法の終点を指示', '寸法線の位置を指示'][c.pts.length],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      make(h) {
        const [p1, p2] = c.pts;
        const a = axis === 'h' ? { x: h.x, y: p1.y } : { x: p1.x, y: h.y };
        const b = axis === 'h' ? { x: h.x, y: p2.y } : { x: p2.x, y: h.y };
        return { type: 'dim', a, b, off: 0, pa: { ...p1 }, pb: { ...p2 }, ...dimStyle(c.o) };
      },
      onPoint(p) {
        if (c.pts.length === 1) { const d = axis === 'h' ? Math.abs(p.y - c.pts[0].y) : Math.abs(p.x - c.pts[0].x); if (d < 1e-9) { K.toast(axis === 'h' ? '東西方向に離れた点を指示してください' : '南北方向に離れた点を指示してください'); return; } }
        if (c.pts.length < 2) { c.pts.push(p); return; }
        K.begin(); K.add(c.make(p)); K.commit(); c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length === 1) R.line(c.pts[0], h, true); if (c.pts.length === 2) R.ents([c.make(h)]); },
    };
    return c;
  }
  function dimSeries() {
    const c = {
      pts: [], base: null, opts: dimOpts(),
      prompt: () => (c.pts.length === 0 ? '最初の点を指示' : c.pts.length === 1 ? '次の点を指示（この2点の方向に測ります）' : !c.base ? '寸法線の位置を指示' : '続けて次の点を指示（［確定］で終わり）'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      proj(p) { const { O, u } = c.base; const s = (p.x - O.x) * u.x + (p.y - O.y) * u.y; return { x: O.x + u.x * s, y: O.y + u.y * s }; },
      make(p0, p1) { return { type: 'dim', a: c.proj(p0), b: c.proj(p1), off: 0, pa: { ...p0 }, pb: { ...p1 }, ...dimStyle(c.o) }; },
      onPoint(p) {
        if (c.pts.length && G.dist(c.lastPt, p) < 1e-9 && c.base) return;
        if (c.pts.length < 2) { c.pts.push(p); return; }
        if (!c.base) {
          const [a, b] = c.pts, L = G.dist(a, b);
          if (L < 1e-9) { c.pts.pop(); return; }
          c.base = { O: { ...p }, u: { x: (b.x - a.x) / L, y: (b.y - a.y) / L } };
          K.begin(); K.add(c.make(a, b)); K.commit(); return;
        }
        const prev = c.lastPt;
        if (G.dist(c.proj(prev), c.proj(p)) < 1e-9) return;
        K.begin(); K.add(c.make(prev, p)); K.commit();
        c.pts.push(p);
      },
      canBack: () => c.pts.length > 0 && !c.base, onBack() { c.pts.pop(); },
      onEnter() { if (c.pts.length) { c.pts = []; c.base = null; } else c.done = true; },
      preview(R, h) {
        if (c.pts.length === 1) R.line(c.pts[0], h, true);
        else if (c.pts.length === 2 && !c.base) { const [a, b] = c.pts, L = G.dist(a, b); if (L > 0) { c.base = { O: h, u: { x: (b.x - a.x) / L, y: (b.y - a.y) / L } }; R.ents([c.make(a, b)]); c.base = null; } }
        else if (c.base) R.ents([c.make(c.lastPt, h)]);
      },
    };
    return c;
  }
  function dimRadius() {
    const c = {
      mode: 'entity', filter: (e) => e.type === 'circle' || e.type === 'arc', src: null,
      opts: [{ k: 'dia', label: '直径で書く（φ）', type: 'check', value: false }, { k: 'hmm', label: '文字高 mm', type: 'num', value: () => Math.min(K.textH(), 3) }],
      prompt: () => (c.src ? '寸法の文字を書く位置を指示' : '円・円弧をクリック'),
      onPick(e) { c.src = e; c.mode = 'point'; },
      make(p) {
        const e = c.src, a = G.angOf(e.c, p), edge = G.arcPt(e.c, e.r, a);
        const v = c.o.dia ? e.r * 2 : e.r;
        const label = (c.o.dia ? 'φ' : 'R') + (K.dimUnit() === 'mm' ? dimText(v, 'mm') : fmt(v));
        const ents = [{ type: 'leader', a: edge, b: { ...p }, text: label, hmm: Number(c.o.hmm) || 2.5 }];
        ents.push({ type: 'line', a: c.o.dia ? G.arcPt(e.c, e.r, a + 180) : { ...e.c }, b: edge });
        return ents;
      },
      onPoint(p) { K.begin(); for (const n of c.make(p)) K.add(n); K.commit(); c.src = null; c.mode = 'entity'; },
      canBack: () => !!c.src, onBack() { c.src = null; c.mode = 'entity'; },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.src && c.mode === 'point') R.ents(c.make(h)); },
    };
    return c;
  }
  function dimAngle() {
    const c = {
      pts: [],
      opts: [{ k: 'hmm', label: '文字高 mm', type: 'num', value: () => Math.min(K.textH(), 3) }],
      prompt: () => ['角の頂点を指示', '1本目の辺上の点を指示', '2本目の辺上の点を指示', '寸法の円弧の位置を指示'][c.pts.length],
      get lastPt() { return c.pts[0] || null; },
      make(h) {
        const [o, a, b] = c.pts, r = Math.max(G.dist(o, h), 1e-6);
        const t1 = G.angOf(o, a), t2 = G.angOf(o, b), th = G.angOf(o, h);
        let a0 = t1, a1 = t2;
        if (!G.inArc(th, t1, t2)) { a0 = t2; a1 = t1; }
        const span = G.norm360(a1 - a0);
        const m = G.arcPt(o, r + K.mm(1.2), a0 + span / 2);
        return [{ type: 'arc', c: { ...o }, r, a0, a1 }, txt(m, toDMS(span, 0), { hmm: Number(c.o.hmm) || 2.5, align: 'center' })];
      },
      onPoint(p) {
        if (c.pts.length && G.dist(c.pts[0], p) < 1e-9) return;
        if (c.pts.length < 3) { c.pts.push(p); return; }
        K.begin(); for (const n of c.make(p)) K.add(n); K.commit(); c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) { if (c.pts.length >= 1 && c.pts.length < 3) R.line(c.pts[0], h, true); if (c.pts.length === 3) { R.line(c.pts[0], c.pts[1], true); R.line(c.pts[0], c.pts[2], true); R.ents(c.make(h)); } },
    };
    return c;
  }

  // ハッチング・求積図形・方位記号
  function hatch() {
    const c = {
      pts: [], mode: 'entity', filter: (e) => !!closedPts(e),
      opts: [
        { k: 'how', label: '範囲', type: 'seg', value: 'pick', options: [['pick', '図形を選ぶ'], ['pts', '点で囲む']] },
        { k: 'pattern', label: '模様', type: 'select', value: () => K.prefs.hatch.pattern, options: Object.entries(HATCHES) },
        { k: 'pitch', label: '間隔 mm', type: 'num', value: () => K.prefs.hatch.pitch },
        { k: 'ang', label: '角度', type: 'num', value: () => K.prefs.hatch.ang },
      ],
      prompt: () => (c.o.how === 'pts' ? (c.pts.length ? `次の点（${c.pts.length} 点）。［確定］で塗る` : '範囲の1点目を指示') : '閉じた連続線・円・多角形をクリック'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onOpt(k, v) { if (k === 'how') { c.mode = v === 'pts' ? 'point' : 'entity'; c.pts = []; } },
      make(pts) {
        K.prefs.hatch = { pattern: c.o.pattern, pitch: Number(c.o.pitch) || 2, ang: Number(c.o.ang) || 0 };
        return { type: 'hatch', pts: pts.map((p) => ({ x: p.x, y: p.y })), pattern: c.o.pattern, pitch: Number(c.o.pitch) || 2, ang: Number(c.o.ang) || 0, border: c.o.how === 'pts' };
      },
      onPick(e) { K.begin(); K.add(c.make(closedPts(e))); K.commit('ハッチングしました'); },
      onPoint(p) { c.pts.push(p); },
      onEnter() {
        if (c.o.how === 'pts' && c.pts.length >= 3) { K.begin(); K.add(c.make(c.pts)); K.commit('ハッチングしました'); c.pts = []; } else c.done = true;
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      preview(R, h) { if (c.o.how === 'pts' && c.pts.length) R.poly([...c.pts, h], true); },
    };
    return c;
  }
  function areafig() {
    const c = {
      pts: [],
      opts: [{ k: 'reg', label: '頂点を点として登録', type: 'check', value: false }],
      prompt: () => (c.pts.length ? `次の頂点を指示（${c.pts.length} 点・${fmt(G.polyArea(c.pts), 3)} ㎡）。［確定］で閉じる` : '1つ目の頂点を指示'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) { c.pts.push(p); },
      onEnter() {
        if (c.pts.length < 3) { c.done = true; return; }
        K.begin();
        if (c.o.reg) for (const p of c.pts) K.ensurePoint(p, 'その他');
        K.add({ type: 'poly', pts: c.pts.map((p) => ({ ...p })), closed: true, area: true });
        K.commit(`面積 ${fmt(G.polyArea(c.pts), 3)} ㎡ の求積図形を作りました`);
        c.pts = [];
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      preview(R, h) { if (c.pts.length) { R.poly([...c.pts, h], true); R.text(h, `${fmt(G.polyArea([...c.pts, h]), 3)} ㎡`); } },
    };
    return c;
  }
  function north() {
    const c = {
      opts: [{ k: 'size', label: '大きさ mm', type: 'num', value: 15 }],
      prompt: '方位記号を置く位置を指示（北が上の矢印）',
      make(p) {
        const L = K.mm(Number(c.o.size) || 15), w = L * 0.28;
        const tip = { x: p.x + L / 2, y: p.y }, tail = { x: p.x - L / 2, y: p.y };
        return [
          { type: 'poly', closed: true, pts: [tip, { x: tail.x, y: p.y + w }, { x: tail.x + L * 0.25, y: p.y }, { x: tail.x, y: p.y - w }] },
          { type: 'hatch', pattern: 'solid', border: false, pts: [tip, { x: tail.x + L * 0.25, y: p.y }, { x: tail.x, y: p.y - w }] },
          txt({ x: tip.x + K.mm(1.5), y: p.y }, 'N', { hmm: Math.max(2.5, (Number(c.o.size) || 15) * 0.25), align: 'center' }),
        ];
      },
      onPoint(p) { K.begin(); for (const e of c.make(p)) K.add(e); K.commit(); c.done = true; },
      preview(R, h) { R.ents(c.make(h)); },
    };
    return c;
  }

  // ------------------------------------------------------------
  // 図形編集
  // ------------------------------------------------------------
  const strip = (e) => { const n = JSON.parse(JSON.stringify(e)); delete n.id; delete n.uid; delete n.t; return n; };
  /** 移動・複写・回転・反転・拡大の共通部分 */
  function transformCmd({ copy, kind }) {
    const c = {
      pts: [], selection: [],
      opts: [],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onSelected(list) { c.selection = list; c.mode = 'point'; },
      fn(h) {
        const [p0] = c.pts;
        if (kind === 'move') return { f: G.fMove(h.x - p0.x, h.y - p0.y), info: {} };
        if (kind === 'rotate') { const a = c.angle(h); return { f: G.fRotate(p0, a), info: { ang: a } }; }
        if (kind === 'scale') { const k = Number(c.o.k) || 1; return { f: G.fScale(p0, k), info: { k } }; }
        if (kind === 'mirror') { const axisAng = G.angOf(p0, h); return { f: G.fMirror(p0, h), info: { mirror: true, axisAng } }; }
        return null;
      },
      angle(h) { if (c.o.useAng || !h) return Number(c.o.ang) || 0; return G.angOf(c.pts[0], h); },
      mapped(h) { const { f, info } = c.fn(h); return c.selection.map((e) => G.mapEntity(e, f, info)); },
      apply(h) {
        const out = c.mapped(h);
        K.begin();
        if (copy || (kind === 'mirror' && c.o.keep)) { const added = out.map((n) => K.add(strip(n), { style: false })); K.commit(`${added.length} 個を${copy ? '複写' : '反転複写'}しました`); if (!copy) K.setSel(added); }
        else { c.selection.forEach((e, i) => K.replace(e, { ...out[i], uid: e.uid })); K.commit(`${out.length} 個の図形を${{ move: '移動', rotate: '回転', mirror: '反転', scale: '拡大縮小' }[kind]}しました`); K.setSel(c.selection); }
      },
      onPoint(p) {
        if (!c.pts.length) {
          c.pts.push(p);
          if (kind === 'scale' || (kind === 'rotate' && c.o.useAng)) { c.apply(p); c.done = true; }
          return;
        }
        if (G.dist(c.pts[0], p) < 1e-12 && kind !== 'move') return;
        c.apply(p);
        if (copy) return; // 複写は続けて置ける
        c.done = true;
      },
      onInput(t) {
        if (kind === 'rotate' && c.pts.length) { const a = Number(t); if (Number.isFinite(a)) { c.o.ang = a; c.o.useAng = true; c.apply(null); c.done = true; return true; } }
        return false;
      },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      onEnter() { c.done = true; },
      preview(R, h) {
        if (!c.pts.length) { if (kind === 'scale') { c.pts = [h]; R.ents(c.mapped(h)); c.pts = []; } return; }
        R.line(c.pts[0], h, true);
        R.ents(c.mapped(h));
        if (kind === 'rotate') R.text(h, `${fmt(c.angle(h), 2)}°`);
        if (kind === 'move' || copy) R.text(h, showLen(c.pts[0], h));
      },
    };
    if (kind === 'move' || kind === 'copy') c.prompt = () => (c.pts.length ? '移動先の点を指示（@ΔX,ΔY・@距離<方向角 も可）' : '基準点を指示');
    if (copy) c.prompt = () => (c.pts.length ? '複写先の点を指示（続けて置けます。［確定］で終了）' : '基準点を指示');
    if (kind === 'rotate') {
      c.opts = [{ k: 'ang', label: '角度（左回り＋）', type: 'num', value: 90 }, { k: 'useAng', label: '角度を数値で指定', type: 'check', value: false }];
      c.prompt = () => (c.pts.length ? '回転後の向き（東を0°として）を指示、または角度を入力' : (c.o.useAng ? `回転の中心を指示（${c.o.ang}° 回転）` : '回転の中心を指示'));
    }
    if (kind === 'scale') { c.opts = [{ k: 'k', label: '倍率', type: 'num', value: 2 }]; c.prompt = () => `拡大・縮小の基準点を指示（倍率 ${c.o.k}）`; }
    if (kind === 'mirror') { c.opts = [{ k: 'keep', label: '元の図形を残す', type: 'check', value: false }]; c.prompt = () => (c.pts.length ? '反転の軸の2点目を指示' : '反転の軸の1点目を指示'); }
    return c;
  }
  function arrayCmd() {
    const c = {
      pts: [], selection: [],
      opts: [
        { k: 'how', label: '方法', type: 'seg', value: 'vec', options: [['vec', '方向と間隔'], ['grid', '縦横']] },
        { k: 'n', label: '個数（元を含む）', type: 'num', value: 3 },
        { k: 'cols', label: '列数（東西）', type: 'num', value: 3 }, { k: 'rows', label: '行数（南北）', type: 'num', value: 2 },
        { k: 'dx', label: '列の間隔', type: 'num', value: 5, unit: lenU }, { k: 'dy', label: '行の間隔', type: 'num', value: 5, unit: lenU },
      ],
      get lastPt() { return c.pts[0] || null; },
      prompt: () => (c.o.how === 'grid' ? '［確定］で縦横に並べます（列は東向き、行は北向き）' : c.pts.length ? '2つ目の図形の位置（間隔と方向）を指示' : '基準点を指示'),
      onSelected(list) { c.selection = list; c.mode = 'point'; },
      copies(h) {
        const out = [];
        if (c.o.how === 'grid') {
          const cols = Math.max(1, Math.round(c.o.cols)), rows = Math.max(1, Math.round(c.o.rows)), dx = K.inLen(c.o.dx), dy = K.inLen(c.o.dy);
          for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) if (i || j) out.push(...c.selection.map((e) => G.mapEntity(e, G.fMove(j * dy, i * dx))));
        } else if (c.pts.length && h) {
          const n = Math.max(2, Math.round(c.o.n)), v = { x: h.x - c.pts[0].x, y: h.y - c.pts[0].y };
          for (let i = 1; i < n; i++) out.push(...c.selection.map((e) => G.mapEntity(e, G.fMove(v.x * i, v.y * i))));
        }
        return out;
      },
      apply(h) {
        const out = c.copies(h);
        if (out.length > 20000) { K.toast('数が多すぎます'); return; }
        K.begin(); out.forEach((n) => K.add(strip(n), { style: false })); K.commit(`${out.length} 個を複写しました`); c.done = true;
      },
      onPoint(p) { if (c.o.how === 'grid') return; if (!c.pts.length) { c.pts.push(p); return; } c.apply(p); },
      onEnter() { if (c.o.how === 'grid') c.apply(null); else c.done = true; },
      canBack: () => c.pts.length > 0, onBack() { c.pts = []; },
      preview(R, h) { const out = c.copies(h); if (out.length < 3000) R.ents(out); },
    };
    return c;
  }
  function erase() {
    const c = {
      mode: 'entity',
      prompt: '消す図形をクリック（ドラッグで範囲内をまとめて削除）。［確定］で終了',
      onPick(e) { K.begin(); K.remove([e]); K.commit(); },
      onWindow(rect, crossing) {
        const list = K.visibleEnts().filter((e) => { const b = K.bbox(e); if (!b) return false; return crossing ? !(b.x1 < rect.x0 || b.x0 > rect.x1 || b.y1 < rect.y0 || b.y0 > rect.y1) : (b.x0 >= rect.x0 && b.x1 <= rect.x1 && b.y0 >= rect.y0 && b.y1 <= rect.y1); });
        if (!list.length) return;
        K.begin(); K.remove(list); K.commit(`${list.length} 個を削除しました`);
      },
      onEnter() { c.done = true; },
    };
    const s = K.sel;
    if (s.length) { K.begin(); K.remove(s); K.commit(`${s.length} 個を削除しました`); }
    c.mode = 'entity';
    return c;
  }
  /** 図形と他の図形の交点（e の線上の位置） */
  function crossings(e, extendSelf = false) {
    const g = K.geo(e), b = K.bbox(e), out = [];
    for (const o of K.visibleEnts()) {
      if (o === e || o.type === 'text' || o.type === 'point') continue;
      const ob = K.bbox(o);
      if (!ob || (!extendSelf && b && (ob.x1 < b.x0 || ob.x0 > b.x1 || ob.y1 < b.y0 || ob.y0 > b.y1))) continue;
      out.push(...G.intersections(g, K.geo(o), false));
    }
    return out;
  }
  /** 線 e の、クリック位置 p に近い方の端を、境界図形 bnd との交点まで伸ばす／縮める */
  function stretchTo(e, p, bnd) {
    const bg = K.geo(bnd);
    if (e.type === 'line' || (e.type === 'poly' && !e.closed)) {
      const isPoly = e.type === 'poly';
      const n = isPoly ? e.pts.length : 2;
      const A = isPoly ? e.pts[0] : e.a, B = isPoly ? e.pts[n - 1] : e.b;
      const nearEnd = G.dist(p, A) < G.dist(p, B) ? 0 : 1;
      const a = nearEnd === 0 ? (isPoly ? e.pts[1] : e.b) : (isPoly ? e.pts[n - 2] : e.a);
      const end = nearEnd === 0 ? A : B;
      const ls = { segs: [[a, end]], arcs: [] };
      let best = null;
      for (const q of G.intersections(ls, bg, true)) {
        const { t } = G.projectOnSeg(q, a, end, false);
        if (t <= 1e-9) continue;
        // 境界は実際の範囲内のみ
        const onB = bg.segs.some(([s0, s1]) => G.segDist(q, s0, s1) < 1e-7) || bg.arcs.some((A2) => Math.abs(G.dist(A2.c, q) - A2.r) < 1e-7 && (A2.full || G.inArc(G.angOf(A2.c, q), A2.a0, A2.a1)));
        if (!onB) continue;
        const d = G.dist(q, end);
        if (!best || d < best.d) best = { q, d };
      }
      if (!best) return null;
      const n2 = JSON.parse(JSON.stringify(e));
      if (isPoly) n2.pts[nearEnd === 0 ? 0 : n - 1] = best.q; else if (nearEnd === 0) n2.a = best.q; else n2.b = best.q;
      return n2;
    }
    return null;
  }
  function stretch() {
    const c = {
      mode: 'entity', bnd: null, filter: (e) => ['line', 'poly', 'circle', 'arc', 'hatch'].includes(e.type),
      prompt: () => (c.bnd ? '伸び縮みさせる線を、動かす端の近くでクリック（続けてできます）' : 'まず基準になる線（ここまで伸ばす・縮める）をクリック'),
      onPick(e, p) {
        if (!c.bnd) { c.bnd = e; c.filter = (q) => q !== c.bnd && (q.type === 'line' || (q.type === 'poly' && !q.closed)); K.setSel([e]); return; }
        const n = stretchTo(e, p, c.bnd);
        if (!n) { K.toast('基準線と交わりません'); return; }
        K.begin(); K.replace(e, n); K.commit(); K.setSel([c.bnd]);
      },
      canBack: () => !!c.bnd, onBack() { c.bnd = null; c.filter = (e) => ['line', 'poly', 'circle', 'arc', 'hatch'].includes(e.type); K.clearSel(); },
      onEnter() { c.done = true; },
      onEnd() { K.clearSel(); },
    };
    return c;
  }
  /** 連続線の一部（曲線長 s0〜s1）を取り出す */
  function subPath(pts, s0, s1) {
    const out = [atLen(pts, s0)];
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      acc += G.dist(pts[i], pts[i + 1]);
      if (acc > s0 + 1e-9 && acc < s1 - 1e-9) out.push({ ...pts[i + 1] });
    }
    out.push(atLen(pts, s1));
    return out;
  }
  function trimEnt(e, p) {
    const xs = crossings(e);
    if (e.type === 'line' || e.type === 'poly') {
      const closed = e.type === 'poly' && e.closed && e.pts.length > 2;
      const pts = e.type === 'line' ? [e.a, e.b] : closed ? [...e.pts, e.pts[0]] : e.pts;
      const cum = [0]; for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i] + G.dist(pts[i], pts[i + 1]));
      const total = cum[cum.length - 1];
      const param = (q) => { let best = null; for (let i = 0; i + 1 < pts.length; i++) { const r = G.projectOnSeg(q, pts[i], pts[i + 1]); const d = G.dist(r.q, q); if (!best || d < best.d) best = { d, s: cum[i] + r.t * (cum[i + 1] - cum[i]) }; } return best; };
      const ss = xs.map(param).filter((r) => r && r.d < 1e-6).map((r) => r.s).filter((s) => s > 1e-7 && s < total - 1e-7).sort((a, b) => a - b);
      const sc = param(p).s;
      if (!ss.length) return null;
      const lo = [...ss].reverse().find((s) => s < sc), hi = ss.find((s) => s > sc);
      const parts = [];
      if (closed) {
        const a = hi ?? ss[0], b = lo ?? ss[ss.length - 1];
        // a から一周して b まで残す
        const pts2 = [...pts.slice(0, -1), ...pts];
        const cum2 = [0]; for (let i = 0; i + 1 < pts2.length; i++) cum2.push(cum2[i] + G.dist(pts2[i], pts2[i + 1]));
        const end = b <= a ? b + total : b;
        if (end - a > 1e-7) parts.push(subPath(pts2, a, end));
      } else {
        if (lo !== undefined && lo > 1e-7) parts.push(subPath(pts, 0, lo));
        if (hi !== undefined && hi < total - 1e-7) parts.push(subPath(pts, hi, total));
      }
      return parts.map((q) => (e.type === 'line' || q.length === 2 ? { ...strip(e), type: 'line', a: q[0], b: q[q.length - 1], pts: undefined, closed: undefined, area: undefined } : { ...strip(e), pts: q, closed: false, area: false }))
        .map((n) => { for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k]; return n; });
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const angs = xs.map((q) => G.angOf(e.c, q));
      const ac = G.angOf(e.c, p);
      if (e.type === 'circle') {
        if (angs.length < 2) return null;
        const rel = angs.map((a) => G.norm360(a - ac)).sort((a, b) => a - b);
        const a1 = G.norm360(ac + rel[0]), a0 = G.norm360(ac + rel[rel.length - 1]);
        return [{ ...strip(e), type: 'arc', a0: a1, a1: a0 }];
      }
      const span = G.norm360(e.a1 - e.a0);
      const ts = angs.map((a) => G.norm360(a - e.a0)).filter((t) => t > 1e-7 && t < span - 1e-7).sort((a, b) => a - b);
      const tc = G.norm360(ac - e.a0);
      if (!ts.length) return null;
      const lo = [...ts].reverse().find((t) => t < tc), hi = ts.find((t) => t > tc);
      const out = [];
      if (lo !== undefined) out.push({ ...strip(e), a0: e.a0, a1: G.norm360(e.a0 + lo) });
      if (hi !== undefined) out.push({ ...strip(e), a0: G.norm360(e.a0 + hi), a1: e.a1 });
      return out;
    }
    return null;
  }
  function trim() {
    const c = {
      mode: 'entity', filter: isCurve,
      prompt: '消したい部分（交点と交点の間）をクリック。交わる線で区切って消します',
      onPick(e, p) {
        const parts = trimEnt(e, p);
        if (!parts) { K.toast('交わる線がないので消せません（全部消すときは［削除］）'); return; }
        K.begin(); K.remove([e]); for (const n of parts) K.add(n, { style: false }); K.commit();
      },
      onEnter() { c.done = true; },
    };
    return c;
  }
  /** 2本の線の角を作る。p1, p2 はクリック位置（残す側） */
  function cornerLines(e1, p1, e2, p2) {
    const X = G.lineX(e1.a, e1.b, e2.a, e2.b);
    if (!X) return null;
    const fix = (e, p) => {
      const t = G.projectOnSeg(X.p, e.a, e.b, false).t, tc = G.projectOnSeg(p, e.a, e.b, false).t;
      return tc < t ? { ...e, b: { ...X.p } } : { ...e, a: { ...X.p } };
    };
    return { X: X.p, n1: fix(e1, p1), n2: fix(e2, p2) };
  }
  function twoLines(title, apply, opts = []) {
    const c = {
      mode: 'entity', filter: isLine, first: null, opts,
      prompt: () => (c.first ? '2本目の線をクリック（残す側）' : '1本目の線をクリック（残す側）'),
      onPick(e, p) {
        if (!c.first) { c.first = { e, p }; K.setSel([e]); return; }
        if (e === c.first.e) return;
        const r = cornerLines(c.first.e, c.first.p, e, p);
        if (!r) { K.toast('2本の線が平行です'); c.first = null; K.clearSel(); return; }
        try { K.begin(); apply(c.first.e, e, r, c.o); K.commit(); } catch (err) { K.undo(); K.toast(err.message); }
        c.first = null; K.clearSel();
      },
      canBack: () => !!c.first, onBack() { c.first = null; K.clearSel(); },
      onEnter() { c.done = true; },
      onEnd() { K.clearSel(); },
    };
    c.title = title;
    return c;
  }
  function corner() { return twoLines('角作成', (e1, e2, r) => { K.replace(e1, { ...r.n1, uid: e1.uid }); K.replace(e2, { ...r.n2, uid: e2.uid }); }); }
  function chamfer() {
    return twoLines('面取り', (e1, e2, r, o) => {
      const d1 = K.inLen(o.d1), d2 = K.inLen(o.d2 || o.d1);
      const cut = (n, d) => {
        const far = G.dist(n.a, r.X) < 1e-9 ? n.b : n.a, L = G.dist(far, r.X);
        if (d >= L) throw new Error('面取りの長さが線より長いです');
        const q = { x: r.X.x + ((far.x - r.X.x) / L) * d, y: r.X.y + ((far.y - r.X.y) / L) * d };
        return { line: G.dist(n.a, r.X) < 1e-9 ? { ...n, a: q } : { ...n, b: q }, q };
      };
      const c1 = cut(r.n1, d1), c2 = cut(r.n2, d2);
      K.replace(e1, { ...c1.line, uid: e1.uid }); K.replace(e2, { ...c2.line, uid: e2.uid });
      K.add({ ...strip(e1), type: 'line', a: c1.q, b: c2.q }, { style: false });
    }, [{ k: 'd1', label: '1本目の長さ', type: 'num', value: 0.5, unit: lenU }, { k: 'd2', label: '2本目の長さ', type: 'num', value: 0.5, unit: lenU }]);
  }
  function fillet() {
    return twoLines('R面取り', (e1, e2, r, o) => {
      const R = K.inLen(o.r);
      if (!(R > 0)) throw new Error('半径を入力してください');
      const far = (n) => (G.dist(n.a, r.X) < 1e-9 ? n.b : n.a);
      const f1 = far(r.n1), f2 = far(r.n2);
      const u1 = G.mul(G.sub(f1, r.X), 1 / G.dist(f1, r.X)), u2 = G.mul(G.sub(f2, r.X), 1 / G.dist(f2, r.X));
      const th = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
      if (th < 1e-6 || Math.PI - th < 1e-6) throw new Error('この2本ではR面取りできません');
      const t = R / Math.tan(th / 2);
      if (t >= G.dist(f1, r.X) || t >= G.dist(f2, r.X)) throw new Error('半径が大きすぎます');
      const T1 = G.add(r.X, G.mul(u1, t)), T2 = G.add(r.X, G.mul(u2, t));
      const bis = G.add(u1, u2), bl = Math.hypot(bis.x, bis.y);
      const cn = G.add(r.X, G.mul(bis, R / Math.sin(th / 2) / bl));
      let a0 = G.angOf(cn, T1), a1 = G.angOf(cn, T2);
      if (G.norm360(a1 - a0) > 180) [a0, a1] = [a1, a0];
      const set = (n, T) => (G.dist(n.a, r.X) < 1e-9 ? { ...n, a: T } : { ...n, b: T });
      K.replace(e1, { ...set(r.n1, T1), uid: e1.uid }); K.replace(e2, { ...set(r.n2, T2), uid: e2.uid });
      K.add({ ...strip(e1), type: 'arc', c: cn, r: R, a0, a1, a: undefined, b: undefined }, { style: false });
      const last = K.doc.entities[K.doc.entities.length - 1]; delete last.a; delete last.b;
    }, [{ k: 'r', label: '半径', type: 'num', value: 1, unit: lenU }]);
  }
  function breakCmd() {
    const c = {
      mode: 'entity', filter: (e) => ['line', 'poly', 'arc'].includes(e.type), src: null,
      prompt: () => (c.src ? '分ける位置を指示（線の上）' : '分割する線・連続線・円弧をクリック'),
      onPick(e) { c.src = e; c.mode = 'point'; K.setSel([e]); },
      onPoint(p) {
        const e = c.src; let parts = null;
        if (e.type === 'line') { const { q, t } = G.projectOnSeg(p, e.a, e.b); if (t > 1e-9 && t < 1 - 1e-9) parts = [{ ...strip(e), b: q }, { ...strip(e), a: q }]; }
        else if (e.type === 'arc') { const a = G.angOf(e.c, p); if (G.inArc(a, e.a0, e.a1)) parts = [{ ...strip(e), a1: a }, { ...strip(e), a0: a }]; }
        else {
          const closed = e.closed && e.pts.length > 2, pts = closed ? [...e.pts, e.pts[0]] : e.pts;
          let best = null;
          for (let i = 0; i + 1 < pts.length; i++) { const r = G.projectOnSeg(p, pts[i], pts[i + 1]); const d = G.dist(r.q, p); if (!best || d < best.d) best = { d, i, q: r.q }; }
          if (closed) { const pp = [best.q, ...pts.slice(best.i + 1, -1), ...pts.slice(0, best.i + 1), best.q]; parts = [{ ...strip(e), pts: pp, closed: false, area: false }]; }
          else parts = [{ ...strip(e), pts: [...pts.slice(0, best.i + 1), best.q] }, { ...strip(e), pts: [best.q, ...pts.slice(best.i + 1)] }];
        }
        if (!parts) { K.toast('線の途中を指示してください'); return; }
        K.begin(); K.remove([e]); for (const n of parts) K.add(n, { style: false }); K.commit(closed(e) ? '閉じた線を開きました' : '2つに分けました');
        c.src = null; c.mode = 'entity'; K.clearSel();
        function closed(x) { return x.type === 'poly' && x.closed; }
      },
      canBack: () => !!c.src, onBack() { c.src = null; c.mode = 'entity'; K.clearSel(); },
      onEnter() { c.done = true; },
    };
    return c;
  }
  function join() {
    return {
      onSelected(list) {
        const segs = list.filter((e) => e.type === 'line' || (e.type === 'poly' && !e.closed)).map((e) => (e.type === 'line' ? [e.a, e.b] : e.pts.map((p) => ({ ...p }))));
        if (segs.length < 2) { K.toast('線か開いた連続線を2つ以上選んでください'); this.done = true; return; }
        const tol = 1e-4, same = (a, b) => G.dist(a, b) < tol;
        const chains = [];
        const rest = segs.map((s) => [...s]);
        while (rest.length) {
          let ch = rest.shift(), grew = true;
          while (grew) {
            grew = false;
            for (let i = 0; i < rest.length; i++) {
              const s = rest[i];
              if (same(ch[ch.length - 1], s[0])) ch = [...ch, ...s.slice(1)];
              else if (same(ch[ch.length - 1], s[s.length - 1])) ch = [...ch, ...[...s].reverse().slice(1)];
              else if (same(ch[0], s[s.length - 1])) ch = [...s.slice(0, -1), ...ch];
              else if (same(ch[0], s[0])) ch = [...[...s].reverse().slice(0, -1), ...ch];
              else continue;
              rest.splice(i, 1); grew = true; break;
            }
          }
          chains.push(ch);
        }
        const src = list.find((e) => e.type === 'line' || e.type === 'poly');
        K.begin();
        K.remove(list.filter((e) => e.type === 'line' || (e.type === 'poly' && !e.closed)));
        const made = chains.map((ch) => {
          const closed = ch.length > 3 && same(ch[0], ch[ch.length - 1]);
          if (closed) ch.pop();
          return K.add({ ...strip(src), type: 'poly', pts: ch, closed, a: undefined, b: undefined }, { style: false });
        });
        made.forEach((e) => { delete e.a; delete e.b; });
        K.commit(`${made.length} 本の連続線にまとめました`);
        K.setSel(made);
        this.done = true;
      },
    };
  }
  function explode() {
    return {
      onSelected(list) {
        const out = [];
        const done = [];
        for (const e of list) {
          if (e.type === 'poly') {
            const pts = e.closed ? [...e.pts, e.pts[0]] : e.pts;
            const { pts: _p, closed: _c, area: _a, ...base } = strip(e);
            for (let i = 0; i + 1 < pts.length; i++) out.push({ ...base, type: 'line', a: pts[i], b: pts[i + 1] });
            done.push(e);
          }
          else if (['dim', 'leader', 'hatch', 'align'].includes(e.type)) {
            const cfg = K.sheet();
            for (const n of explodeForDxf([e], { scaleN: cfg.scaleN, sheetRot: cfg.rot || 0, unit: K.dimUnit(), alignGeom: K.alignGeom, alignPoint, alignStakes })) {
              const m = strip(n); if (m.type === 'text' && e.hmm && !m.hmm) { m.hmm = e.hmm; delete m.h; m.rot = 0; } out.push({ ...m, layer: e.layer || m.layer });
            }
            done.push(e);
          }
        }
        if (!done.length) { K.toast('分解できる図形（連続線・寸法線・引出線・ハッチング・路線）がありません'); this.done = true; return; }
        K.begin(); K.remove(done);
        for (const n of out) K.add(n, { style: false });
        K.commit(`${done.length} 個を ${out.length} 個に分解しました`);
        this.done = true;
      },
    };
  }

  // ------------------------------------------------------------
  // 計測
  // ------------------------------------------------------------
  function mdist() {
    const c = {
      pts: [],
      prompt: () => (c.pts.length ? '次の点を指示（続けて測ると累計を出します）。［確定］でやり直し' : '測る始点を指示'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) { c.pts.push(p); },
      onEnter() { if (c.pts.length) c.pts = []; else c.done = true; },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      info() {
        if (c.pts.length < 2) return '<p>2点を指示すると、距離・方向角・ΔX・ΔY を表示します。</p>';
        let sum = 0, rows = '';
        for (let i = 1; i < c.pts.length; i++) { const d = G.dist(c.pts[i - 1], c.pts[i]); sum += d; rows += `<tr><td>${i}</td><td class="num">${fmt(d)}</td><td class="num">${toDMS(G.azim(c.pts[i - 1], c.pts[i]))}</td></tr>`; }
        const a = c.pts[c.pts.length - 2], b = c.pts[c.pts.length - 1];
        return `<div class="mb-result"><b>距離 ${fmt(G.dist(a, b))} m</b><br>方向角 ${toDMS(G.azim(a, b))}<br>ΔX ${fmt(b.x - a.x)}　ΔY ${fmt(b.y - a.y)}${c.pts.length > 2 ? `<br><b>累計 ${fmt(sum)} m</b>` : ''}</div>
          <div class="tbl"><table><tr><th>#</th><th>距離</th><th>方向角</th></tr>${rows}</table></div><div class="panel-actions"><button class="btn" data-mb="dims">寸法線として残す</button></div>`;
      },
      infoAct(k) {
        if (k !== 'dims' || c.pts.length < 2) return;
        K.begin();
        for (let i = 1; i < c.pts.length; i++) K.add({ type: 'dim', a: { ...c.pts[i - 1] }, b: { ...c.pts[i] }, off: -K.mm(5), term: K.prefs.term || 'tick', hmm: 2.5 });
        K.commit('寸法線を作りました'); c.pts = [];
      },
      preview(R, h) { if (c.pts.length) { R.poly([...c.pts, h]); R.text(h, `${fmt(G.dist(c.lastPt, h))} m`); } },
    };
    return c;
  }
  function mangle() {
    const c = {
      pts: [],
      prompt: () => ['1本目の端の点を指示', '角の頂点を指示', '2本目の端の点を指示'][Math.min(c.pts.length, 2)],
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      onPoint(p) { if (c.pts.length >= 3) c.pts = []; c.pts.push(p); },
      onEnter() { if (c.pts.length) c.pts = []; else c.done = true; },
      canBack: () => c.pts.length > 0, onBack() { c.pts.pop(); },
      info() {
        if (c.pts.length < 3) return '<p>3点（端・頂点・端）を指示すると角度を表示します。</p>';
        const [a, o, b] = c.pts;
        let t = Math.abs(G.azim(o, a) - G.azim(o, b)); if (t > 180) t = 360 - t;
        return `<div class="mb-result"><b>角度 ${toDMS(t)}</b><br>（${fmt(t, 4)}°）<br>外角 ${toDMS(360 - t)}<br>右回りの夾角 ${toDMS(G.norm360(G.azim(o, b) - G.azim(o, a)))}</div>`;
      },
      preview(R, h) { const p = c.pts.length >= 3 ? c.pts : [...c.pts, h]; R.poly(p); },
    };
    return c;
  }
  function marea() {
    const c = {
      pts: [],
      prompt: () => (c.pts.length ? `次の頂点を指示（${c.pts.length} 点）。［確定］で確定` : '囲む範囲の1点目を指示（選択中の閉じた図形があればその面積を表示）'),
      get lastPt() { return c.pts[c.pts.length - 1] || null; },
      fixed: false,
      onPoint(p) { if (c.fixed) { c.pts = []; c.fixed = false; } c.pts.push(p); },
      onEnter() { if (c.pts.length >= 3 && !c.fixed) c.fixed = true; else c.done = true; },
      canBack: () => c.pts.length > 0 && !c.fixed, onBack() { c.pts.pop(); },
      info() {
        const s = K.sel.find((e) => closedPts(e));
        if (!c.pts.length && s) { const pts = closedPts(s); return `<div class="mb-result"><b>面積 ${fmt(G.polyArea(pts), 3)} ㎡</b><br>周長 ${fmt(G.polyLen(pts, true))} m</div>`; }
        if (c.pts.length < 3) return '<p>3点以上を指示すると面積と周長を表示します。</p>';
        return `<div class="mb-result"><b>面積 ${fmt(G.polyArea(c.pts), 3)} ㎡</b><br>周長 ${fmt(G.polyLen(c.pts, true))} m<br>頂点 ${c.pts.length}</div><div class="panel-actions"><button class="btn" data-mb="fig">求積図形として残す</button></div>`;
      },
      infoAct(k) { if (k === 'fig' && c.pts.length >= 3) { K.begin(); K.add({ type: 'poly', pts: c.pts.map((p) => ({ ...p })), closed: true, area: true }); K.commit('求積図形を作りました'); c.pts = []; c.fixed = false; } },
      preview(R, h) { if (c.pts.length) R.poly(c.fixed ? c.pts : [...c.pts, h], true); },
    };
    return c;
  }
  function mcoord() {
    const c = {
      list: [],
      opts: [grpOpt()],
      prompt: '座標を知りたい点を指示',
      onPoint(p, h) { c.list.unshift({ p, label: h?.kind === '点' ? h.label : '' }); c.list = c.list.slice(0, 8); },
      onEnter() { c.done = true; },
      info() {
        if (!c.list.length) return '<p>クリックした位置の X・Y（平面直角座標）を表示します。</p>';
        const q = c.list[0], z = K.doc.zone;
        let ll = '';
        if (z) { const r = xyToLL(q.p.x, q.p.y, z); ll = `<br>緯度 ${toDMS(r.lat, 2)}<br>経度 ${toDMS(r.lon, 2)}`; }
        return `<div class="mb-result">${q.label ? `<b>${K.esc(q.label)}</b><br>` : ''}<b>X ${fmt(q.p.x)}</b><br><b>Y ${fmt(q.p.y)}</b>${ll}</div>
          <div class="panel-actions"><button class="btn" data-mb="reg">点として登録</button></div>
          ${c.list.length > 1 ? '<div class="tbl"><table><tr><th>X</th><th>Y</th></tr>' + c.list.slice(1).map((r) => `<tr><td class="num">${fmt(r.p.x)}</td><td class="num">${fmt(r.p.y)}</td></tr>`).join('') + '</table></div>' : ''}`;
      },
      infoAct(k) { if (k === 'reg' && c.list.length) { K.begin(); const e = K.add({ type: 'point', p: { ...c.list[0].p }, z: 0, name: K.nextPointName(), grp: c.o.grp }); K.commit(`点 ${e.name} を登録しました`); } },
    };
    return c;
  }

  // ------------------------------------------------------------
  // 表示・その他
  // ------------------------------------------------------------
  function zoomwin() {
    const c = {
      pts: [],
      prompt: () => (c.pts.length ? '拡大する範囲の対角を指示' : '拡大する範囲の1点目を指示（ドラッグでも可）'),
      onPoint(p) { if (!c.pts.length) { c.pts.push(p); return; } const a = c.pts[0]; K.fitBox(Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y), 10); c.done = true; },
      onWindow(r) { K.fitBox(r.x0, r.y0, r.x1, r.y1, 10); c.done = true; },
      preview(R, h) { if (c.pts.length) { const a = c.pts[0]; R.poly([a, { x: a.x, y: h.y }, h, { x: h.x, y: a.y }], true, true); } },
    };
    c.mode = 'point';
    return c;
  }
  function movesheet() {
    return {
      prompt: '用紙の中心にする位置を指示（印刷範囲が移動します）',
      onPoint(p) { const s = K.sheet(); s.center = { x: p.x, y: p.y }; K.markDirty(); K.redraw(); this.done = true; K.toast('用紙枠を移動しました'); },
      preview(R, h) {
        const s = K.sheet(); const old = s.center; s.center = h;
        const cs = paperOutline(); s.center = old;
        R.poly(cs, true, true);
      },
    };
  }
  function paperOutline() {
    const s = K.sheet();
    // main.js の用紙計算と同じ（sheet.js を使う）
    const { layout, makeXf } = K.sheetLib;
    const L = layout(s), X = makeXf(s, L);
    return [[0, 0], [L.W, 0], [L.W, L.H], [0, L.H]].map(([x, y]) => X.toM({ x, y }));
  }
  function paste() {
    const list = K.clip();
    if (!list?.length) { K.toast('貼り付ける図形がありません（先に Ctrl+C でコピー）'); return { done: true }; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of list) { const b = G.bboxOf(e, K.alignGeom); if (!b) continue; x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1); }
    const base = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const c = {
      prompt: '貼り付ける位置（図形の中心）を指示。続けて置けます。［確定］で終了',
      lastPt: base,
      at(p) { return list.map((e) => G.mapEntity(e, G.fMove(p.x - base.x, p.y - base.y))); },
      onPoint(p) {
        K.begin();
        const added = c.at(p).map((n) => { const m = strip(n); if (m.type === 'point') m.name = K.uniqueName(m.name); return K.add(m, { style: false }); });
        K.commit(`${added.length} 個を貼り付けました`);
      },
      onEnter() { c.done = true; },
      preview(R, h) { R.ents(c.at(h)); },
    };
    return c;
  }

  const T = (title, icon, start, extra = {}) => ({ title, icon, start, ...extra });
  const sel = (title, icon, start, extra = {}) => ({ title, icon, start, needsSel: true, ...extra });
  return {
    line: T('単線', 'line', line, { tip: '2点を指示して線を引く' }),
    pline: T('連続線', 'pline', pline, { tip: '折れ線・多角形' }),
    rect: T('矩形', 'rect', rect),
    offset: T('平行線', 'offset', offset, { tip: '線・連続線・円を指定間隔で平行に複写' }),
    circle: T('円', 'circle', circle),
    circle3: T('3点円', 'circle3', circle3),
    arc: T('円弧', 'arc', arc, { tip: '中心・始点・終点' }),
    arc3: T('3点円弧', 'arc3', arc3),
    point: T('点', 'point', point, { tip: '測点（点名付き）を置く' }),
    divide: T('等分点', 'divide', divide),
    text: T('文字', 'text', text),
    leader: T('引出線', 'leader', leader, { tip: '旗上げ（引出線と文字）' }),
    dim: T('平行寸法', 'dim', dimAligned),
    dimh: T('水平寸法', 'dimh', () => dimHV('h'), { tip: '東西方向（横）の寸法' }),
    dimv: T('垂直寸法', 'dimv', () => dimHV('v'), { tip: '南北方向（縦）の寸法' }),
    dimser: T('直列寸法', 'dimser', dimSeries, { tip: '寸法を続けて並べる' }),
    dimr: T('半径寸法', 'dimr', dimRadius),
    dimang: T('角度寸法', 'dimang', dimAngle),
    hatch: T('ハッチング', 'hatch', hatch),
    areafig: T('求積図形', 'areafig', areafig, { tip: '面積を表示する多角形' }),
    north: T('方位記号', 'north', north),
    move: sel('移動', 'move', () => transformCmd({ kind: 'move' })),
    copy: sel('複写', 'copyc', () => transformCmd({ kind: 'move', copy: true })),
    rotate: sel('回転', 'rotate', () => transformCmd({ kind: 'rotate' })),
    mirror: sel('反転', 'mirror', () => transformCmd({ kind: 'mirror' })),
    scale: sel('拡大縮小', 'scale', () => transformCmd({ kind: 'scale' })),
    array: sel('配列複写', 'array', arrayCmd),
    erase: T('削除', 'erase', erase),
    stretch: T('伸縮', 'stretch', stretch, { tip: '線の端を基準線まで伸ばす・縮める' }),
    trim: T('部分消去', 'trim', trim, { tip: '交点で区切られた部分を消す' }),
    corner: T('角作成', 'corner', corner, { tip: '2本の線を交点まで伸縮して角にする' }),
    chamfer: T('面取り', 'chamfer', chamfer),
    fillet: T('R面取り', 'fillet', fillet),
    break: T('分割', 'break', breakCmd, { tip: '線を指定位置で2つに分ける' }),
    join: sel('結合', 'join', join, { tip: 'つながった線を1本の連続線にする', filter: (e) => e.type === 'line' || (e.type === 'poly' && !e.closed) }),
    explode: sel('分解', 'explode', explode, { tip: '連続線→線、寸法線→線と文字 など' }),
    mdist: T('距離', 'mdist', mdist),
    mangle: T('角度', 'mangle', mangle),
    marea: T('面積', 'marea', marea),
    mcoord: T('座標', 'mcoord', mcoord),
    zoomwin: T('範囲拡大', 'zoomwin', zoomwin),
    movesheet: T('用紙枠の移動', 'movesheet', movesheet),
    paste: T('貼り付け', 'paste', paste),
    selattr: { title: '属性で選択', icon: 'selattr', run: () => selectByAttr(K) },
  };
}

/** 属性（種類・レイヤ・色・線種）で選ぶ */
async function selectByAttr(K) {
  const ents = K.visibleEnts();
  const uniq = (f) => [...new Set(ents.map(f))].filter((v) => v !== undefined && v !== null && v !== '');
  const NAMES = { point: '点', line: '線', poly: '連続線', circle: '円', arc: '円弧', text: '文字', dim: '寸法線', leader: '引出線', hatch: 'ハッチング', align: '路線' };
  const types = uniq((e) => e.type), layers = uniq((e) => e.layer || '0'), colors = uniq((e) => K.styleOf(e).color), lts = uniq((e) => K.styleOf(e).ltype);
  const box = (name, list, label) => `<fieldset><legend>${name}</legend>${list.map((v) => `<label class="chk"><input type="checkbox" data-f="${name}" value="${K.esc(v)}"> ${label(v)}</label>`).join('')}</fieldset>`;
  const r = await K.dialog({
    title: '属性で選択',
    body: `<div class="form cols"><div>${box('種類', types, (v) => NAMES[v] || v)}${box('線種', lts, (v) => LTYPES[v]?.name || v)}</div><div>${box('レイヤ', layers, (v) => K.esc(v))}${box('色', colors, (v) => `<span style="color:${v}">■</span> ${v}`)}</div></div><p class="small">チェックした条件をすべて満たす図形を選びます（項目内はどれか1つ）。</p>`,
    buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '選択', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  const pick = (f) => [...document.querySelectorAll(`#dlgBody [data-f="${f}"]:checked`)].map((i) => i.value);
  const T = pick('種類'), L = pick('レイヤ'), C = pick('色'), LT = pick('線種');
  const list = ents.filter((e) => (!T.length || T.includes(e.type)) && (!L.length || L.includes(e.layer || '0')) && (!C.length || C.includes(K.styleOf(e).color)) && (!LT.length || LT.includes(K.styleOf(e).ltype)));
  K.setSel(list);
  K.toast(`${list.length} 個の図形を選びました`);
}
