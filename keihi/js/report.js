// 精算書（A4）・領収書の台紙の作成と、PDF・CSV の書き出し
import { canvasToBlob } from './ocr.js';

const W = 1240; const H = 1754; // A4 150dpi
const MM = W / 210;
const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif';
const INK = '#1a1f24'; const SUB = '#5a6570'; const LINE = '#9aa4ad'; const HEAD = '#eef2f0';

export const yen = (n) => `¥${Math.round(n || 0).toLocaleString('ja-JP')}`;
export const isCompanyPaid = (e) => e.method === '会社カード' || e.method === '請求書払い';

export function summarize(items) {
  let reimb = 0; let company = 0;
  const byCat = new Map(); const bySite = new Map();
  for (const e of items) {
    const a = e.amount || 0;
    if (isCompanyPaid(e)) company += a; else reimb += a;
    byCat.set(e.category || '未分類', (byCat.get(e.category || '未分類') || 0) + a);
    bySite.set(e.site || '（なし）', (bySite.get(e.site || '（なし）') || 0) + a);
  }
  const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { reimb, company, total: reimb + company, count: items.length, byCat: sort(byCat), bySite: sort(bySite) };
}

export function sortForReport(items) {
  return [...items].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.created || 0) - (b.created || 0));
}

function jpDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function page() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  g.fillStyle = INK; g.strokeStyle = INK;
  return { c, g };
}

function font(g, sizeMm, weight = 400) { g.font = `${weight} ${Math.round(sizeMm * MM)}px ${FONT}`; }

function fit(g, text, maxW) {
  text = String(text ?? '');
  if (g.measureText(text).width <= maxW) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + '…';
}

function text(g, s, xMm, yMm, { size = 3.2, weight = 400, align = 'left', color = INK, maxMm = 0 } = {}) {
  font(g, size, weight);
  g.fillStyle = color; g.textAlign = align;
  g.fillText(maxMm ? fit(g, s, maxMm * MM) : String(s ?? ''), xMm * MM, yMm * MM);
}

function rect(g, x, y, w, h, { fill = null, stroke = LINE, lw = 1 } = {}) {
  if (fill) { g.fillStyle = fill; g.fillRect(x * MM, y * MM, w * MM, h * MM); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.strokeRect(x * MM + 0.5, y * MM + 0.5, w * MM, h * MM); }
}

function hline(g, x1, x2, y, color = LINE, lw = 1) {
  g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath(); g.moveTo(x1 * MM, y * MM + 0.5); g.lineTo(x2 * MM, y * MM + 0.5); g.stroke();
}

const COLS = [
  { key: 'no', label: 'No.', w: 9, align: 'center' },
  { key: 'date', label: '日付', w: 15, align: 'center' },
  { key: 'category', label: '勘定科目', w: 21 },
  { key: 'payee', label: '支払先', w: 33 },
  { key: 'memo', label: '内容・目的', w: 37 },
  { key: 'site', label: '現場・案件', w: 24 },
  { key: 'method', label: '支払', w: 13, align: 'center' },
  { key: 'inv', label: '適格', w: 8, align: 'center' },
  { key: 'amount', label: '金額', w: 20, align: 'right' },
];
const LEFT = 15; const RIGHT = 195; const ROW = 7.4;

function shortMethod(m) {
  return { 現金: '現金', 個人カード: 'カード', 電子マネー: '電子M', 会社カード: '会社C', 請求書払い: '請求書' }[m] || (m || '');
}

function memoOf(e) {
  const parts = [];
  if (e.route && (e.route.from || e.route.to)) parts.push(`${e.route.from || ''}→${e.route.to || ''}${e.route.round ? '（往復）' : ''}`);
  if (e.kind === 'car' && e.km) parts.push(`${e.km}km`);
  if (e.memo) parts.push(e.memo);
  if (e.people) parts.push(`${e.people}名${e.guests ? `・${e.guests}` : ''}`);
  return parts.join(' ');
}

