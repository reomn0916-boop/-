// 総務の流れ: ルールを配る → 社員 2 人（スマホ）が提出 → 受け取り箱 → 振込先の確認 → 承認 → 全銀形式 → 支払済み → まとめた結果を社員が取り込む
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, launch, openPage, texts, download } from './lib.mjs';

test('総務: 集める・確かめる・振り込む', { timeout: 240000 }, async () => {
  const srv = await serve(); const browser = await launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-'));
  try {
    const G = await openPage(browser, `${srv.base}/keihi/pc/`);
    await G.evaluate(async () => { const st = await import('/keihi/js/store.js'); Object.assign(st.S.settings, { name: '総務 花子', company: '山田工業' }); st.saveSettings(); });
    await G.reload(); await G.waitForSelector('#app');
    // ルール
    await G.keyboard.press('8'); await G.click('[data-act="apvTab"][data-id="rules"]');
    for (const [sel, v] of [['[data-pol="name"]', '経費規程 2026年版'], ['[data-pol="deadlineDay"]', '5'], ['[data-limit="消耗品費"]', '30000']]) { await G.fill(sel, v); await G.dispatchEvent(sel, 'input'); }
    await G.check('[data-pol="requireSite"]');
    const pf = await download(G, () => G.click('[data-act="policyMake"]'));
    const policyFile = path.join(tmp, 'policy.json'); await pf.saveAs(policyFile);
    assert.equal(JSON.parse(fs.readFileSync(policyFile)).policy.limits['消耗品費'], 30000);
    // 名簿に、まだ出さない人
    await G.click('[data-act="apvTab"][data-id="people"]'); await G.click('[data-act="personAdd"]'); await G.fill('#ptIn', '佐藤 一郎'); await G.click('.modal [data-m="ok"]');

    // 社員（スマホ）
    const employee = async (name, empNo, bank, exps, file) => {
      const P = await openPage(browser, `${srv.base}/keihi/`, { phone: true, ready: '.tabs' });
      await P.click('.tabs [data-tab="settings"]');
      for (const [sel, v] of [['[data-s="name"]', name], ['[data-s="empNo"]', empNo], ...Object.entries(bank).map(([k, v]) => [`[data-mb="${k}"]`, v])]) { await P.fill(sel, v); await P.dispatchEvent(sel, 'input'); }
      await P.setInputFiles('#restoreIn', policyFile); await P.click('.confirm [data-c="1"]');
      await P.evaluate(async (list) => { const st = await import('/keihi/js/store.js'); for (const e of list) await st.saveExpense(st.newExpense({ status: 'ok', auto: [], ...e })); }, exps);
      await P.reload(); await P.waitForSelector('.tabs');
      assert.equal(await P.evaluate(async () => (await import('/keihi/js/store.js')).S.settings.policy.name), '経費規程 2026年版');
      await P.click('.tabs [data-tab="report"]'); await P.click('[data-act="makePdf"]'); await P.waitForSelector('[data-act="settleSubmit"]', { timeout: 60000 });
      const dp = P.waitForEvent('download');
      await P.click('[data-act="settleSubmit"]'); await P.waitForTimeout(400);
      if (await P.$('.confirm [data-c="1"]')) await P.click('.confirm [data-c="1"]'); // ルールに合わない経費の確認
      const d = await dp; const f = path.join(tmp, file); await d.saveAs(f);
      assert.match(d.suggestedFilename(), /^精算の提出_/);
      assert.deepEqual(P.errors, []);
      return { P, file: f };
    };
    const A = await employee('山田 太郎', '1024', { bankCode: '0009', bankName: 'ミツイスミトモ', branchCode: '220', branchName: 'シンジュク', number: '7654321', holder: 'ヤマダ タロウ' }, [
      { date: '2026-11-03', amount: 8800, payee: 'コメリ', category: '消耗品費', site: 'A邸', memo: '養生テープ' },
      { date: '2026-11-10', amount: 45000, payee: 'ホームセンター', category: '消耗品費', site: '', memo: '' },
    ], 'a.json');
    const B = await employee('鈴木 花子', '2048', { bankCode: '9900', bankName: 'ユウチヨ', branchCode: '018', branchName: 'ゼロイチハチ', number: '1234567', holder: 'スズキ ハナコ' }, [
      { date: '2026-11-03', amount: 8800, payee: 'コメリ', category: '消耗品費', site: 'B邸', memo: '軍手' },
    ], 'b.json');
    assert.ok(fs.statSync(A.file).size < 9 * 1024 * 1024);

    // 受け取り箱: まとめて取り込む
    await G.setInputFiles('#fileIn', [A.file, B.file]); await G.waitForSelector('.apv-table tbody tr');
    const rows = await texts(G, '.apv-table tbody tr');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => /二重の疑い/.test(r)), rows.join('\n'));
    assert.match(rows.find((r) => r.includes('山田')), /ルール/);
    assert.match((await texts(G, '.kpis.four .kpi')).join(' '), /未提出 ?1 ?人 ?佐藤/);
    // 書き換えた提出ファイル（チェック結果を消し、振込先を変えた）
    const j = JSON.parse(fs.readFileSync(A.file)); j.id = 'tampered1'; j.items = j.items.map((e) => ({ ...e, issues: [] })); j.applicant.bank = { bankCode: '0005', branchCode: '001', number: '9999999', holder: 'ワルイ ヒト' };
    const tf = path.join(tmp, 't.json'); fs.writeFileSync(tf, JSON.stringify(j));
    await G.setInputFiles('#fileIn', tf); await G.waitForSelector('.modal .apv-detail');
    assert.match(await G.textContent('.modal .apv-detail'), /書き換えられた可能性/);
    assert.match(await G.textContent('.modal .apv-detail'), /振込先の変更の申し出/);
    await G.click('.modal [data-m="del"]'); await G.click('.modal .btn.primary, .modal .btn.danger').catch(() => {});
    await G.waitForTimeout(300);
    // 承認: 鈴木さんは 1 件ずつ、山田さんはルール違反があるのでまとめて承認の対象外
    await G.click('.apv-table tbody tr:has-text("鈴木")'); await G.waitForSelector('.modal .apv-detail');
    const dec = await download(G, () => G.click('.modal [data-m="approved"]'));
    assert.match(dec.suggestedFilename(), /^精算の結果_鈴木/);
    // 振込: はじめての振込先は確かめるまで止まる
    await G.click('[data-act="apvTab"][data-id="pay"]');
    await G.click('[data-act="payerEdit"]');
    for (const [sel, v] of [['#acCode', '1234567890'], ['#acName', 'カ）ヤマダコウギョウ'], ['#acBank', '0005'], ['#acBankN', 'ミツビシユーエフジェイ'], ['#acBr', '001'], ['#acBrN', 'ホンテン'], ['#acNo', '1111111']]) await G.fill(sel, v);
    await G.click('.modal [data-m="ok"]'); await G.waitForTimeout(200);
    assert.match(await G.textContent('.pay-table'), /はじめての振込先/);
    assert.equal(await G.isDisabled('[data-act="payZengin"]'), true);
    await G.click('[data-act="apvTab"][data-id="people"]'); await G.click('tr:has-text("鈴木") [data-act="bankOk"]');
    // 山田さんの振込先の変更の申し出（書き換えファイル）は認めない
    assert.ok(await G.$('tr:has-text("山田") [data-act="bankReject"]'));
    await G.click('tr:has-text("山田") [data-act="bankReject"]');
    await G.click('[data-act="apvTab"][data-id="pay"]');
    const z = await download(G, () => G.click('[data-act="payZengin"]'));
    const zf = path.join(tmp, 'z.txt'); await z.saveAs(zf);
    const lines = fs.readFileSync(zf).toString('latin1').split('\r\n').filter(Boolean);
    assert.deepEqual(lines.map((l) => l.length), [120, 120, 120, 120]);
    await G.click('.modal .btn.primary'); await G.waitForTimeout(300);
    await G.click('[data-act="apvTab"][data-id="inbox"]');
    assert.ok((await texts(G, '.apv-table tbody tr')).some((r) => /鈴木.*支払済み/.test(r)));
    // 社員: 結果ファイル
    await B.P.setInputFiles('#restoreIn', await dec.path()); await B.P.waitForTimeout(300);
    assert.equal(await B.P.evaluate(async () => (await import('/keihi/js/store.js')).S.reports[0].approval.status), 'approved');
    // 受け取り箱はバックアップに入る（支払済みも）
    const bk = await download(G, () => G.evaluate(async () => { const st = await import('/keihi/js/store.js'); const ui = await import('/keihi/pc/ui.js'); ui.download(await st.makeBackup(), 'backup.json'); }));
    const bj = JSON.parse(fs.readFileSync(await bk.path()));
    assert.equal(bj.approvals.length, 2); assert.ok(bj.approvals.some((r) => r.paid)); assert.equal(bj.approvalImages.length, 2);
    assert.deepEqual(G.errors, []);
  } finally { await browser.close(); srv.close(); }
});
