// 追加機能の計算・読み取りのテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { depreciationSchedule, straightRate, withholding } from '../js/assets.js';
import { journalsFrom, buildStatements } from '../js/books.js';
import { consumptionTax, siteReport, budgetStatus, vehicleReport, payoutSummary, yearCompare, noInvoiceRatio } from '../js/finance.js';
import { parseStatement, suggestRows, ledgerFromRows, parseDate } from '../js/bank.js';
import { parseEml, decodeWords } from '../js/eml.js';
import { invoiceTotals, nextInvoiceNo, overdueInvoices } from '../js/invoice.js';
import { toYayoi, toMF, toFreee } from '../js/exports.js';
import { ruleJournal } from '../js/aijournal.js';
import { parseReceipt } from '../js/parse.js';

const exp = (o) => ({ status: 'ok', kind: 'receipt', ...o });
const sole = (books = {}) => ({ categories: ['旅費交通費', '車両費', '消耗品費', '通信費', '外注費'], books: { mode: 'sole', closeMonth: 12, openDate: '2026-01-01', opening: { 普通預金: 1000000 }, ...books } });

test('減価償却: 定額法（月割り・1円を残す）', () => {
  assert.equal(straightRate(4), 0.25); assert.equal(straightRate(6), 0.167); assert.equal(straightRate(3), 0.334);
  const s = depreciationSchedule({ cost: 1200000, acquired: '2026-04-10', life: 4, method: 'straight' }, { closeMonth: 12, upto: '2031-12-31' });
  assert.equal(s[0].months, 9); assert.equal(s[0].amount, 225000); // 120万 × 0.25 × 9/12
  assert.equal(s[1].amount, 300000);
  assert.equal(s[s.length - 1].bookClose, 1);
  assert.equal(s.reduce((a, r) => a + r.amount, 0), 1199999);
});

test('減価償却: 少額・一括償却', () => {
  assert.deepEqual(depreciationSchedule({ cost: 250000, acquired: '2026-06-01', method: 'small' }, { upto: '2028-01-01' }).map((r) => r.amount), [250000]);
  assert.deepEqual(depreciationSchedule({ cost: 150000, acquired: '2026-06-01', method: 'lump3' }, { upto: '2030-01-01' }).map((r) => r.amount), [50000, 50000, 50000]);
});

test('源泉徴収', () => {
  assert.equal(withholding(100000), 10210);
  assert.equal(withholding(1500000), 102100 + 102100);
});

test('帳簿: 固定資産（取得・償却・家事分）・家事按分・外注費の源泉', () => {
  const settings = sole({
    fixedAssets: [{ id: 'fa', name: '軽トラ', account: '車両運搬具', cost: 1200000, acquired: '2026-04-10', life: 4, method: 'straight', ratio: 80, paidFrom: '普通預金' }],
    allocation: { 通信費: 60 },
  });
  const j = journalsFrom({
    expenses: [exp({ id: 'a', date: '2026-05-01', amount: 10000, category: '通信費', method: '個人カード' })],
    ledger: [{ id: 'p', type: 'payout', date: '2026-06-30', gross: 100000, wh: 10210, partner: '佐藤', payFrom: '普通預金', site: 'A邸' }],
    settings, asOf: '2026-11-19',
  });
  const st = buildStatements({ journals: j, settings, from: '2026-01-01', to: '2026-12-31' });
  const exps = Object.fromEntries(st.pl.sections.find((s) => s.title === '経費').items);
  assert.equal(exps.減価償却費, 180000); // 225000 × 80%
  assert.equal(exps.通信費, 6000); // 1万のうち 60%
  assert.equal(exps.外注費, 100000);
  const f = (l, n) => (l.find((r) => r.name === n) || {}).close;
  assert.equal(f(st.bs.assets, '車両運搬具'), 975000);
  assert.equal(f(st.bs.assets, '事業主貸'), 45000 + 4000);
  assert.equal(f(st.bs.liabs, '預り金'), 10210);
  assert.equal(f(st.bs.assets, '普通預金'), 1000000 - 1200000 - 89790);
  assert.equal(st.bs.balanced, true);
});

test('消費税: 一般・簡易・2割特例、登録番号なしの経過措置', () => {
  const settings = sole({ taxMethod: 'general', simpleRate: 70 });
  const j = journalsFrom({
    expenses: [exp({ id: 'a', date: '2026-05-01', amount: 110000, category: '消耗品費', method: '現金', invoiceNo: 'T1' }), exp({ id: 'b', date: '2026-05-02', amount: 11000, category: '消耗品費', method: '現金' })],
    ledger: [{ id: 'i', type: 'income', date: '2026-05-31', amount: 1100000, debit: '普通預金', credit: '売上高' }],
    settings, asOf: '2026-11-19',
  });
  const t = consumptionTax({ journals: j, from: '2026-01-01', to: '2026-12-31', settings });
  assert.equal(t.salesTax, 100000);
  assert.equal(t.buyTax, 10000 + 800);
  assert.equal(t.byMethod.general, 89200);
  assert.equal(t.byMethod.simple, 30000);
  assert.equal(t.byMethod.twoTenths, 20000);
  assert.equal(t.best, 'twoTenths');
  assert.equal(noInvoiceRatio('2026-09-30'), 0.8); assert.equal(noInvoiceRatio('2026-10-01'), 0.5);
});

