// 同期: 2 台のパソコン（同期フォルダ）と、スマホ・パソコン（Google ドライブ・テスト用の偽物）
import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openPage, fakeDrive, withFakeGoogle } from './lib.mjs';

// 同期フォルダの代わり（テストの中のメモリ）
function fakeFolder() {
  const files = new Map(); let clock = Date.now();
  const setup = async (ctx) => {
    await ctx.exposeFunction('__fsList', () => [...files.entries()].map(([n, f]) => [n, f.t]));
    await ctx.exposeFunction('__fsRead', (n) => (files.get(n) || {}).text || '');
    await ctx.exposeFunction('__fsWrite', (n, text) => { files.set(n, { text, t: ++clock }); });
    await ctx.exposeFunction('__fsDel', (n) => files.delete(n));
  };
  const attach = (page) => page.evaluate(async () => {
    const mk = (n, t) => ({ kind: 'file', name: n, getFile: async () => new File([await window.__fsRead(n)], n, { lastModified: t }), createWritable: async () => { const parts = []; return { write: async (b) => parts.push(b), close: async () => window.__fsWrite(n, await new Blob(parts).text()) }; } });
    const dir = { kind: 'directory', name: '共有', queryPermission: async () => 'granted', requestPermission: async () => 'granted', async *entries() { for (const [n, t] of await window.__fsList()) yield [n, mk(n, t)]; }, getFileHandle: async (n) => mk(n, 0), removeEntry: async (n) => window.__fsDel(n) };
    const sh = await import('/keihi/js/share.js'); sh.syncState.handle = dir; sh.syncState.permission = 'granted';
  });
  return { files, setup, attach };
}
const sync = (p) => p.evaluate(async () => (await import('/keihi/js/share.js')).syncNow());
const state = (p) => p.evaluate(async () => { const st = await import('/keihi/js/store.js'); const sh = await import('/keihi/js/share.js'); return { exp: st.S.expenses.map((e) => e.payee).sort(), led: st.S.ledger.map((l) => l.partner).sort(), name: st.S.settings.name, carRate: st.S.settings.carRate, apv: (await sh.listApprovals()).map((r) => `${r.sub.applicant.name}:${r.status}:${r.paid ? 'paid' : ''}`).sort(), rec: st.S.recurring.map((r) => r.paused ? 'paused' : 'on') }; });

