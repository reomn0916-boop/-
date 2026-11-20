// 銀行・カードの明細 CSV（主な形式）と、会計ソフトへの書き出し（弥生・マネーフォワード）の形
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement, suggestRows, ledgerFromRows, decodeBytes } from '../js/bank.js';
import { toYayoi, toMF, MF_HEAD, yayoiTax, mfTax, splitByRate, encodeSJIS, cutBytes } from '../js/exports.js';
import { noInvoiceRatio, consumptionTax } from '../js/finance.js';

const short = (rows) => rows.map((r) => [r.date, r.desc, r.out, r.in]);

test('三菱UFJ銀行（支払い金額・預かり金額、摘要が 2 列）', () => {
  const csv = '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高","メモ","未資金化区分","入払区分"\n"2026/11/1","振込","マルマルコウムテン","","330,000","1,330,000","","",""\n"2026/11/2","カード","ＡＭＡＺＯＮ","3,980","","1,326,020","","",""\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-01', '振込 マルマルコウムテン', 0, 330000], ['2026-11-02', 'カード AMAZON', 3980, 0]]);
});
test('三井住友銀行（年月日・お引出し・お預入れ、令和の日付）', () => {
  const csv = '年月日,お引出し,お預入れ,お取り扱い内容,残高,メモ,ラベル\nR8.11.05,"50,000",,ATM,"900,000",,\n2026/11/06,,"12,000",ﾌﾘｺﾐ ｽｽﾞｷ,"912,000",,\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-05', 'ATM', 50000, 0], ['2026-11-06', 'フリコミ スズキ', 0, 12000]]);
});
test('みずほ銀行（前に口座の行がある）', () => {
  const csv = '口座番号,1234567\n照会期間,2026/11/01～2026/11/30\n\n日付,お引出金額,お預入金額,お取引内容,残高,メモ\n2026.11.10,8800,,NTTドコモ,991200,\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-10', 'NTTドコモ', 8800, 0]]);
});
test('ゆうちょ銀行（取引日 8 桁・受入金額・払出金額・詳細）', () => {
  const csv = '取引日,受入金額（円）,払出金額（円）,詳細１,詳細２,現在（貸付）高\n20261115,,3300,ﾃﾞﾝｷﾘﾖｳ,,500000\n20261116,55000,,ﾌﾘｺﾐ,ｶﾌﾞｼｷｶﾞｲｼﾔ△△,555000\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-15', 'デンキリヨウ', 3300, 0], ['2026-11-16', 'フリコミ カブシキガイシヤ△△', 0, 55000]]);
});
test('楽天銀行（入出金の 1 列: ＋が入金・－が出金）', () => {
  const csv = '取引日,入出金(円),取引後残高(円),入出金内容\n20261101,-1100,98900,VISAデビット AMAZON\n20261102,200000,298900,振込 ヤマダ\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-01', 'VISAデビット AMAZON', 1100, 0], ['2026-11-02', '振込 ヤマダ', 0, 200000]]);
});
test('住信SBIネット銀行', () => {
  const csv = '"日付","内容","出金金額(円)","入金金額(円)","残高(円)","メモ"\n"2026/11/20","振込手数料","145","","1,000,000",""\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-20', '振込手数料', 145, 0]]);
});
test('PayPay銀行（年・月・日が別の列）', () => {
  const csv = '操作日(年),操作日(月),操作日(日),操作時刻(時),操作時刻(分),操作時刻(秒),取引順番号,摘要,お支払金額,お預り金額,残高,メモ\n2026,11,3,10,5,0,1,ｶ-ﾄﾞ ﾋｷｵﾄｼ,"42,000",,"700,000",\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-03', 'カ-ド ヒキオトシ', 42000, 0]]);
});
test('楽天カード（支払総額・月の支払金額の列に引っぱられない、返品はマイナス）', () => {
  const csv = '"利用日","利用店名・商品名","利用者","支払方法","利用金額","支払手数料","支払総額","12月支払金額","1月繰越残高","新規サイン"\n"2026/11/03","ENEOS","本人","1回払い","5,500","0","5,500","5,500","0","*"\n"2026/11/08","ユニクロ 返品","本人","1回払い","-1,990","0","-1,990","-1,990","0",""\n';
  assert.deepEqual(short(parseStatement(csv)), [['2026-11-03', 'ENEOS', 5500, 0], ['2026-11-08', 'ユニクロ 返品', 0, 1990]]);
});
test('JCB・アメックス・イオン', () => {
  const jcb = 'ご利用者,カテゴリ,ご利用日,ご利用先など,ご利用金額(￥),支払区分,今回回数,訂正サイン,お支払い金額(￥),国内／海外,摘要,備考\n本人,ショッピング,2026/11/04,コメリ,"8,800",1回,,,"8,800",国内,,\n';
  assert.deepEqual(short(parseStatement(jcb)), [['2026-11-04', 'コメリ', 8800, 0]]);
  const amex = 'ご利用日,データ処理日,ご利用内容,金額\n2026/11/05,2026/11/06,ホテル,"16,500"\n2026/11/07,2026/11/08,返金 ホテル,"-3,000"\n';
  assert.deepEqual(short(parseStatement(amex)), [['2026-11-05', 'ホテル', 16500, 0], ['2026-11-07', '返金 ホテル', 0, 3000]]);
  const aeon = '利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考\n26/11/06,ミニストップ,本人,1回払い,,550,\n2026/11/06,ミニストップ,本人,1回払い,,550,\n';
  assert.equal(parseStatement(aeon).length, 1); // 2 桁の年は読まない（日付として不確か）
});
test('三井住友カード（見出しなし・1 行目が名前）と Shift_JIS', () => {
  const csv = '山田　太郎　様,4980-****-****-****,三井住友カード\n2026/11/02,ＥＮＥＯＳ　○○ＳＳ,6600,１,１,6600,\n2026/11/09,アマゾン,3980,１,１,3980,\n,,10580,,,,合計\n';
  const bytes = encodeSJIS(csv);
  const rows = parseStatement(decodeBytes(bytes));
  assert.deepEqual(short(rows), [['2026-11-02', 'ENEOS ○○SS', 6600, 0], ['2026-11-09', 'アマゾン', 3980, 0]]);
});
test('カードの返金は「未払金 ／ 経費」、振込手数料を引かれた入金も請求に消し込む', () => {
  const ledger = [{ id: 'inv1', type: 'income', debit: '売掛金', credit: '売上高', amount: 330000, partner: '○○工務店', date: '2026-10-31' }];
  const card = suggestRows([{ date: '2026-11-08', desc: 'ユニクロ 返品', out: 0, in: 1990 }], { kind: 'card', ledger });
  assert.equal(card[0].action, 'refund');
  const lc = ledgerFromRows(card, { kind: 'card' });
  assert.deepEqual([lc[0].debit, lc[0].amount], ['未払金', 1990]);
  const bank = suggestRows([{ date: '2026-11-20', desc: 'フリコミ マルマルコウムテン', out: 0, in: 329340 }], { kind: 'bank', ledger });
  assert.deepEqual([bank[0].action, bank[0].ref, bank[0].fee], ['paid', 'inv1', 660]);
  const lb = ledgerFromRows(bank, { kind: 'bank', account: '普通預金' });
  assert.deepEqual(lb.map((l) => [l.debit, l.credit, l.amount]), [['普通預金', '売掛金', 329340], ['支払手数料', '売掛金', 660]]);
  assert.notEqual(lb[0].bankKey, lb[1].bankKey);
});

