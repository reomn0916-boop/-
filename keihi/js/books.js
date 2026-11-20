// 帳簿: 勘定科目・仕訳の自動作成・損益計算書・貸借対照表（画面に依存しない。Node でもテストできる）
//
// 考え方
// - 経費（確定したもの）・売上や収入・振替伝票・精算（法人のみ）から、複式簿記の仕訳を自動で作る
// - 期首残高（資産・負債）を 1 回入れておけば、あとの期は記録から繰り越して計算する
// - 純資産の期首（個人: 元入金 / 法人: 繰越利益剰余金）は「資産 − 負債（− 資本金）」で決まるので、必ず貸借が一致する
// - 税込経理。減価償却・棚卸・法人税等は自動では計算しない（振替伝票で入れる）

export const ASSET_ACCOUNTS = [
  ['現金', 'cur'], ['普通預金', 'cur'], ['売掛金', 'cur'], ['立替金', 'cur'], ['仮払金', 'cur'], ['前払金', 'cur'],
  ['車両運搬具', 'fix'], ['工具器具備品', 'fix'],
];
export const LIABILITY_ACCOUNTS = ['買掛金', '未払金', '預り金', '前受金', '借入金'];
export const REVENUE_ACCOUNTS = ['売上高', '雑収入', '受取利息'];
export const EXTRA_EXPENSES = ['仕入高', '外注費', '地代家賃', '水道光熱費', '保険料', '修繕費', '減価償却費', '給料賃金', '支払利息'];
const COGS = new Set(['仕入高']);
const NONOP_REV = new Set(['雑収入', '受取利息']);
const NONOP_EXP = new Set(['支払利息']);
const ASSET_SET = new Set(ASSET_ACCOUNTS.map(([a]) => a));
const LIAB_SET = new Set(LIABILITY_ACCOUNTS);
const REV_SET = new Set(REVENUE_ACCOUNTS);
const EQUITY_SET = new Set(['元入金', '事業主借', '資本金', '繰越利益剰余金']);

import { depreciationSchedule } from './assets.js';

export const MODES = { sole: '個人事業主（青色申告）', corp: '法人' };

// 支払方法 → 貸方の科目（初期値）。個人のお金で払った経費は、個人事業主なら「事業主借」、法人なら立て替えた人への「未払金」
const PAY_MAP = {
  sole: { 現金: '事業主借', 個人カード: '事業主借', 電子マネー: '事業主借', 会社カード: '未払金', 請求書払い: '未払金' },
  corp: { 現金: '未払金', 個人カード: '未払金', 電子マネー: '未払金', 会社カード: '未払金', 請求書払い: '未払金' },
};

export const DEFAULT_BOOKS = {
  mode: 'sole', closeMonth: 12, openDate: '', opening: {}, capital: 0, payMap: {}, reimbAccount: '普通預金', tradeName: '',
  fixedAssets: [], allocation: {}, taxMethod: 'general', simpleRate: 70, taxable: true,
};

export function booksOf(settings) {
  const b = { ...DEFAULT_BOOKS, ...((settings && settings.books) || {}) };
  b.opening = { ...(b.opening || {}) };
  b.payMap = { ...PAY_MAP[b.mode === 'corp' ? 'corp' : 'sole'], ...(b.payMap || {}) };
  return b;
}

export function accountType(name, mode = 'sole') {
  if (ASSET_SET.has(name) || name === '事業主貸') return 'asset';
  if (LIAB_SET.has(name)) return 'liability';
  if (EQUITY_SET.has(name)) return 'equity';
  if (REV_SET.has(name)) return 'revenue';
  return 'expense';
}

// 振替伝票などで選べる科目（グループごと）
export function accountGroups(mode, categories = []) {
  const exp = [...new Set([...categories, ...EXTRA_EXPENSES])];
  return [
    ['資産', [...ASSET_ACCOUNTS.map(([a]) => a), ...(mode === 'sole' ? ['事業主貸'] : [])]],
    ['負債', LIABILITY_ACCOUNTS.slice()],
    ['純資産', mode === 'sole' ? ['元入金', '事業主借'] : ['資本金', '繰越利益剰余金']],
    ['収益', REVENUE_ACCOUNTS.slice()],
    ['費用', exp],
  ];
}

// 決算月から、その日を含む会計期間（期首〜期末）
export function fiscalRange(dateISO, closeMonth = 12) {
  const [y, m] = dateISO.split('-').map(Number);
  const startMonth = (closeMonth % 12) + 1; // 決算 12 月 → 1 月始まり
  const sy = m >= startMonth ? y : y - 1;
  const from = `${sy}-${String(startMonth).padStart(2, '0')}-01`;
  const end = new Date(sy, startMonth - 1 + 12, 0);
  const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  return { from, to };
}

