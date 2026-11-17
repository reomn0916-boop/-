// ファイル入出力: DXF / SIMA / CSV
// 内部の座標: x = X(北), y = Y(東)。DXF では DXF-X = 東(Y), DXF-Y = 北(X) として扱う。
import { LTYPES, aciToHex, hexToAci, trueColorHex } from './draft.js';

/** バイト列を文字列へ（UTF-8 で化ける場合は Shift_JIS） */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  let s = new TextDecoder('utf-8').decode(u8);
  if (s.includes('�')) {
    try { s = new TextDecoder('shift_jis').decode(u8); } catch { /* 非対応環境はそのまま */ }
  }
  return s;
}

// ---------------- DXF 読み込み ----------------
export function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  }
  // 画層の表（色・線種）
  const layers = [];
  const ltByDxf = Object.fromEntries(Object.entries(LTYPES).map(([k, v]) => [v.dxf, k]));
  const ltOf = (name) => { const n = String(name || '').trim().toUpperCase(); if (!n || n === 'BYLAYER' || n === 'BYBLOCK') return null; return ltByDxf[n] || (/DASH|HIDDEN|破線/.test(n) ? 'dash' : /CENTER|CHAIN|DASHDOT|一点/.test(n) ? 'chain' : /PHANTOM|二点/.test(n) ? 'chain2' : /DOT|点線/.test(n) ? 'dot' : null); };
  for (let k = 0; k < pairs.length; k++) {
    if (pairs[k][0] !== 0 || pairs[k][1].trim() !== 'LAYER') continue;
    const L = { name: '', color: null, ltype: null, hidden: false };
    for (let m = k + 1; m < pairs.length && pairs[m][0] !== 0; m++) {
      const [c, v] = pairs[m];
      if (c === 2) L.name = v.trim();
      else if (c === 62) { const n = parseInt(v, 10); L.hidden = n < 0; L.color = aciToHex(Math.abs(n)); }
      else if (c === 420) L.color = trueColorHex(v);
      else if (c === 6) L.ltype = ltOf(v);
    }
    if (L.name && !layers.some((q) => q.name === L.name)) layers.push(L);
  }

  // ENTITIES セクションを探す（BLOCKS は対象外）
  let i = 0;
  let inEntities = false;
  const out = [];
  const warn = new Set();
  while (i < pairs.length) {
    const [c, v] = pairs[i];
    if (c === 0 && v.trim() === 'SECTION' && pairs[i + 1] && pairs[i + 1][1].trim() === 'ENTITIES') {
      inEntities = true; i += 2; continue;
    }
    if (inEntities && c === 0 && v.trim() === 'ENDSEC') break;
    if (!inEntities || c !== 0) { i++; continue; }
    const type = v.trim();
    // エンティティのグループを集める
    let j = i + 1;
    const g = [];
    while (j < pairs.length && pairs[j][0] !== 0) { g.push(pairs[j]); j++; }
    const num = (code, def = 0) => { const p = g.find((q) => q[0] === code); return p ? parseFloat(p[1]) : def; };
    const str = (code) => { const p = g.find((q) => q[0] === code); return p ? p[1] : ''; };
    const layer = str(8).trim() || '0';
    const P = (e, nn) => ({ x: nn, y: e }); // DXF(東, 北) → 内部(北, 東)
    const n0 = out.length;

    switch (type) {
      case 'LINE':
        out.push({ type: 'line', layer, a: P(num(10), num(20)), b: P(num(11), num(21)) });
        break;
      case 'POINT':
        out.push({ type: 'point', layer, p: P(num(10), num(20)), name: '' });
        break;
      case 'CIRCLE':
        out.push({ type: 'circle', layer, c: P(num(10), num(20)), r: num(40) });
        break;
      case 'ARC':
        // DXF の角度（東から反時計回り）をそのまま保持
        out.push({ type: 'arc', layer, c: P(num(10), num(20)), r: num(40), a0: num(50), a1: num(51) });
        break;
      case 'TEXT':
      case 'MTEXT': {
        let t = g.filter((q) => q[0] === 3 || q[0] === 1).map((q) => q[1]).join('');
        t = t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
        let align = 'left';
        let pos = P(num(10), num(20));
        if (type === 'TEXT') {
          const h72 = num(72, 0);
          if (h72 === 1 || h72 === 4) align = 'center'; else if (h72 === 2) align = 'right';
          if (align !== 'left' && g.some((q) => q[0] === 11)) pos = P(num(11), num(21));
        } else {
          align = ['left', 'center', 'right'][(Math.max(1, num(71, 1)) - 1) % 3];
        }
        out.push({ type: 'text', layer, p: pos, h: num(40, 1), text: t, rot: num(50, 0), align });
        break;
      }
      case 'LWPOLYLINE': {
        const pts = [];
        let cur = null;
        for (const [cc, vv] of g) {
          if (cc === 10) { cur = { e: parseFloat(vv), n: 0 }; }
          else if (cc === 20 && cur) { cur.n = parseFloat(vv); pts.push(P(cur.e, cur.n)); cur = null; }
        }
        out.push({ type: 'poly', layer, pts, closed: (num(70) & 1) === 1 });
        break;
      }
      case 'POLYLINE': {
        const closed = (num(70) & 1) === 1;
        const pts = [];
        let k = j;
        while (k < pairs.length) {
          if (pairs[k][0] === 0 && pairs[k][1].trim() === 'SEQEND') break;
          if (pairs[k][0] === 0 && pairs[k][1].trim() === 'VERTEX') {
            let e = 0, nn = 0, m = k + 1;
            while (m < pairs.length && pairs[m][0] !== 0) {
              if (pairs[m][0] === 10) e = parseFloat(pairs[m][1]);
              if (pairs[m][0] === 20) nn = parseFloat(pairs[m][1]);
              m++;
            }
            pts.push(P(e, nn));
            k = m; continue;
          }
          k++;
        }
        out.push({ type: 'poly', layer, pts, closed });
        j = k + 1;
        break;
      }
      default:
        if (!['SEQEND', 'VERTEX', 'ATTRIB'].includes(type)) warn.add(type);
    }
    // 図形ごとの色・線種（BYLAYER は画層に従う）
    if (out.length > n0) {
      const e = out[out.length - 1];
      const tc = g.find((q) => q[0] === 420);
      const ci = g.find((q) => q[0] === 62);
      if (tc) e.color = trueColorHex(tc[1]);
      else if (ci) { const n = parseInt(ci[1], 10); if (n > 0 && n < 256) e.color = aciToHex(n); }
      const lt = ltOf(str(6));
      if (lt && lt !== 'solid') e.ltype = lt;
    }
    i = j;
  }
  // 本アプリが書き出した点名（POINT_NAME 画層の文字）を点に戻す
  const names = out.filter((e) => e.type === 'text' && e.layer === 'POINT_NAME');
  const used = new Set();
  for (const t of names) {
    const pt = out.find((e) => e.type === 'point' && !e.name && Math.abs(e.p.x - t.p.x) < 1e-3 && Math.abs(e.p.y - t.p.y) < 1e-3);
    if (pt) { pt.name = t.text; used.add(t); }
  }
  return { entities: out.filter((e) => !used.has(e)), skipped: [...warn], layers };
}

