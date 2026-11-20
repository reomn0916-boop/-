// 分析: 消費税の概算・現場別の損益・車両・外注先（源泉）・予算・前年との比較とヒント（画面に依存しない）
import { accountType, booksOf, fiscalRange } from './books.js';

const inR = (d, from, to) => d && d >= from && d <= to;
const ymOf = (d) => (d || '').slice(0, 7);

// ---- 消費税 -------------------------------------------------------------------
// 税込の記録から、預かった税・払った税を逆算して納める税額の目安を出す（国税＋地方税の合計）
const NONTAX = new Set(['租税公課', '給料賃金', '保険料', '支払利息', '減価償却費', '受取利息', '事業主貸', '事業主借']);
export const TAX_METHODS = { general: '一般課税（原則）', simple: '簡易課税', twoTenths: '2割特例', threeTenths: '3割特例' };
export const SIMPLE_RATES = [[90, '第1種（卸売業）'], [80, '第2種（小売業）'], [70, '第3種（建設業・製造業など）'], [60, '第4種（その他）'], [50, '第5種（サービス業など）'], [40, '第6種（不動産業）']];

// 適格請求書がない仕入れの控除の割合（経過措置。令和8年度改正で 2026年10月から 70%）
export function noInvoiceRatio(date) {
  if (date < '2023-10-01') return 1;
  if (date < '2026-10-01') return 0.8;
  if (date < '2028-10-01') return 0.7;
  if (date < '2030-10-01') return 0.5;
  if (date < '2031-10-01') return 0.3;
  return 0;
}
const taxIn = (amount, rate) => (amount * rate) / (100 + rate);

export function consumptionTax({ journals, from, to, settings }) {
  const b = booksOf(settings);
  let sales10 = 0; let sales8 = 0; let salesTax = 0;
  let buyTax = 0; let buyBase = 0; let noInvoiceCut = 0; let buyCount = 0; let noInvCount = 0;
  for (const j of journals) {
    if (!inR(j.date, from, to)) continue;
    // 売上（課税）
    if (accountType(j.credit, b.mode) === 'revenue' && j.credit !== '受取利息') {
      if (j.split) { sales10 += j.split[10]; sales8 += j.split[8]; salesTax += taxIn(j.split[10], 10) + taxIn(j.split[8], 8); continue; }
      const r = j.taxRate == null ? 10 : +j.taxRate;
      if (r > 0) { if (r === 8) sales8 += j.amount; else sales10 += j.amount; salesTax += taxIn(j.amount, r); }
    }
    // 仕入れ・経費（課税）
    if (accountType(j.debit, b.mode) === 'expense' || (j.src === 'asset' && accountType(j.debit, b.mode) === 'asset')) {
      if (NONTAX.has(j.debit) || j.src === 'dep' || j.src === 'alloc') continue;
      if (j.credit === '預り金') continue; // 源泉の部分は外注費の総額で数える
      let base = j.amount;
      if (j.src === 'payout' && j.credit !== '預り金') base = j.amount; // 差引額のみ（下で源泉分を足す）
      let t;
      if (j.tax10 || j.tax8) t = taxIn(j.tax10 || 0, 10) + taxIn(j.tax8 || 0, 8) + taxIn(Math.max(0, j.amount - (j.tax10 || 0) - (j.tax8 || 0)), 10);
      else t = taxIn(base, 10);
      if (j.src === 'asset' && j.ratio != null) { t = (t * Math.min(100, Math.max(0, +j.ratio))) / 100; } // 固定資産の私用分は控除しない
      const ratio = j.invoice === false ? noInvoiceRatio(j.date) : 1;
      if (ratio < 1) { noInvoiceCut += t * (1 - ratio); noInvCount++; }
      buyTax += t * ratio; buyBase += base; buyCount++;
    }
  }
  // 家事按分で事業主貸に振り替えた分は、控除する消費税からも外す
  for (const j of journals) if (inR(j.date, from, to) && j.src === 'alloc' && accountType(j.credit, b.mode) === 'expense' && !NONTAX.has(j.credit)) { const t = taxIn(j.amount, 10); buyTax -= t; buyBase -= j.amount; }
  // 外注費の源泉分（総額に含まれる消費税）
  for (const j of journals) if (inR(j.date, from, to) && j.src === 'payout' && j.credit === '預り金') { const t = taxIn(j.amount, 10); buyTax += j.invoice === false ? t * noInvoiceRatio(j.date) : t; }
  const salesTotal = sales10 + sales8;
  const methods = {
    general: Math.max(0, salesTax - buyTax),
    simple: Math.max(0, salesTax * (1 - (+b.simpleRate || 70) / 100)),
    twoTenths: salesTax * 0.2,
    threeTenths: salesTax * 0.3,
  };
  // 2割特例: 個人は令和8年（2026年）分まで、法人は 2026年9月30日を含む期まで。3割特例: 個人の令和9年（2027年）分から
  const avail = { general: true, simple: true, twoTenths: b.mode === 'sole' ? from <= '2026-12-31' : from <= '2026-09-30', threeTenths: b.mode === 'sole' && to >= '2027-01-01' };
  for (const k of Object.keys(methods)) if (!avail[k] && k !== b.taxMethod) delete methods[k];
  const pick = methods[b.taxMethod] != null ? b.taxMethod : 'general';
  const floor100 = (n) => Math.floor(n / 100) * 100;
  return {
    sales10, sales8, salesTotal, salesTax: Math.floor(salesTax), buyTax: Math.floor(buyTax), buyBase, buyCount, noInvCount, noInvoiceCut: Math.floor(noInvoiceCut),
    method: pick, payable: floor100(methods[pick]), byMethod: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, floor100(v)])),
    best: Object.entries(methods).sort((x, y) => x[1] - y[1])[0][0],
  };
}