// ---- 会計ソフト ---------------------------------------------------------------
const J = [
  { date: '2026-05-01', debit: '消耗品費', credit: '事業主借', amount: 1100, memo: 'コメリ 養生テープ', src: 'expense', invoice: true },
  { date: '2026-05-02', debit: '会議費', credit: '現金', amount: 3080, tax8: 1080, memo: 'コンビニ 弁当と日用品', src: 'expense', invoice: true, site: 'A邸' },
  { date: '2026-11-03', debit: '外注費', credit: '普通預金', amount: 50000, memo: '鈴木 塗装', src: 'payout', invoice: false },
  { date: '2026-05-04', debit: '売掛金', credit: '売上高', amount: 331080, memo: '○○工務店', src: 'income', split: { 10: 330000, 8: 1080 } },
  { date: '2026-05-05', debit: '普通預金', credit: '受取利息', amount: 12, memo: '利息', src: 'income' },
  { date: '2026-05-06', debit: '保険料', credit: '普通預金', amount: 20000, memo: '火災保険', src: 'journal' },
  { date: '2026-12-31', debit: '減価償却費', credit: '車両運搬具', amount: 225000, memo: '軽トラ 減価償却', src: 'dep' },
  { date: '2026-12-31', debit: '事業主貸', credit: '通信費', amount: 4000, memo: '通信費 家事按分', src: 'alloc' },
  { date: '2026-05-07', debit: '普通預金', credit: '売掛金', amount: 5000, memo: '入金', src: 'journal' },
];
test('税率で行を分ける', () => {
  assert.deepEqual(splitByRate(J[1]), [{ amount: 2000, rate: 10 }, { amount: 1080, rate: 8 }]);
  assert.deepEqual(splitByRate(J[3]), [{ amount: 330000, rate: 10 }, { amount: 1080, rate: 8 }]);
});
test('弥生インポート形式（25 列・税込の税区分・インボイス・本決）', () => {
  const rows = toYayoi(J, { mode: 'sole', taxMethod: 'general' }).trim().split('\r\n').map((r) => r.split(','));
  assert.ok(rows.every((r) => r.length === 25));
  assert.deepEqual(rows[0].slice(0, 16), ['2000', '', '', '2026/05/01', '消耗品費', '', '', '課対仕入込10%適格', '1100', '', '事業主借', '', '', '対象外', '1100', '']);
  assert.equal(rows[1][7], '課対仕入込10%適格'); assert.equal(rows[1][8], '2000');
  assert.equal(rows[2][7], '課対仕入込軽減8%適格'); assert.equal(rows[2][8], '1080');
  assert.equal(rows[3][7], '課対仕入込10%区分70%'); // 2026年10月からは 70%
  assert.deepEqual([rows[4][13], rows[5][13]], ['課税売上込10%', '課税売上込軽減8%']);
  assert.equal(rows[6][13], '非課売上');
  assert.equal(rows[7][7], '非課仕入');
  assert.deepEqual([rows[8][2], rows[8][7], rows[8][13]], ['本決', '対象外', '対象外']);
  assert.deepEqual([rows[9][2], rows[9][13]], ['本決', '課対仕入込10%適格']); // 家事按分は貸方に仕入の税区分
  assert.deepEqual([rows[10][7], rows[10][13]], ['対象外', '対象外']);
  assert.equal(rows.at(-1)[24], 'no'); assert.equal(rows.at(-1)[19], '0');
  assert.equal(yayoiTax(J[3], 'credit', 10, { mode: 'sole', taxMethod: 'simple', simpleRate: 70 }), '課税売上込三10%');
});
test('弥生の摘要は半角 64 桁（全角 32 文字）まで', () => {
  assert.equal(cutBytes('あ'.repeat(40), 64).length, 32);
  assert.equal(cutBytes('ABCｱｲｳ', 4), 'ABCｱ');
});
test('マネーフォワード 仕訳帳（A〜AA 列・税区分・インボイス・複合仕訳）', () => {
  const rows = toMF(J, { mode: 'sole', taxMethod: 'general' }).trim().split('\r\n').map((r) => r.split(','));
  assert.deepEqual(rows[0], MF_HEAD); assert.equal(MF_HEAD.length, 27);
  assert.ok(rows.every((r) => r.length === 27));
  assert.deepEqual([rows[1][6], rows[1][7], rows[1][8], rows[1][14], rows[1][15]], ['課税仕入 10%', '適格', '1100', '対象外', '']);
  assert.deepEqual([rows[2][0], rows[3][0]], ['2', '2']); // 10% と 8% の行は同じ取引No
  assert.equal(rows[3][6], '課税仕入 (軽)8%');
  assert.deepEqual([rows[4][6], rows[4][7]], ['課税仕入 10%', '70％控除']);
  assert.deepEqual([rows[5][14], rows[6][14], rows[7][14]], ['課税売上 10%', '課税売上 (軽)8%', '非課税売上']);
  assert.deepEqual([rows[9][21], rows[9][22]], ['償却', '1']);
  assert.equal(mfTax(J[3], 'credit', 10, { mode: 'sole', taxMethod: 'simple', simpleRate: 70 }), '課税売上 10% 三種');
});
test('インボイスのない仕入の経過措置（令和8年度改正）', () => {
  assert.deepEqual(['2023-09-30', '2026-09-30', '2026-10-01', '2028-09-30', '2028-10-01', '2030-10-01', '2031-10-01'].map(noInvoiceRatio), [1, 0.8, 0.7, 0.7, 0.5, 0.3, 0]);
});
test('消費税: 家事按分・固定資産の私用分は控除しない、2割・3割特例の時期', () => {
  const settings = { books: { mode: 'sole', taxable: true, taxMethod: 'general' } };
  const base = [{ date: '2027-03-01', debit: '売掛金', credit: '売上高', amount: 1100000, src: 'income' }, { date: '2027-03-02', debit: '通信費', credit: '普通預金', amount: 110000, src: 'expense', invoice: true }];
  const t1 = consumptionTax({ journals: base, from: '2027-01-01', to: '2027-12-31', settings });
  const t2 = consumptionTax({ journals: [...base, { date: '2027-12-31', debit: '事業主貸', credit: '通信費', amount: 44000, src: 'alloc' }], from: '2027-01-01', to: '2027-12-31', settings });
  assert.equal(t1.buyTax - t2.buyTax, 4000);
  assert.ok('threeTenths' in t1.byMethod && !('twoTenths' in t1.byMethod));
  const t3 = consumptionTax({ journals: [{ date: '2026-03-01', debit: '車両運搬具', credit: '普通預金', amount: 1100000, src: 'asset', invoice: true, ratio: 60 }], from: '2026-01-01', to: '2026-12-31', settings });
  assert.equal(t3.buyTax, 60000);
  assert.ok('twoTenths' in t3.byMethod && !('threeTenths' in t3.byMethod));
});

