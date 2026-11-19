// 銀行・カードの明細（CSV）の読み込みと、経費・売上・振替への振り分けの提案（画面に依存しない）
import { guessCategory, payeeKey } from './parse.js';

// バイト列 → 文字（UTF-8 で読めなければ Shift_JIS。銀行の CSV はほとんど Shift_JIS）
export function decodeBytes(u8) {
  const utf = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  const bad = (utf.match(/�/g) || []).length;
  if (!bad) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('shift_jis').decode(u8); } catch (_) { return utf; }
}

export function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

export function parseDate(s) {
  const t = String(s || '').normalize('NFKC').trim();
  let m = t.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
  if (!m) { const n = t.match(/^(\d{4})(\d{2})(\d{2})$/); if (n) m = n; }
  let y; let mo; let d;
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; } else {
    const r = t.match(/^(?:R|令和)\s*(\d{1,2})[/.\-年](\d{1,2})[/.\-月](\d{1,2})/);
    if (!r) return '';
    [y, mo, d] = [2018 + +r[1], +r[2], +r[3]];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const money = (s) => { const t = String(s || '').normalize('NFKC').replace(/[,円¥\s]/g, ''); if (!t || !/^-?\d+(\.\d+)?$/.test(t.replace(/^△/, '-'))) return null; return Math.round(+t.replace(/^△/, '-')); };

const KEYS = {
  date: /^(日付|取引日|お取引日|利用日|ご利用日|年月日|お取扱日|日時|勘定日|ご利用年月日)/,
  desc: /(摘要|内容|お取引内容|取引内容|ご利用先|利用店名|ご利用店名|利用先|お支払先|明細|備考|取引先)/,
  out: /(出金|お支払|支払金額|お引出|引出|ご利用金額|利用金額|支払額|払出)/,
  in: /(入金|お預入|預入|お預け入れ|受入|お預り|預り|お預かり|預かり)/,
  amount: /^(金額|取引金額|ご請求額|請求金額)/,
  balance: /(残高)/,
};

// 明細の行に直す: [{ date, desc, out, in, balance }]
export function parseStatement(text) {
  const rows = csvRows(text);
  let hi = rows.findIndex((r) => r.some((c) => KEYS.date.test(c)) && r.some((c) => KEYS.desc.test(c) || KEYS.out.test(c) || KEYS.amount.test(c)));
  let col;
  if (hi >= 0) {
    const h = rows[hi];
    const f = (re, not) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
    col = { date: f(KEYS.date), desc: f(KEYS.desc), out: f(KEYS.out), in: f(KEYS.in), amount: f(KEYS.amount), balance: f(KEYS.balance) };
  } else {
    // 見出しがない: 日付らしい列・文字の列・数字の列から推測
    hi = -1;
    const s = rows.find((r) => r.some((c) => parseDate(c)));
    if (!s) return [];
    const di = s.findIndex((c) => parseDate(c));
    const nums = s.map((c, i) => (i !== di && money(c) != null ? i : -1)).filter((i) => i >= 0);
    const ti = s.findIndex((c, i) => i !== di && c && money(c) == null);
    col = { date: di, desc: ti, out: -1, in: -1, amount: nums[0] ?? -1, balance: nums.length > 1 ? nums[nums.length - 1] : -1 };
  }
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[col.date]); if (!date) continue;
    let o = col.out >= 0 ? money(r[col.out]) : null; let i = col.in >= 0 ? money(r[col.in]) : null;
    if (o == null && i == null && col.amount >= 0) { const a = money(r[col.amount]); if (a != null) { if (a < 0) i = -a; else o = a; } }
    if (!o && !i) continue;
    out.push({ date, desc: col.desc >= 0 ? (r[col.desc] || '').normalize('NFKC') : '', out: o || 0, in: i || 0, balance: col.balance >= 0 ? money(r[col.balance]) : null });
  }
  return out;
}