// ---- 現場ごとの損益（見積・予算との比較つき） ----------------------------------------------
const GROUPS = [['材料・消耗品', ['消耗品費', '仕入高']], ['外注費', ['外注費']], ['交通・車両', ['旅費交通費', '車両費']]];
export function siteReport({ journals, from, to, settings }) {
  const b = booksOf(settings);
  const plan = (settings && settings.sites) || {};
  const m = new Map();
  const get = (name) => { if (!m.has(name)) m.set(name, { name, revenue: 0, cost: 0, groups: {}, count: 0 }); return m.get(name); };
  for (const j of journals) {
    if (!inR(j.date, from, to) || !j.site) continue;
    if (j.src === 'dep' || j.src === 'alloc') continue;
    const s = get(j.site);
    if (accountType(j.credit, b.mode) === 'revenue') { s.revenue += j.amount; s.count++; }
    if (accountType(j.debit, b.mode) === 'expense') {
      s.cost += j.amount; s.count++;
      const g = (GROUPS.find(([, l]) => l.includes(j.debit)) || ['その他'])[0];
      s.groups[g] = (s.groups[g] || 0) + j.amount;
    }
  }
  for (const name of Object.keys(plan)) get(name);
  return [...m.values()].map((s) => {
    const p = plan[s.name] || {};
    const budget = +p.budget || 0; const contract = +p.contract || 0;
    return { ...s, profit: s.revenue - s.cost, margin: s.revenue ? (s.revenue - s.cost) / s.revenue : null, budget, contract, used: budget ? s.cost / budget : null, billed: contract ? s.revenue / contract : null, closed: !!p.closed };
  }).sort((x, y) => (y.revenue + y.cost) - (x.revenue + x.cost));
}

