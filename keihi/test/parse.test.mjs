// レシート読み取り（parse.js）のテスト: node --test keihi/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReceipt, normalizeLines, amountsIn, findDate, findTotal, checkInvoiceNo, findInvoiceNo, findTaxes, guessCategory,
} from '../js/parse.js';

const today = new Date(2026, 10, 19); // 2026-11-19

test('ホームセンターのレシート', () => {
  const r = parseReceipt(`
    コメリ ハード＆グリーン 〇〇店
    TEL 0258-12-3456
    登録番号 T1234567890123
    2026年11月18日(水) 10:42 レジ0003
    軍手 10双組        ※ ¥598
    養生テープ 50mm         ¥1,280
    小計                    ¥1,878
    (10%対象 ¥1,280 内税 ¥116)
    (8%対象  ¥598  内税 ¥44)
    合 計              ¥1,878
    お預り              ¥2,000
    お釣り                ¥122
  `, { today });
  assert.equal(r.amount, 1878);
  assert.equal(r.date, '2026-11-18');
  assert.equal(r.payee, 'コメリ');
  assert.equal(r.category, '消耗品費');
  assert.equal(r.invoiceNo, 'T1234567890123');
  assert.equal(r.tax10, 1280);
  assert.equal(r.tax8, 598);
  assert.equal(r.payment, '現金');
  assert.equal(r.sure.amount, true);
});

test('OCR らしい空白・全角・\\ の混ざったレシート', () => {
  const r = parseReceipt(`
    E N E O S  〇 〇 S S
    ２０２６／１１／１５　１７：０２
    レ ギ ュ ラ ー  3 0 . 5 2 L  @ 1 6 5 . 0
    お 買 上 げ 計   \\5, 036
    ク レ ジ ッ ト   \\5,036
  `, { today });
  assert.equal(r.amount, 5036);
  assert.equal(r.date, '2026-11-15');
  assert.equal(r.payee, 'ENEOS');
  assert.equal(r.category, '車両費');
  assert.equal(r.memo, 'ガソリン代');
  assert.equal(r.payment, 'カード');
});

test('手書きの領収書（令和・但し書き）', () => {
  const r = parseReceipt(`
    領 収 書
    株式会社 山田建材 様
    金 ¥ 33,000 -
    但し 砂利代として
    令和8年11月10日
    有限会社 佐藤石材店
  `, { today });
  assert.equal(r.amount, 33000);
  assert.equal(r.date, '2026-11-10');
  assert.equal(r.memo, '砂利代');
});

test('駐車場（2桁の年・料金）', () => {
  const r = parseReceipt(`
    タイムズ〇〇第3
    入庫 26/11/17 08:12
    出庫 26/11/17 17:40
    駐車料金 1,400円
    領収金額 1,400円
  `, { today });
  assert.equal(r.amount, 1400);
  assert.equal(r.date, '2026-11-17');
  assert.equal(r.payee, 'タイムズ');
  assert.equal(r.category, '旅費交通費');
});

test('合計の行がないときはお預り−お釣り', () => {
  const t = findTotal(normalizeLines(`
    ラーメン 900
    ぎょうざ 400
    お預り 2,000
    お釣り 700
  `));
  assert.equal(t.value, 1300);
});

test('金額の候補（日付・時刻・電話・数量を除く）', () => {
  assert.deepEqual(amountsIn('2026/11/18 10:42').map((a) => a.value), []);
  assert.deepEqual(amountsIn('TEL 03-1234-5678').map((a) => a.value), []);
  assert.deepEqual(amountsIn('数量 3個 ¥1,200').map((a) => a.value), [1200]);
  assert.deepEqual(amountsIn('30.52L @165.0').map((a) => a.value), []);
  assert.deepEqual(amountsIn('金 5,000-').map((a) => a.value), [5000]);
});