function drawTableHeader(g, y) {
  let x = LEFT;
  rect(g, LEFT, y, RIGHT - LEFT, 7.5, { fill: HEAD, stroke: INK });
  for (const col of COLS) {
    text(g, col.label, col.align === 'right' ? x + col.w - 1.5 : col.align === 'center' ? x + col.w / 2 : x + 1.5, y + 3.9, { size: 2.9, weight: 700, align: col.align || 'left' });
    x += col.w;
    if (x < RIGHT) { g.strokeStyle = LINE; g.lineWidth = 1; g.beginPath(); g.moveTo(x * MM, y * MM); g.lineTo(x * MM, (y + 7.5) * MM); g.stroke(); }
  }
  return y + 7.5;
}

function drawRow(g, y, e, no) {
  const [, m, d] = (e.date || '--').split('-');
  const cells = {
    no: String(no),
    date: e.date ? `${+m}/${+d}` : '',
    category: e.category || '',
    payee: e.payee || '',
    memo: memoOf(e),
    site: e.site || '',
    method: shortMethod(e.method),
    inv: e.invoiceNo ? '○' : '',
    amount: isCompanyPaid(e) ? `(${yen(e.amount)})` : yen(e.amount),
  };
  let x = LEFT;
  for (const col of COLS) {
    const tx = col.align === 'right' ? x + col.w - 1.5 : col.align === 'center' ? x + col.w / 2 : x + 1.5;
    text(g, cells[col.key], tx, y + ROW / 2 + 0.2, { size: col.key === 'amount' ? 3.1 : 2.8, align: col.align || 'left', maxMm: col.w - 2.4, weight: col.key === 'amount' ? 600 : 400 });
    x += col.w;
    if (x < RIGHT) { g.strokeStyle = '#d5dbe0'; g.lineWidth = 1; g.beginPath(); g.moveTo(x * MM, y * MM); g.lineTo(x * MM, (y + ROW) * MM); g.stroke(); }
  }
  hline(g, LEFT, RIGHT, y + ROW, '#c3cbd2');
  g.strokeStyle = LINE; g.beginPath(); g.moveTo(LEFT * MM + 0.5, y * MM); g.lineTo(LEFT * MM + 0.5, (y + ROW) * MM); g.moveTo(RIGHT * MM + 0.5, y * MM); g.lineTo(RIGHT * MM + 0.5, (y + ROW) * MM); g.stroke();
  return y + ROW;
}

function footer(g, i, n, settings) {
  text(g, `${settings.name ? `${settings.name}　` : ''}経費精算書　${i} / ${n}`, 105, 287, { size: 2.6, align: 'center', color: SUB });
}

