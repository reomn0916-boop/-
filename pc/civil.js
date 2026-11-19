// パソコン版: 土木の機能
// 座標一覧・頂点の点登録・座標合わせ・横断図・縦断図・求積表・逃げ杭・杭打ち表
import { fitTransform, applyTransform, areaTable, stakeout, offsetPolyline, orientation, extendFrom, parseStation, fmtStation } from '../js/cogo.js';
import { toDMS } from '../js/geo.js';
import { parseSIMA, parseCSV } from '../js/io.js';

export function civilDefs(K) {
  const G = K.G, fmt = K.fmt, esc = K.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const num = (v) => Number(String(v ?? '').replace(/[，]/g, '.').replace(/[^\d.\-+eE]/g, ''));

  /** 用紙の向き（右・上）と、用紙 mm → 図面 m */
  function paperAxes() {
    const th = ((K.sheet().rot || 0) * Math.PI) / 180;
    return { U: { x: Math.cos(th), y: Math.sin(th) }, R: { x: -Math.sin(th), y: Math.cos(th) }, mm: K.mm(1) };
  }
  /** 用紙上で (右 u mm, 下 v mm) の位置 */
  function at(O, u, v, A = paperAxes()) {
    return { x: O.x + A.R.x * u * A.mm - A.U.x * v * A.mm, y: O.y + A.R.y * u * A.mm - A.U.y * v * A.mm };
  }
  const T = (p, text, hmm = 2.5, extra = {}) => ({ type: 'text', p, text: String(text), hmm, ...extra });

  /** 表を作る。O = 左上、cols = 列幅 mm、rows = 文字の2次元配列 */
  function tableEnts(O, cols, rows, { title, hmm = 2.5, rowH = 6, align = [] } = {}) {
    const A = paperAxes(), out = [];
    const W = cols.reduce((a, b) => a + b, 0);
    let top = 0;
    if (title) { out.push(T(at(O, 0, -1.5, A), title, hmm + 0.5)); }
    const H = rows.length * rowH;
    const L = (u0, v0, u1, v1, lw) => out.push({ type: 'line', a: at(O, u0, v0, A), b: at(O, u1, v1, A), ...(lw ? { lw } : {}) });
    L(0, top, W, top, 0.35); L(0, top + H, W, top + H, 0.35); L(0, top, 0, top + H, 0.35); L(W, top, W, top + H, 0.35);
    for (let i = 1; i < rows.length; i++) L(0, top + i * rowH, W, top + i * rowH, i === 1 ? 0.25 : 0.13);
    let x = 0;
    cols.forEach((w, j) => {
      if (j) L(x, top, x, top + H, 0.13);
      rows.forEach((r, i) => {
        const a = i === 0 ? 'center' : (align[j] || (j ? 'right' : 'left'));
        const u = a === 'center' ? x + w / 2 : a === 'right' ? x + w - 1.2 : x + 1.2;
        if (r[j] !== undefined && r[j] !== '') out.push(T(at(O, u, top + i * rowH + rowH * 0.72, A), r[j], hmm, { align: a }));
      });
      x += w;
    });
    return out;
  }
  function place(list, layer) {
    K.begin();
    const st = K.style();
    for (const e of list) K.add({ ...st, layer: layer || st.layer, ...e }, { style: false });
    K.commit();
  }
  const ghostAt = (build) => (R, h) => { try { R.ents(build(h)); } catch { /* 途中 */ } };

  // ------------------------------------------------------------
  // 座標一覧
  // ------------------------------------------------------------
  async function pointTable() {
    let filter = '';
    const pts = () => K.doc.entities.filter((e) => e.type === 'point' && (!filter || K.grpOf(e) === filter));
    const rowHtml = (e) => `<tr data-id="${e.id}"><td class="c"><input type="checkbox" data-chk></td>
      <td><input data-f="name" value="${esc(e.name)}"></td><td><input class="num" data-f="x" value="${fmt(e.p.x)}"></td><td><input class="num" data-f="y" value="${fmt(e.p.y)}"></td>
      <td><input class="num" data-f="z" value="${fmt(e.z || 0)}"></td>
      <td><select data-f="grp">${K.GROUPS.map((g) => `<option ${K.grpOf(e) === g ? 'selected' : ''}>${g}</option>`).join('')}</select></td>
      <td class="c"><button class="btn" data-go type="button">図</button></td></tr>`;
    const body = document.createElement('div');
    const render = () => {
      const list = pts();
      body.innerHTML = `<div class="btnrow" style="margin:0 0 8px">
        <select id="ptFilter"><option value="">すべての種別</option>${K.GROUPS.map((g) => `<option ${filter === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
        <button type="button" class="btn" data-a="add">点を追加</button><button type="button" class="btn" data-a="del">チェックした点を削除</button>
        <button type="button" class="btn" data-a="sel">チェックした点を図で選択</button>
        <button type="button" class="btn" data-a="imp">SIMA・CSV 読込</button><span class="small">${list.length} 点</span></div>
        <div class="tblwrap"><table class="gridtbl"><thead><tr><th style="width:30px"><input type="checkbox" data-all></th><th>点名</th><th>X（北）</th><th>Y（東）</th><th>Z</th><th>種別</th><th></th></tr></thead>
        <tbody>${list.map(rowHtml).join('')}</tbody></table></div>
        <p class="small">値を書き換えるとすぐ図面に反映します（Ctrl+Z で戻せます）。書き出しは［ファイル］→［SIMA］［CSV］。</p>`;
    };
    render();
    body.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.id === 'ptFilter') { filter = t.value; render(); return; }
      if (t.matches('[data-all]')) { $$('[data-chk]', body).forEach((c) => { c.checked = t.checked; }); return; }
      const tr = t.closest('tr[data-id]'); if (!tr || !t.dataset.f) return;
      const e = K.ent(Number(tr.dataset.id)); if (!e) return;
      const f = t.dataset.f;
      if (f === 'name') {
        const n = t.value.trim();
        if (!n || (n !== e.name && K.pointByName(n))) { K.toast(n ? `点名「${n}」は使われています` : '点名を入力してください'); t.value = e.name; return; }
        K.begin(); e.name = n; K.commit(); return;
      }
      if (f === 'grp') { K.begin(); e.grp = t.value; K.commit(); return; }
      const v = num(t.value);
      if (!Number.isFinite(v)) { K.toast('数値を入力してください'); t.value = fmt(f === 'z' ? e.z || 0 : e.p[f]); return; }
      K.begin(); if (f === 'z') e.z = v; else e.p[f] = v; K.commit();
      t.value = fmt(v);
    });
    body.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      const checked = () => $$('tr[data-id]', body).filter((tr) => $('[data-chk]', tr).checked).map((tr) => K.ent(Number(tr.dataset.id))).filter(Boolean);
      if (b.dataset.go !== undefined) {
        const e = K.ent(Number(b.closest('tr').dataset.id));
        document.getElementById('dlg').close();
        K.setSel([e]); K.view.x = e.p.x; K.view.y = e.p.y; K.redraw();
        return;
      }
      switch (b.dataset.a) {
        case 'add': {
          K.begin();
          K.add({ type: 'point', p: { x: Number(K.view.x.toFixed(3)), y: Number(K.view.y.toFixed(3)) }, z: 0, name: K.nextPointName(), grp: filter || '位置出し' });
          K.commit(); render();
          const last = $$('tr[data-id]', body).pop(); $('[data-f="x"]', last)?.focus(); last?.scrollIntoView({ block: 'nearest' });
          break;
        }
        case 'del': { const s = checked(); if (!s.length) { K.toast('削除する点にチェックを付けてください'); return; } K.begin(); K.remove(s); K.commit(`${s.length} 点を削除しました`); render(); break; }
        case 'sel': { const s = checked(); document.getElementById('dlg').close(); K.setSel(s); if (s.length) { const xs = s.map((e) => e.p.x), ys = s.map((e) => e.p.y); K.fitBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 80); } break; }
        case 'imp': {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.sim,.csv,.txt';
          inp.onchange = async () => { const f = inp.files[0]; if (!f) return; const { decodeText } = await import('../js/io.js'); K.importPointsText(decodeText(await f.arrayBuffer()), f.name); render(); };
          inp.click();
          break;
        }
      }
    });
    await K.dialog({ title: '座標一覧', body, wide: true });
  }

  // ------------------------------------------------------------
  // 頂点を点登録
  // ------------------------------------------------------------
  function regVerts() {
    return {
      opts: [{ k: 'grp', label: '種別', type: 'select', value: () => K.prefs.ptGrp || '位置出し', options: K.GROUPS.map((g) => [g, g]) }],
      onSelected(list) {
        const vs = [];
        for (const e of list) vs.push(...K.geo(e).ends, ...(e.type === 'circle' || e.type === 'arc' ? [e.c] : []));
        K.begin();
        let n = 0;
        for (const p of vs) if (!K.pointAt(p)) { K.add({ type: 'point', p: { x: p.x, y: p.y }, z: 0, name: K.nextPointName(), grp: this.o.grp }); n++; }
        K.commit(n ? `${n} 点を登録しました（${this.o.grp}）` : '新しく登録する点はありませんでした');
        this.done = true;
      },
    };
  }

  // ------------------------------------------------------------
  // 座標合わせ（図面の座標を現場の座標に合わせる）
  // ------------------------------------------------------------
  const fit = { pairs: [], mode: 'rigid', target: 'all' };
  async function fitDialog() {
    for (;;) {
      const resultHtml = () => {
        const ok = fit.pairs.filter((q) => q.src && q.dst);
        if (!ok.length) return '<p class="small">図面上の点と、それに対応する現場の点（点名か X,Y）を組にしてください。2組以上で回転も合わせます。</p>';
        const tf = fitTransform(ok.map((q) => ({ src: q.src, dst: q.dst })), ok.length < 2 ? 'shift' : fit.mode);
        const res = tf.residuals.map((r, i) => `<tr><td>${i + 1}</td><td class="num">${fmt(r.dx * 1000, 1)}</td><td class="num">${fmt(r.dy * 1000, 1)}</td><td class="num"><b>${fmt(r.d * 1000, 1)}</b></td></tr>`).join('');
        return `<div class="kv" style="margin:8px 0"><dt>回転</dt><dd>${toDMS(Math.abs(tf.rot))} ${tf.rot >= 0 ? '右回り' : '左回り'}</dd><dt>縮尺</dt><dd>${fmt(tf.scale, 6)}</dd><dt>移動 ΔX / ΔY</dt><dd>${fmt(tf.tx)} / ${fmt(tf.ty)}</dd></div>
          <div class="tbl"><table><tr><th>組</th><th>ΔX mm</th><th>ΔY mm</th><th>ずれ mm</th></tr>${res}</table></div>`;
      };
      const rows = fit.pairs.map((q, i) => `<tr data-i="${i}"><td class="c">${i + 1}</td><td class="c">${q.src ? `${fmt(q.src.x)}, ${fmt(q.src.y)}` : '—'}</td>
        <td><input data-dst value="${esc(q.dstText || '')}" list="ptNames" placeholder="点名 または X,Y"></td><td class="c"><button type="button" class="btn" data-rm>削除</button></td></tr>`).join('');
      const r = await K.dialog({
        title: '座標合わせ（図面 → 現場の座標）', wide: true,
        body: `<div class="form"><p class="small">CAD 座標で描かれた図面を、基準点などの現場の座標に移します。［図から点を追加］で図面上の位置を選び、右に対応する点名を入れます。</p>
          <table class="gridtbl"><thead><tr><th>#</th><th>図面上の位置 X, Y</th><th>現場の点（点名 / X,Y）</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="c small">まだありません</td></tr>'}</tbody></table>
          <div class="grid2"><label>合わせ方 <select id="fitMode"><option value="shift" ${fit.mode === 'shift' ? 'selected' : ''}>平行移動のみ</option><option value="rigid" ${fit.mode === 'rigid' ? 'selected' : ''}>回転＋移動（縮尺そのまま）</option><option value="helmert" ${fit.mode === 'helmert' ? 'selected' : ''}>回転＋移動＋縮尺</option></select></label>
          <label>動かす図形 <select id="fitTarget"><option value="all" ${fit.target === 'all' ? 'selected' : ''}>すべて（基準点は動かさない）</option><option value="sel" ${fit.target === 'sel' ? 'selected' : ''}>選択中の図形だけ</option></select></label></div>
          <div id="fitRes">${resultHtml()}</div></div>`,
        buttons: [{ label: '閉じる', value: 'cancel' }, { label: '図から点を追加', value: 'pick' }, { label: '計算', value: 'calc' }, { label: '適用', value: 'apply', primary: true }],
        onOpen(root) {
          root.addEventListener('click', (ev) => { const b = ev.target.closest('[data-rm]'); if (b) { readRows(root); fit.pairs.splice(Number(b.closest('tr').dataset.i), 1); $('[data-rm]', root) && b.closest('tr').remove(); } });
        },
        onButton(v, root) {
          readRows(root);
          if (v === 'calc') { $('#fitRes', root).innerHTML = resultHtml(); return false; }
          return true;
        },
      });
      if (r === 'pick') {
        const p = await K.getPoint('図面上で、現場の点に合わせたい位置を指示（端点・交点に吸着します）');
        if (p) fit.pairs.push({ src: p, dst: null, dstText: '' });
        continue;
      }
      if (r === 'apply') {
        const ok = fit.pairs.filter((q) => q.src && q.dst);
        if (!ok.length) { K.toast('対応する点の組がありません'); continue; }
        const tf = fitTransform(ok.map((q) => ({ src: q.src, dst: q.dst })), ok.length < 2 ? 'shift' : fit.mode);
        const f = (p) => applyTransform(tf, p);
        const o = f({ x: 0, y: 0 }), e1 = f({ x: 0, y: 1 });
        const info = { ang: G.angOf(o, e1), k: tf.scale };
        const list = fit.target === 'sel' ? K.sel : K.doc.entities.filter((e) => !(e.type === 'point' && K.grpOf(e) === '基準点'));
        if (!list.length) { K.toast('動かす図形がありません'); continue; }
        K.begin();
        for (const e of list) K.replace(e, { ...G.mapEntity(e, f, info), uid: e.uid });
        K.commit(`${list.length} 個の図形を現場の座標に合わせました（最大のずれ ${fmt(Math.max(...tf.residuals.map((q) => q.d)) * 1000, 1)} mm）`);
        fit.pairs = [];
        K.zoomAll();
      }
      return;
    }
    function readRows(root) {
      $$('tr[data-i]', root).forEach((tr) => {
        const q = fit.pairs[Number(tr.dataset.i)]; if (!q) return;
        q.dstText = $('[data-dst]', tr).value.trim();
        q.dst = null;
        if (q.dstText) {
          const pe = K.pointByName(q.dstText);
          if (pe) q.dst = { ...pe.p };
          else { const m = q.dstText.split(/[,，、\s]+/).map(Number); if (m.length === 2 && m.every(Number.isFinite)) q.dst = { x: m[0], y: m[1] }; }
        }
      });
      fit.mode = $('#fitMode', root).value; fit.target = $('#fitTarget', root).value;
    }
  }

  // ------------------------------------------------------------
  // 横断図
  // ------------------------------------------------------------
  const parsePairs = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/[，、\t]/g, ',').split(/[,\s]+/).map(num)).filter((a) => a.length >= 2 && a.every(Number.isFinite))
    .map(([d, z]) => ({ d, z })).sort((a, b) => a.d - b.d);
  const interp = (pts, d) => {
    if (!pts.length) return NaN;
    if (d <= pts[0].d) return d < pts[0].d - 1e-9 ? NaN : pts[0].z;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (d >= a.d - 1e-12 && d <= b.d + 1e-12) return b.d - a.d < 1e-12 ? b.z : a.z + ((b.z - a.z) * (d - a.d)) / (b.d - a.d);
    }
    return NaN;
  };
  /** 標準断面（中心高・幅員・横断勾配・法勾配）から計画線を作る */
  function templatePlan(ground, t) {
    const out = [];
    const side = (s) => {
      const W = s < 0 ? t.wl : t.wr, cross = (s < 0 ? t.cl : t.cr) / 100;
      const E = { d: s * W, z: t.h - W * cross };
      const g = interp(ground, E.d);
      if (!Number.isFinite(g)) return [E];
      const cut = g > E.z;
      const n = cut ? t.nc : t.nf;
      const zl = (d) => E.z + (cut ? 1 : -1) * Math.abs(d - E.d) / (n || 1e-9);
      // 外側へ地盤線と交わる点
      const gs = ground.filter((q) => (s < 0 ? q.d < E.d : q.d > E.d)).sort((a, b) => (s < 0 ? b.d - a.d : a.d - b.d));
      let prev = { d: E.d, z: g };
      for (const q of gs) {
        const f0 = prev.z - zl(prev.d), f1 = q.z - zl(q.d);
        if ((f0 > 0) !== (f1 > 0) || Math.abs(f1) < 1e-9) {
          const k = Math.abs(f0) / (Math.abs(f0) + Math.abs(f1) || 1);
          const d = prev.d + (q.d - prev.d) * k;
          return [E, { d, z: zl(d) }];
        }
        prev = q;
      }
      return [E];
    };
    const L = side(-1).reverse(), Rr = side(1);
    out.push(...L, { d: 0, z: t.h }, ...Rr);
    return out.sort((a, b) => a.d - b.d);
  }
  /** 2本の線の間の切土・盛土（面積と範囲の多角形） */
  function cutFill(ground, plan) {
    const d0 = Math.max(ground[0].d, plan[0].d), d1 = Math.min(ground[ground.length - 1].d, plan[plan.length - 1].d);
    if (!(d1 > d0)) return { cut: 0, fill: 0, polys: [] };
    let xs = [...new Set([...ground, ...plan].map((q) => q.d).filter((d) => d >= d0 && d <= d1))];
    xs.push(d0, d1); xs = [...new Set(xs)].sort((a, b) => a - b);
    const f = (d) => interp(ground, d) - interp(plan, d);
    const all = [xs[0]];
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = xs[i], b = xs[i + 1], fa = f(a), fb = f(b);
      if (fa * fb < 0) all.push(a + ((b - a) * fa) / (fa - fb));
      all.push(b);
    }
    let cut = 0, fill = 0;
    const polys = [];
    let cur = null;
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i], b = all[i + 1];
      if (b - a < 1e-9) continue;
      const fa = f(a), fb = f(b), area = ((fa + fb) / 2) * (b - a);
      const kind = (fa + fb) / 2 > 1e-9 ? 'cut' : (fa + fb) / 2 < -1e-9 ? 'fill' : null;
      if (kind === 'cut') cut += area; else if (kind === 'fill') fill -= area;
      if (!kind) { cur = null; continue; }
      if (!cur || cur.kind !== kind) { cur = { kind, ds: [a] }; polys.push(cur); }
      cur.ds.push(b);
    }
    return {
      cut, fill,
      polys: polys.map((p) => ({ kind: p.kind, pts: [...p.ds.map((d) => ({ d, z: interp(ground, d) })), ...[...p.ds].reverse().map((d) => ({ d, z: interp(plan, d) }))] })),
    };
  }
  const xsecState = { name: 'No.1', H: 100, V: 100, ground: '-12,10.20\n-6,10.60\n0,10.85\n5,11.30\n12,12.10', planMode: 'tpl', plan: '-4,10.95\n0,11.00\n4,10.95', h: 11.0, wl: 3.5, wr: 3.5, cl: 2, cr: 2, nc: 1.0, nf: 1.5, dl: '', table: true, hatch: true };
  function xsecBuild(s, O) {
    const ground = parsePairs(s.ground);
    if (ground.length < 2) throw new Error('現況地盤を2点以上入力してください（距離,地盤高）');
    const plan = s.planMode === 'tpl' ? templatePlan(ground, s) : parsePairs(s.plan);
    if (plan.length < 2) throw new Error('計画線を2点以上入力してください');
    const A = paperAxes(), sc = K.scaleN();
    const kh = sc / s.H, kv = sc / s.V;
    const zs = [...ground, ...plan].map((q) => q.z);
    const DL = Number.isFinite(num(s.dl)) && String(s.dl).trim() !== '' ? num(s.dl) : Math.floor(Math.min(...zs) - 1);
    const P = (d, z) => ({ x: O.x + A.R.x * d * kh + A.U.x * (z - DL) * kv, y: O.y + A.R.y * d * kh + A.U.y * (z - DL) * kv });
    const out = [];
    const ds = [...ground, ...plan].map((q) => q.d), dmin = Math.min(...ds), dmax = Math.max(...ds);
    const cf = cutFill(ground, plan);
    if (s.hatch) for (const pg of cf.polys) out.push({ type: 'hatch', layer: '横断_土量', pattern: 'line', pitch: 1.5, ang: pg.kind === 'cut' ? 45 : 135, border: false, color: pg.kind === 'cut' ? '#c8a000' : '#0096a8', pts: pg.pts.map((q) => P(q.d, q.z)) });
    out.push({ type: 'poly', layer: '横断_現況', color: '#8b4513', lw: 0.25, pts: ground.map((q) => P(q.d, q.z)) });
    out.push({ type: 'poly', layer: '横断_計画', color: '#e00000', lw: 0.35, pts: plan.map((q) => P(q.d, q.z)) });
    const ztop = Math.max(...zs);
    out.push({ type: 'line', layer: '横断_中心', ltype: 'chain', a: P(0, DL), b: { x: P(0, ztop).x + A.U.x * K.mm(12), y: P(0, ztop).y + A.U.y * K.mm(12) } });
    out.push({ type: 'line', layer: '横断_基準', a: P(dmin, DL), b: P(dmax, DL) });
    out.push(T(at(P(dmin, DL), -2, -1, A), `DL=${fmt(DL, 2)}`, 2.5, { layer: '横断_基準', align: 'right' }));
    const topC = { x: P(0, ztop).x + A.U.x * K.mm(16), y: P(0, ztop).y + A.U.y * K.mm(16) };
    out.push(T(topC, s.name, 3.5, { layer: '横断_文字', align: 'center' }));
    out.push(T(at(topC, 0, 5, A), `CA=${fmt(cf.cut, 2)}㎡  BA=${fmt(cf.fill, 2)}㎡`, 2.5, { layer: '横断_文字', align: 'center' }));
    if (s.table) {
      const rowH = 7, labels = ['計画高', '地盤高', '距離'];
      const base = P(dmin, DL);
      const left = at(base, -22, 0, A);
      const pts = [...new Set([...ground, ...plan].map((q) => Math.round(q.d * 1000) / 1000))].sort((a, b) => a - b);
      for (let i = 0; i <= 3; i++) out.push({ type: 'line', layer: '横断_表', a: at(left, 0, i * rowH, A), b: at(P(dmax, DL), 0, i * rowH, A) });
      out.push({ type: 'line', layer: '横断_表', a: left, b: at(left, 0, 3 * rowH, A) });
      labels.forEach((l, i) => out.push(T(at(left, 1.5, i * rowH + rowH * 0.7, A), l, 2.5, { layer: '横断_表' })));
      for (const d of pts) {
        const b = P(d, DL);
        out.push({ type: 'line', layer: '横断_表', a: b, b: at(b, 0, 3 * rowH, A), lw: 0.13 });
        const zp = interp(plan, d), zg = interp(ground, d);
        const vals = [Number.isFinite(zp) ? fmt(zp, 2) : '', Number.isFinite(zg) ? fmt(zg, 2) : '', fmt(d, 2)];
        vals.forEach((v, i) => { if (v) out.push(T(at(b, -0.6, i * rowH + rowH - 0.8, A), v, 1.8, { layer: '横断_表', rot: 90 })); });
        // 地盤・計画の縦線（破線）
        const zz = Math.max(Number.isFinite(zp) ? zp : -Infinity, Number.isFinite(zg) ? zg : -Infinity);
        if (Number.isFinite(zz)) out.push({ type: 'line', layer: '横断_表', ltype: 'dot', lw: 0.13, a: b, b: P(d, zz) });
      }
    }
    for (const e of out) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return { ents: out, cf, DL };
  }
  async function xsecDialog() {
    const s = xsecState;
    const r = await K.dialog({
      title: '横断図の作成', wide: true,
      body: `<div class="form cols"><div>
        <div class="grid3"><label>測点名 <input id="xsName" value="${esc(s.name)}"></label><label>横の縮尺 1: <input id="xsH" type="number" value="${s.H}"></label><label>縦の縮尺 1: <input id="xsV" type="number" value="${s.V}"></label></div>
        <label>現況地盤（1行に「中心からの距離, 地盤高」。左はマイナス。Excel から貼り付け可）<textarea id="xsGround" rows="8">${esc(s.ground)}</textarea></label>
        <label>基準高 DL（空欄は自動） <input id="xsDL" value="${esc(s.dl)}"></label>
        <label class="chk"><input type="checkbox" id="xsTable" ${s.table ? 'checked' : ''}> 下に表（計画高・地盤高・距離）を付ける</label>
        <label class="chk"><input type="checkbox" id="xsHatch" ${s.hatch ? 'checked' : ''}> 切土・盛土にハッチング</label>
      </div><div>
        <label>計画線の作り方 <select id="xsMode"><option value="tpl" ${s.planMode === 'tpl' ? 'selected' : ''}>標準断面から作る</option><option value="pts" ${s.planMode === 'pts' ? 'selected' : ''}>点で入力する</option></select></label>
        <div id="xsTpl" class="grid2" ${s.planMode === 'tpl' ? '' : 'hidden'}>
          <label>計画高（中心） <input id="xsHc" value="${s.h}"></label><span></span>
          <label>左の幅員 m <input id="xsWl" value="${s.wl}"></label><label>右の幅員 m <input id="xsWr" value="${s.wr}"></label>
          <label>左の横断勾配 %（下がり＋） <input id="xsCl" value="${s.cl}"></label><label>右の横断勾配 % <input id="xsCr" value="${s.cr}"></label>
          <label>切土の法勾配 1: <input id="xsNc" value="${s.nc}"></label><label>盛土の法勾配 1: <input id="xsNf" value="${s.nf}"></label>
        </div>
        <label id="xsPtsL" ${s.planMode === 'pts' ? '' : 'hidden'}>計画線（「距離, 計画高」）<textarea id="xsPlan" rows="8">${esc(s.plan)}</textarea></label>
        <div id="xsCalc" class="kv" style="margin-top:8px"></div>
      </div></div>`,
      buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '面積を計算', value: 'calc' }, { label: '図面に配置', value: 'ok', primary: true }],
      onOpen(root) {
        $('#xsMode', root).addEventListener('change', (ev) => { $('#xsTpl', root).hidden = ev.target.value !== 'tpl'; $('#xsPtsL', root).hidden = ev.target.value === 'tpl'; });
      },
      onButton(v, root) {
        if (v === 'cancel') return true;
        Object.assign(s, {
          name: $('#xsName', root).value, H: num($('#xsH', root).value) || 100, V: num($('#xsV', root).value) || 100,
          ground: $('#xsGround', root).value, dl: $('#xsDL', root).value, table: $('#xsTable', root).checked, hatch: $('#xsHatch', root).checked,
          planMode: $('#xsMode', root).value, plan: $('#xsPlan', root).value,
          h: num($('#xsHc', root).value), wl: num($('#xsWl', root).value), wr: num($('#xsWr', root).value), cl: num($('#xsCl', root).value), cr: num($('#xsCr', root).value), nc: num($('#xsNc', root).value), nf: num($('#xsNf', root).value),
        });
        try {
          const b = xsecBuild(s, { x: 0, y: 0 });
          $('#xsCalc', root).innerHTML = `<dt>切土面積 CA</dt><dd>${fmt(b.cf.cut, 3)} ㎡</dd><dt>盛土面積 BA</dt><dd>${fmt(b.cf.fill, 3)} ㎡</dd><dt>基準高 DL</dt><dd>${fmt(b.DL, 2)}</dd>`;
        } catch (err) { $('#xsCalc', root).innerHTML = `<dt class="err">エラー</dt><dd class="err">${esc(err.message)}</dd>`; return false; }
        return v !== 'calc';
      },
    });
    if (r !== 'ok') return;
    const p = await K.getPoint('横断図の中心線と基準高（DL）の交わる位置を指示', { preview: ghostAt((h) => xsecBuild(s, h).ents) });
    if (!p) return;
    const b = xsecBuild(s, p);
    place(b.ents);
    K.toast(`横断図 ${s.name} を配置しました（CA ${fmt(b.cf.cut, 2)} ㎡・BA ${fmt(b.cf.fill, 2)} ㎡）`);
    // 次の測点名
    const m = s.name.match(/^(.*?)(\d+)$/); if (m) s.name = m[1] + (Number(m[2]) + 1);
  }

  // ------------------------------------------------------------
  // 縦断図
  // ------------------------------------------------------------
  const profState = {
    H: 1000, V: 100, pitch: 20, dl: '', vip: '0,10.50\n60,11.25\n120,10.80',
    rows: 'No.0,,10.20,\nNo.1,,10.90,\nNo.2,,11.60,\nNo.2+10,,11.40,\nNo.3,,11.05,\nNo.4,,10.95,\nNo.5,,10.30,\nNo.6,,10.55,',
  };
  function vipHeight(vips, s) {
    // VIP: [{s, z, vcl}]。縦断曲線は放物線
    if (vips.length < 2) return NaN;
    if (s < vips[0].s - 1e-9 || s > vips[vips.length - 1].s + 1e-9) return NaN;
    let i = 0; while (i + 1 < vips.length - 1 && s > vips[i + 1].s) i++;
    const a = vips[i], b = vips[i + 1];
    let z = a.z + ((b.z - a.z) * (s - a.s)) / (b.s - a.s);
    for (let k = 1; k + 1 < vips.length; k++) {
      const V = vips[k], L = V.vcl || 0; if (!L) continue;
      const g1 = (V.z - vips[k - 1].z) / (V.s - vips[k - 1].s), g2 = (vips[k + 1].z - V.z) / (vips[k + 1].s - V.s);
      const x = s - (V.s - L / 2);
      if (x >= 0 && x <= L) z = V.z - g1 * (L / 2) + g1 * x + ((g2 - g1) / (2 * L)) * x * x;
    }
    return z;
  }
  function profBuild(s, O) {
    const vips = s.vip.split(/\r?\n/).map((l) => l.replace(/[，、\t]/g, ',').split(',').map((t) => t.trim())).filter((a) => a[0] !== '')
      .map(([st, z, vcl]) => ({ s: parseStation(st, s.pitch), z: num(z), vcl: num(vcl) || 0 })).filter((q) => Number.isFinite(q.s) && Number.isFinite(q.z)).sort((a, b) => a.s - b.s);
    const rows = s.rows.split(/\r?\n/).map((l) => l.replace(/[，、\t]/g, ',').split(',').map((t) => t.trim())).filter((a) => a[0] !== '' || a[1]).map(([name, add, g, p]) => {
      const sv = add !== undefined && add !== '' ? num(add) : parseStation(name, s.pitch);
      const zg = g !== undefined && g !== '' ? num(g) : NaN;
      let zp = p !== undefined && p !== '' ? num(p) : NaN;
      if (!Number.isFinite(zp)) zp = vipHeight(vips, sv);
      return { name: name || fmtStation(sv, s.pitch), s: sv, zg, zp };
    }).filter((r) => Number.isFinite(r.s)).sort((a, b) => a.s - b.s);
    if (rows.length < 2) throw new Error('測点を2つ以上入力してください（測点, 追加距離, 地盤高, 計画高）');
    const A = paperAxes(), sc = K.scaleN(), kh = sc / s.H, kv = sc / s.V;
    const zs = rows.flatMap((r) => [r.zg, r.zp]).filter(Number.isFinite);
    if (!zs.length) throw new Error('地盤高か計画高を入力してください');
    const DL = String(s.dl).trim() !== '' && Number.isFinite(num(s.dl)) ? num(s.dl) : Math.floor(Math.min(...zs) - 1);
    const s0 = rows[0].s, sEnd = rows[rows.length - 1].s;
    const P = (sv, z) => ({ x: O.x + A.R.x * (sv - s0) * kh + A.U.x * (z - DL) * kv, y: O.y + A.R.y * (sv - s0) * kh + A.U.y * (z - DL) * kv });
    const out = [];
    const g = rows.filter((r) => Number.isFinite(r.zg)), p = rows.filter((r) => Number.isFinite(r.zp));
    if (g.length >= 2) out.push({ type: 'poly', layer: '縦断_地盤', color: '#8b4513', lw: 0.25, pts: g.map((r) => P(r.s, r.zg)) });
    if (vips.length >= 2) {
      const pts = [];
      const a = Math.max(vips[0].s, s0), b = Math.min(vips[vips.length - 1].s, sEnd);
      const n = Math.max(2, Math.ceil((b - a) / 1));
      for (let i = 0; i <= n; i++) { const sv = a + ((b - a) * i) / n; pts.push(P(sv, vipHeight(vips, sv))); }
      out.push({ type: 'poly', layer: '縦断_計画', color: '#e00000', lw: 0.35, pts });
      for (const v of vips) if (v.s >= s0 && v.s <= sEnd) out.push({ type: 'circle', layer: '縦断_計画', color: '#e00000', c: P(v.s, v.z), r: K.mm(0.8) });
    } else if (p.length >= 2) out.push({ type: 'poly', layer: '縦断_計画', color: '#e00000', lw: 0.35, pts: p.map((r) => P(r.s, r.zp)) });
    out.push({ type: 'line', layer: '縦断_基準', a: P(s0, DL), b: P(sEnd, DL) });
    // 表
    const labels = ['測点', '単距離', '追加距離', '地盤高', '計画高', '切土高', '盛土高'];
    const rowH = 9, nRow = labels.length + 1;
    const left = at(P(s0, DL), -26, 0, A);
    for (let i = 0; i <= nRow; i++) out.push({ type: 'line', layer: '縦断_表', lw: i === 0 || i === nRow ? 0.35 : 0.13, a: at(left, 0, i * rowH, A), b: at(P(sEnd, DL), 0, i * rowH, A) });
    out.push({ type: 'line', layer: '縦断_表', lw: 0.35, a: left, b: at(left, 0, nRow * rowH, A) });
    out.push({ type: 'line', layer: '縦断_表', lw: 0.25, a: at(left, 26, 0, A), b: at(left, 26, nRow * rowH, A) });
    [...labels, '勾配'].forEach((l, i) => out.push(T(at(left, 1.5, i * rowH + rowH * 0.68, A), l, 2.5, { layer: '縦断_表' })));
    rows.forEach((r, i) => {
      const b = P(r.s, DL);
      out.push({ type: 'line', layer: '縦断_表', lw: 0.13, a: b, b: at(b, 0, labels.length * rowH, A) });
      const top = Math.max(Number.isFinite(r.zg) ? r.zg : -Infinity, Number.isFinite(r.zp) ? r.zp : -Infinity);
      if (Number.isFinite(top)) out.push({ type: 'line', layer: '縦断_表', ltype: 'dot', lw: 0.13, a: b, b: P(r.s, top) });
      const d = r.zg - r.zp;
      const vals = [r.name, i ? fmt(r.s - rows[i - 1].s, 2) : '', fmt(r.s, 2), Number.isFinite(r.zg) ? fmt(r.zg, 2) : '', Number.isFinite(r.zp) ? fmt(r.zp, 2) : '',
        Number.isFinite(d) && d > 0 ? fmt(d, 2) : '', Number.isFinite(d) && d < 0 ? fmt(-d, 2) : ''];
      vals.forEach((v, j) => { if (v) out.push(T(at(b, -0.6, j * rowH + rowH - 0.8, A), v, 2.0, { layer: '縦断_表', rot: 90 })); });
    });
    // 勾配の欄
    const gy = labels.length * rowH;
    const segs = vips.length >= 2 ? vips.map((v) => ({ s: v.s, z: v.z })) : p.map((r) => ({ s: r.s, z: r.zp }));
    const breaks = [];
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i], b = segs[i + 1]; if (b.s <= a.s) continue;
      const gr = ((b.z - a.z) / (b.s - a.s)) * 100;
      if (breaks.length && Math.abs(breaks[breaks.length - 1].g - gr) < 1e-6) breaks[breaks.length - 1].b = b.s;
      else breaks.push({ a: a.s, b: b.s, g: gr });
    }
    for (const q of breaks) {
      const a = Math.max(q.a, s0), b = Math.min(q.b, sEnd); if (b <= a) continue;
      const pa = at(P(a, DL), 0, gy, A), pb = at(P(b, DL), 0, gy + rowH, A);
      const up = q.g >= 0;
      out.push({ type: 'line', layer: '縦断_表', lw: 0.25, a: up ? at(P(a, DL), 0, gy + rowH, A) : pa, b: up ? at(P(b, DL), 0, gy, A) : pb });
      out.push({ type: 'line', layer: '縦断_表', lw: 0.13, a: at(P(b, DL), 0, gy, A), b: at(P(b, DL), 0, gy + rowH, A) });
      const m = at(P((a + b) / 2, DL), 0, gy + rowH * 0.62, A);
      out.push(T(m, `${q.g >= 0 ? '+' : ''}${fmt(q.g, 3)}%  L=${fmt(b - a, 2)}`, 2.0, { layer: '縦断_表', align: 'center' }));
    }
    out.push(T(at(P(s0, Math.max(...zs)), 0, -14, A), `縦断図　H=1:${s.H}　V=1:${s.V}`, 3.5, { layer: '縦断_文字' }));
    out.push(T(at(P(s0, DL), -2, -1, A), `DL=${fmt(DL, 2)}`, 2.5, { layer: '縦断_基準', align: 'right' }));
    return { ents: out, rows, DL };
  }
  async function profileDialog() {
    const s = profState;
    const r = await K.dialog({
      title: '縦断図の作成', wide: true,
      body: `<div class="form cols"><div>
        <div class="grid3"><label>横の縮尺 1: <input id="pfH" type="number" value="${s.H}"></label><label>縦の縮尺 1: <input id="pfV" type="number" value="${s.V}"></label><label>杭間隔 m <input id="pfPitch" type="number" value="${s.pitch}"></label></div>
        <label>測点（1行に「測点, 追加距離, 地盤高, 計画高」。追加距離は空欄なら No. から、計画高は空欄なら右の縦断線形から）<textarea id="pfRows" rows="12">${esc(s.rows)}</textarea></label>
      </div><div>
        <label>縦断線形 VIP（1行に「追加距離 or 測点, 計画高, 縦断曲線長 VCL」）<textarea id="pfVip" rows="6">${esc(s.vip)}</textarea></label>
        <label>基準高 DL（空欄は自動） <input id="pfDL" value="${esc(s.dl)}"></label>
        <div id="pfMsg" class="small"></div>
      </div></div>`,
      buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '確認', value: 'calc' }, { label: '図面に配置', value: 'ok', primary: true }],
      onButton(v, root) {
        if (v === 'cancel') return true;
        Object.assign(s, { H: num($('#pfH', root).value) || 1000, V: num($('#pfV', root).value) || 100, pitch: num($('#pfPitch', root).value) || 20, rows: $('#pfRows', root).value, vip: $('#pfVip', root).value, dl: $('#pfDL', root).value });
        try { const b = profBuild(s, { x: 0, y: 0 }); $('#pfMsg', root).innerHTML = `<span class="ok">測点 ${b.rows.length}・延長 ${fmt(b.rows[b.rows.length - 1].s - b.rows[0].s, 2)} m・DL ${fmt(b.DL, 2)}</span>`; } catch (err) { $('#pfMsg', root).innerHTML = `<span class="err">${esc(err.message)}</span>`; return false; }
        return v !== 'calc';
      },
    });
    if (r !== 'ok') return;
    const p = await K.getPoint('縦断図の起点（最初の測点と DL の交わる位置）を指示', { preview: ghostAt((h) => profBuild(s, h).ents) });
    if (!p) return;
    place(profBuild(s, p).ents);
    K.toast('縦断図を配置しました');
  }

  // ------------------------------------------------------------
  // 求積表
  // ------------------------------------------------------------
  function areaTbl() {
    return {
      onSelected(list) {
        const e = list.find((q) => q.type === 'poly' && q.closed && q.pts.length > 2);
        if (!e) { K.toast('閉じた連続線（多角形）を選んでください'); this.done = true; return; }
        this.done = true;
        const names = e.pts.map((p, i) => K.pointAt(p)?.name || `V${i + 1}`);
        const t = areaTable(e.pts.map((p, i) => ({ ...p, name: names[i] })));
        const rows = [['測点', 'X', 'Y', 'Xn+1 − Xn−1', 'Yn×(Xn+1 − Xn−1)'], ...t.rows.map((r) => [r.name, fmt(r.x), fmt(r.y), fmt(r.dX), fmt(r.prod, 4)]),
          ['', '', '', '倍面積', fmt(Math.abs(t.double), 4)], ['', '', '', '面積', `${fmt(t.area, 4)} ㎡`]];
        const build = (O) => {
          const ents = tableEnts(O, [16, 28, 28, 28, 36], rows, { title: '座標求積表' });
          // 図形に点名を付ける（点がない頂点）
          e.pts.forEach((p, i) => { if (!K.pointAt(p)) ents.push(T({ x: p.x + K.mm(1), y: p.y + K.mm(1) }, names[i], 2.5)); });
          return ents;
        };
        (async () => {
          const p = await K.getPoint('求積表を置く位置（左上）を指示', { preview: ghostAt(build) });
          if (!p) return;
          place(build(p));
          if (!e.area) { K.begin(); e.area = true; K.commit(); }
          K.toast(`求積表を配置しました（面積 ${fmt(t.area, 3)} ㎡）`);
        })();
      },
    };
  }

  // ------------------------------------------------------------
  // 逃げ杭（スマホ版と同じ作り方）
  // ------------------------------------------------------------
  const EPS = 1e-4;
  function nige() {
    const c = {
      mode: 'point', src: null,
      opts: [
        { k: 'how', label: '作り方', type: 'seg', value: 'corner', options: [['corner', '角の延長'], ['ext', '線の延長'], ['par', '平行']] },
        { k: 'ds', label: '逃げ距離 m（例 1,2）', type: 'text', value: '1' },
      ],
      prompt: () => ({ corner: '逃げを作る角（端点・交点）をクリック。つながる線の延長上に作ります', ext: '線をクリック（両端の延長上に作ります）', par: c.src ? '逃げを作る側をクリック' : '線・連続線・多角形をクリック' }[c.o.how]),
      onOpt(k, v) { if (k === 'how') { c.src = null; c.mode = v === 'corner' ? 'point' : 'entity'; c.filter = v === 'ext' ? (e) => e.type === 'line' : (e) => e.type === 'line' || e.type === 'poly'; } },
      dists() { const ds = String(c.o.ds).split(/[,、\s]+/).filter(Boolean).map(Number); if (!ds.length || ds.some((d) => !Number.isFinite(d) || d === 0)) throw new Error('逃げ距離を数値で（例 1 または 1,2）'); return ds; },
      onPoint(p, h) {
        try {
          const ds = c.dists();
          if (c.o.how === 'par' && c.src) { done(nigeParallel(c.src, p, ds), '平行逃げ'); c.src = null; c.mode = 'entity'; return; }
          if (!h || !h.kind || h.kind === '線上' || h.kind === '直交') { K.toast('線の端点・角・交点をクリックしてください'); return; }
          done(nigeCorner(p, baseSegs(), ds), '角の逃げ');
        } catch (err) { K.toast(err.message); }
      },
      onPick(e) {
        try {
          const ds = c.dists();
          if (c.o.how === 'ext') { done(nigeExt(e.a, e.b, ds), '延長逃げ'); return; }
          c.src = e; c.mode = 'point';
        } catch (err) { K.toast(err.message); }
      },
      canBack: () => !!c.src, onBack() { c.src = null; c.mode = 'entity'; },
      onEnter() { c.done = true; },
      info: '<p>位置出し点（角）から、線の延長上や平行に逃げ杭（点の種別「逃げ」）を作ります。点名は「元の点名-1」。SIMA で TS に送れます。</p>',
    };
    function done(n, what) {
      if (n) K.commit(`${what}：逃げ杭 ${n} 本を作りました`);
      else { K.commit(); K.toast('作れる逃げがありませんでした（同じ位置に点があるか、線が見つかりません）'); }
    }
    return c;
  }
  function baseSegs() {
    const out = [];
    for (const e of K.visibleEnts()) {
      if (e.layer === '逃げ' || ['dim', 'align', 'text', 'leader', 'point', 'hatch'].includes(e.type)) continue;
      for (const s of K.geo(e).segs) if (G.dist(s[0], s[1]) > EPS) out.push(s);
    }
    return out;
  }
  function nigeName(base) {
    const used = new Set(K.doc.entities.filter((e) => e.type === 'point').map((e) => e.name));
    let i = 1; while (used.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }
  function addNige(base, p) { if (K.pointAt(p)) return null; return K.add({ type: 'point', p: { x: p.x, y: p.y }, z: 0, name: nigeName(base), grp: '逃げ' }); }
  function addNigeLine(a, b) { K.add({ type: 'line', a: { ...a }, b: { ...b }, layer: '逃げ', dash: true }, { style: false }); }
  function nigeCorner(P, segs, ds) {
    const dirs = [];
    const addDir = (u) => { if (!dirs.some((v) => Math.abs(v.x - u.x) < 1e-6 && Math.abs(v.y - u.y) < 1e-6)) dirs.push(u); };
    for (const [a, b] of segs) {
      const L = G.dist(a, b), u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      if (G.dist(P, a) < EPS) addDir({ x: -u.x, y: -u.y });
      else if (G.dist(P, b) < EPS) addDir(u);
      else if (G.segDist(P, a, b) < EPS) { addDir(u); addDir({ x: -u.x, y: -u.y }); }
    }
    if (!dirs.length) return 0;
    K.begin();
    const base = K.ensurePoint(P, '位置出し').name;
    let n = 0;
    for (const u of dirs) {
      let far = null;
      for (const d of ds) { const q = { x: P.x + u.x * d, y: P.y + u.y * d }; if (addNige(base, q)) n++; if (!far || Math.abs(d) > far.d) far = { q, d: Math.abs(d) }; }
      addNigeLine(P, far.q);
    }
    return n;
  }
  function nigeExt(a, b, ds) {
    K.begin();
    let n = 0;
    for (const [from, end] of [[b, a], [a, b]]) {
      const base = K.ensurePoint(end, '位置出し').name;
      let far = null;
      for (const d of ds) { const q = extendFrom(from, end, d); if (addNige(base, q)) n++; if (!far || Math.abs(d) > far.d) far = { q, d: Math.abs(d) }; }
      addNigeLine(end, far.q);
    }
    return n;
  }
  function nigeParallel(e, tap, ds) {
    const pts = e.type === 'line' ? [e.a, e.b] : e.pts, closed = e.type === 'poly' && !!e.closed && e.pts.length > 2;
    let side;
    if (closed) side = (G.pointInPoly(tap, pts) === orientation(pts) > 0) ? 1 : -1;
    else {
      let best = null;
      for (let i = 0; i + 1 < pts.length; i++) { const d = G.segDist(tap, pts[i], pts[i + 1]); if (!best || d < best.d) best = { d, a: pts[i], b: pts[i + 1] }; }
      side = -(tap.x - best.a.x) * (best.b.y - best.a.y) + (tap.y - best.a.y) * (best.b.x - best.a.x) >= 0 ? 1 : -1;
    }
    K.begin();
    const bases = pts.map((p) => K.ensurePoint(p, '位置出し').name);
    let n = 0;
    for (const d of ds) {
      const off = offsetPolyline(pts, side * Math.abs(d), closed);
      off.forEach((q, i) => { if (addNige(bases[i], q)) n++; });
      K.add({ type: 'poly', pts: off, closed, layer: '逃げ', dash: true }, { style: false });
    }
    return n;
  }

  // ------------------------------------------------------------
  // 杭打ち表（TS の器械点・後視点から）
  // ------------------------------------------------------------
  const stState = { o: '', bs: '', targets: '位置出し' };
  async function stakeTableDialog() {
    const s = stState;
    let result = null;
    const compute = () => {
      const o = K.pointByName(s.o), bs = K.pointByName(s.bs);
      if (!o || !bs) throw new Error('器械点と後視点の点名を入れてください');
      let list;
      if (K.GROUPS.includes(s.targets)) list = K.doc.entities.filter((e) => e.type === 'point' && K.grpOf(e) === s.targets);
      else if (s.targets === '全点') list = K.doc.entities.filter((e) => e.type === 'point');
      else list = s.targets.split(/[,、\s]+/).filter(Boolean).map((n) => { const e = K.pointByName(n); if (!e) throw new Error(`点「${n}」がありません`); return e; });
      list = list.filter((e) => e !== o && e !== bs);
      if (!list.length) throw new Error('杭打ちする点がありません');
      const r = stakeout(o.p, bs.p, list.map((e) => ({ name: e.name, p: e.p })));
      return { o, bs, rows: r.map((q, i) => ({ ...q, p: list[i].p })) };
    };
    const r = await K.dialog({
      title: '杭打ち表（器械点・後視点から夾角と距離）', wide: true,
      body: `<div class="form"><div class="grid3"><label>器械点 <input id="stO" list="ptNames" value="${esc(s.o)}"></label><label>後視点 <input id="stB" list="ptNames" value="${esc(s.bs)}"></label>
        <label>杭打ちする点（種別名・全点・点名をカンマ区切り） <input id="stT" value="${esc(s.targets)}"></label></div><div id="stRes"></div></div>`,
      buttons: [{ label: '閉じる', value: 'cancel' }, { label: '計算', value: 'calc' }, { label: '図面に表を置く', value: 'place', primary: true }],
      onButton(v, root) {
        if (v === 'cancel') return true;
        s.o = $('#stO', root).value.trim(); s.bs = $('#stB', root).value.trim(); s.targets = $('#stT', root).value.trim();
        try { result = compute(); } catch (err) { $('#stRes', root).innerHTML = `<p class="err">${esc(err.message)}</p>`; return false; }
        $('#stRes', root).innerHTML = `<div class="tbl"><table><tr><th>点名</th><th>夾角（右回り）</th><th>水平距離</th><th>X</th><th>Y</th></tr>${result.rows.map((q) => `<tr><td>${esc(q.name)}</td><td class="num">${toDMS(q.ang)}</td><td class="num">${fmt(q.d)}</td><td class="num">${fmt(q.p.x)}</td><td class="num">${fmt(q.p.y)}</td></tr>`).join('')}</table></div>`;
        return v !== 'calc';
      },
    });
    if (r !== 'place' || !result) return;
    const rows = [['点名', '夾角', '距離', 'X', 'Y'], ...result.rows.map((q) => [q.name, toDMS(q.ang), fmt(q.d), fmt(q.p.x), fmt(q.p.y)])];
    const build = (O) => tableEnts(O, [18, 26, 20, 28, 28], rows, { title: `杭打ち表　器械点 ${result.o.name}　後視点 ${result.bs.name}` });
    const p = await K.getPoint('杭打ち表を置く位置（左上）を指示', { preview: ghostAt(build) });
    if (p) { place(build(p)); K.toast('杭打ち表を配置しました'); }
  }

  const R = (title, icon, run, extra = {}) => ({ title, icon, run, ...extra });
  return {
    ptable: R('座標一覧', 'ptable', pointTable),
    regverts: { title: '頂点を点登録', icon: 'regverts', start: regVerts, needsSel: true, filter: (e) => ['line', 'poly', 'arc', 'circle', 'hatch'].includes(e.type) },
    fit: R('座標合わせ', 'fit', fitDialog, { tip: '図面を現場の座標（基準点）に合わせる' }),
    xsec: R('横断図', 'xsec', xsecDialog),
    profile: R('縦断図', 'profile', profileDialog),
    areatbl: { title: '求積表', icon: 'areatbl', start: areaTbl, needsSel: true, filter: (e) => e.type === 'poly' && e.closed },
    nige: { title: '逃げ杭', icon: 'nige', start: nige },
    stakeTable: R('杭打ち表', 'stake', stakeTableDialog),
  };
}

// テスト用
export const _test = {};