// ---------------- DXF 書き出し (R12 ASCII) ----------------
/**
 * @param entities 線・連続線・円・円弧・文字・点・寸法（寸法は線と文字に簡略化）
 * @param opt {layers:[{name,color,ltype}], scaleN} 画層の色・線種、線種のピッチ用の縮尺
 */
export function toDXF(entities, opt = {}) {
  const L = [];
  const w = (c, v) => { L.push(String(c), String(v)); };
  const f = (v) => Number(v).toFixed(4);
  const xy = (p, base = 10) => { w(base, f(p.y)); w(base + 10, f(p.x)); w(base + 20, '0.0'); };
  const k = (opt.scaleN || 100) / 1000; // 用紙 mm → m
  const layerOf = (e) => e.layer || (e.type === 'point' ? 'POINT' : e.type === 'dim' ? 'DIM' : '0');
  const defs = new Map((opt.layers || []).map((l) => [l.name, l]));
  const names = new Set(['0']);
  for (const e of entities) { names.add(layerOf(e)); if (e.type === 'point' && e.name) names.add('POINT_NAME'); }
  w(0, 'SECTION'); w(2, 'HEADER'); w(9, '$ACADVER'); w(1, 'AC1009'); w(9, '$DWGCODEPAGE'); w(3, 'ANSI_932'); w(0, 'ENDSEC');
  // 線種と画層の表
  w(0, 'SECTION'); w(2, 'TABLES');
  const lts = Object.values(LTYPES);
  w(0, 'TABLE'); w(2, 'LTYPE'); w(70, lts.length);
  for (const t of lts) {
    w(0, 'LTYPE'); w(2, t.dxf); w(70, 0); w(3, t.name); w(72, 65); w(73, t.pat.length);
    w(40, f(t.pat.reduce((a, b) => a + b, 0) * k));
    t.pat.forEach((d, i) => w(49, f((i % 2 ? -d : d) * k)));
  }
  w(0, 'ENDTAB');
  w(0, 'TABLE'); w(2, 'LAYER'); w(70, names.size);
  for (const n of names) {
    const d = defs.get(n) || {};
    w(0, 'LAYER'); w(2, n); w(70, 0); w(62, (d.hidden ? -1 : 1) * hexToAci(d.color)); w(6, LTYPES[d.ltype]?.dxf || 'CONTINUOUS');
  }
  w(0, 'ENDTAB');
  w(0, 'ENDSEC');
  w(0, 'SECTION'); w(2, 'ENTITIES');
  const head = (type, e, layer = layerOf(e)) => {
    w(0, type); w(8, layer);
    if (e.color) w(62, hexToAci(e.color));
    const lt = e.dash ? 'dash' : e.ltype;
    if (lt && lt !== 'solid' && LTYPES[lt]) w(6, LTYPES[lt].dxf);
  };
  for (const e of entities) {
    switch (e.type) {
      case 'point':
        head('POINT', e); xy(e.p);
        if (e.name) { w(0, 'TEXT'); w(8, 'POINT_NAME'); xy({ x: e.p.x, y: e.p.y }); w(40, '0.5'); w(1, e.name); }
        break;
      case 'line':
        head('LINE', e); xy(e.a, 10); xy(e.b, 11);
        break;
      case 'dim': {
        head('LINE', e); xy(e.a, 10); xy(e.b, 11);
        const m = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
        head('TEXT', e); xy(m); w(40, '0.5'); w(1, Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y).toFixed(3));
        break;
      }
      case 'poly':
        head('POLYLINE', e); w(66, 1); xy({ x: 0, y: 0 }); w(70, e.closed ? 1 : 0);
        for (const p of e.pts) { w(0, 'VERTEX'); w(8, layerOf(e)); xy(p); }
        w(0, 'SEQEND'); w(8, layerOf(e));
        break;
      case 'circle':
        head('CIRCLE', e); xy(e.c); w(40, f(e.r));
        break;
      case 'arc':
        head('ARC', e); xy(e.c); w(40, f(e.r)); w(50, f(e.a0)); w(51, f(e.a1));
        break;
      case 'text':
        head('TEXT', e); xy(e.p); w(40, f(e.h || 1)); w(1, e.text);
        if (e.rot) w(50, f(e.rot));
        if (e.align === 'center' || e.align === 'right') { w(72, e.align === 'center' ? 1 : 2); xy(e.p, 11); }
        break;
    }
  }
  w(0, 'ENDSEC'); w(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

// ---------------- 座標リスト (SIMA / CSV) ----------------
/** SIMA (A01 座標データ) を読む → [{name, x, y, z}] */
export function parseSIMA(text) {
  const out = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const c = line.split(',');
    if (c[0] !== 'A01') continue;
    const x = parseFloat(c[3]), y = parseFloat(c[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ name: (c[2] || c[1] || '').trim(), x, y, z: parseFloat(c[5]) || 0 });
  }
  return out;
}