// ---- 車ごとの記録 ---------------------------------------------------------------
export function vehicleReport({ expenses, from, to, vehicles = [] }) {
  const rows = new Map(vehicles.map((v) => [v.id, { id: v.id, name: v.name, fuel: 0, liters: 0, other: 0, km: 0, odoMin: null, odoMax: null, count: 0, carKm: 0 }]));
  for (const e of expenses) {
    if (e.status === 'draft' || !inR(e.date, from, to) || !e.vehicle || !rows.has(e.vehicle)) continue;
    const r = rows.get(e.vehicle);
    r.count++;
    const isFuel = +e.liters > 0 || /ガソリン|給油|軽油|レギュラー|ハイオク/.test(`${e.memo} ${e.payee}`);
    if (e.kind === 'car') r.carKm += (+e.km || 0) * (e.route && e.route.round ? 2 : 1);
    else if (isFuel) { r.fuel += e.amount || 0; r.liters += +e.liters || 0; } else r.other += e.amount || 0;
    if (+e.odometer > 0) { r.odoMin = r.odoMin == null ? +e.odometer : Math.min(r.odoMin, +e.odometer); r.odoMax = r.odoMax == null ? +e.odometer : Math.max(r.odoMax, +e.odometer); }
  }
  return [...rows.values()].map((r) => {
    const km = r.odoMax != null && r.odoMax > r.odoMin ? r.odoMax - r.odoMin : 0;
    return { ...r, km, kmpl: km && r.liters ? km / r.liters : null, yenPerKm: km ? (r.fuel + r.other) / km : null, total: r.fuel + r.other };
  });
}

// ---- 外注先（源泉徴収・支払調書） ------------------------------------------------------
export function payoutSummary({ ledger, from, to }) {
  const m = new Map();
  for (const l of ledger) {
    if (l.type !== 'payout' || !inR(l.date, from, to)) continue;
    const k = l.partner || '（名前なし）';
    const r = m.get(k) || { partner: k, gross: 0, wh: 0, net: 0, count: 0, address: l.address || '' };
    r.gross += Math.round(l.gross || 0); r.wh += Math.round(l.wh || 0); r.net += Math.round((l.gross || 0) - (l.wh || 0)); r.count++;
    if (l.address) r.address = l.address;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => b.gross - a.gross);
}