function isoOf(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// ---- 仕訳を作る ---------------------------------------------------------------
// 1 行 = { date, debit, credit, amount, memo, src: 'expense' | 'income' | 'journal' | 'settle', ref }
export function journalsFrom({ expenses = [], ledger = [], reports = [], settings = {}, asOf = '', closed = null }) {
  const b = booksOf(settings);
  const out = [];
  const today = asOf || isoOf(Date.now());
  for (const e of expenses) {
    if (e.status === 'draft' || !e.amount || !e.date) continue;
    const route = e.route && (e.route.from || e.route.to) ? `${e.route.from || ''}→${e.route.to || ''}` : '';
    out.push({
      date: e.date, debit: e.category || '雑費', credit: b.payMap[e.method] || '未払金', amount: Math.round(e.amount),
      memo: [e.payee, route, e.memo].filter(Boolean).join(' '), src: 'expense', ref: e.id, site: e.site || '', invoice: !!e.invoiceNo || e.kind === 'transit' || e.kind === 'car' || e.noInvoiceOk === true, tax10: e.tax10, tax8: e.tax8,
    });
  }
  for (const l of ledger) {
    if (l.type === 'payout') {
      // 外注費の支払い: 借方 外注費（総額）／ 貸方 支払元（差引額）・預り金（源泉）
      if (!l.gross || !l.date) continue;
      const memo = [l.partner, l.memo].filter(Boolean).join(' ');
      const wh = Math.round(l.wh || 0);
      if (l.gross - wh > 0) out.push({ date: l.date, debit: l.debit || '外注費', credit: l.payFrom || '普通預金', amount: Math.round(l.gross - wh), memo, src: 'payout', ref: l.id, site: l.site || '', invoice: !!l.invoiceNo });
      if (wh > 0) out.push({ date: l.date, debit: l.debit || '外注費', credit: '預り金', amount: wh, memo: `${memo} 源泉所得税`.trim(), src: 'payout', ref: l.id, site: l.site || '', invoice: !!l.invoiceNo });
      continue;
    }
    if (!l.amount || !l.date || !l.debit || !l.credit) continue;
    out.push({ date: l.date, debit: l.debit, credit: l.credit, amount: Math.round(l.amount), memo: [l.partner, l.memo].filter(Boolean).join(' '), src: l.type === 'income' ? 'income' : l.src === 'bank' ? 'bank' : 'journal', ref: l.id, site: l.site || '', taxRate: l.taxRate, invoice: l.noInvoice ? false : true, split: l.invoice && l.invoice.totals ? { 10: l.invoice.totals.base10 + l.invoice.totals.tax10, 8: l.invoice.totals.base8 + l.invoice.totals.tax8 } : null });
  }
  // 固定資産: 買ったときの仕訳と、期末ごとの減価償却（事業で使う割合を超える分は事業主貸）
  for (const a of b.fixedAssets || []) {
    if (!a.cost || !a.acquired) continue;
    const acc = a.account || '工具器具備品';
    const ratio = b.mode === 'sole' ? Math.min(100, Math.max(0, a.ratio == null ? 100 : +a.ratio)) : 100;
    if (a.paidFrom) out.push({ date: a.acquired, debit: acc, credit: a.paidFrom, amount: Math.round(a.cost), memo: `${a.name || '固定資産'} 取得`, src: 'asset', ref: a.id, invoice: a.invoice !== false, ratio });
    for (const r of depreciationSchedule(a, { closeMonth: b.closeMonth, upto: today })) {
      if (!r.amount) continue;
      const biz = Math.round((r.amount * ratio) / 100);
      if (biz) out.push({ date: r.fyEnd, debit: '減価償却費', credit: acc, amount: biz, memo: `${a.name || '固定資産'} 減価償却`, src: 'dep', ref: a.id });
      if (r.amount - biz) out.push({ date: r.fyEnd, debit: '事業主貸', credit: acc, amount: r.amount - biz, memo: `${a.name || '固定資産'} 減価償却（家事分）`, src: 'dep', ref: a.id });
    }
  }
  if (b.mode === 'corp') {
    // 精算（立て替えた人に払った）: 未払金を減らす。仮払金があれば相殺
    for (const r of reports) {
      if (!r.reimb) continue;
      const date = isoOf(r.created);
      const adv = Math.min(r.advance || 0, r.reimb);
      if (adv) out.push({ date, debit: '未払金', credit: '仮払金', amount: adv, memo: '経費精算（仮払金と相殺）', src: 'settle', ref: r.id });
      if (r.reimb - adv > 0) out.push({ date, debit: '未払金', credit: b.reimbAccount || '普通預金', amount: r.reimb - adv, memo: '経費精算の支払い', src: 'settle', ref: r.id });
    }
  }
  // 家事按分（個人事業主）: 期末に、事業で使っていない割合を事業主貸へ
  if (b.mode === 'sole') {
    const alloc = Object.entries(b.allocation || {}).filter(([, v]) => v != null && +v < 100);
    if (alloc.length) {
      const sums = new Map();
      for (const j of out) {
        const r = alloc.find(([cat]) => cat === j.debit);
        if (!r || j.src === 'dep' || j.src === 'alloc') continue;
        const end = fiscalRange(j.date, b.closeMonth).to;
        const k = `${end}|${j.debit}`;
        sums.set(k, (sums.get(k) || 0) + j.amount);
      }
      for (const [k, v] of sums) {
        const [end, cat] = k.split('|');
        const ratio = +alloc.find(([c]) => c === cat)[1];
        const priv = Math.round((v * (100 - ratio)) / 100);
        if (priv > 0) out.push({ date: end, debit: '事業主貸', credit: cat, amount: priv, memo: `家事按分（事業 ${ratio}%）`, src: 'alloc', ref: cat });
      }
    }
  }
  out.sort((a, c) => a.date.localeCompare(c.date));
  // 締めた期間は、締めたときに固定した仕訳を使う（あとで記録や設定を変えても、決算書の数字は変わらない）
  if (closed && closed.until) return [...closed.journals.map((j) => ({ ...j, closed: true })), ...out.filter((j) => j.date > closed.until)];
  return out;
}

// ---- 決算書を作る ---------------------------------------------------------------
export function buildStatements({ journals, settings = {}, from, to }) {
  const b = booksOf(settings);
  const mode = b.mode === 'corp' ? 'corp' : 'sole';
  const type = (a) => accountType(a, mode);
  const owner = (a) => a === '事業主貸' || a === '事業主借';
  const notes = [];

  // 期首の残高（資産・負債）: 期首残高を入れた日から、この期の前日までの記録で繰り越す
  const base = b.openDate || '';
  const useBase = !!base && from >= base;
  if (base && from < base) notes.push({ level: 'warn', msg: `期首残高の日付（${base}）より前の期間です。期首の残高は 0 として計算しています` });
  if (!base) notes.push({ level: 'info', msg: '期首残高が未設定のため、記録の最初から積み上げています（帳簿の設定で入れると正確になります）' });
  const open = new Map();
  if (useBase) for (const [a, v] of Object.entries(b.opening)) { const n = Math.round(+v || 0); if (n && (type(a) === 'asset' || type(a) === 'liability') && !owner(a)) open.set(a, n); }
  const add = (m, a, v) => m.set(a, (m.get(a) || 0) + v);
  const eqAdjBefore = new Map();
  for (const j of journals) {
    if (j.date >= from) continue;
    if (useBase && j.date < base) continue;
    for (const [acc, sign] of [[j.debit, 1], [j.credit, -1]]) {
      const t = type(acc);
      if (owner(acc)) continue; // 事業主貸・借は期首に元入金へ入れる
      if (t === 'asset') add(open, acc, sign * j.amount);
      else if (t === 'liability') add(open, acc, -sign * j.amount);
      else if (t === 'equity') add(eqAdjBefore, acc, -sign * j.amount);
    }
  }
  const sum = (m, f) => [...m.entries()].filter(([a]) => f(a)).reduce((s, [, v]) => s + v, 0);
  const openAssets = sum(open, (a) => type(a) === 'asset');
  const openLiabs = sum(open, (a) => type(a) === 'liability');
  const capital = Math.round(+b.capital || 0) + (eqAdjBefore.get('資本金') || 0);
  const openEquity = openAssets - openLiabs;

  // この期の動き
  const close = new Map(open);
  const flow = new Map(); // 収益・費用（収益は貸方がプラス、費用は借方がプラス）
  const eqAdj = new Map(); // この期に純資産の科目を直接動かしたもの（増資など）
  let draw = 0; let loan = 0; // 事業主貸・事業主借
  const deb = new Map(); const cre = new Map();
  const months = new Map();
  const inPeriod = journals.filter((j) => j.date >= from && j.date <= to);
  for (const j of inPeriod) {
    add(deb, j.debit, j.amount); add(cre, j.credit, j.amount);
    const ym = j.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, { rev: 0, exp: 0 });
    for (const [acc, sign] of [[j.debit, 1], [j.credit, -1]]) {
      const t = type(acc);
      if (acc === '事業主貸') draw += sign * j.amount;
      else if (acc === '事業主借') loan -= sign * j.amount;
      else if (t === 'asset') add(close, acc, sign * j.amount);
      else if (t === 'liability') add(close, acc, -sign * j.amount);
      else if (t === 'equity') add(eqAdj, acc, -sign * j.amount);
      else if (t === 'revenue') { add(flow, acc, -sign * j.amount); months.get(ym).rev += -sign * j.amount; } else { add(flow, acc, sign * j.amount); months.get(ym).exp += sign * j.amount; }
    }
  }

  // 損益計算書
  const revs = [...flow.entries()].filter(([a]) => type(a) === 'revenue' && flow.get(a));
  const exps = [...flow.entries()].filter(([a]) => type(a) === 'expense' && flow.get(a));
  const order = (list, ref) => list.sort((x, y) => { const ix = ref.indexOf(x[0]); const iy = ref.indexOf(y[0]); return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || y[1] - x[1]; });
  const catRef = [...((settings && settings.categories) || []), ...EXTRA_EXPENSES];
  const total = (l) => l.reduce((s, [, v]) => s + v, 0);
  const revenue = total(revs); const expense = total(exps);
  const netIncome = revenue - expense;
  const cogsL = order(exps.filter(([a]) => COGS.has(a)), EXTRA_EXPENSES);
  let pl;
  if (mode === 'corp') {
    const salesL = order(revs.filter(([a]) => !NONOP_REV.has(a)), REVENUE_ACCOUNTS);
    const nonRevL = order(revs.filter(([a]) => NONOP_REV.has(a)), REVENUE_ACCOUNTS);
    const nonExpL = order(exps.filter(([a]) => NONOP_EXP.has(a)), EXTRA_EXPENSES);
    const sgaL = order(exps.filter(([a]) => !COGS.has(a) && !NONOP_EXP.has(a)), catRef);
    const sales = total(salesL); const cogs = total(cogsL); const gross = sales - cogs; const sga = total(sgaL); const op = gross - sga;
    const ord = op + total(nonRevL) - total(nonExpL);
    pl = {
      mode,
      sections: [
        { title: '売上高', items: salesL, total: sales, totalLabel: '売上高合計' },
        { title: '売上原価', items: cogsL, total: cogs, totalLabel: '売上原価合計', skipIfEmpty: true },
        { result: '売上総利益', value: gross },
        { title: '販売費及び一般管理費', items: sgaL, total: sga, totalLabel: '販売費及び一般管理費合計' },
        { result: '営業利益', value: op },
        { title: '営業外収益', items: nonRevL, total: total(nonRevL), totalLabel: '営業外収益合計', skipIfEmpty: true },
        { title: '営業外費用', items: nonExpL, total: total(nonExpL), totalLabel: '営業外費用合計', skipIfEmpty: true },
        { result: '経常利益', value: ord },
        { result: '税引前当期純利益', value: ord },
        { result: '当期純利益', value: ord, final: true },
      ],
      revenue, expense, netIncome,
    };
  } else {
    const revL = order(revs, REVENUE_ACCOUNTS);
    const expL = order(exps.filter(([a]) => !COGS.has(a)), catRef);
    const cogs = total(cogsL);
    pl = {
      mode,
      sections: [
        { title: '売上（収入）金額', items: revL, total: revenue, totalLabel: '売上（収入）金額 計' },
        { title: '売上原価', items: cogsL, total: cogs, totalLabel: '売上原価 計', skipIfEmpty: true },
        { result: '差引金額（売上総利益）', value: revenue - cogs, skipIfNoCogs: !cogs },
        { title: '経費', items: expL, total: total(expL), totalLabel: '経費 計' },
        { result: '差引金額（青色申告特別控除前の所得金額）', value: netIncome, final: true },
      ],
      revenue, expense, netIncome,
    };
  }

  // 貸借対照表（期首・期末）
  const show = (a, o, c) => o || c || ['現金', '普通預金'].includes(a);
  const assets = ASSET_ACCOUNTS.map(([a, g]) => ({ name: a, group: g, open: open.get(a) || 0, close: close.get(a) || 0 }))
    .concat([...close.keys()].filter((a) => type(a) === 'asset' && !ASSET_SET.has(a) && !owner(a)).map((a) => ({ name: a, group: 'cur', open: open.get(a) || 0, close: close.get(a) || 0 })))
    .filter((r) => show(r.name, r.open, r.close));
  const liabs = LIABILITY_ACCOUNTS.map((a) => ({ name: a, open: open.get(a) || 0, close: close.get(a) || 0 })).filter((r) => r.open || r.close);
  let equity;
  if (mode === 'corp') {
    const reOpen = openEquity - capital;
    const other = [...eqAdj.entries()].filter(([a]) => a !== '資本金').reduce((s, [, v]) => s + v, 0);
    equity = [
      { name: '資本金', open: capital, close: capital + (eqAdj.get('資本金') || 0) },
      { name: '繰越利益剰余金', open: reOpen, close: reOpen + netIncome + other },
    ];
    if (eqAdj.get('元入金') || eqAdj.get('事業主借') || draw || loan) notes.push({ level: 'warn', msg: '法人の帳簿で「事業主貸・事業主借・元入金」が使われています。科目を見直してください' });
    if (draw) assets.push({ name: '事業主貸', group: 'own', open: 0, close: draw });
    if (loan) equity.push({ name: '事業主借', open: 0, close: loan });
  } else {
    equity = [
      { name: '元入金', open: openEquity, close: openEquity + [...eqAdj.values()].reduce((s, v) => s + v, 0) },
      { name: '事業主借', open: 0, close: loan },
      { name: '青色申告特別控除前の所得金額', open: 0, close: netIncome },
    ];
    assets.push({ name: '事業主貸', group: 'own', open: 0, close: draw });
  }
  const sumOf = (l, k) => l.reduce((s, r) => s + r[k], 0);
  const bs = {
    mode, assets, liabs, equity,
    totalAssets: { open: sumOf(assets, 'open'), close: sumOf(assets, 'close') },
    totalLiabs: { open: sumOf(liabs, 'open'), close: sumOf(liabs, 'close') },
    totalEquity: { open: sumOf(equity, 'open'), close: sumOf(equity, 'close') },
  };
  bs.balanced = bs.totalAssets.close === bs.totalLiabs.close + bs.totalEquity.close && bs.totalAssets.open === bs.totalLiabs.open + bs.totalEquity.open;
  if (!bs.balanced) notes.push({ level: 'error', msg: '貸借が一致しません（計算の不具合です）' });
  for (const r of assets) {
    if (r.close < 0 && r.group !== 'own') {
      const hint = r.name === '仮払金' ? '仮払いを渡したときの振替（借方 仮払金 ／ 貸方 現金など）を入れてください'
        : r.name === '現金' || r.name === '普通預金' ? '期首残高や入金（売上・借入・事業主借など）の入れ忘れがないか確かめてください'
        : '期首残高や振替の入れ忘れがないか確かめてください';
      notes.push({ level: 'warn', msg: `${r.name}がマイナス（${r.close.toLocaleString('ja-JP')}円）です。${hint}` });
    }
  }
  for (const r of liabs) if (r.close < 0) notes.push({ level: 'warn', msg: `${r.name}がマイナス（${r.close.toLocaleString('ja-JP')}円）です。支払いの振替が多すぎないか確かめてください` });

  // 月ごとの推移（期の全月）
  const monthly = [];
  const [fy, fm] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  let cum = 0;
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const v = months.get(ym) || { rev: 0, exp: 0 };
    cum += v.rev - v.exp;
    monthly.push({ ym, rev: v.rev, exp: v.exp, profit: v.rev - v.exp, cum });
    if (monthly.length > 36) break;
  }

  // 試算表
  const accs = new Set([...open.keys(), ...close.keys(), ...deb.keys(), ...cre.keys(), ...flow.keys()]);
  const typeOrder = { asset: 0, liability: 1, equity: 2, revenue: 3, expense: 4 };
  const trial = [...accs].map((a) => ({ name: a, type: type(a), open: open.get(a) || 0, debit: deb.get(a) || 0, credit: cre.get(a) || 0, close: type(a) === 'revenue' || type(a) === 'expense' ? flow.get(a) || 0 : a === '事業主貸' ? draw : a === '事業主借' ? loan : close.get(a) || 0 }))
    .sort((x, y) => typeOrder[x.type] - typeOrder[y.type] || x.name.localeCompare(y.name, 'ja'));

  return { mode, from, to, pl, bs, monthly, trial, notes, journals: inPeriod, counts: { journals: inPeriod.length } };
}
