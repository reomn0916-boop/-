// 計算メニュー（座標計算・路線計算）と計算書
import * as G from './cogo.js';
import { toDMS, parseAngle } from './geo.js';

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lr = (w) => (Math.abs(w) < 5e-4 ? '中心' : `${w > 0 ? '右' : '左'} ${fmt(Math.abs(w))} m`);
const xy = (p) => `${fmt(p.x)}, ${fmt(p.y)}`;

/** 計算の定義 */
function defs(api) {
  const pt = (k, label, opt = {}) => ({ k, label, type: 'pt', ...opt });
  const num = (k, label, opt = {}) => ({ k, label, type: 'num', ...opt });
  const ang = (k, label, opt = {}) => ({ k, label, type: 'ang', ...opt });
  const txt = (k, label, opt = {}) => ({ k, label, type: 'text', ...opt });

  return [
    {
      id: 'inverse', group: '座標計算', title: '2点間の計算（逆計算）', desc: '距離・方向角・高低差',
      fields: [pt('a', '始点'), pt('b', '終点')],
      run: ({ a, b }) => {
        const r = G.inverse({ ...a.p, z: a.z ?? 0 }, { ...b.p, z: b.z ?? 0 });
        const rows = [
          ['水平距離', fmt(r.d) + ' m', 'big'], ['方向角', toDMS(r.az)], ['ΔX', fmt(r.dx)], ['ΔY', fmt(r.dy)],
        ];
        if (a.z || b.z) rows.push(['高低差', fmt(r.dz)], ['勾配', fmt(r.slope, 2) + ' %'], ['斜距離', fmt(r.sd)]);
        return { rows, overlay: { lines: [[a.p, b.p]], pts: [{ p: a.p, label: a.label }, { p: b.p, label: b.label }] } };
      },
    },
    {
      id: 'radial', group: '座標計算', title: '放射計算', desc: '器械点から角度・距離で座標を出す',
      fields: [pt('o', '器械点'), pt('bs', '後視点', { opt: true, hint: '空欄なら下の方向角を使用' }),
        ang('bsAz', '後視の方向角', { opt: true }), ang('ang', '夾角（右回り）', { hint: '例 45-30-15 または 45.5' }),
        num('d', '水平距離 m'), txt('name', '新しい点名', { def: () => api.nextName() })],
      run: ({ o, bs, bsAz, ang: a, d, name }) => {
        if (!bs && !Number.isFinite(bsAz)) throw new Error('後視点か後視の方向角を入力してください');
        const r = G.radial(o.p, bs ? { bs: bs.p } : { bsAz }, a, d);
        return {
          rows: [['X', fmt(r.p.x), 'big'], ['Y', fmt(r.p.y), 'big'], ['方向角', toDMS(r.az)]],
          newPts: [{ p: r.p, name }],
          overlay: { lines: [...(bs ? [[o.p, bs.p]] : []), [o.p, r.p]], pts: [{ p: r.p, label: name }] },
        };
      },
    },
    {
      id: 'stakeout', group: '座標計算', title: '杭打ち計算（TS）', desc: '器械点・後視点から各点の夾角と距離',
      fields: [pt('o', '器械点'), pt('bs', '後視点'), { k: 'targets', label: '杭打ちする点', type: 'pts', def: '全点', hint: '点名をカンマ区切り。「全点」や「逃げ」「位置出し」など種別名でも可' }],
      run: ({ o, bs, targets }) => {
        const list = targets.filter((t) => t.label !== o.label && t.label !== bs.label);
        const r = G.stakeout(o.p, bs.p, list.map((t) => ({ name: t.label, p: t.p })));
        return {
          rows: [['後視方向角', toDMS(G.inverse(o.p, bs.p).az)], ['後視距離', fmt(G.dist(o.p, bs.p)) + ' m']],
          table: { head: ['点名', '夾角', '水平距離', '方向角'], rows: r.map((q) => [q.name, toDMS(q.ang), fmt(q.d), toDMS(q.az)]) },
          overlay: { lines: [[o.p, bs.p], ...list.map((t) => [o.p, t.p])], pts: [] },
        };
      },
    },
    {
      id: 'intersect', group: '座標計算', title: '交点計算（2直線）', desc: '直線AB と 直線CD の交点',
      fields: [pt('a', '直線1 始点 A'), pt('b', '直線1 終点 B'), pt('c', '直線2 始点 C'), pt('d', '直線2 終点 D'),
        txt('name', '新しい点名', { def: () => api.nextName() })],
      run: ({ a, b, c, d, name }) => {
        const r = G.intersect(a.p, b.p, c.p, d.p);
        if (!r) throw new Error('2直線が平行で交わりません');
        const where = (t) => (t >= 0 && t <= 1 ? '線分内' : '延長上');
        return {
          rows: [['X', fmt(r.p.x), 'big'], ['Y', fmt(r.p.y), 'big'],
            ['A からの距離', fmt(G.dist(a.p, r.p)) + ` m（${where(r.t)}）`], ['C からの距離', fmt(G.dist(c.p, r.p)) + ` m（${where(r.u)}）`]],
          newPts: [{ p: r.p, name }],
          overlay: { lines: [[a.p, r.p], [b.p, r.p], [c.p, r.p], [d.p, r.p]], pts: [{ p: r.p, label: name }] },
        };
      },
    },
    {
      id: 'distdist', group: '座標計算', title: '距離交会（杭の復元）', desc: '2つの引照点からの距離で位置を出す',
      fields: [pt('a', '引照点 A'), num('da', 'A からの距離 m'), pt('b', '引照点 B'), num('db', 'B からの距離 m'),
        { k: 'side', label: '求める側（A→B を見て）', type: 'select', options: [['right', '右側'], ['left', '左側']] },
        txt('name', '新しい点名', { def: () => api.nextName() })],
      run: ({ a, da, b, db, side, name }) => {
        const r = G.distDist(a.p, da, b.p, db);
        if (!r) throw new Error('この距離では2つの円が交わりません');
        const p = r[side];
        return {
          rows: [['X', fmt(p.x), 'big'], ['Y', fmt(p.y), 'big'], ['もう一方の解', xy(side === 'right' ? r.left : r.right)]],
          newPts: [{ p, name }],
          overlay: { lines: [[a.p, p], [b.p, p], [a.p, b.p]], pts: [{ p, label: name }] },
        };
      },
    },
    {
      id: 'perp', group: '座標計算', title: '垂線計算（点→線）', desc: '基準線に対する追加距離と幅（右＋/左−）',
      fields: [pt('a', '基準線 始点'), pt('b', '基準線 終点'), pt('p', '対象点'), txt('name', '垂線の足の点名', { def: () => api.nextName() })],
      run: ({ a, b, p, name }) => {
        const r = G.perpendicular(a.p, b.p, p.p);
        return {
          rows: [['追加距離', fmt(r.s) + ' m', 'big'], ['幅', lr(r.w), 'big'], ['垂線の足', xy(r.foot)],
            ['位置', r.inside ? '線分内' : '線分の延長上'], ['基準線の長さ', fmt(r.L) + ' m']],
          newPts: [{ p: r.foot, name }],
          overlay: { lines: [[a.p, b.p], [p.p, r.foot]], pts: [{ p: r.foot, label: name }] },
        };
      },
    },
    {
      id: 'offset', group: '座標計算', title: '幅杭・オフセット点（線→点）', desc: '基準線の追加距離と幅から座標',
      fields: [pt('a', '基準線 始点'), pt('b', '基準線 終点'), num('s', '追加距離 m（始点から）'), num('w', '幅 m（右＋ / 左−）'),
        txt('name', '新しい点名', { def: () => api.nextName() })],
      run: ({ a, b, s, w, name }) => {
        const p = G.offsetPoint(a.p, b.p, s, w);
        const foot = G.offsetPoint(a.p, b.p, s, 0);
        return {
          rows: [['X', fmt(p.x), 'big'], ['Y', fmt(p.y), 'big']],
          newPts: [{ p, name }],
          overlay: { lines: [[a.p, b.p], [foot, p]], pts: [{ p, label: name }] },
        };
      },
    },
    {
      id: 'area', group: '面積', title: '座標求積（面積計算書）', desc: '頂点の座標から面積（座標法）',
      fields: [{ k: 'pts', label: '頂点（順番に）', type: 'pts', hint: '点名をカンマ区切り。「選択」で選択中の図形' }],
      run: ({ pts }) => {
        if (pts.length < 3) throw new Error('3点以上必要です');
        const t = G.areaTable(pts.map((q) => ({ ...q.p, name: q.label })));
        return {
          rows: [['面積', fmt(t.area) + ' ㎡', 'big'], ['倍面積', fmt(t.double)], ['（坪）', fmt(t.area / 3.305785, 2) + ' 坪'], ['周長', fmt(t.perimeter) + ' m']],
          table: { head: ['点名', 'X', 'Y', 'Xn+1−Xn−1', 'Y×(Xn+1−Xn−1)'], rows: t.rows.map((r) => [r.name, fmt(r.x), fmt(r.y), fmt(r.dX), fmt(r.prod, 4)]) },
          overlay: { lines: pts.map((q, i) => [q.p, pts[(i + 1) % pts.length].p]), pts: [] },
          actions: [{ label: '面積図形を追加', fn: () => api.addArea(pts.map((q) => q.p)) }],
        };
      },
    },
    {
      id: 'align', group: '路線', title: '路線計算（中心杭・幅杭）', desc: 'IP 法・単曲線。No.杭 と主要点の座標',
      fields: [txt('aname', '路線名', { def: () => api.nextAlignName() }),
        { k: 'ips', label: 'BP・IP…・EP（順番に）', type: 'pts', hint: '例 BP,IP1,IP2,EP' },
        { k: 'radii', label: '各 IP の曲線半径 R', type: 'list', opt: true, hint: 'IP の順にカンマ区切り。0 は折れ点' },
        txt('s0', 'BP の測点', { def: 'No.0', hint: '例 No.0 / No.12+5.0 / 245.0' }),
        num('pitch', '杭の間隔 m', { def: '20' }),
        { k: 'widths', label: '幅杭の幅', type: 'list', opt: true, hint: '例 -5,5（左−・右＋）' },
        { k: 'extra', label: '追加測点', type: 'text', opt: true, hint: '例 No.3+5, 77.5' }],
      run: (v) => {
        const pitch = v.pitch > 0 ? v.pitch : 20;
        const s0 = G.parseStation(v.s0 || '0', pitch);
        if (!Number.isFinite(s0)) throw new Error('BP の測点が読めません');
        const ips = v.ips.map((q) => ({ ...q.p, name: q.label }));
        const radii = v.radii || [];
        const al = G.buildAlignment(ips, radii, s0);
        const extra = String(v.extra || '').split(/[,、\s]+/).filter(Boolean).map((t) => G.parseStation(t, pitch)).filter(Number.isFinite);
        const widths = v.widths || [];
        const stakes = G.alignStakes(al, { pitch, extra, widths });
        const head = ['測点', '追加距離', 'X', 'Y', ...widths.flatMap((w) => [`${w < 0 ? '左' : '右'}${Math.abs(w)} X`, `${w < 0 ? '左' : '右'}${Math.abs(w)} Y`])];
        const rows = stakes.map((q) => [q.station + (q.label ? ` ${q.label}` : ''), fmt(q.s), fmt(q.p.x), fmt(q.p.y), ...q.wp.flatMap((w) => [fmt(w.p.x), fmt(w.p.y)])]);
        const curveRows = al.curves.map((c) => [`${c.name}`, `R=${c.R} IA=${toDMS(Math.abs(c.IA), 0)}${c.IA > 0 ? '右' : '左'} TL=${fmt(c.TL)} CL=${fmt(c.CL)}`]);
        const ent = { type: 'align', name: v.aname || '路線', ips, radii, s0, pitch, widths };
        const stakePts = stakes.map((q) => ({ p: q.p, name: q.label ? `${q.station}(${q.label})` : q.station }));
        const widthPts = stakes.flatMap((q) => q.wp.map((w) => ({ p: w.p, name: `${q.station} ${w.w < 0 ? '左' : '右'}${Math.abs(w.w)}` })));
        return {
          rows: [['路線延長', fmt(al.length) + ' m', 'big'], ['BP', G.fmtStation(al.s0, pitch)], ['EP', G.fmtStation(al.sEnd, pitch)], ...curveRows],
          table: { head, rows },
          overlay: { lines: [], pts: [], align: ent },
          actions: [
            { label: '路線を図に追加', primary: true, fn: () => api.addAlign(ent) },
            { label: `中心杭 ${stakePts.length}点を登録`, fn: () => api.addPoints(stakePts) },
            ...(widthPts.length ? [{ label: `幅杭 ${widthPts.length}点を登録`, fn: () => api.addPoints(widthPts) }] : []),
          ],
        };
      },
    },
    {
      id: 'station', group: '路線', title: '測点 ⇔ 座標', desc: '点の測点・幅を出す／測点・幅から座標を出す',
      fields: [{ k: 'al', label: '路線', type: 'align' },
        { k: 'mode', label: '計算', type: 'select', options: [['p2s', '点 → 測点・幅'], ['s2p', '測点・幅 → 座標']] },
        pt('p', '点（点→測点のとき）', { opt: true }),
        txt('st', '測点（測点→座標のとき）', { opt: true, hint: '例 No.3+12.5' }),
        num('w', '幅 m（右＋ / 左−）', { opt: true, def: '0' }),
        txt('name', '新しい点名', { def: () => api.nextName() })],
      run: ({ al, mode, p, st, w, name }) => {
        const geo = api.alignGeom(al);
        if (mode === 'p2s') {
          if (!p) throw new Error('点を入力してください');
          const r = G.alignStation(geo, p.p, 0.5);
          if (!r) throw new Error('この点は路線の範囲外です');
          const c = G.alignPoint(geo, r.s).p;
          return {
            rows: [['測点', G.fmtStation(r.s, al.pitch), 'big'], ['幅', lr(r.w), 'big'], ['追加距離', fmt(r.s) + ' m'], ['中心の座標', xy(c)]],
            overlay: { lines: [[c, p.p]], pts: [{ p: c, label: G.fmtStation(r.s, al.pitch) }] },
            newPts: [{ p: c, name }],
          };
        }
        const s = G.parseStation(st, al.pitch);
        if (!Number.isFinite(s)) throw new Error('測点が読めません');
        if (s < geo.s0 - 1e-6 || s > geo.sEnd + 1e-6) throw new Error('路線の範囲外の測点です');
        const r = G.alignPoint(geo, s, w || 0);
        return {
          rows: [['X', fmt(r.p.x), 'big'], ['Y', fmt(r.p.y), 'big'], ['接線方向角', toDMS(r.az)], ['追加距離', fmt(s) + ' m']],
          newPts: [{ p: r.p, name }],
          overlay: { lines: [[G.alignPoint(geo, s).p, r.p]], pts: [{ p: r.p, label: name }] },
        };
      },
    },
    {
      id: 'curve', group: '路線', title: '単曲線の要素', desc: 'R と IA から TL・CL・SL など',
      fields: [num('R', '曲線半径 R m'), ang('IA', '交角 IA', { hint: '例 35-20-00' })],
      run: ({ R, IA }) => {
        const c = G.curveElements(R, IA);
        return {
          rows: [['接線長 TL', fmt(c.TL) + ' m', 'big'], ['曲線長 CL', fmt(c.CL) + ' m', 'big'], ['外線長 SL', fmt(c.SL) + ' m'],
            ['中央縦距 M', fmt(c.M) + ' m'], ['弦長 C', fmt(c.C) + ' m']],
        };
      },
    },
    {
      id: 'slope', group: 'その他', title: '勾配・法長', desc: '高さと勾配 1:n から水平距離・法長',
      fields: [num('H', '高さ H m'), num('n', '勾配 1 : n の n', { hint: '例 1.5（1割5分）' })],
      run: ({ H, n }) => {
        const r = G.slope(H, n);
        return {
          rows: [['水平距離', fmt(r.L) + ' m', 'big'], ['法長', fmt(r.len) + ' m', 'big'], ['角度', toDMS(r.deg, 0)], ['勾配', fmt(r.pct, 2) + ' %']],
        };
      },
    },
  ];
}

