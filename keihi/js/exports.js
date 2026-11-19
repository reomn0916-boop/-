// 会計ソフトへの書き出し（弥生会計・freee・マネーフォワード クラウド会計）と Shift_JIS
// 列の並びは各ソフトの取り込み形式に合わせているが、版によって変わることがあるので、取り込み画面で確かめること
import { accountType } from './books.js';

let sjisMap = null;
export function encodeSJIS(str) {
  if (!sjisMap) {
    sjisMap = new Map();
    const dec = new TextDecoder('shift_jis');
    for (let b = 0xa1; b <= 0xdf; b++) sjisMap.set(dec.decode(new Uint8Array([b])), [b]);
    const leads = [];
    for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
    for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
    for (const l of leads) for (let t = 0x40; t <= 0xfc; t++) { if (t === 0x7f) continue; const ch = dec.decode(new Uint8Array([l, t])); if (ch.length === 1 && ch !== '�' && !sjisMap.has(ch)) sjisMap.set(ch, [l, t]); }
  }
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const m = sjisMap.get(ch === '〜' ? '～' : ch);
    if (m) out.push(...m); else out.push(0x3f);
  }
  return new Uint8Array(out);
}

const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const lines = (rows) => rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
const d8 = (iso) => iso.replace(/-/g, '/');
const NONTAX = new Set(['租税公課', '給料賃金', '保険料', '支払利息', '減価償却費', '受取利息']);

function taxKind(acc, side, mode, j, soft) {
  const t = accountType(acc, mode);
  const rate8 = j.tax8 && !j.tax10;
  if (t === 'expense' && side === 'debit' && !NONTAX.has(acc) && j.src !== 'dep' && j.src !== 'alloc') {
    if (soft === 'yayoi') return rate8 ? '課対仕入込軽減8%' : '課対仕入込10%';
    if (soft === 'mf') return rate8 ? '課税仕入 (軽)8%' : '課税仕入 10%';
    return rate8 ? '課対仕入8%（軽）' : '課対仕入10%';
  }
  if (t === 'revenue' && side === 'credit' && acc !== '受取利息') {
    if (soft === 'yayoi') return '課税売上込10%';
    if (soft === 'mf') return '課税売上 10%';
    return '課税売上10%';
  }
  return '対象外';
}

// 弥生会計: 弥生インポート形式（仕訳日記帳・25 列）
export function toYayoi(journals, mode) {
  return lines(journals.map((j) => ['2000', '', '', d8(j.date), j.debit, '', j.site || '', taxKind(j.debit, 'debit', mode, j, 'yayoi'), j.amount, '', j.credit, '', '', taxKind(j.credit, 'credit', mode, j, 'yayoi'), j.amount, '', (j.memo || '').slice(0, 64), '', '', '0', '', '', '0', '0', 'no']));
}

// マネーフォワード クラウド会計: 仕訳帳インポート
export function toMF(journals, mode) {
  const head = ['取引No', '取引日', '借方勘定科目', '借方補助科目', '借方部門', '借方取引先', '借方税区分', '借方インボイス', '借方金額(円)', '借方税額', '貸方勘定科目', '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス', '貸方金額(円)', '貸方税額', '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ', '決算整理仕訳'];
  return lines([head, ...journals.map((j, i) => [i + 1, d8(j.date), j.debit, '', j.site || '', '', taxKind(j.debit, 'debit', mode, j, 'mf'), j.invoice === false ? '' : '適格', j.amount, '', j.credit, '', '', '', taxKind(j.credit, 'credit', mode, j, 'mf'), '', j.amount, '', j.memo || '', '', '', '', j.src === 'dep' || j.src === 'alloc' ? '1' : ''])]);
}

// freee: 取引のインポート（収入・支出の取引だけ。振替は freee の「振替伝票」で入れる）
export function toFreee(journals, mode) {
  const head = ['収支区分', '管理番号', '発生日', '決済期日', '取引先', '勘定科目', '税区分', '金額', '税計算区分', '税額', '備考', '品目', '部門', 'メモタグ（複数指定可、カンマ区切り）', '決済日', '決済口座', '決済金額'];
  const rows = [];
  let skipped = 0;
  for (const j of journals) {
    const dt = accountType(j.debit, mode); const ct = accountType(j.credit, mode);
    if (dt === 'expense' && ct !== 'expense') rows.push(['支出', '', d8(j.date), '', '', j.debit, taxKind(j.debit, 'debit', mode, j, 'freee'), j.amount, '内税', '', j.memo || '', '', j.site || '', '', d8(j.date), j.credit, j.amount]);
    else if (ct === 'revenue' && dt !== 'revenue') rows.push(['収入', '', d8(j.date), '', '', j.credit, taxKind(j.credit, 'credit', mode, j, 'freee'), j.amount, '内税', '', j.memo || '', '', j.site || '', '', d8(j.date), j.debit, j.amount]);
    else skipped++;
  }
  return { csv: lines([head, ...rows]), skipped };
}
