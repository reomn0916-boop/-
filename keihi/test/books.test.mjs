// 帳簿（books.js）のテスト: 金額は手で計算した値と照らし合わせる
import test from 'node:test';
import assert from 'node:assert/strict';
import { journalsFrom, buildStatements, fiscalRange, booksOf } from '../js/books.js';

const exp = (o) => ({ status: 'ok', kind: 'receipt', ...o });
const find = (l, name) => l.find((r) => r.name === name) || { open: 0, close: 0 };

const soleSettings = {
  categories: ['旅費交通費', '車両費', '消耗品費', '雑費'],
  books: { mode: 'sole', closeMonth: 12, openDate: '2026-01-01', opening: { 現金: 50000, 普通預金: 300000, 未払金: 20000 } },
};
const soleData = {
  expenses: [
    exp({ id: 'a', date: '2026-02-03', amount: 1878, category: '消耗品費', method: '現金', payee: 'コメリ' }),
    exp({ id: 'b', date: '2026-03-15', amount: 5036, category: '車両費', method: '個人カード', payee: 'ENEOS' }),
    exp({ id: 'c', date: '2026-03-20', amount: 3300, category: '旅費交通費', method: '会社カード' }),
    exp({ id: 'd', date: '2026-03-21', amount: 9999, category: '雑費', method: '現金', status: 'draft' }), // 確認待ちは入れない
  ],
  ledger: [
    { id: 'i1', type: 'income', date: '2026-03-31', amount: 500000, debit: '売掛金', credit: '売上高', partner: '○○工務店' },
    { id: 'i2', type: 'income', date: '2026-04-02', amount: 2000, debit: '現金', credit: '雑収入' },
    { id: 'j1', type: 'journal', date: '2026-04-30', amount: 300000, debit: '普通預金', credit: '売掛金', memo: '入金' },
    { id: 'j2', type: 'journal', date: '2026-05-25', amount: 100000, debit: '事業主貸', credit: '普通預金', memo: '生活費' },
  ],
};

