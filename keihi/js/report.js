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

function text(g, s, xMm, yMm, { size = 3.2, weight = 400, align = 'left', color = INK, maxMm = 0, shrink = false } = {}) {
  font(g, size, weight);
  // 長い科目名は切らずに、入るまで小さくする
  if (shrink && maxMm) { while (size > 2.1 && g.measureText(String(s ?? '')).width > maxMm * MM) { size -= 0.1; font(g, size, weight); } }
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

export function memoOf(e) {
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

// ---- 会計ソフト用（仕訳）CSV ------------------------------------------------------
// 借方 = 経費の科目、貸方 = 未払金など（設定で変更）。税率ごとの対象額が分かれていれば 2 行に分ける

export function toJournalCSV(items, { credit = '未払金' } = {}) {
  const head = ['日付', '借方勘定科目', '借方金額', '借方税区分', '貸方勘定科目', '貸方金額', '摘要', '取引先', '適格請求書', '登録番号', '現場・案件', '支払方法'];
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [];
  for (const e of sortForReport(items)) {
    if (!e.amount) continue;
    const desc = [e.payee, memoOf(e)].filter(Boolean).join(' ');
    const date = (e.date || '').replace(/-/g, '/');
    const inv = e.invoiceNo ? '有' : '無';
    let parts;
    if (e.category === '租税公課') parts = [[e.amount, '対象外']];
    else if (e.tax10 && e.tax8 && e.tax10 + e.tax8 === e.amount) parts = [[e.tax10, '課対仕入10%'], [e.tax8, '課対仕入8%(軽)']];
    else if (e.tax8 && !e.tax10) parts = [[e.amount, '課対仕入8%(軽)']];
    else parts = [[e.amount, '課対仕入10%']];
    for (const [amt, tax] of parts) rows.push([date, e.category, amt, tax, credit, amt, desc, e.payee, inv, e.invoiceNo || '', e.site || '', e.method || '']);
  }
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---- 決算書（損益計算書・貸借対照表・月別推移） ------------------------------------------
// st は books.js の buildStatements の結果

const amt = (n) => (n < 0 ? `△${Math.abs(Math.round(n)).toLocaleString('ja-JP')}` : Math.round(n || 0).toLocaleString('ja-JP'));
const KIND_SRC = { expense: '経費', income: '売上・収入', journal: '振替', settle: '精算' };

function stHead(g, title, sub, settings, books) {
  text(g, title, 105, 22, { size: 7.4, weight: 700, align: 'center' });
  hline(g, 72, 138, 27.2, INK, 2); hline(g, 72, 138, 28.2, INK, 1);
  text(g, sub, 105, 34.5, { size: 3.3, align: 'center', color: SUB });
  const who = books.tradeName || settings.company || settings.name || '';
  if (who) text(g, who, 25, 45, { size: 3.9, weight: 700, maxMm: 120 });
  text(g, '（単位：円）', 185, 45, { size: 2.8, align: 'right', color: SUB });
}

function stFooter(pages, settings, books) {
  const who = books.tradeName || settings.company || settings.name || '';
  pages.forEach((c, i) => text(c.getContext('2d'), `${who ? `${who}　` : ''}決算書（参考資料）　${i + 1} / ${pages.length}`, 105, 287, { size: 2.6, align: 'center', color: SUB }));
}

function plPage(st, settings, books) {
  const { c, g } = page();
  stHead(g, '損 益 計 算 書', `自 ${jpDate(st.from)}　至 ${jpDate(st.to)}`, settings, books);
  const L = 25; const R = 185; const inner = 150; const outer = 183;
  const rows = [];
  for (const s of st.pl.sections) {
    if (s.result) { if (!s.skipIfNoCogs) rows.push({ kind: 'result', label: s.result, value: s.value, final: s.final }); continue; }
    if (s.skipIfEmpty && !s.items.length) continue;
    rows.push({ kind: 'head', label: `【${s.title}】` });
    if (!s.items.length) rows.push({ kind: 'item', label: '（なし）', value: 0, muted: true });
    for (const [name, v] of s.items) rows.push({ kind: 'item', label: name, value: v });
    rows.push({ kind: 'total', label: s.totalLabel, value: s.total });
  }
  const top = 52; const bottom = 262;
  const rh = Math.min(7.4, (bottom - top) / Math.max(1, rows.length));
  let y = top;
  hline(g, L, R, y, INK, 2);
  for (const r of rows) {
    const cy = y + rh / 2 + 0.2;
    if (r.kind === 'head') {
      rect(g, L, y, R - L, rh, { fill: HEAD, stroke: null });
      text(g, r.label, L + 2, cy, { size: 3.1, weight: 700 });
    } else if (r.kind === 'item') {
      text(g, r.label, L + 8, cy, { size: 3.1, color: r.muted ? SUB : INK, maxMm: 100 });
      text(g, amt(r.value), inner, cy, { size: 3.2, align: 'right', color: r.muted ? SUB : INK });
    } else if (r.kind === 'total') {
      hline(g, inner - 34, inner, y + 0.4, LINE);
      text(g, r.label, L + 8, cy, { size: 3.1, weight: 600 });
      text(g, amt(r.value), outer, cy, { size: 3.3, align: 'right', weight: 700 });
    } else {
      rect(g, L, y, R - L, rh, { fill: r.final ? '#dff1e8' : '#f6f8f7', stroke: null });
      text(g, r.label, L + 2, cy, { size: r.final ? 3.6 : 3.3, weight: 700 });
      text(g, amt(r.value), outer, cy, { size: r.final ? 4 : 3.4, align: 'right', weight: 800 });
      if (r.final) { hline(g, outer - 40, outer, y + rh - 1.2, INK, 1); hline(g, outer - 40, outer, y + rh - 0.4, INK, 1); }
    }
    hline(g, L, R, y + rh, '#d5dbe0');
    y += rh;
  }
  hline(g, L, R, y, INK, 2);
  const note = st.mode === 'corp'
    ? '税込経理。法人税等・減価償却・棚卸は自動では計算していません（必要なら振替伝票で入れてください）。'
    : '税込経理。青色申告特別控除・減価償却・棚卸は自動では計算していません。確定申告では税理士・会計ソフトで確認してください。';
  text(g, note, L, y + 7, { size: 2.6, color: SUB, maxMm: R - L });
  return c;
}

function bsTable(g, x, y0, w, title, groups, totalLabel, total, alignY) {
  const nameX = x + 2; const openR = x + w - 26; const closeR = x + w - 2;
  rect(g, x, y0, w, 8, { fill: HEAD, stroke: INK });
  text(g, title, nameX, y0 + 4.2, { size: 3.2, weight: 700 });
  text(g, '期首', openR, y0 + 4.2, { size: 2.7, weight: 700, align: 'right', color: SUB });
  text(g, '期末', closeR, y0 + 4.2, { size: 2.7, weight: 700, align: 'right', color: SUB });
  let y = y0 + 8; const rh = 6.8;
  for (const gr of groups) {
    if (gr.label) { text(g, gr.label, nameX, y + rh / 2 + 0.2, { size: 2.8, weight: 700, color: SUB }); y += rh * 0.85; }
    for (const r of gr.rows) {
      text(g, r.name, nameX + 3, y + rh / 2 + 0.2, { size: 3, maxMm: w - 56, shrink: true });
      text(g, amt(r.open), openR, y + rh / 2 + 0.2, { size: 3, align: 'right', color: SUB });
      text(g, amt(r.close), closeR, y + rh / 2 + 0.2, { size: 3.1, align: 'right', weight: 600 });
      hline(g, x, x + w, y + rh, '#e1e6e9');
      y += rh;
    }
    if (gr.total) {
      text(g, gr.total.label, nameX + 3, y + rh / 2 + 0.2, { size: 2.9, weight: 700 });
      text(g, amt(gr.total.open), openR, y + rh / 2 + 0.2, { size: 3, align: 'right', weight: 700, color: SUB });
      text(g, amt(gr.total.close), closeR, y + rh / 2 + 0.2, { size: 3.1, align: 'right', weight: 700 });
      hline(g, x, x + w, y, LINE); hline(g, x, x + w, y + rh, '#e1e6e9');
      y += rh;
    }
    y += 1.5;
  }
  const ty = Math.max(y, alignY || 0);
  rect(g, x, ty, w, 8.5, { fill: '#dff1e8', stroke: INK });
  text(g, totalLabel, nameX, ty + 4.4, { size: 3.2, weight: 800 });
  text(g, amt(total.open), openR, ty + 4.4, { size: 3.1, align: 'right', weight: 700, color: SUB });
  text(g, amt(total.close), closeR, ty + 4.4, { size: 3.4, align: 'right', weight: 800 });
  g.strokeStyle = INK; g.lineWidth = 1; g.strokeRect(x * MM + 0.5, y0 * MM + 0.5, w * MM, (ty + 8.5 - y0) * MM);
  return y;
}

function bsPage(st, settings, books) {
  const { c, g } = page();
  stHead(g, '貸 借 対 照 表', `${jpDate(st.to)} 現在（期首 ${jpDate(st.from)}）`, settings, books);
  const { bs } = st;
  const cur = bs.assets.filter((r) => r.group === 'cur'); const fix = bs.assets.filter((r) => r.group === 'fix'); const own = bs.assets.filter((r) => r.group === 'own');
  const sumG = (l) => ({ open: l.reduce((s, r) => s + r.open, 0), close: l.reduce((s, r) => s + r.close, 0) });
  const left = [{ label: '流動資産', rows: cur, total: { label: '流動資産合計', ...sumG(cur) } }];
  if (fix.length) left.push({ label: '固定資産', rows: fix, total: { label: '固定資産合計', ...sumG(fix) } });
  if (own.length) left.push({ label: '', rows: own });
  const sole = st.mode !== 'corp';
  const right = [
    { label: '負債', rows: bs.liabs.length ? bs.liabs : [{ name: '（なし）', open: 0, close: 0 }], total: { label: '負債合計', ...bs.totalLiabs } },
    { label: sole ? '資本' : '純資産', rows: bs.equity, total: { label: sole ? '資本合計' : '純資産合計', ...bs.totalEquity } },
  ];
  // 両方の合計の行をそろえる
  const height = (groups) => groups.reduce((h, gr) => h + (gr.label ? 6.8 * 0.85 : 0) + gr.rows.length * 6.8 + (gr.total ? 6.8 : 0) + 1.5, 8);
  const y0 = 52; const alignY = y0 + Math.max(height(left), height(right));
  const totalLiabEq = { open: bs.totalLiabs.open + bs.totalEquity.open, close: bs.totalLiabs.close + bs.totalEquity.close };
  bsTable(g, 15, y0, 88, '資産の部', left, '資産合計', bs.totalAssets, alignY);
  bsTable(g, 107, y0, 88, sole ? '負債・資本の部' : '負債・純資産の部', right, sole ? '負債・資本合計' : '負債・純資産合計', totalLiabEq, alignY);
  const ok = bs.balanced;
  text(g, ok ? `✓ 資産合計と${sole ? '負債・資本合計' : '負債・純資産合計'}が一致しています` : '× 貸借が一致しません', 15, alignY + 16, { size: 2.9, weight: 700, color: ok ? '#0d7a55' : '#c0372d' });
  text(g, sole ? '元入金（期首）＝ 期首の資産 − 期首の負債。事業主貸・事業主借は翌期の期首に元入金へ入れます。' : '繰越利益剰余金（期首）＝ 期首の資産 − 期首の負債 − 資本金。法人税等は含みません。', 15, alignY + 23, { size: 2.6, color: SUB, maxMm: 180 });
  return c;
}

function monthlyPage(st, settings, books) {
  const { c, g } = page();
  stHead(g, '月 別 推 移', `自 ${jpDate(st.from)}　至 ${jpDate(st.to)}`, settings, books);
  const L = 25; const R = 185;
  const cols = [['月', L + 2, 'left'], [st.mode === 'corp' ? '売上・収益' : '売上（収入）', 92, 'right'], ['経費・費用', 124, 'right'], ['利益', 154, 'right'], ['累計', 183, 'right']];
  let y = 52; const rh = 7.4;
  rect(g, L, y, R - L, 8, { fill: HEAD, stroke: INK });
  cols.forEach(([l, x, a]) => text(g, l, x, y + 4.2, { size: 2.9, weight: 700, align: a }));
  y += 8;
  for (const m of st.monthly) {
    const cy = y + rh / 2 + 0.2;
    text(g, `${+m.ym.slice(0, 4)}年${+m.ym.slice(5)}月`, L + 2, cy, { size: 3 });
    text(g, amt(m.rev), 92, cy, { size: 3.1, align: 'right' });
    text(g, amt(m.exp), 124, cy, { size: 3.1, align: 'right' });
    text(g, amt(m.profit), 154, cy, { size: 3.1, align: 'right', weight: 700, color: m.profit < 0 ? '#c0372d' : INK });
    text(g, amt(m.cum), 183, cy, { size: 3.1, align: 'right', color: SUB });
    hline(g, L, R, y + rh, '#e1e6e9');
    y += rh;
  }
  const tot = st.monthly.reduce((a, m) => ({ rev: a.rev + m.rev, exp: a.exp + m.exp }), { rev: 0, exp: 0 });
  rect(g, L, y, R - L, 8.5, { fill: '#dff1e8', stroke: INK });
  text(g, '合計', L + 2, y + 4.4, { size: 3.2, weight: 800 });
  text(g, amt(tot.rev), 92, y + 4.4, { size: 3.2, align: 'right', weight: 700 });
  text(g, amt(tot.exp), 124, y + 4.4, { size: 3.2, align: 'right', weight: 700 });
  text(g, amt(tot.rev - tot.exp), 154, y + 4.4, { size: 3.3, align: 'right', weight: 800 });
  g.strokeStyle = INK; g.lineWidth = 1; g.strokeRect(L * MM + 0.5, 52 * MM + 0.5, (R - L) * MM, (y + 8.5 - 52) * MM);
  // 経費の科目別（期間の合計）
  y += 18;
  const exps = st.pl.sections.filter((s) => s.items && s.title && /経費|販売費|売上原価|営業外費用/.test(s.title)).flatMap((s) => s.items);
  const totalExp = exps.reduce((s, [, v]) => s + v, 0) || 1;
  text(g, '経費の内訳（勘定科目別）', L, y, { size: 3.4, weight: 700 });
  y += 5;
  const maxV = Math.max(1, ...exps.map(([, v]) => v));
  for (const [name, v] of exps.slice(0, Math.floor((272 - y) / 6.4))) {
    text(g, name, L + 2, y + 3.2, { size: 2.9, maxMm: 36 });
    g.fillStyle = '#e9eeeb'; g.fillRect((L + 42) * MM, (y + 1.8) * MM, 90 * MM, 2.8 * MM);
    g.fillStyle = '#0d7a55'; g.fillRect((L + 42) * MM, (y + 1.8) * MM, Math.max(0.6, (v / maxV) * 90) * MM, 2.8 * MM);
    text(g, amt(v), 175, y + 3.2, { size: 2.9, align: 'right', weight: 600 });
    text(g, `${Math.round((v / totalExp) * 100)}%`, R, y + 3.2, { size: 2.6, align: 'right', color: SUB });
    y += 6.4;
  }
  return c;
}

export function renderStatements(st, settings, books) {
  const pages = [plPage(st, settings, books), bsPage(st, settings, books), monthlyPage(st, settings, books)];
  stFooter(pages, settings, books);
  return pages;
}

const csvq = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvq).join(',')).join('\r\n') + '\r\n';
const TYPE_JA = { asset: '資産', liability: '負債', equity: '純資産', revenue: '収益', expense: '費用' };

// 試算表
export function toTrialCSV(st) {
  return csv([['区分', '勘定科目', '期首残高', '借方合計', '貸方合計', '期末残高・金額'],
    ...st.trial.map((r) => [TYPE_JA[r.type], r.name, r.type === 'revenue' || r.type === 'expense' ? '' : r.open, r.debit, r.credit, r.close])]);
}

// 仕訳帳（経費・売上・振替・精算から作った仕訳）
export function toJournalBookCSV(st) {
  return csv([['日付', '借方勘定科目', '借方金額', '貸方勘定科目', '貸方金額', '摘要', '元の記録'],
    ...st.journals.map((j) => [j.date.replace(/-/g, '/'), j.debit, j.amount, j.credit, j.amount, j.memo, KIND_SRC[j.src] || ''])]);
}