test('現場ごとの損益と予算', () => {
  const settings = { ...sole(), sites: { A邸: { budget: 50000, contract: 300000 } } };
  const j = journalsFrom({
    expenses: [exp({ id: 'a', date: '2026-05-01', amount: 20000, category: '消耗品費', method: '現金', site: 'A邸' }), exp({ id: 'b', date: '2026-05-02', amount: 5000, category: '旅費交通費', method: '現金', site: 'A邸' })],
    ledger: [{ id: 'i', type: 'income', date: '2026-05-31', amount: 150000, debit: '売掛金', credit: '売上高', site: 'A邸' }],
    settings,
  });
  const [a] = siteReport({ journals: j, from: '2026-01-01', to: '2026-12-31', settings });
  assert.equal(a.revenue, 150000); assert.equal(a.cost, 25000); assert.equal(a.profit, 125000);
  assert.equal(a.used, 0.5); assert.equal(a.billed, 0.5);
  assert.equal(a.groups['材料・消耗品'], 20000);
  const b = budgetStatus({ expenses: [exp({ date: '2026-11-03', amount: 26000, category: '消耗品費' })], ym: '2026-11', settings: { budgets: { 消耗品費: 30000, 通信費: 0 } } });
  assert.equal(b.length, 1); assert.equal(b[0].level, 'near');
});

test('車ごとの記録と外注先の集計', () => {
  const v = vehicleReport({ vehicles: [{ id: 'v1', name: '軽トラ' }], from: '2026-01-01', to: '2026-12-31', expenses: [
    exp({ date: '2026-05-01', amount: 5000, category: '車両費', vehicle: 'v1', liters: 30, odometer: 10000, memo: 'ガソリン代' }),
    exp({ date: '2026-05-20', amount: 4000, category: '車両費', vehicle: 'v1', liters: 25, odometer: 10600, memo: 'ガソリン代' }),
    exp({ date: '2026-05-22', amount: 3000, category: '車両費', vehicle: 'v1', memo: 'オイル交換' }),
  ] });
  assert.equal(v[0].km, 600); assert.equal(v[0].liters, 55); assert.equal(Math.round(v[0].kmpl * 10) / 10, 10.9); assert.equal(v[0].total, 12000);
  const p = payoutSummary({ from: '2026-01-01', to: '2026-12-31', ledger: [{ type: 'payout', date: '2026-02-01', partner: '佐藤', gross: 100000, wh: 10210 }, { type: 'payout', date: '2026-03-01', partner: '佐藤', gross: 50000, wh: 5105 }] });
  assert.deepEqual([p[0].gross, p[0].wh, p[0].net, p[0].count], [150000, 15315, 134685, 2]);
});

test('前の期との比較とヒント', () => {
  const settings = sole();
  const expenses = [exp({ id: 'a', date: '2026-05-01', amount: 150000, category: '消耗品費', method: '現金' }), exp({ id: 'b', date: '2025-05-01', amount: 50000, category: '消耗品費', method: '現金' })];
  const j = journalsFrom({ expenses, settings });
  const y = yearCompare({ journals: j, settings, expenses, ledger: [], today: '2026-11-19' });
  assert.equal(y.a.expense, 150000); assert.equal(y.p.expense, 50000);
  assert.equal(y.cats[0].diff, 100000);
  assert.ok(y.hints.some((h) => /10万円以上/.test(h.title)));
});

test('銀行明細の読み込みと振り分け', () => {
  const csv = '日付,摘要,お支払金額,お預り金額,残高\n2026/11/01,ﾌﾘｺﾐ ﾏﾙﾏﾙｺｳﾑﾃﾝ,,500000,1500000\n2026/11/05,NTTﾄﾞｺﾓ,8800,,1491200\n2026/11/10,ﾐﾂｲｽﾐﾄﾓｶ-ﾄﾞ,30000,,1461200\n2026/11/12,ｺﾒﾘ,1878,,1459322\n';
  const rows = parseStatement(csv);
  assert.equal(rows.length, 4); assert.deepEqual([rows[0].in, rows[1].out], [500000, 8800]);
  const ledger = [{ id: 'inv', type: 'income', date: '2026-10-31', amount: 500000, debit: '売掛金', credit: '売上高', partner: '○○工務店' }];
  const s = suggestRows(rows, { kind: 'bank', ledger, expenses: [exp({ id: 'e1', date: '2026-11-12', amount: 1878, category: '消耗品費' })] });
  assert.deepEqual(s.map((r) => r.action), ['paid', 'expense', 'transfer', 'skip']);
  assert.equal(s[1].account, '通信費'); assert.equal(s[2].account, '未払金');
  const l = ledgerFromRows(s, { kind: 'bank' });
  assert.equal(l.length, 3);
  assert.deepEqual([l[0].debit, l[0].credit, l[0].ref], ['普通預金', '売掛金', 'inv']);
  const again = suggestRows(rows, { kind: 'bank', ledger: [...ledger, ...l], expenses: [] });
  assert.equal(again.filter((r) => r.note === '取り込み済み').length, 3);
  assert.equal(parseDate('R8.11.3'), '2026-11-03'); assert.equal(parseDate('20261103'), '2026-11-03');
  // 金額 1 列（マイナスが入金）の CSV・見出しなし
  const r2 = parseStatement('2026-11-01,セブンイレブン,550\n2026-11-02,返金,-300\n');
  assert.deepEqual(r2.map((r) => [r.out, r.in]), [[550, 0], [0, 300]]);
});