// ---- 定率法・少額減価償却資産の上限 ---------------------------------------------------
import { depreciationSchedule, smallAssetTotal, rateOf, DECLINING } from '../js/assets.js';
test('200%定率法: 保証額を下回ったら改定償却率に切り替え、最後は 1 円', () => {
  const s = depreciationSchedule({ cost: 1000000, acquired: '2026-01-01', method: 'declining', life: 5 }, { closeMonth: 12, upto: '2035-12-31' });
  assert.deepEqual(s.map((x) => x.amount), [400000, 240000, 144000, 108000, 107999]);
  assert.equal(s.at(-1).bookClose, 1);
  const t = depreciationSchedule({ cost: 2000000, acquired: '2026-04-01', method: 'declining', life: 6 }, { closeMonth: 3, upto: '2035-12-31' });
  assert.deepEqual(t.map((x) => x.amount), [666000, 444222, 296296, 198222, 198222, 197037]);
  const half = depreciationSchedule({ cost: 1200000, acquired: '2026-10-01', method: 'declining', life: 4 }, { closeMonth: 12, upto: '2026-12-31' });
  assert.deepEqual([half[0].months, half[0].amount], [3, 150000]); // 1,200,000 × 0.500 × 3/12
  assert.deepEqual(DECLINING[4], [0.5, 1, 0.12499]);
  assert.equal(rateOf({ method: 'declining', life: 6 }), '0.333');
});
test('少額減価償却資産は 1 年 300万円まで', () => {
  const a = [{ id: 'a', method: 'small', cost: 290000, acquired: '2026-03-01' }, { id: 'b', method: 'small', cost: 280000, acquired: '2026-05-01' }, { id: 'c', method: 'small', cost: 100000, acquired: '2025-12-01' }, { id: 'd', method: 'straight', cost: 500000, acquired: '2026-05-01' }];
  assert.equal(smallAssetTotal(a, { from: '2026-01-01', to: '2026-12-31' }), 570000);
  assert.equal(smallAssetTotal(a, { from: '2026-01-01', to: '2026-12-31' }, 'a'), 280000);
});