/**
 * SIMA 座標データ（＋任意で区画データ）
 * points: [{name, x, y, z}]
 * areas:  [{name, idx: [points の番号(0始まり)…]}]
 */
export function toSIMA(points, title = 'MobileCAD', areas = []) {
  const L = ['G00,01,' + title + ',', 'Z00,座標ﾃﾞｰﾀ,', 'A00,'];
  points.forEach((p, i) => {
    L.push(`A01,${i + 1},${p.name || 'P' + (i + 1)},${p.x.toFixed(3)},${p.y.toFixed(3)},${(p.z || 0).toFixed(3)},`);
  });
  L.push('A99,');
  if (areas.length) {
    L.push('Z00,区画ﾃﾞｰﾀ,');
    areas.forEach((a, k) => {
      L.push(`D00,${k + 1},${a.name || '区画' + (k + 1)},1,`);
      for (const i of a.idx) L.push(`B01,${i + 1},${points[i].name},`);
      L.push('D99,');
    });
  }
  return L.join('\r\n') + '\r\n';
}

// ---------------- Shift_JIS 変換 ----------------
let sjisMap = null;
/** 文字列 → Shift_JIS のバイト列（変換できない文字は "?"） */
export function encodeSJIS(str) {
  if (!sjisMap) {
    sjisMap = new Map();
    const dec = new TextDecoder('shift_jis');
    for (let b = 0xa1; b <= 0xdf; b++) sjisMap.set(dec.decode(new Uint8Array([b])), [b]); // 半角カナ
    const leads = [];
    for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
    for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
    for (const l of leads) {
      for (let t = 0x40; t <= 0xfc; t++) {
        if (t === 0x7f) continue;
        const ch = dec.decode(new Uint8Array([l, t]));
        if (ch.length === 1 && ch !== '\uFFFD' && !sjisMap.has(ch)) sjisMap.set(ch, [l, t]);
      }
    }
  }
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const m = sjisMap.get(ch);
    if (m) out.push(...m); else out.push(0x3f);
  }
  return new Uint8Array(out);
}

/** CSV: 「点名,X,Y[,Z]」 または 「X,Y」。見出し行は自動で読み飛ばす */
export function parseCSV(text) {
  const out = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const c = raw.split(/[,\t]/).map((s) => s.trim());
    if (c.length < 2) continue;
    const nums = c.map(Number);
    if (c.length >= 3 && Number.isFinite(nums[1]) && Number.isFinite(nums[2]) && c[1] !== '' && c[2] !== '') {
      out.push({ name: c[0], x: nums[1], y: nums[2], z: Number.isFinite(nums[3]) ? nums[3] : 0 });
    } else if (Number.isFinite(nums[0]) && Number.isFinite(nums[1]) && c[0] !== '' && c[1] !== '') {
      out.push({ name: '', x: nums[0], y: nums[1], z: 0 });
    }
  }
  return out;
}

export function toCSV(points, zone) {
  const L = [`点名,X(北),Y(東),Z${zone ? ',系=' + zone : ''}`];
  for (const p of points) L.push(`${p.name},${p.x.toFixed(3)},${p.y.toFixed(3)},${(p.z || 0).toFixed(3)}`);
  return '﻿' + L.join('\r\n') + '\r\n'; // BOM 付き（Excel で文字化けしない）
}