// 明細の摘要は NFKC で全角カナにそろえてから見る（ｶ-ﾄﾞ → カ-ド）
const RULES = [
  [/カ[ー-]ド|クレジット|JCB|VISA|MASTER|AMEX|セゾン|ラクテン/i, 'transfer', '未払金'],
  [/ATM|エ[ー-]テイエム|引出|ヒキダシ|コンビニ/i, 'transfer', '事業主貸'],
  [/手数料|テスウリヨウ/, 'expense', '支払手数料'],
  [/電気|デンキ|電力|デンリヨク|ガス|水道|スイドウ/, 'expense', '水道光熱費'],
  [/NTT|ドコモ|ソフトバンク|KDDI|プロバイダ/i, 'expense', '通信費'],
  [/家賃|ヤチン|地代|チダイ/, 'expense', '地代家賃'],
  [/保険|ホケン|共済|キヨウサイ/, 'expense', '保険料'],
  [/利息|リソク/, 'interest', ''],
  [/税|ゼイ|国民年金|健康保険/, 'expense', '租税公課'],
  [/借入|ロ[ー-]ン|返済|ヘンサイ/, 'transfer', '借入金'],
];

// 1 行ずつ、どう扱うかを提案する
// kind: 'bank'（口座）| 'card'（クレジットカード）
export function suggestRows(rows, { kind = 'bank', expenses = [], ledger = [], learned = {}, categories = [] }) {
  const usedExp = new Set(); const usedInc = new Set();
  const known = new Set(ledger.filter((l) => l.bankKey).map((l) => l.bankKey));
  const near = (a, b, days) => Math.abs(new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) <= days * 86400000;
  const unpaid = ledger.filter((l) => l.type === 'income' && l.debit === '売掛金' && !ledger.some((x) => x.ref === l.id));
  return rows.map((r) => {
    const key = `${kind}|${r.date}|${r.out}|${r.in}|${payeeKey(r.desc)}`;
    const base = { ...r, key, include: true };
    if (known.has(key)) return { ...base, action: 'skip', note: '取り込み済み', include: false };
    if (r.out) {
      // 同じ金額の経費（レシート）がすでにある → 二重にしない
      const m = expenses.find((e) => !usedExp.has(e.id) && e.status !== 'draft' && e.amount === r.out && e.date && near(e.date, r.date, kind === 'card' ? 45 : 4));
      if (m) { usedExp.add(m.id); return { ...base, action: 'skip', note: `レシート登録済み（${m.payee || m.category || ''} ${m.date.slice(5).replace('-', '/')}）`, include: false, match: m.id }; }
      const rule = RULES.find(([re]) => re.test(r.desc));
      if (rule && rule[1] === 'transfer' && kind === 'bank') return { ...base, action: 'transfer', account: rule[2], note: '振替' };
      if (rule && rule[1] === 'interest') return { ...base, action: 'expense', account: '支払利息' };
      const cat = (rule && rule[1] === 'expense' && rule[2]) || guessCategory(r.desc, '', learned, categories) || '雑費';
      return { ...base, action: 'expense', account: cat };
    }
    // 入金
    const inv = unpaid.find((l) => !usedInc.has(l.id) && l.amount === r.in);
    if (inv) { usedInc.add(inv.id); return { ...base, action: 'paid', ref: inv.id, note: `請求の入金${inv.partner ? `（${inv.partner}）` : ''}` }; }
    if (/利息|リソク/.test(r.desc)) return { ...base, action: 'income', account: '受取利息' };
    if (/返金|ﾍﾝｷﾝ|キャンセル/.test(r.desc)) return { ...base, action: 'income', account: '雑収入' };
    return { ...base, action: 'income', account: '売上高' };
  });
}

// 提案から帳簿の記録（ledger）を作る
export function ledgerFromRows(rows, { kind = 'bank', account = '普通預金' } = {}) {
  const acc = kind === 'card' ? '未払金' : account;
  const out = [];
  for (const r of rows) {
    if (!r.include || r.action === 'skip') continue;
    const common = { date: r.date, memo: r.desc, bankKey: r.key, src: 'bank' };
    if (r.action === 'expense') out.push({ type: 'journal', ...common, amount: r.out, debit: r.account, credit: acc });
    else if (r.action === 'transfer') out.push({ type: 'journal', ...common, amount: r.out, debit: r.account, credit: acc });
    else if (r.action === 'income') out.push({ type: 'income', ...common, amount: r.in, debit: acc, credit: r.account, partner: r.desc });
    else if (r.action === 'paid') out.push({ type: 'journal', ...common, amount: r.in, debit: acc, credit: '売掛金', ref: r.ref, memo: '入金' });
  }
  return out;
}