test('メール（.eml）の読み取り', () => {
  const html = Buffer.from('<p>ご注文ありがとうございます</p><p>合計 &yen;3,300</p><p>2026年11月10日</p>').toString('base64');
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const eml = [
    'From: =?UTF-8?B?44Oi44OO44K/44Ot44Km?= <info@example.jp>',
    'Subject: =?ISO-2022-JP?B?GyRCTk48fT1xGyhC?=',
    'Date: Tue, 10 Nov 2026 10:00:00 +0900',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '', '--XYZ', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', html,
    '--XYZ', 'Content-Type: application/pdf; name="receipt.pdf"', 'Content-Disposition: attachment; filename="receipt.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--XYZ--', '',
  ].join('\r\n');
  const m = parseEml(eml);
  assert.equal(m.from.startsWith('モノタロウ'), true);
  assert.equal(m.subject, '領収書');
  assert.match(m.text, /合計 ¥3,300/);
  assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].name, 'receipt.pdf');
  assert.equal(parseReceipt(m.text, { today: new Date(2026, 10, 19) }).amount, 3300);
  assert.equal(decodeWords('=?UTF-8?Q?=E9=A0=98=E5=8F=8E?='), '領収');
});

test('請求書の金額（税率ごとに端数処理）と期日超過', () => {
  const t = invoiceTotals([{ name: '内装工事', qty: 1, price: 300000, rate: 10 }, { name: '弁当', qty: 3, price: 555, rate: 8 }, { name: '印紙', qty: 1, price: 200, rate: 0 }]);
  assert.deepEqual([t.base10, t.tax10, t.base8, t.tax8, t.base0, t.total], [300000, 30000, 1665, 133, 200, 331998]);
  assert.equal(nextInvoiceNo([{ invoice: { no: '2026-0003' } }], new Date(2026, 10, 1)), '2026-0004');
  const od = overdueInvoices([{ id: 'a', type: 'income', debit: '売掛金', amount: 1, invoice: { due: '2026-11-01' } }, { id: 'b', type: 'income', debit: '売掛金', amount: 1, invoice: { due: '2026-11-01' } }, { id: 'c', type: 'journal', ref: 'b' }], '2026-11-19');
  assert.deepEqual(od.map((x) => x.id), ['a']);
});

test('会計ソフトの形式', () => {
  const j = [{ date: '2026-05-01', debit: '消耗品費', credit: '現金', amount: 1100, memo: 'コメリ', src: 'expense' }, { date: '2026-05-02', debit: '普通預金', credit: '売上高', amount: 5000, memo: '', src: 'income' }, { date: '2026-05-03', debit: '普通預金', credit: '売掛金', amount: 5000, memo: '', src: 'journal' }];
  const y = toYayoi(j, 'sole').trim().split('\r\n');
  assert.equal(y.length, 3); assert.equal(y[0].split(',').length, 25); assert.match(y[0], /^2000,,,2026\/05\/01,消耗品費,,,課対仕入込10%,1100/);
  const mf = toMF(j, 'sole').trim().split('\r\n'); assert.equal(mf.length, 4); assert.match(mf[1], /課税仕入 10%/);
  const fr = toFreee(j, 'sole'); assert.equal(fr.skipped, 1); assert.equal(fr.csv.trim().split('\r\n').length, 3);
});

test('文章から仕訳（決まった言い回し）', () => {
  const t = new Date(2026, 10, 19);
  assert.deepEqual((({ debit, credit, amount }) => [debit, credit, amount])(ruleJournal('軽トラを120万で買った、銀行から振り込んだ', t)), ['車両運搬具', '普通預金', 1200000]);
  assert.deepEqual((({ debit, credit, amount, date }) => [debit, credit, amount, date])(ruleJournal('昨日、生活費を5万円引き出した', t)), ['事業主貸', '普通預金', 50000, '2026-11-18']);
  assert.deepEqual((({ debit, credit }) => [debit, credit])(ruleJournal('銀行から300万円借りた', t)), ['普通預金', '借入金']);
  assert.equal(ruleJournal('よくわからない', t), null);
});

test('レシートの給油量', () => {
  assert.equal(parseReceipt('ENEOS\nレギュラー 30.52L\n合計 ¥5,036', { today: new Date(2026, 10, 19) }).liters, 30.52);
  assert.equal(parseReceipt('コメリ\n合計 ¥1,000', { today: new Date(2026, 10, 19) }).liters, null);
});