// 精算書のページを作る
export async function renderReport({ items, settings, from, to, advance = 0, getImage, onProgress }) {
  const list = sortForReport(items);
  const sum = summarize(list);
  const pages = [];
  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  // ---- 1 ページ目: 見出し・申請者・承認欄・合計
  let { c, g } = page();
  pages.push(c);
  text(g, `提出日　${todayStr}`, RIGHT, 14, { size: 3, align: 'right', color: SUB });
  text(g, '経 費 精 算 書', 105, 24, { size: 8, weight: 700, align: 'center' });
  hline(g, 70, 140, 29.2, INK, 2); hline(g, 70, 140, 30.2, INK, 1);

  const info = [
    ['会社名・所属', [settings.company, settings.dept].filter(Boolean).join('　')],
    ['氏名', settings.name || ''],
    ['精算期間', `${jpDate(from)} 〜 ${jpDate(to)}`],
  ];
  info.forEach(([k, v], i) => {
    const y = 40 + i * 8.5;
    text(g, k, LEFT, y, { size: 2.9, color: SUB });
    text(g, v, LEFT + 25, y, { size: i === 1 ? 4.2 : 3.4, weight: i === 1 ? 700 : 400, maxMm: 85 });
    hline(g, LEFT, LEFT + 110, y + 3.6, LINE);
  });
  if (settings.name) text(g, '印', LEFT + 107, 48.5, { size: 3, color: '#b9c1c8', align: 'center' });

  const stamps = ['承認', '確認', '申請者'];
  stamps.forEach((s, i) => {
    const x = RIGHT - 63 + i * 21;
    rect(g, x, 34, 21, 6, { fill: HEAD, stroke: INK });
    rect(g, x, 40, 21, 19, { stroke: INK });
    text(g, s, x + 10.5, 37.1, { size: 2.8, weight: 600, align: 'center' });
  });

  // 合計の枠
  const net = sum.reimb - (advance || 0);
  const boxes = [
    ['立替合計（精算対象）', yen(sum.reimb), false],
    ['仮払金', advance ? `− ${yen(advance)}` : '¥0', false],
    [net >= 0 ? '差引支給額' : '差引返金額', yen(Math.abs(net)), true],
  ];
  const bw = (RIGHT - LEFT) / 3;
  boxes.forEach(([k, v, strong], i) => {
    const x = LEFT + i * bw;
    rect(g, x, 66, bw, 7, { fill: strong ? '#dff1e8' : HEAD, stroke: INK });
    rect(g, x, 73, bw, 14, { stroke: INK, lw: strong ? 3 : 1 });
    text(g, k, x + bw / 2, 69.6, { size: 3, weight: 700, align: 'center' });
    text(g, v, x + bw - 4, 80.3, { size: strong ? 6.4 : 5.2, weight: 700, align: 'right' });
  });
  text(g, `件数 ${sum.count}件　${sum.company ? `会社払い（参考・精算額に含まない） ${yen(sum.company)}　` : ''}（ ）は会社払い　適格○＝登録番号あり`, LEFT, 91.5, { size: 2.6, color: SUB });

  // ---- 明細
  let y = drawTableHeader(g, 95);
  let no = 0;
  const bottom = 278;
  for (const e of list) {
    if (y + ROW > bottom) {
      ({ c, g } = page()); pages.push(c);
      text(g, '経費精算書（明細のつづき）', LEFT, 16, { size: 3.6, weight: 700 });
      y = drawTableHeader(g, 22);
    }
    y = drawRow(g, y, e, ++no);
  }
  // 合計行
  if (y + 9 > bottom) { ({ c, g } = page()); pages.push(c); y = drawTableHeader(g, 22); }
  rect(g, LEFT, y, RIGHT - LEFT, 8.5, { fill: HEAD, stroke: INK });
  text(g, '合　計', LEFT + 4, y + 4.4, { size: 3.2, weight: 700 });
  text(g, `立替 ${yen(sum.reimb)}${sum.company ? `　会社払い ${yen(sum.company)}` : ''}`, RIGHT - 1.5, y + 4.4, { size: 3.4, weight: 700, align: 'right' });
  y += 14;

  // ---- 科目別・現場別の集計
  const blockH = (n) => 8 + n * 6.4;
  const sites = sum.bySite.filter(([k]) => k !== '（なし）').length ? sum.bySite : [];
  const needH = Math.max(blockH(sum.byCat.length), sites.length ? blockH(sites.length) : 0) + 4;
  if (y + needH > bottom) { ({ c, g } = page()); pages.push(c); y = 20; }
  const drawSum = (title, rows, x, w) => {
    rect(g, x, y, w, 7, { fill: HEAD, stroke: INK });
    text(g, title, x + 2, y + 3.7, { size: 3, weight: 700 });
    let yy = y + 7;
    for (const [k, v] of rows) {
      text(g, k, x + 2, yy + 3.4, { size: 2.9, maxMm: w - 30 });
      text(g, yen(v), x + w - 2, yy + 3.4, { size: 3, weight: 600, align: 'right' });
      hline(g, x, x + w, yy + 6.4, '#d5dbe0');
      yy += 6.4;
    }
    rect(g, x, y, w, yy - y, { stroke: INK });
  };
  drawSum('勘定科目別', sum.byCat, LEFT, 86);
  if (sites.length) drawSum('現場・案件別', sites, LEFT + 94, 86);

  // ---- 領収書の台紙（1 ページに 6 枚）
  const withImg = list.map((e, i) => ({ e, no: i + 1 })).filter((x) => x.e.imageId);
  const per = 6;
  for (let p = 0; p < withImg.length; p += per) {
    ({ c, g } = page()); pages.push(c);
    const chunk = withImg.slice(p, p + per);
    text(g, `領収書・レシート（No.${chunk[0].no}〜${chunk[chunk.length - 1].no}）`, LEFT, 14, { size: 3.6, weight: 700 });
    const cw = (RIGHT - LEFT - 8) / 3; const ch = 128;
    for (let i = 0; i < chunk.length; i++) {
      const { e, no: n } = chunk[i];
      const x = LEFT + (i % 3) * (cw + 4); const top = 20 + Math.floor(i / 3) * (ch + 6);
      rect(g, x, top, cw, ch, { stroke: LINE });
      rect(g, x, top, cw, 9, { fill: HEAD, stroke: LINE });
      text(g, `No.${n}　${e.date ? e.date.slice(5).replace('-', '/') : ''}`, x + 2, top + 2.9, { size: 2.6, weight: 700 });
      text(g, yen(e.amount), x + cw - 2, top + 2.9, { size: 2.8, weight: 700, align: 'right' });
      text(g, e.payee || '', x + 2, top + 6.6, { size: 2.5, color: SUB, maxMm: cw - 4 });
      try {
        const blob = await getImage(e.imageId);
        if (blob) {
          const bmp = await blobToImage(blob);
          const bx = x + 1.5; const by = top + 10.5; const bw2 = cw - 3; const bh = ch - 12;
          const k = Math.min((bw2 * MM) / bmp.width, (bh * MM) / bmp.height);
          const dw = bmp.width * k; const dh = bmp.height * k;
          g.drawImage(bmp, bx * MM + (bw2 * MM - dw) / 2, by * MM + (bh * MM - dh) / 2, dw, dh);
          if (bmp.close) bmp.close();
        }
      } catch (_) {
        text(g, '（画像を読めませんでした）', x + cw / 2, top + ch / 2, { size: 2.8, color: SUB, align: 'center' });
      }
      onProgress && onProgress((p + i + 1) / withImg.length);
    }
  }

  pages.forEach((pc, i) => footer(pc.getContext('2d'), i + 1, pages.length, settings));
  return { pages, sum, count: list.length };
}