export function initCalc(api) {
  const sheet = document.getElementById('calcSheet');
  const body = document.getElementById('calcBody');
  const titleEl = document.getElementById('calcTitle');
  const backBtn = document.getElementById('calcBack');
  const CALCS = defs(api);
  const forms = new Map(); // id -> { el, resultEl }
  let current = null;

  function home() {
    current = null;
    titleEl.textContent = '計算';
    backBtn.hidden = true;
    let html = '';
    let group = '';
    for (const c of CALCS) {
      if (c.group !== group) { group = c.group; html += `<h3>${group}</h3>`; }
      html += `<button class="calc-item" data-calc="${c.id}"><b>${esc(c.title)}</b><span>${esc(c.desc)}</span></button>`;
    }
    body.innerHTML = html;
  }

  function fieldHtml(f) {
    const def = typeof f.def === 'function' ? f.def() : (f.def ?? '');
    const hint = f.hint ? `<small>${esc(f.hint)}</small>` : '';
    let input;
    if (f.type === 'select') {
      input = `<select data-k="${f.k}">${f.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'align') {
      const al = api.aligns();
      input = `<select data-k="${f.k}">${al.length ? al.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('') : '<option value="">（路線がありません）</option>'}</select>`;
    } else {
      const list = f.type === 'pt' ? ' list="ptNames"' : '';
      input = `<input data-k="${f.k}" type="text" value="${esc(def)}"${list} autocomplete="off" autocapitalize="off" spellcheck="false">`;
      if (f.type === 'pt' || f.type === 'pts') input += `<button class="pick" data-pick="${f.k}" data-multi="${f.type === 'pts' ? 1 : 0}" aria-label="図から選ぶ">📍</button>`;
    }
    return `<label class="field"><span>${esc(f.label)}${f.opt ? '<i>任意</i>' : ''}</span><div class="in">${input}</div>${hint}</label>`;
  }

  function open(id) {
    const c = CALCS.find((q) => q.id === id);
    if (!c) return;
    current = c;
    titleEl.textContent = c.title;
    backBtn.hidden = false;
    let f = forms.get(id);
    if (!f) {
      const el = document.createElement('div');
      el.className = 'calc-form';
      el.innerHTML = c.fields.map(fieldHtml).join('') +
        '<div class="row"><button class="btn primary wide" data-run>計算する</button></div><div class="calc-result"></div>';
      f = { el, resultEl: el.querySelector('.calc-result') };
      forms.set(id, f);
    } else {
      // 点名の初期値・路線リストを最新に
      for (const fd of c.fields) {
        const inp = f.el.querySelector(`[data-k="${fd.k}"]`);
        if (fd.type === 'align') inp.outerHTML = fieldHtml(fd).match(/<select[\s\S]*<\/select>/)[0];
        else if (fd.k === 'name' && typeof fd.def === 'function' && f.used) { inp.value = fd.def(); f.used = false; }
      }
    }
    body.innerHTML = '';
    body.appendChild(f.el);
  }

  function readValues(c, el) {
    const v = {};
    for (const f of c.fields) {
      const inp = el.querySelector(`[data-k="${f.k}"]`);
      const raw = (inp.value || '').trim();
      if (!raw && !f.opt && f.type !== 'select') throw new Error(`「${f.label}」を入力してください`);
      switch (f.type) {
        case 'pt': v[f.k] = raw ? api.resolve(raw) : null; break;
        case 'pts': {
          if (raw === '全点') { v[f.k] = api.allPoints(); break; }
          if (['基準点', '位置出し', '逃げ', 'その他'].includes(raw)) { v[f.k] = api.allPoints(raw); if (!v[f.k].length) throw new Error(`種別「${raw}」の点がありません`); break; }
          if (raw === '選択') { v[f.k] = api.selectedVerts(); if (!v[f.k]) throw new Error('図形が選択されていません'); break; }
          v[f.k] = raw.split(/[,、\s]+/).filter(Boolean).map((t) => api.resolve(t));
          break;
        }
        case 'num': {
          if (!raw) { v[f.k] = NaN; break; }
          const n = Number(raw.replace(/，/g, '.'));
          if (!Number.isFinite(n)) throw new Error(`「${f.label}」は数値で入力してください`);
          v[f.k] = n; break;
        }
        case 'ang': {
          if (!raw) { v[f.k] = NaN; break; }
          const a = parseAngle(raw);
          if (!Number.isFinite(a)) throw new Error(`「${f.label}」の角度が読めません`);
          v[f.k] = a; break;
        }
        case 'list': v[f.k] = raw ? raw.split(/[,、\s]+/).filter(Boolean).map(Number) : []; if (v[f.k].some((n) => !Number.isFinite(n))) throw new Error(`「${f.label}」は数値をカンマ区切りで`); break;
        case 'align': { const a = api.aligns().find((q) => String(q.id) === inp.value); if (!a) throw new Error('路線がありません。先に「路線計算」で路線を追加してください'); v[f.k] = a; break; }
        default: v[f.k] = raw;
      }
    }
    return v;
  }

  function kv(rows) {
    return '<dl class="kv">' + rows.map(([k, val, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(val)}</dd>`).join('') + '</dl>';
  }

  function run() {
    const c = current; if (!c) return;
    const f = forms.get(c.id);
    let res, vals;
    try {
      vals = readValues(c, f.el);
      res = c.run(vals);
    } catch (err) {
      f.resultEl.innerHTML = `<p class="err">${esc(err.message)}</p>`;
      return;
    }
    let html = kv(res.rows || []);
    if (res.table) {
      html += '<div class="tbl"><table><thead><tr>' + res.table.head.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>' +
        res.table.rows.map((r) => '<tr>' + r.map((x, i) => `<td class="${i ? 'num' : ''}">${esc(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
    }
    html += '<div class="panel-actions">';
    const acts = [];
    if (res.newPts?.length) acts.push({ label: res.newPts.length === 1 ? `「${res.newPts[0].name}」を点登録` : `${res.newPts.length}点を登録`, primary: true, fn: () => { api.addPoints(res.newPts); f.used = true; } });
    for (const a of res.actions || []) acts.push(a);
    if (res.overlay) acts.push({ label: '図で確認', fn: () => { sheet.close(); api.showOverlay(res.overlay); } });
    acts.push({ label: '計算書に追加', fn: () => api.addReport(makeReport(c, f.el, res)) });
    html += acts.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''}" data-ract="${i}">${esc(a.label)}</button>`).join('');
    html += '</div>';
    f.resultEl.innerHTML = html;
    f.acts = acts;
    api.setOverlay(res.overlay || null);
  }

  function makeReport(c, el, res) {
    const inputs = c.fields.map((f) => {
      const inp = el.querySelector(`[data-k="${f.k}"]`);
      const val = inp.tagName === 'SELECT' ? inp.options[inp.selectedIndex]?.text : inp.value;
      return [f.label, val || ''];
    }).filter(([k, v]) => v && !/点名$/.test(k));
    return { title: c.title, time: new Date().toLocaleString('ja-JP'), inputs, rows: (res.rows || []).map(([k, v]) => [k, v]), table: res.table || null };
  }

  body.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-calc]');
    if (item) { open(item.dataset.calc); return; }
    if (ev.target.closest('[data-run]')) { ev.preventDefault(); run(); return; }
    const ra = ev.target.closest('[data-ract]');
    if (ra) { ev.preventDefault(); const f = forms.get(current.id); f.acts?.[Number(ra.dataset.ract)]?.fn(); return; }
    const pk = ev.target.closest('[data-pick]');
    if (pk) {
      ev.preventDefault();
      const inp = pk.parentElement.querySelector('input');
      const multi = pk.dataset.multi === '1';
      sheet.close();
      if (multi && /^(全点|選択)$/.test(inp.value.trim())) inp.value = '';
      api.pick((r) => {
        if (multi) inp.value = inp.value.trim() ? inp.value.replace(/[,\s]*$/, '') + ',' + r : r;
        else inp.value = r;
      }, multi, () => sheet.showModal());
    }
  });
  backBtn.addEventListener('click', home);

  return {
    open(id) { if (id) open(id); else if (!current) home(); sheet.showModal(); },
    /** 計算フォームに値を入れて開く */
    openWith(id, values) {
      open(id);
      const f = forms.get(id);
      for (const [k, val] of Object.entries(values)) { const inp = f.el.querySelector(`[data-k="${k}"]`); if (inp) inp.value = val; }
      sheet.showModal();
      run();
    },
  };
}

// ============================================================
// 計算書
// ============================================================
export function reportHtml(r) {
  let h = `<section class="report"><h3>${esc(r.title)}</h3><p class="small">${esc(r.time)}</p>`;
  if (r.inputs?.length) h += '<table class="rk">' + r.inputs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</table>';
  if (r.rows?.length) h += '<table class="rk res">' + r.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</table>';
  if (r.table) {
    h += '<div class="tbl"><table><thead><tr>' + r.table.head.map((x) => `<th>${esc(x)}</th>`).join('') + '</tr></thead><tbody>' +
      r.table.rows.map((row) => '<tr>' + row.map((x, i) => `<td class="${i ? 'num' : ''}">${esc(x)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  return h + '</section>';
}

export function reportsCSV(reports) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const L = [];
  for (const r of reports) {
    L.push(q(r.title), q(r.time));
    for (const [k, v] of r.inputs || []) L.push([q(k), q(v)].join(','));
    for (const [k, v] of r.rows || []) L.push([q(k), q(v)].join(','));
    if (r.table) { L.push(r.table.head.map(q).join(',')); for (const row of r.table.rows) L.push(row.map(q).join(',')); }
    L.push('');
  }
  return '﻿' + L.join('\r\n');
}