test('同期フォルダ: 削除・設定・受け取り箱・自動登録、名前は混ざらない', { timeout: 180000 }, async () => {
  const srv = await serve(); const browser = await launch(); const F = fakeFolder();
  try {
    const A = await openPage(browser, `${srv.base}/keihi/pc/`, { setup: async (c) => { await F.setup(c); await c.addInitScript(() => localStorage.setItem('rakukeihi.device', 'pcA')); } });
    const B = await openPage(browser, `${srv.base}/keihi/pc/`, { setup: async (c) => { await F.setup(c); await c.addInitScript(() => localStorage.setItem('rakukeihi.device', 'pcB')); } });
    await F.attach(A); await F.attach(B);
    await A.evaluate(async () => {
      const st = await import('/keihi/js/store.js'); const sh = await import('/keihi/js/share.js');
      Object.assign(st.S.settings, { name: '山田 太郎', carRate: 15 }); st.saveSettings();
      await st.saveExpense(st.newExpense({ status: 'ok', auto: [], date: '2026-11-03', amount: 1000, payee: '消す経費', category: '雑費' }));
      await st.saveExpense(st.newExpense({ status: 'ok', auto: [], date: '2026-11-04', amount: 2000, payee: '残す経費', category: '雑費' }));
      await st.saveLedger({ type: 'income', date: '2026-11-05', amount: 50000, debit: '普通預金', credit: '売上高', partner: '消す売上' });
      st.addRecurring({ id: 'rcX', kind: 'income', label: '顧問料', day: 1, start: '2026-10', last: '', data: { amount: 55000, debit: '普通預金', credit: '売上高', partner: '顧問料' } });
      await sh.receiveSubmission({ app: 'rakukeihi', kind: 'submission', id: 'subX', reportId: 'r1', at: Date.now(), from: '2026-11-01', to: '2026-11-30', applicant: { name: '鈴木 花子' }, sum: { reimb: 100, company: 0, count: 1 }, items: [{ id: 'e1', date: '2026-11-03', amount: 100, payee: 'x' }], images: [] });
    });
    await B.evaluate(async () => { const st = await import('/keihi/js/store.js'); Object.assign(st.S.settings, { name: '鈴木 花子' }); st.saveSettings(); });
    assert.ok((await sync(A)).ok); assert.ok((await sync(B)).ok);
    let b = await state(B);
    assert.deepEqual(b.exp, ['残す経費', '消す経費']); assert.equal(b.name, '鈴木 花子'); assert.deepEqual(b.apv, ['鈴木 花子:pending:']);
    // 両方で自動登録しても同じ月は 1 件
    await A.evaluate(async () => (await import('/keihi/js/store.js')).runRecurring('2026-11-20'));
    await B.evaluate(async () => (await import('/keihi/js/store.js')).runRecurring('2026-11-20'));
    // B: 消す・単価を変える・承認して支払済み・自動登録を止める
    await B.evaluate(async () => {
      const st = await import('/keihi/js/store.js'); const sh = await import('/keihi/js/share.js');
      await st.removeExpenses([st.S.expenses.find((e) => e.payee === '消す経費').id]);
      await st.removeLedger(st.S.ledger.find((l) => l.partner === '消す売上').id);
      st.S.settings.carRate = 20; st.saveSettings();
      st.updateRecurring('rcX', { paused: true });
      const r = (await sh.listApprovals())[0]; await sh.decide(r, { status: 'approved' }); await sh.setPaid([r.id], { at: '2026-11-25', batch: 'b1' });
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok((await sync(B)).ok); assert.ok((await sync(A)).ok);
    const a = await state(A);
    assert.deepEqual(a.exp, ['残す経費']);
    assert.deepEqual(a.led, ['顧問料', '顧問料']); // 10 月・11 月の 2 件（重ならない）
    assert.equal(a.name, '山田 太郎'); // 自分の名前のまま
    assert.equal(a.carRate, 20); // 共通の設定は新しい方
    assert.deepEqual(a.apv, ['鈴木 花子:approved:paid']);
    assert.deepEqual(a.rec, ['paused']);
    assert.deepEqual([...A.errors, ...B.errors], []);
  } finally { await browser.close(); srv.close(); }
});

test('Google ドライブ: スマホで撮った経費（画像つき）がパソコンに出る・つなぎ直し', { timeout: 180000 }, async () => {
  const srv = await serve(); const browser = await launch(); const drive = fakeDrive();
  try {
    const P = await openPage(browser, `${srv.base}/keihi/`, { phone: true, ready: '.tabs', setup: async (c) => { await withFakeGoogle(drive)(c); await c.addInitScript(() => localStorage.setItem('rakukeihi.device', 'phone')); } });
    await P.evaluate(async () => {
      const st = await import('/keihi/js/store.js');
      const c = document.createElement('canvas'); c.width = 200; c.height = 260; c.getContext('2d').fillRect(10, 10, 50, 50);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      const id = 'img_test1'; const db = (await import('/keihi/js/db.js')).db; await db.put('images', { id, blob, thumb: blob, w: 200, h: 260 });
      await st.saveExpense(st.newExpense({ status: 'ok', auto: [], date: '2026-11-19', amount: 8800, payee: 'コメリ', category: '消耗品費', imageId: id }));
    });
    await P.click('.tabs [data-tab="settings"]'); await P.click('[data-act="driveConnect"]'); await P.waitForTimeout(2000);
    assert.match(await P.textContent('#drive'), /同期しています/);
    const C = await openPage(browser, `${srv.base}/keihi/pc/`, { setup: async (c) => { await withFakeGoogle(drive)(c); await c.addInitScript(() => localStorage.setItem('rakukeihi.device', 'pc')); } });
    await C.keyboard.press('0'); await C.click('#set-sync [data-act="driveConnect"]'); await C.waitForTimeout(2500);
    const got = await C.evaluate(async () => { const st = await import('/keihi/js/store.js'); const e = st.S.expenses[0]; return [e && e.payee, !!(e && await st.imageRecord(e.imageId))]; });
    assert.deepEqual(got, ['コメリ', true]);
    // つながりが切れたら「つなぎ直す」
    await C.evaluate(async () => { (await import('/keihi/js/share.js')).gd.drive.exp = 0; });
    const r = await C.evaluate(async () => (await import('/keihi/js/share.js')).syncNow());
    assert.equal(r.auth, true);
    await C.keyboard.press('1'); await C.waitForTimeout(300);
    assert.ok((await C.$$eval('.banner', (l) => l.map((b) => b.textContent))).some((t) => /つなぎ直/.test(t)));
    assert.deepEqual([...P.errors, ...C.errors], []);
  } finally { await browser.close(); srv.close(); }
});