async function blobToImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  const img = new Image(); img.src = url; await img.decode(); URL.revokeObjectURL(url);
  return img;
}

// ---- PDF（ページごとに JPEG 画像 1 枚） ----------------------------------------

function utf16Hex(s) {
  let h = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) { const v = cp - 0x10000; h += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); } else h += cp.toString(16).padStart(4, '0');
  }
  return `<${h.toUpperCase()}>`;
}

export async function pagesToPdf(pages, title = '経費精算書') {
  const enc = new TextEncoder();
  const chunks = []; let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const offsets = [];
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 2 行目はバイナリを含むことを示す印
  const n = pages.length;
  const pageNo = (i) => 4 + i * 3;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageNo(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title ${utf16Hex(title)} /Producer (RakuKeihi) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`));
  const PW = 595.28; const PH = 841.89;
  for (let i = 0; i < n; i++) {
    const jpg = new Uint8Array(await (await canvasToBlob(pages[i], 'image/jpeg', 0.85)).arrayBuffer());
    const p = pageNo(i);
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(p + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(p + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${pages[i].width} /Height ${pages[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
  }
  const total = 4 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// ---- CSV（Excel で開ける BOM 付き） ----------------------------------------------

export function toCSV(items) {
  const head = ['No', '日付', '勘定科目', '支払先', '内容・目的', '現場・案件', '支払方法', '金額', '精算対象', '10%対象額', '8%対象額', '登録番号', '人数', '相手先', '出発', '到着', '往復', '距離km', '状態', '領収書画像'];
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = sortForReport(items).map((e, i) => [
    i + 1, e.date, e.category, e.payee, e.memo, e.site, e.method, e.amount ?? '', isCompanyPaid(e) ? '会社払い' : '立替',
    e.tax10 ?? '', e.tax8 ?? '', e.invoiceNo || '', e.people || '', e.guests || '',
    e.route ? e.route.from || '' : '', e.route ? e.route.to || '' : '', e.route && e.route.round ? '往復' : '', e.km || '',
    e.status === 'done' ? '精算済み' : e.status === 'draft' ? '確認待ち' : '未精算', e.imageId ? 'あり' : '',
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
