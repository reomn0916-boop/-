// 会計ソフトへの書き出し（弥生会計・マネーフォワード クラウド会計。freee は「弥生会計仕訳インポート」で弥生の形式を読み込む）と Shift_JIS
// 弥生: 「仕訳データの項目と記述形式」（弥生インポート形式・25 列）と「課税方式別税区分・税計算区分一覧」（税込経理の記述形式）に合わせる
// マネーフォワード: 「仕訳帳」インポートのサンプルフォーマット（A〜AA 列）と「税区分」の名称に合わせる
import { accountType } from './books.js';
import { noInvoiceRatio } from './finance.js';

let sjisMap = null;
function sjis() {
  if (sjisMap) return sjisMap;
  sjisMap = new Map();
  const dec = new TextDecoder('shift_jis');
  for (let b = 0xa1; b <= 0xdf; b++) sjisMap.set(dec.decode(new Uint8Array([b])), [b]);
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const l of leads) for (let t = 0x40; t <= 0xfc; t++) { if (t === 0x7f) continue; const ch = dec.decode(new Uint8Array([l, t])); if (ch.length === 1 && ch !== '�' && !sjisMap.has(ch)) sjisMap.set(ch, [l, t]); }
  return sjisMap;
}
const sjisChar = (ch) => sjis().get(ch === '〜' ? '～' : ch === '−' ? '－' : ch);
export function encodeSJIS(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const m = sjisChar(ch);
    if (m) out.push(...m); else out.push(0x3f);
  }
  return new Uint8Array(out);
}
// Shift_JIS で n バイトまでに切る（弥生の摘要は半角 64 桁 = 全角 32 文字）
export function cutBytes(str, n) {
  let len = 0; let out = '';
  for (const ch of String(str || '')) { const w = ch.codePointAt(0) < 0x80 || (sjisChar(ch) || []).length === 1 ? 1 : 2; if (len + w > n) break; len += w; out += ch; }
  return out;
}

const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const lines = (rows) => rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
const d8 = (iso) => iso.replace(/-/g, '/');

// 消費税がかからない経費（給料・税金）と、非課税の経費（保険料・利息）
const NOT_SUBJECT = new Set(['租税公課', '給料賃金', '減価償却費', '事業主貸', '事業主借']);
const EXEMPT_BUY = new Set(['保険料', '支払利息']);
const SIMPLE_KIND = { 90: '一', 80: '二', 70: '三', 60: '四', 50: '五', 40: '六' };
const asBooks = (b) => (typeof b === 'string' ? { mode: b } : b || { mode: 'sole' });

// 1 本の仕訳を、税率ごとの行に分ける（10% と 8% が混ざったレシート・請求書）
// 戻り値: [{ amount, rate }]（rate: 10 | 8 | 0）
export function splitByRate(j) {
  if (j.split && (j.split[8] || 0) > 0) {
    const out = [];
    if (j.split[10]) out.push({ amount: j.split[10], rate: 10 });
    out.push({ amount: j.split[8], rate: 8 });
    const rest = j.amount - (j.split[10] || 0) - j.split[8];
    if (rest > 0) out.push({ amount: rest, rate: 0 });
    return out;
  }
  if ((j.tax8 || 0) > 0 && j.tax8 < j.amount) return [{ amount: j.amount - j.tax8, rate: 10 }, { amount: j.tax8, rate: 8 }];
  if ((j.tax8 || 0) > 0) return [{ amount: j.amount, rate: 8 }];
  if (j.taxRate != null && +j.taxRate !== 10) return [{ amount: j.amount, rate: +j.taxRate }];
  return [{ amount: j.amount, rate: 10 }];
}

