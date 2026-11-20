// 総務: 会社の経費ルールのチェック・締切、全銀形式の振込データ
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyIssues, deadlineInfo, asPolicy, policyFile } from '../js/policy.js';
import { toZenginKana, badKana, zenginTransfer, checkAccount } from '../js/zengin.js';
import { encodeSJIS } from '../js/exports.js';

const P = asPolicy({ requireMemo: true, requireSite: true, requireImage: true, requireGuests: true, perHeadLimit: 10000, maxAgeDays: 60, limits: { 消耗品費: 30000 }, allowedCats: ['消耗品費', '会議費', '旅費交通費'] });
test('会社のルール: 必須項目・上限・科目・古い経費', () => {
  const msgs = (e) => policyIssues(e, P, '2026-11-20').map((x) => x.msg);
  assert.deepEqual(policyIssues({ kind: 'receipt', category: '消耗品費', amount: 1000, memo: '軍手', site: 'A邸', imageId: 'i', date: '2026-11-10' }, P, '2026-11-20'), []);
  const m1 = msgs({ kind: 'receipt', category: '消耗品費', amount: 45000, memo: '', site: '', date: '2026-08-01' });
  assert.equal(m1.length, 5); // 内容・現場・画像・上限・古い
  assert.ok(m1.some((m) => /1 件 ¥30,000/.test(m)));
  const m2 = msgs({ kind: 'receipt', category: '会議費', amount: 36000, people: 3, guests: '', memo: '打合せ', site: 'A邸', imageId: 'i', date: '2026-11-10' });
  assert.ok(m2.some((m) => /人数と相手先/.test(m)) && m2.some((m) => /1 人あたり ¥12,000/.test(m)));
  assert.ok(msgs({ kind: 'receipt', category: '接待交際費', amount: 1, memo: 'x', site: 'A', imageId: 'i', people: 1, guests: 'a', date: '2026-11-10' }).some((m) => /使わない科目/.test(m)));
  assert.deepEqual(msgs({ kind: 'transit', category: '旅費交通費', amount: 660, site: 'A邸', date: '2026-11-10' }), []); // 電車は画像・内容なしで OK
  assert.deepEqual(policyIssues({ amount: 1 }, null), []);
});
test('提出の締切（毎月 5 日までに前の月の分）', () => {
  const p = { deadlineDay: 5 };
  assert.deepEqual(deadlineInfo(p, '2026-11-03'), { date: '2026-11-05', daysLeft: 2, month: '2026-10' });
  assert.deepEqual(deadlineInfo(p, '2026-11-20'), { date: '2026-12-05', daysLeft: 15, month: '2026-11' });
  assert.deepEqual(deadlineInfo(p, '2026-12-28'), { date: '2027-01-05', daysLeft: 8, month: '2026-12' });
  assert.equal(deadlineInfo({ deadlineDay: 0 }, '2026-11-20'), null);
  const f = policyFile({ policy: { deadlineDay: 10 }, categories: ['消耗品費'], company: '山田工業' });
  assert.deepEqual([f.app, f.kind, f.policy.deadlineDay, f.policy.requireMemo], ['rakukeihi', 'policy', 10, true]);
});
test('振込用の半角カナ', () => {
  assert.equal(toZenginKana('ヤマダ　タロウ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(toZenginKana('すずき　じゅんいち'), 'ｽｽﾞｷ ｼﾞﾕﾝｲﾁ');
  assert.equal(toZenginKana('カ）ヤマダコウギョウ'), 'ｶ)ﾔﾏﾀﾞｺｳｷﾞﾖｳ');
  assert.equal(toZenginKana('ミツビシユーエフジェイ'), 'ﾐﾂﾋﾞｼﾕ-ｴﾌｼﾞｴｲ');
  assert.equal(toZenginKana('ﾊﾟﾌﾟﾘｶ abc'), 'ﾊﾟﾌﾟﾘｶ ABC');
  assert.deepEqual(badKana(toZenginKana('山田 タロウ')), ['山', '田']);
  assert.deepEqual(checkAccount({ bankCode: '0005', branchCode: '123', number: '1234567', type: '1', holder: 'ヤマダ タロウ' }), []);
  assert.equal(checkAccount({ bankCode: '5', branchCode: '12', number: '', holder: '山田' }).length, 4);
});
test('全銀形式（総合振込）: 1 行 120 桁、件数と合計', () => {
  const s = zenginTransfer({
    date: '2026-11-25',
    sender: { code: '1234567890', name: 'ｶ)ﾔﾏﾀﾞｺｳｷﾞｮｳ', bankCode: '0005', bankName: 'ﾐﾂﾋﾞｼﾕｰｴﾌｼﾞｪｲ', branchCode: '001', branchName: 'ﾎﾝﾃﾝ', type: '1', number: '1234567' },
    items: [
      { bankCode: '0009', bankName: 'ミツイスミトモ', branchCode: '220', branchName: 'シンジュク', type: '1', number: '7654321', holder: 'ヤマダ タロウ', amount: 20106 },
      { bankCode: '9900', bankName: 'ユウチヨ', branchCode: '018', branchName: 'ゼロイチハチ', type: '1', number: '123', holder: 'スズキ ハナコ', amount: 5036 },
    ],
  });
  const lines = s.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => [...l].length === 120), lines.map((l) => [...l].length).join(','));
  assert.equal(lines[0].slice(0, 4), '1210');
  assert.equal(lines[0].slice(4, 14), '1234567890');
  assert.equal(lines[0].slice(54, 58), '1125');
  assert.equal(lines[1][0], '2'); assert.equal(lines[1].slice(1, 5), '0009');
  assert.equal(lines[1][42], '1'); assert.equal(lines[1].slice(43, 50), '7654321');
  assert.equal(lines[1].slice(50, 80).trim(), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(lines[1].slice(80, 90), '0000020106');
  assert.equal(lines[2].slice(43, 50), '0000123');
  assert.equal(lines[3], `8000002${'000000025142'}${' '.repeat(101)}`);
  assert.equal(lines[4][0], '9');
  // Shift_JIS にすると 1 行 120 バイト（半角カナは 1 バイト）
  assert.equal(encodeSJIS(lines[1]).length, 120);
});

// ---- 振込先の変更は止める ----
test('提出ファイルで振込先が変わっても、総務が認めるまで使わない', async () => {
  const sh = await import('../js/share.js');
  const st = await import('../js/store.js');
  st.S.settings.roster = [];
  const A = { bankCode: '0009', branchCode: '220', number: '7654321', holder: 'ヤマダ タロウ' };
  sh.upsertRoster({ name: '山田 太郎', empNo: '1024', bank: A }, 's1');
  const key = 'no:1024';
  const me = () => st.S.settings.roster.find((p) => sh.personKey(p) === key);
  assert.match(sh.payBlock(me()), /はじめて/);
  sh.resolveBank(key, 'ok'); assert.equal(sh.payBlock(me()), '');
  sh.upsertRoster({ name: '山田 太郎', empNo: '1024', bank: { ...A, holder: 'ﾔﾏﾀﾞ ﾀﾛｳ' } }, 's2'); // 半角・全角のちがいは同じ口座
  assert.equal(sh.payBlock(me()), '');
  sh.upsertRoster({ name: '山田 太郎', empNo: '1024', bank: { bankCode: '0005', branchCode: '001', number: '1111111', holder: 'ワルイ ヒト' } }, 's3');
  assert.match(sh.payBlock(me()), /変更の申し出/); assert.equal(me().bank.number, '7654321');
  sh.resolveBank(key, 'reject'); assert.equal(sh.payBlock(me()), ''); assert.equal(me().bank.number, '7654321');
  sh.upsertRoster({ name: '山田 太郎', empNo: '1024', bank: { bankCode: '0005', branchCode: '001', number: '2222222', holder: 'ヤマダ タロウ' } }, 's4');
  sh.resolveBank(key, 'accept'); assert.equal(me().bank.number, '2222222'); assert.equal(sh.payBlock(me()), '');
});