test('個人事業主: 損益計算書', () => {
  const st = buildStatements({ journals: journalsFrom({ ...soleData, settings: soleSettings }), settings: soleSettings, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(st.pl.revenue, 502000);
  assert.equal(st.pl.expense, 10214);
  assert.equal(st.pl.netIncome, 491786);
  const last = st.pl.sections[st.pl.sections.length - 1];
  assert.equal(last.value, 491786);
  assert.match(last.result, /青色申告特別控除前の所得金額/);
});

test('個人事業主: 貸借対照表（期首・期末）が一致する', () => {
  const st = buildStatements({ journals: journalsFrom({ ...soleData, settings: soleSettings }), settings: soleSettings, from: '2026-01-01', to: '2026-12-31' });
  const { bs } = st;
  assert.equal(bs.balanced, true);
  assert.equal(find(bs.assets, '現金').close, 52000);
  assert.equal(find(bs.assets, '普通預金').close, 500000);
  assert.equal(find(bs.assets, '売掛金').close, 200000);
  assert.equal(find(bs.assets, '事業主貸').close, 100000);
  assert.equal(find(bs.liabs, '未払金').close, 23300);
  assert.equal(find(bs.equity, '元入金').open, 330000);
  assert.equal(find(bs.equity, '事業主借').close, 6914);
  assert.equal(bs.totalAssets.close, 852000);
  assert.equal(bs.totalLiabs.close + bs.totalEquity.close, 852000);
  assert.equal(bs.totalAssets.open, 350000);
});

test('個人事業主: 次の年は繰り越して、元入金に所得・事業主貸借を入れる', () => {
  const st = buildStatements({ journals: journalsFrom({ ...soleData, settings: soleSettings }), settings: soleSettings, from: '2027-01-01', to: '2027-12-31' });
  assert.equal(find(st.bs.assets, '普通預金').open, 500000);
  assert.equal(find(st.bs.equity, '元入金').open, 330000 + 491786 + 6914 - 100000);
  assert.equal(st.bs.balanced, true);
  assert.equal(st.pl.netIncome, 0);
});

test('月ごとの推移と試算表', () => {
  const st = buildStatements({ journals: journalsFrom({ ...soleData, settings: soleSettings }), settings: soleSettings, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(st.monthly.length, 12);
  const mar = st.monthly.find((m) => m.ym === '2026-03');
  assert.equal(mar.rev, 500000); assert.equal(mar.exp, 8336);
  assert.equal(st.monthly[11].cum, 491786);
  const tb = st.trial.find((r) => r.name === '売掛金');
  assert.deepEqual([tb.debit, tb.credit, tb.close], [500000, 300000, 200000]);
});

const corpSettings = {
  categories: ['旅費交通費', '消耗品費'],
  books: { mode: 'corp', closeMonth: 3, openDate: '2026-04-01', capital: 1000000, opening: { 普通預金: 1500000, 借入金: 300000 } },
};

test('法人: 精算の支払い・営業外の収益と費用・繰越利益剰余金', () => {
  const data = {
    expenses: [
      exp({ id: 'a', date: '2026-04-10', amount: 1878, category: '消耗品費', method: '現金' }),
      exp({ id: 'b', date: '2026-04-12', amount: 3300, category: '旅費交通費', method: '会社カード' }),
    ],
    reports: [{ id: 'r1', created: new Date(2026, 3, 30).getTime(), reimb: 1878, advance: 0 }],
    ledger: [
      { id: 'i1', type: 'income', date: '2026-05-31', amount: 100000, debit: '普通預金', credit: '売上高' },
      { id: 'i2', type: 'income', date: '2026-06-30', amount: 10, debit: '普通預金', credit: '受取利息' },
      { id: 'j1', type: 'journal', date: '2026-06-30', amount: 500, debit: '支払利息', credit: '普通預金' },
    ],
  };
  const { from, to } = fiscalRange('2026-11-19', 3);
  assert.deepEqual([from, to], ['2026-04-01', '2027-03-31']);
  const st = buildStatements({ journals: journalsFrom({ ...data, settings: corpSettings }), settings: corpSettings, from, to });
  const r = (name) => st.pl.sections.find((s) => s.result === name).value;
  assert.equal(r('売上総利益'), 100000);
  assert.equal(r('営業利益'), 94822);
  assert.equal(r('経常利益'), 94332);
  assert.equal(st.pl.netIncome, 94332);
  assert.equal(find(st.bs.assets, '普通預金').close, 1597632);
  assert.equal(find(st.bs.liabs, '未払金').close, 3300);
  assert.equal(find(st.bs.equity, '資本金').close, 1000000);
  assert.equal(find(st.bs.equity, '繰越利益剰余金').open, 200000);
  assert.equal(find(st.bs.equity, '繰越利益剰余金').close, 294332);
  assert.equal(st.bs.balanced, true);
});

test('法人: 仮払金と相殺した精算（仮払いを入れ忘れるとマイナスを知らせる）', () => {
  const data = { expenses: [exp({ id: 'a', date: '2026-04-10', amount: 1878, category: '消耗品費', method: '現金' })], reports: [{ id: 'r', created: new Date(2026, 3, 30).getTime(), reimb: 1878, advance: 1000 }] };
  const j = journalsFrom({ ...data, settings: corpSettings });
  assert.deepEqual(j.filter((x) => x.src === 'settle').map((x) => [x.credit, x.amount]), [['仮払金', 1000], ['普通預金', 878]]);
  const st = buildStatements({ journals: j, settings: corpSettings, from: '2026-04-01', to: '2027-03-31' });
  assert.equal(st.bs.balanced, true);
  assert.ok(st.notes.some((n) => /仮払金がマイナス/.test(n.msg)));
});

test('期首残高なし・期首残高の前の期間でも貸借は一致する', () => {
  const s1 = { ...soleSettings, books: { mode: 'sole' } };
  const st = buildStatements({ journals: journalsFrom({ ...soleData, settings: s1 }), settings: s1, from: '2026-01-01', to: '2026-12-31' });
  assert.equal(st.bs.balanced, true);
  assert.ok(st.notes.some((n) => /期首残高が未設定/.test(n.msg)));
  const st2 = buildStatements({ journals: journalsFrom({ ...soleData, settings: soleSettings }), settings: soleSettings, from: '2025-01-01', to: '2025-12-31' });
  assert.equal(st2.bs.balanced, true);
  assert.ok(st2.notes.some((n) => /より前の期間/.test(n.msg)));
});

test('支払方法ごとの貸方科目は設定で変えられる', () => {
  const s = { ...soleSettings, books: { ...soleSettings.books, payMap: { 現金: '現金' } } };
  const j = journalsFrom({ expenses: [exp({ id: 'a', date: '2026-02-03', amount: 1000, category: '消耗品費', method: '現金' })], settings: s });
  assert.equal(j[0].credit, '現金');
  assert.equal(booksOf(s).payMap.個人カード, '事業主借');
});

test('会計期間', () => {
  assert.deepEqual(fiscalRange('2026-11-19', 12), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(fiscalRange('2026-02-10', 3), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(fiscalRange('2026-09-30', 9), { from: '2025-10-01', to: '2026-09-30' });
});

test('締めた期間は固定した仕訳を使う', () => {
  const settings = { books: { mode: 'sole', closeMonth: 12 } };
  const e1 = { id: 'a', status: 'ok', date: '2026-10-05', amount: 1000, category: '消耗品費', method: '現金' };
  const e2 = { id: 'b', status: 'ok', date: '2026-11-05', amount: 2000, category: '消耗品費', method: '現金' };
  const all = journalsFrom({ expenses: [e1, e2], settings, asOf: '2026-11-20' });
  const closed = { until: '2026-10-31', journals: all.filter((j) => j.date <= '2026-10-31') };
  // 締めたあとに 10 月の経費を（もし）直しても、10 月の仕訳は変わらない
  const after = journalsFrom({ expenses: [{ ...e1, amount: 9999 }, e2], settings, asOf: '2026-11-20', closed });
  assert.deepEqual(after.map((j) => [j.date, j.amount, !!j.closed]), [['2026-10-05', 1000, true], ['2026-11-05', 2000, false]]);
});