// その行が「売上」「仕入（経費）」「どちらでもない」のどれか
function role(j, side, mode) {
  const acc = side === 'debit' ? j.debit : j.credit;
  const t = accountType(acc, mode);
  if (j.src === 'dep') return 'none';
  if (side === 'credit' && t === 'revenue') return acc === '受取利息' ? 'exemptSale' : 'sale';
  if (side === 'debit' && t === 'revenue') return 'none'; // 売上の取消しは手で
  if (side === 'debit' && (t === 'expense' || (j.src === 'asset' && t === 'asset'))) return NOT_SUBJECT.has(acc) ? 'none' : EXEMPT_BUY.has(acc) ? 'exemptBuy' : 'buy';
  if (side === 'credit' && t === 'expense' && j.src === 'alloc') return NOT_SUBJECT.has(acc) ? 'none' : EXEMPT_BUY.has(acc) ? 'exemptBuy' : 'buy'; // 家事按分は仕入の税区分のまま貸方へ（控除を減らす）
  return 'none';
}
// インボイス: 'ok'（適格）か、経過措置の割合（80 / 70 / 50 / 30）か、'none'（控除不可）
function invoiceOf(j) {
  if (j.invoice !== false) return 'ok';
  const r = noInvoiceRatio(j.date);
  return r >= 1 ? 'ok' : r > 0 ? String(Math.round(r * 100)) : 'none';
}

export function yayoiTax(j, side, rate, books) {
  const b = asBooks(books);
  const r = role(j, side, b.mode);
  if (r === 'exemptSale') return '非課売上';
  if (r === 'exemptBuy') return '非課仕入';
  if (r === 'none' || rate === 0) return '対象外';
  const rt = rate === 8 ? '軽減8%' : '10%';
  if (r === 'sale') return `課税売上込${b.taxMethod === 'simple' ? SIMPLE_KIND[+b.simpleRate] || '' : ''}${rt}`;
  const inv = invoiceOf(j);
  return `課対仕入込${rt}${inv === 'ok' ? '適格' : inv === 'none' ? '区分控不' : `区分${inv}%`}`;
}
export function mfTax(j, side, rate, books) {
  const b = asBooks(books);
  const r = role(j, side, b.mode);
  if (r === 'exemptSale') return '非課税売上';
  if (r === 'none' || r === 'exemptBuy' || rate === 0) return '対象外';
  const rt = rate === 8 ? '(軽)8%' : '10%';
  if (r === 'sale') return `課税売上 ${rt}${b.taxMethod === 'simple' && SIMPLE_KIND[+b.simpleRate] ? ` ${SIMPLE_KIND[+b.simpleRate]}種` : ''}`;
  return `課税仕入 ${rt}`;
}
function mfInvoice(j, side, rate, books) {
  if (role(j, side, asBooks(books).mode) !== 'buy' || rate === 0) return '';
  const inv = invoiceOf(j);
  return inv === 'ok' ? '適格' : inv === 'none' ? '控除なし' : `${inv}％控除`;
}

// 弥生会計: 弥生インポート形式（25 列）。決算整理（減価償却・家事按分）は「本決」
export function toYayoi(journals, books) {
  const rows = [];
  for (const j of journals) {
    for (const p of splitByRate(j)) {
      const memo = cutBytes(j.memo || '', 64);
      const note = cutBytes([j.site ? `現場:${j.site}` : '', j.src === 'expense' ? 'ラク経費' : ''].filter(Boolean).join(' '), 180);
      rows.push(['2000', '', j.src === 'dep' || j.src === 'alloc' ? '本決' : '', d8(j.date),
        j.debit, '', '', yayoiTax(j, 'debit', p.rate, books), p.amount, '',
        j.credit, '', '', yayoiTax(j, 'credit', p.rate, books), p.amount, '',
        memo, '', '', '0', '', note, '0', '0', 'no']);
    }
  }
  return lines(rows);
}

// マネーフォワード クラウド会計: 仕訳帳インポート（サンプルフォーマットの A〜AA 列）。税率で分けた行は同じ取引No（複合仕訳）
export const MF_HEAD = ['取引No', '取引日', '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額', '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額', '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者'];
export function toMF(journals, books) {
  const rows = [MF_HEAD];
  journals.forEach((j, i) => {
    const kind = j.src === 'dep' ? '償却' : j.src === 'alloc' ? '家事按分' : '';
    for (const p of splitByRate(j)) {
      rows.push([i + 1, d8(j.date), j.debit, '', '', '', mfTax(j, 'debit', p.rate, books), mfInvoice(j, 'debit', p.rate, books), p.amount, '',
        j.credit, '', '', '', mfTax(j, 'credit', p.rate, books), mfInvoice(j, 'credit', p.rate, books), p.amount, '',
        String(j.memo || '').slice(0, 200), j.site ? `現場:${j.site}`.slice(0, 200) : '', '', kind, kind ? '1' : '', '', '', '', '']);
    }
  });
  return lines(rows);
}
