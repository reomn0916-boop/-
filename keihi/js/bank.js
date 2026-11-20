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
const money = (s) => { const t = String(s || '').normalize('NFKC').replace(/[,円¥\\\s+]/g, '').replace(/^[−‐-]/, '-').replace(/^\((.*)\)$/, '-$1'); if (!t || !/^-?\d+(\.\d+)?$/.test(t.replace(/^△/, '-'))) return null; return Math.round(+t.replace(/^△/, '-')); };

// 見出しの言葉（主な銀行・カード会社の CSV: 三菱UFJ・三井住友・みずほ・ゆうちょ・楽天・住信SBI・PayPay・りそな、楽天カード・JCB・アメックス・イオン・セゾン など）
const KEYS = {
  date: /^(日付|取引日|お取引日|利用日|ご利用日|年月日|お取扱日|お取り扱い日|日時|勘定日|ご利用年月日|取扱日|起算日|約定日)/,
  desc: /(摘要|内容|お取引内容|取引内容|お取り扱い内容|ご利用先|利用店名|ご利用店名|利用先|お支払先|明細|取引先|詳細|商品名)/,
  out: /(出金|お支払|支払金額|支払い金額|お引出|引出|ご利用金額|利用金額|支払額|払出|払戻)/,
  in: /(入金|お預入|預入|お預け入れ|受入|お預り|預り|お預かり|預かり)/,
  inout: /^(入出金|入出金額|入出金\(円\)|お取引金額)/, // ＋が入金・－が出金の 1 列（楽天銀行など）
  amount: /^(金額|取引金額|ご請求額|請求金額|利用額)/,
  balance: /(残高|現在.*高)/,
  notDesc: /(メモ|ラベル|利用者|支払方法|支払区分|カテゴリ|区分|サイン|国内|手数料|回数|残高|金額|日)/,
};

// 明細の行に直す: [{ date, desc, out, in, balance }]
export function parseStatement(text) {
  const rows = csvRows(text).map((r) => r.map((c) => c.replace(/^\ufeff/, '')));
  const norm = (c) => c.normalize('NFKC').replace(/\s/g, '');
  let hi = rows.findIndex((r) => r.some((c) => KEYS.date.test(norm(c)) || /^.+\(年\)$/.test(norm(c))) && r.some((c) => KEYS.desc.test(norm(c)) || KEYS.out.test(norm(c)) || KEYS.amount.test(norm(c)) || KEYS.inout.test(norm(c))));
  let col;
  if (hi >= 0) {
    const h = rows[hi].map(norm);
    const f = (re, not) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
    const inout = f(KEYS.inout, /内容/);
    col = {
      date: f(KEYS.date),
      // 年・月・日が別の列（PayPay銀行など）
      ymd: (() => { const y = h.findIndex((c) => /\(年\)$|^年$/.test(c)); const m = h.findIndex((c) => /\(月\)$|^月$/.test(c)); const d = h.findIndex((c) => /\(日\)$|^日$/.test(c)); return y >= 0 && m >= 0 && d >= 0 ? [y, m, d] : null; })(),
      desc: h.map((c, i) => (KEYS.desc.test(c) && !KEYS.notDesc.test(c.replace(/内容|明細|取引先/g, '')) ? i : -1)).filter((i) => i >= 0),
      out: inout >= 0 ? -1 : f(KEYS.out, /内容|残高|手数料|総額|回数/),
      in: inout >= 0 ? -1 : f(KEYS.in, /内容|残高/),
      inout,
      amount: f(KEYS.amount),
      balance: f(KEYS.balance),
    };
    if (!col.desc.length) { const d = f(KEYS.desc); if (d >= 0) col.desc = [d]; }
  } else {
    // 見出しがない（三井住友カードなど）: 日付らしい列・文字の列・数字の列から推測
    hi = -1;
    const s = rows.find((r) => r.some((c) => parseDate(c)) && r.some((c, i) => i > 0 && money(c) != null));
    if (!s) return [];
    const di = s.findIndex((c) => parseDate(c));
    const nums = s.map((c, i) => (i !== di && money(c) != null ? i : -1)).filter((i) => i >= 0);
    const ti = s.findIndex((c, i) => i !== di && c && money(c) == null);
    col = { date: di, ymd: null, desc: ti >= 0 ? [ti] : [], out: -1, in: -1, inout: -1, amount: nums[0] ?? -1, balance: -1 };
  }
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const date = col.ymd ? parseDate(`${r[col.ymd[0]]}/${r[col.ymd[1]]}/${r[col.ymd[2]]}`) : parseDate(r[col.date]);
    if (!date) continue;
    let o = col.out >= 0 ? money(r[col.out]) : null; let i = col.in >= 0 ? money(r[col.in]) : null;
    if (col.inout >= 0) { const a = money(r[col.inout]); if (a != null) { if (a < 0) o = -a; else i = a; } }
    if (o == null && i == null && col.amount >= 0) { const a = money(r[col.amount]); if (a != null) { if (a < 0) i = -a; else o = a; } }
    if (o != null && o < 0) { i = (i || 0) - o; o = 0; } // 出金の列のマイナスは返金
    if (!o && !i) continue;
    const desc = col.desc.map((k) => (r[k] || '').trim()).filter(Boolean).join(' ').normalize('NFKC');
    out.push({ date, desc, out: o || 0, in: i || 0, balance: col.balance >= 0 ? money(r[col.balance]) : null });
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
    // カードの返金・返品: 未払金を減らし、経費を戻す
    if (kind === 'card') {
      const cat = guessCategory(r.desc, '', learned, categories) || '雑費';
      return { ...base, action: 'refund', account: cat, note: '返金・返品' };
    }
    // 入金: 同じ金額の請求 → 振込手数料を引かれた金額（990円まで）の請求の順に探す
    const inv = unpaid.find((l) => !usedInc.has(l.id) && l.amount === r.in);
    if (inv) { usedInc.add(inv.id); return { ...base, action: 'paid', ref: inv.id, note: `請求の入金${inv.partner ? `（${inv.partner}）` : ''}` }; }
    const near2 = unpaid.filter((l) => !usedInc.has(l.id) && l.amount > r.in && l.amount - r.in <= 990).sort((a, b) => (a.amount - r.in) - (b.amount - r.in))[0];
    if (near2) { usedInc.add(near2.id); return { ...base, action: 'paid', ref: near2.id, fee: near2.amount - r.in, note: `請求の入金（振込手数料 ${(near2.amount - r.in).toLocaleString('ja-JP')}円 引き）${near2.partner ? ` ${near2.partner}` : ''}` }; }
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
    else if (r.action === 'paid') {
      out.push({ type: 'journal', ...common, amount: r.in, debit: acc, credit: '売掛金', ref: r.ref, memo: '入金' });
      if (r.fee) out.push({ type: 'journal', ...common, bankKey: `${r.key}|fee`, amount: r.fee, debit: '支払手数料', credit: '売掛金', memo: '振込手数料（先方が差し引き）' });
    } else if (r.action === 'refund') out.push({ type: 'journal', ...common, amount: r.in, debit: acc, credit: r.account });
  }
  return out;
}
