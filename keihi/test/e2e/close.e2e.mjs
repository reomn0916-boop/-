// 帳簿の締め: 締めた期間の記録は直せない・数字は固定・戻すと直せる（記録が残る）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve, launch, openPage, download } from './lib.mjs';

test('帳簿の締め', { timeout: 120000 }, async () => {
  const srv = await serve(); const browser = await launch();
  try {
    const p = await openPage(browser, `${srv.base}/keihi/pc/`);
    await p.evaluate(async () => {
      const st = await import('/keihi/js/store.js');
      Object.assign(st.S.settings, { name: '経理 一郎' }); st.saveSettings();
      for (const [d, a, n] of [['2026-10-05', 1000, '10月の経費'], ['2026-11-05', 2000, '11月の経費']]) await st.saveExpense(st.newExpense({ id: n, status: 'ok', auto: [], date: d, amount: a, payee: n, category: '消耗品費', method: '現金' }));
      await st.saveLedger({ id: 'inc10', type: 'income', date: '2026-10-20', amount: 50000, debit: '普通預金', credit: '売上高', partner: '10月の売上' });
    });
    await p.reload(); await p.waitForSelector('#app');
    const pl = () => p.evaluate(async () => { const st = await import('/keihi/js/store.js'); const b = await import('/keihi/js/books.js'); const j = b.journalsFrom({ expenses: st.S.expenses, ledger: st.S.ledger, reports: st.S.reports, settings: st.S.settings, closed: st.S.closed }); return b.buildStatements({ journals: j, settings: st.S.settings, from: '2026-10-01', to: '2026-10-31' }).pl.netIncome; });
    assert.equal(await pl(), 49000);
    // 10 月末で締める
    await p.keyboard.press('5'); await p.click('[data-btab="setup"]');
    await p.selectOption('#closeUntil', '2026-10-31');
    await p.click('[data-act="booksClose"]'); await p.click('.modal .btn.primary'); await p.waitForSelector('.closed-now');
    // 10 月の経費・売上は直せない・消せない・その日付で新しく入れられない
    const err = (fn) => p.evaluate(async (f) => { const st = await import('/keihi/js/store.js'); try { await (new Function('st', `return (async () => { ${f} })()`))(st); return 'saved'; } catch (e) { return e.name; } }, fn);
    assert.equal(await err("const e = { ...st.byId('10月の経費'), amount: 9999 }; await st.saveExpense(e);"), 'LockedError');
    assert.equal(await err("await st.removeExpenses(['10月の経費']);"), 'LockedError');
    assert.equal(await err("await st.removeLedger('inc10');"), 'LockedError');
    assert.equal(await err("await st.saveExpense(st.newExpense({ status: 'ok', auto: [], date: '2026-10-30', amount: 5, payee: 'x', category: '雑費' }));"), 'LockedError');
    assert.equal(await err("const e = { ...st.byId('11月の経費'), amount: 2500 }; await st.saveExpense(e);"), 'saved'); // 11 月は直せる
    assert.equal(await err("const e = { ...st.byId('10月の経費'), memo: 'メモだけ' }; await st.saveExpense(e);"), 'saved'); // 数字に関係ない欄は直せる
    // 経費の画面に「締めた期間」
    await p.keyboard.press('3'); await p.click('[data-act="periodMenu"]'); await p.click('.menu button:has-text("すべての期間")');
    await p.click('#tableWrap tr:has-text("10月の経費")'); await p.waitForTimeout(400);
    assert.match(await p.textContent('#drawer'), /締めた期間の経費/);
    await p.keyboard.press('Escape');
    // 設定を変えても、締めた期間の数字は変わらない
    await p.evaluate(async () => { const st = await import('/keihi/js/store.js'); st.S.settings.books = { ...(st.S.settings.books || {}), allocation: { 消耗品費: 50 } }; st.saveSettings(); });
    assert.equal(await pl(), 49000);
    // バックアップに入る
    const bk = await download(p, () => p.evaluate(async () => { const st = await import('/keihi/js/store.js'); const ui = await import('/keihi/pc/ui.js'); ui.download(await st.makeBackup({ images: false }), 'b.json'); }));
    assert.equal(JSON.parse(fs.readFileSync(await bk.path())).closed.until, '2026-10-31');
    // 戻す（理由がいる）→ 直せる。記録が残る
    await p.keyboard.press('5'); await p.click('[data-btab="setup"]');
    await p.click('[data-act="booksReopen"]'); await p.fill('#ptIn', '10月の請求の入れ忘れ'); await p.click('.modal [data-m="ok"]'); await p.waitForTimeout(400);
    assert.equal(await err("const e = { ...st.byId('10月の経費'), amount: 1100 }; await st.saveExpense(e);"), 'saved');
    assert.match(await p.textContent('.close-log'), /戻した：10月の請求の入れ忘れ/);
    const hist = await p.evaluate(async () => (await (await import('/keihi/js/store.js')).allHistory()).filter((h) => h.kind === 'soumu').map((h) => h.summary.payee));
    assert.ok(hist.some((h) => /締めた/.test(h)) && hist.some((h) => /戻した/.test(h)));
    assert.deepEqual(p.errors, []);
    void os; void path;
  } finally { await browser.close(); srv.close(); }
});
