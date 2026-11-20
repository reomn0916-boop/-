// 画面をひととおり開いてエラーがないか・使い方ガイドの検索・まとめて承認の結果ファイル
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { serve, launch, openPage, texts, download } from './lib.mjs';

test('パソコン版: 全部の画面と帳簿のタブが開ける', { timeout: 120000 }, async () => {
  const srv = await serve(); const browser = await launch();
  try {
    const p = await openPage(browser, `${srv.base}/keihi/pc/`);
    await p.evaluate(async () => {
      const st = await import('/keihi/js/store.js');
      await st.saveExpense(st.newExpense({ status: 'ok', auto: [], date: '2026-11-03', amount: 8800, payee: 'コメリ', category: '消耗品費', site: 'A邸' }));
      await st.saveLedger({ type: 'income', date: '2026-11-10', amount: 330000, debit: '売掛金', credit: '売上高', partner: '○○工務店', site: 'A邸' });
    });
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) { await p.keyboard.press(k); await p.waitForTimeout(250); }
    await p.keyboard.press('5');
    for (const t of ['income', 'invoice', 'journal', 'bank', 'assets', 'payout', 'book', 'setup']) { await p.click(`[data-btab="${t}"]`); await p.waitForTimeout(150); }
    await p.keyboard.press('7');
    for (const t of ['site', 'budget', 'vehicle', 'partner', 'year']) { await p.click(`[data-act="anTab"][data-id="${t}"]`); await p.waitForTimeout(150); }
    await p.keyboard.press('8');
    for (const t of ['inbox', 'pay', 'people', 'rules', 'mine']) { await p.click(`[data-act="apvTab"][data-id="${t}"]`); await p.waitForTimeout(150); }
    await p.keyboard.press('6'); await p.waitForSelector('#finArea canvas', { timeout: 30000 });
    assert.deepEqual(p.errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('スマホ版: タブが開ける', { timeout: 60000 }, async () => {
  const srv = await serve(); const browser = await launch();
  try {
    const p = await openPage(browser, `${srv.base}/keihi/`, { phone: true, ready: '.tabs' });
    for (const t of ['list', 'report', 'settings', 'home']) { await p.click(`.tabs [data-tab="${t}"]`); await p.waitForTimeout(200); }
    await p.click('[data-act="help"]'); await p.waitForSelector('.guide-link');
    assert.deepEqual(p.errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('使い方ガイド: 検索', { timeout: 60000 }, async () => {
  const srv = await serve(); const browser = await launch();
  try {
    const p = await openPage(browser, `${srv.base}/keihi/guide/`, { ready: '#q' });
    const find = async (q) => { await p.fill('#q', q); await p.waitForTimeout(250); return texts(p, '.topic:not([hidden]) h3'); };
    assert.ok((await find('領収書がない')).some((t) => /なくした/.test(t)));
    assert.ok((await find('ガソリン')).some((t) => /早見表/.test(t)));
    assert.ok((await find('いんすとーる')).some((t) => /iPhone/.test(t)));
    assert.ok((await find('全銀')).some((t) => /振込データ/.test(t)));
    assert.deepEqual(await find('xyzzz'), []);
    assert.deepEqual(p.errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('まとめて承認: 結果を 1 つのファイルにし、社員はそれぞれ自分の分だけ取り込む', { timeout: 120000 }, async () => {
  const srv = await serve(); const browser = await launch();
  try {
    // 社員 2 人の端末で提出ファイルを作る（画面を使わずに）
    const emp = async (name) => {
      const p = await openPage(browser, `${srv.base}/keihi/pc/`);
      const sub = await p.evaluate(async (n) => {
        const st = await import('/keihi/js/store.js'); const sh = await import('/keihi/js/share.js');
        st.S.settings.name = n; st.saveSettings();
        const e = st.newExpense({ status: 'ok', auto: [], date: '2026-11-05', amount: n.length * 1000, payee: `店${n}`, category: '消耗品費', memo: '文房具' });
        await st.saveExpense(e);
        const rep = await st.createReport([e], { from: '2026-11-01', to: '2026-11-30', sum: { reimb: e.amount, company: 0, count: 1 } });
        return (await sh.makeSubmission(rep)).text();
      }, name);
      return { p, sub };
    };
    const A = await emp('山田 太郎'); const B = await emp('鈴木 花子さん');
    const G = await openPage(browser, `${srv.base}/keihi/pc/`);
    await G.keyboard.press('8');
    await G.evaluate(async (subs) => { const sh = await import('/keihi/js/share.js'); for (const s of subs) await sh.receiveSubmission(JSON.parse(s)); }, [A.sub, B.sub]);
    await G.reload(); await G.waitForSelector('#app'); await G.keyboard.press('8');
    await G.fill('#vp1', 'souko-2026'); await G.fill('#vp2', 'souko-2026'); await G.click('[data-act="vaultSetup"]'); await G.waitForSelector('.lock-chip');
    await G.waitForSelector('[data-act="apvBulkApprove"]');
    const d = await download(G, async () => { await G.click('[data-act="apvBulkApprove"]'); await G.click('.modal .btn.primary'); });
    const j = JSON.parse(fs.readFileSync(await d.path()));
    assert.equal(j.kind, 'decisions'); assert.equal(j.list.length, 2);
    assert.ok(!JSON.stringify(j).includes('山田') && !JSON.stringify(j).includes('鈴木')); // ほかの人の名前は入らない
    const jf = `${await d.path()}.json`; fs.copyFileSync(await d.path(), jf);
    await A.p.setInputFiles('#fileIn', jf); await A.p.waitForTimeout(400);
    const st = await A.p.evaluate(async () => (await import('/keihi/js/store.js')).S.reports.map((r) => r.approval.status));
    assert.deepEqual(st, ['approved']);
    assert.deepEqual([...A.p.errors, ...B.p.errors, ...G.errors], []);
  } finally { await browser.close(); srv.close(); }
});