test('日付のいろいろな書き方', () => {
  const L = (s) => normalizeLines(s);
  assert.equal(findDate(L('2026.11.3'), today), '2026-11-03');
  assert.equal(findDate(L('R8.11.03'), today), '2026-11-03');
  assert.equal(findDate(L('11月3日(月)'), today), '2026-11-03');
  assert.equal(findDate(L('12/25'), today), '2025-12-25'); // 未来になるときは去年
  assert.equal(findDate(L('2030年1月1日'), today), null); // 先すぎる日付は使わない
});

test('登録番号の検査用数字', () => {
  assert.equal(checkInvoiceNo('T7000012050002'), true); // 国税庁の法人番号
  assert.equal(checkInvoiceNo('T1180301018771'), true);
  assert.equal(checkInvoiceNo('T1180301018772'), false);
  assert.equal(findInvoiceNo(normalizeLines('登録番号:T 7000-0120-50002')), 'T7000012050002');
  // OCR の読みまちがい: T →「 / T → 7
  assert.equal(findInvoiceNo(normalizeLines('登録番号 「1180301018771')), 'T1180301018771');
  assert.equal(findInvoiceNo(normalizeLines('登録番号 71180301018771')), 'T1180301018771');
  assert.equal(findInvoiceNo(normalizeLines('TEL 0258-12-3456')), '');
});

test('税率ごとの対象額', () => {
  const t = findTaxes(normalizeLines('10%対象 ¥2,200\n(内消費税 ¥200)\n8%対象\n¥1,080'));
  assert.equal(t.tax10, 2200);
  assert.equal(t.tax8, 1080);
});

test('学習した科目を優先', () => {
  const learned = { payeeCat: { 'コメリ': '福利厚生費' } };
  assert.equal(guessCategory('コメリ', '', learned), '福利厚生費');
  assert.equal(guessCategory('不明な店', 'カフェ ラテ', {}), '会議費');
});

// 端末内 OCR（Tesseract・PSM 6）が実際に出した文字そのまま
test('実際の OCR 結果: ホームセンター（¥ が \\ や 半 になる）', () => {
  const r = parseReceipt(`コメリ ハード&グリーン
OO店
TEL 0258-12-3456
登録番号 「7009912050902

2026年11月18日(火) 10:42

レジ909003 責No.12

軍手 19双組 ※                               \\598
養生テープ 50mm        \\1, 280
小計                                           \\1,878
(10%対象                                        \\1,280)
(8%対象                                            \\598)
合計                                        1,878
お預り                                         \\2, 000

お釣り                                            半122`, { today });
  assert.equal(r.amount, 1878);
  assert.equal(r.date, '2026-11-18');
  assert.equal(r.payee, 'コメリ');
  assert.equal(r.tax10, 1280);
  assert.equal(r.tax8, 598);
  assert.equal(r.payment, '現金');
});

test('実際の OCR 結果: ガソリン（ENEO0S・\\\\5, 036）', () => {
  const r = parseReceipt(`ENEO0S
セルフ〇C〇S$
登録番号 T1180301018771
2026/11/15 17:02
レギュラー           39.52L
単価                                               @165.0
お買上げ計                            \\\\5, 036
クレジット                               \\5, 036`, { today });
  assert.equal(r.amount, 5036);
  assert.equal(r.payee, 'ENEOS');
  assert.equal(r.category, '車両費');
  assert.equal(r.invoiceNo, 'T1180301018771');
  assert.equal(r.payment, 'カード');
});

test('実際の OCR 結果: 喫茶（店名が 1 行目・品目の行を店名にしない）', () => {
  const r = parseReceipt('喫茶 ひまわり\n2026年11月12日\nブレンド X3             \\1,656\n合計                 \\1,650', { today });
  assert.equal(r.payee, '喫茶ひまわり');
  assert.equal(r.amount, 1650);
  assert.equal(r.category, '会議費');
});

test('学習した登録番号から支払先', () => {
  const r = parseReceipt('なにかの店\n登録番号 T7000012050002\n合計 ¥500', { today, learned: { tnoPayee: { T7000012050002: '国税庁売店' } } });
  assert.equal(r.payee, '国税庁売店');
});