// ---- 予算 -------------------------------------------------------------------
// settings.budgets = { 消耗品費: 30000, ... }（毎月）。今月の使った額と割合
export function budgetStatus({ expenses, ym, settings }) {
  const budgets = (settings && settings.budgets) || {};
  const used = {};
  for (const e of expenses) if (e.status !== 'draft' && ymOf(e.date) === ym && e.category) used[e.category] = (used[e.category] || 0) + (e.amount || 0);
  return Object.entries(budgets).filter(([, v]) => +v > 0).map(([cat, v]) => {
    const u = used[cat] || 0; const ratio = u / +v;
    return { category: cat, budget: +v, used: u, ratio, level: ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok' };
  }).sort((a, b) => b.ratio - a.ratio);
}

// ---- 前の期との比較・ヒント --------------------------------------------------------
export function yearCompare({ journals, settings, expenses, ledger, today }) {
  const b = booksOf(settings);
  const cur = fiscalRange(today, b.closeMonth);
  const prevEnd = new Date(`${cur.from}T00:00:00`); prevEnd.setDate(prevEnd.getDate() - 1);
  const prev = fiscalRange(`${prevEnd.getFullYear()}-${String(prevEnd.getMonth() + 1).padStart(2, '0')}-15`, b.closeMonth);
  const sum = (r) => {
    const o = { revenue: 0, expense: 0, cats: {}, payees: {} };
    for (const j of journals) {
      if (!inR(j.date, r.from, r.to)) continue;
      if (accountType(j.credit, b.mode) === 'revenue') o.revenue += j.amount;
      if (accountType(j.debit, b.mode) === 'expense') { o.expense += j.amount; o.cats[j.debit] = (o.cats[j.debit] || 0) + j.amount; }
      if (accountType(j.debit, b.mode) === 'revenue') o.revenue -= j.amount;
      if (accountType(j.credit, b.mode) === 'expense') { o.expense -= j.amount; o.cats[j.credit] = (o.cats[j.credit] || 0) - j.amount; }
    }
    for (const e of expenses) if (e.status !== 'draft' && inR(e.date, r.from, r.to) && e.payee) o.payees[e.payee] = (o.payees[e.payee] || 0) + (e.amount || 0);
    o.profit = o.revenue - o.expense;
    return o;
  };
  const a = sum(cur); const p = sum(prev);
  const cats = [...new Set([...Object.keys(a.cats), ...Object.keys(p.cats)])].map((c) => ({ name: c, cur: a.cats[c] || 0, prev: p.cats[c] || 0 }))
    .map((r) => ({ ...r, diff: r.cur - r.prev })).sort((x, y) => y.cur - x.cur);
  const payees = Object.entries(a.payees).sort((x, y) => y[1] - x[1]).slice(0, 8);
  return { cur, prev, a, p, cats, payees, hints: hints({ b, expenses, ledger, cur, a, today }) };
}

function hints({ b, expenses, ledger, cur, a, today }) {
  const out = [];
  const inCur = expenses.filter((e) => e.status !== 'draft' && inR(e.date, cur.from, cur.to));
  const big = inCur.filter((e) => e.amount >= 100000 && ['消耗品費', '工具器具備品', '雑費'].includes(e.category));
  if (big.length) out.push({ title: '10万円以上の買い物', text: `${big.length}件あります。10万円以上の物は固定資産です。${b.mode === 'sole' ? '青色申告なら30万円未満は「少額減価償却資産」として一度に経費にできます。' : '中小法人なら30万円未満は少額減価償却資産の特例が使えます。'}［帳簿 → 固定資産］で登録してください。` });
  const noInv = inCur.filter((e) => !e.invoiceNo && e.kind === 'receipt' && !['租税公課'].includes(e.category));
  if (inCur.length && noInv.length / inCur.length > 0.3) out.push({ title: '登録番号のない領収書', text: `経費の ${Math.round((noInv.length / inCur.length) * 100)}% に登録番号（インボイス）がありません。課税事業者なら仕入税額控除が減ります。よく使う店は登録番号を確かめましょう。` });
  if (b.mode === 'sole') {
    const alloc = b.allocation || {};
    const mixed = ['車両費', '通信費', '水道光熱費', '地代家賃'].filter((c) => a.cats[c] && alloc[c] == null);
    if (mixed.length) out.push({ title: '家事按分', text: `${mixed.join('・')}に私用分が含まれるなら、［帳簿 → 帳簿の設定 → 家事按分］で事業の割合を決めておくと、期末に自動で振り分けます。` });
    out.push({ title: '青色申告特別控除（最大65万円）', text: 'この帳簿は複式簿記の形です。e-Tax で申告するか優良な電子帳簿保存にすると、最大65万円の控除を受けられます（10万円・55万円の場合もあります）。' });
    if (a.profit > 3000000) out.push({ title: '将来への備え', text: '所得が大きい年は、小規模企業共済や iDeCo（掛金が全額所得控除）も検討しましょう。' });
  } else {
    if (a.profit > 8000000) out.push({ title: '法人税の税率', text: '中小法人は所得 800 万円までの部分の税率が低くなっています。決算前に、役員報酬や設備投資の時期を税理士と相談しましょう。' });
  }
  const overdue = ledger.filter((l) => l.type === 'income' && l.debit === '売掛金' && l.invoice && l.invoice.due && l.invoice.due < today && !ledger.some((x) => x.ref === l.id));
  if (overdue.length) out.push({ title: '入金期日を過ぎた請求', text: `${overdue.length}件（${overdue.reduce((s, l) => s + l.amount, 0).toLocaleString('ja-JP')}円）の請求が期日を過ぎても入金されていません。` });
  const drafts = expenses.filter((e) => e.status === 'draft').length;
  if (drafts) out.push({ title: '確認待ち', text: `確認待ちの経費が ${drafts}件あります。確定しないと決算書に入りません。` });
  return out;
}
