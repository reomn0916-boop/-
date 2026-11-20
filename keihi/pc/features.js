// ラク経費 パソコン版: 追加の機能の画面（請求書・明細の取り込み・固定資産・外注と源泉・分析・承認・同期・電帳法など）
// pc.js の部品（画面の状態・描き直しなど）は init() で受け取る
import * as st from '../js/store.js';
import { newId } from '../js/db.js';
import { booksOf, accountGroups, accountType, REVENUE_ACCOUNTS } from '../js/books.js';
import { consumptionTax, TAX_METHODS, SIMPLE_RATES, siteReport, vehicleReport, payoutSummary, budgetStatus, yearCompare } from '../js/finance.js';
import { decodeBytes, parseStatement, suggestRows, ledgerFromRows } from '../js/bank.js';
import { invoiceTotals, nextInvoiceNo, overdueInvoices } from '../js/invoice.js';
import { depreciationSchedule, DEP_METHODS, LIFE_HINTS, withholding, SMALL_LIMIT, smallAssetTotal, rateOf } from '../js/assets.js';
import { encodeSJIS, toYayoi, toMF } from '../js/exports.js';
import { ruleJournal, aiJournal } from '../js/aijournal.js';
import * as sh from '../js/share.js';
import { renderInvoice, pagesToPdf, taxPage, bluePage, toPayoutCSV } from '../js/report.js';
import { $, $$, esc, ic, yen, md, ymd, jpYM, ago, toast, modal, confirmDialog, download } from './ui.js';
import { FIELD_LABEL } from './editor.js';

const { S } = st;
const X = {}; // pc.js から: P, render, go, allJournals, fyOf, shiftFY, fyLabel, booksRange, accountOptions, emptyState, editLedger, printPages
export function init(ctx) { Object.assign(X, ctx); if (!X.P.an) X.P.an = { tab: 'site', from: '', to: '', ym: st.todayISO().slice(0, 7) }; }

const today = () => st.todayISO();
const bk = () => booksOf(S.settings);
const saveBooks = (patch) => { S.settings.books = { ...(S.settings.books || {}), ...patch }; st.saveSettings(); X.P.fin.pages = null; };
const fmtN = (n) => (n ? Number(n).toLocaleString('ja-JP') : '');
const pct = (r) => (r == null || !Number.isFinite(r) ? '—' : `${Math.round(r * 100)}%`);
const signed = (n) => (n < 0 ? `△${yen(-n)}` : yen(n));
const opt = (list, cur) => list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
const select = (id, list, cur, icon = 'tag', attrs = '') => `<span class="select">${ic(icon)}<select ${id ? `id="${id}"` : ''} ${attrs}>${opt(list, cur)}</select>${ic('chevD', 'caret')}</span>`;
const pbar = (r, level = '') => `<span class="pbar ${level}"><i style="width:${Math.max(0, Math.min(100, Math.round((r || 0) * 100)))}%"></i></span>`;
const inR = (d, r) => d && d >= r.from && d <= r.to;
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_');
function pickFile(accept, multiple = false) {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = multiple; i.onchange = () => res([...i.files]); i.click(); });
}
const csvOut = (text, name, sjis = false) => { const t = String(text).replace(/^\ufeff/, ''); download(new Blob([sjis ? encodeSJIS(t) : `\ufeff${t}`], { type: 'text/csv' }), name); };
const partners = () => [...new Set(S.ledger.map((x) => x.partner).filter(Boolean))];
const sites = () => [...new Set([...S.expenses.map((e) => e.site), ...S.ledger.map((l) => l.site), ...Object.keys(S.settings.sites || {})].filter(Boolean))].sort();
const endOfNextMonth = (iso) => { const ym = st.addMonth(iso.slice(0, 7), 1); return st.monthEnd(ym); };
const amtIn = (id, v, ph = '0', cls = '') => `<span class="amt-in ${cls}"><em>¥</em><input id="${id}" inputmode="numeric" placeholder="${ph}" value="${fmtN(v)}"></span>`;
function moneyBlur(root) { root.addEventListener('change', (ev) => { const el = ev.target; if (el.inputMode === 'numeric' && !el.dataset.raw) { const n = st.num(el.value); el.value = n ? n.toLocaleString('ja-JP') : ''; } }); }
// モーダルの保存ボタン: 検証して、だめなら閉じない
function guard(el, values, check) {
  values.forEach((v) => { const b = $(`[data-m="${v}"]`, el); if (b) b.addEventListener('click', (ev) => { const err = check(v); if (err) { ev.stopPropagation(); const e = $('.form-err', el); e.textContent = err; e.hidden = false; } }, true); });
}

// ===========================================================================
// 帳簿のタブ
// ===========================================================================
export const BOOK_TABS = [['income', '売上・収入', 'arrowR'], ['invoice', '請求書', 'doc'], ['journal', '振替伝票', 'layers'], ['bank', '明細の取り込み', 'bank'], ['assets', '固定資産', 'box'], ['payout', '外注・源泉', 'pen'], ['book', '仕訳帳', 'list'], ['setup', '帳簿の設定', 'sliders']];
export const tabButton = (tab) => ({
  income: `<button class="btn primary" data-act="newIncome">${ic('plus')}売上・収入を入れる</button>`,
  invoice: `<button class="btn primary" data-act="invNew">${ic('plus')}請求書を作る</button>`,
  journal: `<button class="btn" data-act="textJournal">${ic('spark')}文章で入れる</button><button class="btn primary" data-act="newJournal">${ic('plus')}振替を入れる</button>`,
  assets: `<button class="btn primary" data-act="assetNew">${ic('plus')}固定資産を登録</button>`,
  payout: `<button class="btn" data-act="payoutCsv">${ic('download')}支払調書 CSV</button><button class="btn primary" data-act="payoutNew">${ic('plus')}外注費を払った</button>`,
}[tab] || '');

export function bookTab(tab, r) {
  if (tab === 'invoice') return invoiceTab(r);
  if (tab === 'bank') return bankTab(r);
  if (tab === 'assets') return assetsTab(r);
  if (tab === 'payout') return payoutTab(r);
  return '';
}

// ---- 請求書 -------------------------------------------------------------------
function invState(l, paid, t) {
  const p = paid.get(l.id);
  if (p) return ['done', `入金済み ${md(p.date)}`, 'checkCircle'];
  if (l.invoice.due && l.invoice.due < t) return ['over', `期日超過（${md(l.invoice.due)}）`, 'warn'];
  return ['draft', '入金待ち', 'clock'];
}
function invoiceTab(r) {
  const list = S.ledger.filter((l) => l.type === 'income' && l.invoice && inR(l.date, r)).sort((a, c) => (c.invoice.no || '').localeCompare(a.invoice.no || ''));
  const paid = new Map(S.ledger.filter((l) => l.ref).map((l) => [l.ref, l]));
  const t = today();
  const me = S.settings.issuer || {};
  const open = list.filter((l) => !paid.has(l.id));
  const over = open.filter((l) => l.invoice.due && l.invoice.due < t);
  return `
    ${!me.name ? `<div class="note">${ic('spark')}<span>請求書にのせる発行元（名前・住所・登録番号・振込先）は <button class="link sm" data-act="booksSetup">帳簿の設定</button> で入れられます。</span></div>` : ''}
    <div class="sumbar"><span>${list.length}件</span><span>請求額 <b>${yen(list.reduce((s, l) => s + l.amount, 0))}</b></span>${open.length ? `<span>入金待ち <b>${yen(open.reduce((s, l) => s + l.amount, 0))}</b>（${open.length}件）</span>` : ''}${over.length ? `<span class="warn-text">${ic('warn')}期日を過ぎた請求 ${over.length}件</span>` : ''}</div>
    <div class="table-wrap">${list.length ? `<table class="grid ledger">
      <thead><tr><th class="c-no">番号</th><th class="c-date">請求日</th><th>宛先・件名</th><th class="c-date">期日</th><th class="c-amt num">金額（税込）</th><th class="c-site">状態</th><th class="c-act2"></th></tr></thead>
      <tbody>${list.map((l) => { const [cls, label, icn] = invState(l, paid, t); return `<tr data-act="invEdit" data-id="${l.id}">
        <td class="c-no"><b>${esc(l.invoice.no || '')}</b></td>
        <td class="c-date"><b>${md(l.date)}</b></td>
        <td class="c-payee"><b>${esc(l.invoice.to || l.partner || '')} ${esc(l.invoice.toSuffix || '')}</b><small>${esc(l.invoice.subject || '')}${l.site ? ` ・ ${esc(l.site)}` : ''}</small></td>
        <td class="c-date">${l.invoice.due ? md(l.invoice.due) : '—'}</td>
        <td class="c-amt num"><b>${yen(l.amount)}</b></td>
        <td class="c-site"><span class="badge ${cls}">${ic(icn)}${label}</span></td>
        <td class="c-act2"><button class="icon-btn sm" data-act="invPdf" data-id="${l.id}" title="PDF">${ic('download')}</button>${paid.has(l.id) ? '' : `<button class="chip sm" data-paid="${l.id}">${ic('cash')}入金</button>`}</td>
      </tr>`; }).join('')}</tbody></table>`
      : X.emptyState('doc', 'この期の請求書はありません', '品目と金額を入れるだけで、インボイス（適格請求書）の形の請求書ができます。作った請求書は売上（売掛金）になり、入金を記録すると消し込まれます。', `<button class="btn primary" data-act="invNew">${ic('plus')}請求書を作る</button>`)}</div>`;
}

function invRowHTML(it, i) {
  return `<tr data-row="${i}">
    <td><input data-c="name" value="${esc(it.name || '')}" placeholder="例: 内装工事一式"></td>
    <td class="n"><input data-c="qty" inputmode="decimal" data-raw="1" value="${it.qty ?? ''}"></td>
    <td class="u"><input data-c="unit" value="${esc(it.unit || '')}" placeholder="式"></td>
    <td class="p"><input data-c="price" inputmode="numeric" value="${fmtN(it.price)}" placeholder="0"></td>
    <td class="r"><select data-c="rate">${opt([[10, '10%'], [8, '8%※'], [0, '対象外']], it.rate ?? 10)}</select></td>
    <td class="a num" data-amt>${it.price ? yen(Math.round((+it.qty || 0) * (+it.price || 0))) : ''}</td>
    <td class="x"><button type="button" class="icon-btn sm" data-delrow="${i}" title="この行を消す" tabindex="-1">${ic('x')}</button></td>
  </tr>`;
}
async function editInvoice(l0) {
  const t = today();
  const inv = l0 ? JSON.parse(JSON.stringify(l0.invoice)) : { no: nextInvoiceNo(S.ledger, new Date()), to: '', toSuffix: '御中', due: endOfNextMonth(t), subject: '', items: [{ name: '', qty: 1, unit: '式', price: '', rate: 10 }], note: '' };
  const cur = { date: l0 ? l0.date : t, site: l0 ? l0.site || '' : '', ...inv };
  const r = await modal({
    title: l0 ? `請求書 ${inv.no} を直す` : '請求書を作る', width: 860,
    body: `<div class="inv-form">
      <datalist id="dlInvTo">${partners().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="row4">
        <label class="fld span2"><span class="lb">宛先</span><input id="iTo" list="dlInvTo" value="${esc(cur.to)}" placeholder="例: ○○工務店" autofocus></label>
        <label class="fld"><span class="lb">敬称</span>${select('iSuf', ['御中', '様', '殿'], cur.toSuffix, 'pen')}</label>
        <label class="fld"><span class="lb">請求番号</span><input id="iNo" value="${esc(cur.no)}"></label>
      </div>
      <div class="row4">
        <label class="fld"><span class="lb">請求日</span><input type="date" id="iDate" value="${esc(cur.date)}"></label>
        <label class="fld"><span class="lb">お支払期限</span><input type="date" id="iDue" value="${esc(cur.due)}"></label>
        <label class="fld span2"><span class="lb">現場・案件</span><input id="iSite" list="dlSite" value="${esc(cur.site)}" placeholder="現場別の損益に入ります"></label>
      </div>
      <label class="fld"><span class="lb">件名</span><input id="iSubj" value="${esc(cur.subject)}" placeholder="例: 11月分 A邸 内装工事"></label>
      <table class="inv-items"><thead><tr><th>品目</th><th class="n">数量</th><th class="u">単位</th><th class="p">単価（税抜）</th><th class="r">税率</th><th class="a num">金額</th><th class="x"></th></tr></thead><tbody id="iRows"></tbody></table>
      <button type="button" class="link sm" id="iAdd">${ic('plus')}行を足す</button>
      <div class="inv-bottom">
        <label class="fld"><span class="lb">備考</span><textarea id="iNote" rows="3" placeholder="例: 恐れ入りますが振込手数料はご負担ください">${esc(cur.note)}</textarea></label>
        <div class="inv-tot" id="iTot"></div>
      </div>
      <p class="form-err" hidden></p>
    </div>`,
    actions: [...(l0 ? [{ label: '削除', value: 'del', kind: 'ghost danger' }] : []), { label: 'やめる', value: 'no' }, { label: '保存', value: 'ok' }, { label: '保存して PDF', value: 'pdf', kind: 'primary', icon: 'download' }],
    onMount: (el) => {
      const rows = $('#iRows', el);
      const draw = () => { rows.innerHTML = cur.items.map(invRowHTML).join(''); tot(); };
      const tot = () => {
        const T = invoiceTotals(cur.items);
        $('#iTot', el).innerHTML = `<div><span>小計（税抜）</span><b>${yen(T.subtotal)}</b></div>
          ${T.base10 ? `<div class="s"><span>10%対象 ${yen(T.base10)}</span><span>消費税 ${yen(T.tax10)}</span></div>` : ''}
          ${T.base8 ? `<div class="s"><span>8%対象 ${yen(T.base8)}</span><span>消費税 ${yen(T.tax8)}</span></div>` : ''}
          ${T.base0 ? `<div class="s"><span>対象外 ${yen(T.base0)}</span><span></span></div>` : ''}
          <div class="g"><span>ご請求金額</span><b>${yen(T.total)}</b></div>`;
      };
      const read = () => {
        cur.to = $('#iTo', el).value.trim(); cur.toSuffix = $('#iSuf', el).value; cur.no = $('#iNo', el).value.trim();
        cur.date = $('#iDate', el).value; cur.due = $('#iDue', el).value; cur.site = $('#iSite', el).value.trim();
        cur.subject = $('#iSubj', el).value.trim(); cur.note = $('#iNote', el).value;
      };
      rows.addEventListener('input', (ev) => {
        const tr = ev.target.closest('[data-row]'); if (!tr) return;
        const it = cur.items[+tr.dataset.row]; const k = ev.target.dataset.c;
        it[k] = k === 'price' ? st.num(ev.target.value) : k === 'qty' ? st.dec(ev.target.value) : k === 'rate' ? +ev.target.value : ev.target.value;
        $('[data-amt]', tr).textContent = it.price ? yen(Math.round((+it.qty || 0) * (+it.price || 0))) : '';
        tot();
      });
      rows.addEventListener('change', (ev) => { if (ev.target.dataset.c === 'price') { const n = st.num(ev.target.value); ev.target.value = n ? n.toLocaleString('ja-JP') : ''; } if (ev.target.dataset.c === 'rate') { const tr = ev.target.closest('[data-row]'); cur.items[+tr.dataset.row].rate = +ev.target.value; tot(); } });
      rows.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.closest('tr') === rows.lastElementChild) { ev.preventDefault(); cur.items.push({ name: '', qty: 1, unit: '', price: '', rate: 10 }); draw(); $$('tr', rows).pop().querySelector('input').focus(); } });
      el.addEventListener('click', (ev) => {
        const d = ev.target.closest('[data-delrow]'); if (d) { cur.items.splice(+d.dataset.delrow, 1); if (!cur.items.length) cur.items.push({ name: '', qty: 1, unit: '', price: '', rate: 10 }); draw(); }
        if (ev.target.closest('#iAdd')) { cur.items.push({ name: '', qty: 1, unit: '', price: '', rate: 10 }); draw(); $$('tr', rows).pop().querySelector('input').focus(); }
      });
      guard(el, ['ok', 'pdf'], () => { read(); const T = invoiceTotals(cur.items); return !cur.to ? '宛先を入れてください' : !cur.date ? '請求日を入れてください' : T.total <= 0 ? '品目と金額を入れてください' : ''; });
      draw();
    },
  });
  if (r === 'del') { if (await confirmDialog(`請求書 ${inv.no} を消しますか？（売上からも消えます）`, '消す', { danger: true })) { await st.removeLedger(l0.id); toast('請求書を消しました'); } return; }
  if (r !== 'ok' && r !== 'pdf') return;
  const totals = invoiceTotals(cur.items);
  const items = totals.lines.map(({ name, qty, unit, price, rate }) => ({ name, qty, unit, price, rate }));
  const l = { ...(l0 || {}), type: 'income', date: cur.date, amount: totals.total, debit: l0 ? l0.debit : '売掛金', credit: l0 ? l0.credit : '売上高', partner: cur.to, memo: cur.subject || `請求書 ${cur.no}`, site: cur.site,
    invoice: { no: cur.no, to: cur.to, toSuffix: cur.toSuffix, due: cur.due, subject: cur.subject, items, note: cur.note, totals } };
  await st.saveLedger(l);
  toast(`請求書 ${cur.no} を保存しました ${yen(totals.total)}（売上に入りました）`, { kind: 'ok' });
  if (r === 'pdf') await invoicePdf(l);
}
async function invoicePdf(l) {
  const c = renderInvoice({ ...l.invoice, date: l.date }, l.invoice.totals || invoiceTotals(l.invoice.items), S.settings.issuer || {});
  const name = `請求書_${l.invoice.no}_${safe(l.invoice.to)}`;
  download(await pagesToPdf([c], name), `${name}.pdf`);
}

// ---- 銀行・カードの明細 ------------------------------------------------------------
function bankTab(r) {
  const list = S.ledger.filter((l) => l.src === 'bank' && inR(l.date, r)).sort((a, c) => c.date.localeCompare(a.date));
  return `<div class="bank-head card">
      <div class="bh-ic">${ic('bank')}</div>
      <div><h3>銀行・クレジットカードの明細（CSV）を取り込む</h3>
        <p class="muted">ネットバンキング・カード会社のサイトからダウンロードした CSV を選ぶか、この画面にドラッグします。経費・売上・入金・振替に自動で振り分け、レシートで登録済みのものや、前に取り込んだ行は飛ばします。</p></div>
      <button class="btn primary" data-act="bankPick">${ic('upload')}CSV を選ぶ</button>
    </div>
    <div class="sumbar"><span>この期に明細から入れた記録 ${list.length}件</span></div>
    <div class="table-wrap">${list.length ? `<table class="grid ledger">
      <thead><tr><th class="c-date">日付</th><th>摘要</th><th>借方</th><th>貸方</th><th class="c-amt num">金額</th><th class="c-act"></th></tr></thead>
      <tbody>${list.map((l) => `<tr data-led="${l.id}">
        <td class="c-date"><b>${md(l.date)}</b></td><td class="c-payee"><b>${esc(l.memo || l.partner || '')}</b></td>
        <td><span class="tag">${esc(l.debit)}</span></td><td><span class="tag">${esc(l.credit)}</span></td>
        <td class="c-amt num"><b>${yen(l.amount)}</b></td>
        <td class="c-act"><button class="icon-btn sm" data-led-del="${l.id}" title="削除">${ic('trash')}</button></td></tr>`).join('')}</tbody></table>` : ''}</div>`;
}
const ACTION_LABEL = { expense: '経費', transfer: '振替', income: '売上・収入', paid: '請求の入金', refund: '返金・返品', skip: '取り込まない' };
export async function bankImportFile(file) {
  let rows;
  try { rows = parseStatement(decodeBytes(new Uint8Array(await file.arrayBuffer()))); } catch (e) { toast(`読み込めませんでした: ${e.message || e}`, { kind: 'error' }); return; }
  if (!rows.length) { toast('明細の行が見つかりませんでした（日付と金額の列がある CSV を選んでください）', { kind: 'error', ms: 7000 }); return; }
  const guessCard = /カード|card|ご利用/i.test(file.name) || rows.every((x) => !x.in);
  let kind = guessCard ? 'card' : 'bank';
  let acc = '普通預金';
  let sug = suggestRows(rows, { kind, expenses: S.expenses, ledger: S.ledger, learned: S.learned, categories: st.cats() });
  const accounts = (a) => {
    if (a === 'expense' || a === 'refund') return accountGroups(bk().mode, st.cats()).filter(([g]) => /費用|経費/.test(g)).flatMap(([, l]) => l);
    if (a === 'income') return [...REVENUE_ACCOUNTS, ...(bk().mode === 'sole' ? ['事業主借'] : []), '借入金', '前受金'];
    return accountGroups(bk().mode, st.cats()).filter(([g]) => !/費用|経費|収益/.test(g)).flatMap(([, l]) => l);
  };
  const rowHTML = (x, i) => `<tr data-i="${i}" class="${x.include ? '' : 'off'}">
    <td class="c-check"><input type="checkbox" data-inc ${x.include ? 'checked' : ''}></td>
    <td class="c-date">${md(x.date)}</td>
    <td class="desc"><b>${esc(x.desc)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ''}</td>
    <td class="num">${x.out ? yen(x.out) : ''}</td><td class="num in">${x.in ? yen(x.in) : ''}</td>
    <td><select data-a>${opt((x.out ? ['expense', 'transfer'] : kind === 'card' ? ['refund'] : ['income', ...(x.ref ? ['paid'] : [])]).concat('skip').map((k) => [k, ACTION_LABEL[k]]), x.action)}</select></td>
    <td>${x.action === 'skip' || x.action === 'paid' ? `<span class="muted">${x.action === 'paid' ? '売掛金' : ''}</span>` : `<select data-acc>${opt([...new Set([x.account, ...accounts(x.action)])].filter(Boolean), x.account)}</select>`}</td>
  </tr>`;
  const r = await modal({
    title: `明細を取り込む（${esc(file.name)}）`, width: 1040,
    body: `<div class="bank-prev">
      <div class="row-inline"><label class="fld inline"><span class="lb">明細の種類</span>${select('bKind', [['bank', '銀行口座'], ['card', 'クレジットカード']], kind, 'card')}</label>
        <label class="fld inline" id="bAccWrap" ${kind === 'card' ? 'hidden' : ''}><span class="lb">口座の科目</span>${select('bAcc', ['普通預金', '現金'], acc, 'bank')}</label>
        <span class="grow"></span><span class="muted" id="bSum"></span></div>
      <div class="table-wrap modal-table"><table class="grid bank-table"><thead><tr><th class="c-check"></th><th class="c-date">日付</th><th>摘要</th><th class="num">出金</th><th class="num">入金</th><th>扱い</th><th>科目</th></tr></thead><tbody id="bRows"></tbody></table></div>
      <p class="hint">${ic('spark')}カードの明細は「借方 科目 ／ 貸方 未払金」、口座からのカード引き落としは「未払金 ／ 普通預金」の振替になります。</p>
    </div>`,
    actions: [{ label: 'やめる', value: 'no' }, { label: '取り込む', value: 'ok', kind: 'primary', icon: 'check' }],
    onMount: (el) => {
      const body = $('#bRows', el);
      const draw = () => {
        body.innerHTML = sug.map(rowHTML).join('');
        const n = sug.filter((x) => x.include && x.action !== 'skip');
        $('#bSum', el).textContent = `${sug.length}行のうち ${n.length}行を取り込みます（出金 ${yen(n.reduce((s, x) => s + x.out, 0))} ・ 入金 ${yen(n.reduce((s, x) => s + x.in, 0))}）`;
      };
      el.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.id === 'bKind') { kind = t.value; $('#bAccWrap', el).hidden = kind === 'card'; sug = suggestRows(rows, { kind, expenses: S.expenses, ledger: S.ledger, learned: S.learned, categories: st.cats() }); draw(); return; }
        if (t.id === 'bAcc') { acc = t.value; return; }
        const tr = t.closest('[data-i]'); if (!tr) return;
        const x = sug[+tr.dataset.i];
        if (t.matches('[data-inc]')) { x.include = t.checked; if (x.include && x.action === 'skip') x.action = x.out ? 'expense' : kind === 'card' ? 'refund' : 'income'; }
        if (t.matches('[data-a]')) { x.action = t.value; x.include = t.value !== 'skip'; if (!accounts(x.action).includes(x.account)) x.account = x.action === 'expense' || x.action === 'refund' ? '雑費' : x.action === 'income' ? '売上高' : x.action === 'transfer' ? (bk().mode === 'sole' ? '事業主貸' : '未払金') : ''; }
        if (t.matches('[data-acc]')) x.account = t.value;
        draw();
      });
      draw();
    },
  });
  if (r !== 'ok') return;
  const list = ledgerFromRows(sug, { kind, account: acc });
  for (const l of list) await st.saveLedger(l);
  toast(list.length ? `明細から ${list.length}件を帳簿に入れました` : '取り込む行はありませんでした', { kind: 'ok' });
  if (X.P.view !== 'books' || X.P.books.tab !== 'bank') { X.P.books.tab = 'bank'; X.go('books'); }
}

// ---- 固定資産 ------------------------------------------------------------------
function assetsTab(r) {
  const b = bk(); const list = b.fixedAssets || [];
  const sole = b.mode === 'sole';
  const rows = list.map((a) => {
    const sch = depreciationSchedule(a, { closeMonth: b.closeMonth });
    const c = sch.find((x) => inR(x.fyEnd, r));
    const last = [...sch].reverse().find((x) => x.fyEnd <= r.to);
    return { a, c, book: last ? last.bookClose : (a.acquired <= r.to ? a.cost : null) };
  });
  const total = rows.reduce((s, x) => s + (x.c ? x.c.amount : 0), 0);
  const small = smallAssetTotal(list, r);
  return `
    ${small > SMALL_LIMIT ? `<div class="note warn">${ic('warn')}<span>この期に「少額減価償却資産」で一度に経費にした合計が ${yen(small)} です。特例は 1 年 300万円までなので、こえた分は定額法・定率法などに直してください。</span></div>` : ''}
    <div class="sumbar"><span>${list.length}件</span><span>今期の減価償却費 <b>${yen(total)}</b></span>${small ? `<span>少額の特例 ${yen(small)} / 300万円</span>` : ''}<span class="muted">期末に「減価償却費 ／ 資産」の仕訳を自動で作ります${sole ? '（事業で使う割合を超える分は事業主貸）' : ''}</span></div>
    <div class="table-wrap">${list.length ? `<table class="grid ledger">
      <thead><tr><th>資産</th><th class="c-date">取得日</th><th class="c-amt num">取得価額</th><th>償却の方法</th>${sole ? '<th class="num">事業割合</th>' : ''}<th class="c-amt num">今期の償却</th><th class="c-amt num">期末の残り</th><th class="c-act"></th></tr></thead>
      <tbody>${rows.map(({ a, c, book }) => `<tr data-act="assetEdit" data-id="${a.id}">
        <td class="c-payee"><b>${esc(a.name || '（名前なし）')}</b><small>${esc(a.account || '工具器具備品')}</small></td>
        <td class="c-date"><b>${md(a.acquired)}</b><small>${a.acquired.slice(0, 4)}</small></td>
        <td class="c-amt num">${yen(a.cost)}</td>
        <td>${a.method === 'small' ? '少額（一度に経費）' : a.method === 'lump3' ? '一括償却（3年）' : `${a.method === 'declining' ? '定率法' : '定額法'} ${a.life}年（${rateOf(a)}）`}</td>
        ${sole ? `<td class="num">${a.ratio == null ? 100 : a.ratio}%</td>` : ''}
        <td class="c-amt num"><b>${c ? yen(c.amount) : '—'}</b>${c && c.months < 12 ? `<small>${c.months}か月分</small>` : ''}</td>
        <td class="c-amt num">${book == null ? '—' : yen(book)}</td>
        <td class="c-act"><button class="icon-btn sm" data-act="assetDel" data-id="${a.id}" title="削除">${ic('trash')}</button></td>
      </tr>`).join('')}</tbody></table>`
      : X.emptyState('box', '固定資産はまだありません', '10万円以上の車・機械・パソコンなどは、買った年に全部を経費にせず、耐用年数に分けて「減価償却費」にします。登録しておくと、毎期の償却を自動で計算して決算書に入れます。', `<button class="btn primary" data-act="assetNew">${ic('plus')}固定資産を登録</button>`)}</div>`;
}
async function editAsset(a0) {
  const b = bk(); const sole = b.mode === 'sole';
  const a = a0 ? { ...a0 } : { id: newId('fa'), name: '', account: '工具器具備品', acquired: today(), cost: null, method: b.mode === 'corp' ? 'declining' : 'straight', life: 5, ratio: 100, paidFrom: '普通預金' };
  const payFrom = [['', '支払の仕訳を作らない（期首残高に入れた）'], ['普通預金', '普通預金から払った'], ['現金', '現金で払った'], ['未払金', 'カード・後払い（未払金）'], ['借入金', 'ローン（借入金）'], ...(sole ? [['事業主借', '個人のお金で払った（事業主借）']] : [])];
  const r = await modal({
    title: a0 ? '固定資産を直す' : '固定資産を登録する', width: 680,
    body: `<div class="asset-form">
      <div class="row2"><label class="fld"><span class="lb">名前</span><input id="aName" value="${esc(a.name)}" placeholder="例: 軽トラック（ハイゼット）" autofocus></label>
        <label class="fld"><span class="lb">科目</span>${select('aAcc', ['車両運搬具', '工具器具備品'], a.account, 'box')}</label></div>
      <div class="row3"><label class="fld"><span class="lb">取得日（使い始めた日）</span><input type="date" id="aDate" value="${esc(a.acquired)}"></label>
        <label class="fld"><span class="lb">取得価額（税込）</span>${amtIn('aCost', a.cost)}</label>
        <label class="fld"><span class="lb">支払</span>${select('aPay', payFrom, a.paidFrom || '', 'card')}</label></div>
      <div class="row3"><label class="fld"><span class="lb">償却の方法</span>${select('aMethod', Object.entries(DEP_METHODS), a.method, 'layers')}</label>
        <label class="fld" id="aLifeW"><span class="lb">耐用年数</span><span class="amt-in sm"><input id="aLife" inputmode="numeric" data-raw="1" value="${a.life || ''}"><em>年</em></span></label>
        ${sole ? `<label class="fld"><span class="lb">事業で使う割合</span><span class="amt-in sm"><input id="aRatio" inputmode="numeric" data-raw="1" value="${a.ratio == null ? 100 : a.ratio}"><em>%</em></span></label>` : '<span></span>'}</div>
      <div class="chips" id="aHints">${LIFE_HINTS.map(([n, y]) => `<button type="button" class="chip sm" data-life="${y}">${esc(n)} ${y}年</button>`).join('')}</div>
      <div class="note" id="aNote" hidden></div>
      <div id="aSched"></div>
      <p class="form-err" hidden></p></div>`,
    actions: [...(a0 ? [{ label: '削除', value: 'del', kind: 'ghost danger' }] : []), { label: 'やめる', value: 'no' }, { label: '保存', value: 'ok', kind: 'primary' }],
    onMount: (el) => {
      const read = () => {
        a.name = $('#aName', el).value.trim(); a.account = $('#aAcc', el).value; a.acquired = $('#aDate', el).value; a.cost = st.num($('#aCost', el).value);
        a.paidFrom = $('#aPay', el).value; a.method = $('#aMethod', el).value; a.life = st.num($('#aLife', el).value) || 1; if ($('#aRatio', el)) a.ratio = Math.min(100, st.num($('#aRatio', el).value) ?? 100);
      };
      const upd = () => {
        read();
        const lifeUsed = a.method === 'straight' || a.method === 'declining';
        $('#aLifeW', el).hidden = !lifeUsed; $('#aHints', el).hidden = !lifeUsed;
        const n = $('#aNote', el); let msg = '';
        const fy = X.fyOf(a.acquired || today()); const smallSum = smallAssetTotal(bk().fixedAssets || [], fy, a.id) + (a.method === 'small' ? a.cost || 0 : 0);
        if (a.cost && a.cost < 100000) msg = '10万円未満の物は固定資産にしなくても、買った年の「消耗品費」にできます。';
        else if (a.method === 'small' && a.cost >= 300000) msg = '少額減価償却資産の特例は 30万円未満の物だけです（青色申告の個人・中小企業者）。';
        else if (a.method === 'small' && smallSum > SMALL_LIMIT) msg = `少額減価償却資産の特例は 1 年に 300万円までです。この期の合計が ${yen(smallSum)} になります。`;
        else if (a.method === 'declining' && b.mode === 'sole') msg = '個人事業主の車・機械などは、届出をしていなければ定額法です（定率法は「減価償却資産の償却方法の届出書」が必要）。';
        else if (a.method === 'straight' && b.mode === 'corp' && a.account !== '建物') msg = '法人の車・機械・器具は、届出をしていなければ定率法です。';
        else if (a.method === 'declining' && +a.life > 20) msg = '定率法の表は耐用年数 20 年までです。';
        else if (a.method === 'lump3' && a.cost >= 200000) msg = '一括償却資産は 20万円未満の物だけです。';
        n.hidden = !msg; n.innerHTML = `${ic('spark')}<span>${msg}</span>`;
        const sch = a.cost && a.acquired ? depreciationSchedule(a, { closeMonth: b.closeMonth }) : [];
        $('#aSched', el).innerHTML = sch.length ? `<table class="mini-table sched"><thead><tr><th>期末</th><th class="num">月数</th><th class="num">償却費</th><th class="num">期末の残り</th></tr></thead><tbody>${sch.slice(0, 12).map((x) => `<tr><td>${ymd(x.fyEnd)}</td><td class="num">${x.months}</td><td class="num">${yen(x.amount)}</td><td class="num">${yen(x.bookClose)}</td></tr>`).join('')}</tbody></table>${sch.length > 12 ? `<p class="muted small">ほか ${sch.length - 12}期</p>` : ''}` : '';
      };
      el.addEventListener('input', upd); el.addEventListener('change', upd); moneyBlur(el);
      el.addEventListener('click', (ev) => { const l = ev.target.closest('[data-life]'); if (l) { $('#aLife', el).value = l.dataset.life; if (!$('#aName', el).value) $('#aName', el).value = l.textContent.replace(/ \d+年$/, ''); upd(); } });
      guard(el, ['ok'], () => { read(); const fy = X.fyOf(a.acquired || today()); return !a.name ? '名前を入れてください' : !a.acquired ? '取得日を入れてください' : !a.cost ? '取得価額を入れてください' : a.method === 'small' && a.cost >= 300000 ? '少額減価償却資産の特例は 30万円未満の物だけです' : a.method === 'small' && smallAssetTotal(bk().fixedAssets || [], fy, a.id) + a.cost > SMALL_LIMIT ? '少額減価償却資産の特例は 1 年 300万円までです。ほかの方法を選んでください' : ''; });
      upd();
    },
  });
  const list = [...(bk().fixedAssets || [])];
  if (r === 'del') { saveBooks({ fixedAssets: list.filter((x) => x.id !== a.id) }); X.render(); toast('固定資産を消しました'); return; }
  if (r !== 'ok') return;
  const i = list.findIndex((x) => x.id === a.id); if (i >= 0) list[i] = a; else list.push(a);
  saveBooks({ fixedAssets: list });
  X.render();
  toast(`${a.name} を保存しました`, { kind: 'ok' });
}

// ---- 外注費と源泉徴収 -------------------------------------------------------------
function payoutTab(r) {
  const list = S.ledger.filter((l) => l.type === 'payout' && inR(l.date, r)).sort((a, c) => c.date.localeCompare(a.date));
  const s = list.reduce((o, l) => ({ g: o.g + (l.gross || 0), w: o.w + (l.wh || 0) }), { g: 0, w: 0 });
  return `
    <div class="sumbar"><span>${list.length}件</span><span>支払金額 <b>${yen(s.g)}</b></span><span>源泉徴収 <b>${yen(s.w)}</b></span><span>差引支払 <b>${yen(s.g - s.w)}</b></span>${s.w ? '<span class="muted">預かった源泉所得税は、翌月10日（納期の特例なら半年ごと）までに納めます</span>' : ''}</div>
    <div class="table-wrap">${list.length ? `<table class="grid ledger">
      <thead><tr><th class="c-date">日付</th><th>外注先・内容</th><th class="c-site">現場</th><th class="c-amt num">支払金額</th><th class="c-amt num">源泉</th><th class="c-amt num">差引支払額</th><th class="c-act"></th></tr></thead>
      <tbody>${list.map((l) => `<tr data-act="payoutEdit" data-id="${l.id}">
        <td class="c-date"><b>${md(l.date)}</b></td>
        <td class="c-payee"><b>${esc(l.partner || '')}</b><small>${esc(l.memo || '')}</small></td>
        <td class="c-site">${esc(l.site || '')}</td>
        <td class="c-amt num">${yen(l.gross)}</td><td class="c-amt num">${l.wh ? yen(l.wh) : '—'}</td><td class="c-amt num"><b>${yen((l.gross || 0) - (l.wh || 0))}</b></td>
        <td class="c-act"><button class="icon-btn sm" data-led-del="${l.id}" title="削除">${ic('trash')}</button></td></tr>`).join('')}</tbody></table>`
      : X.emptyState('pen', 'この期の外注費の支払いはありません', '一人親方・個人の外注先に払った工事代・報酬を入れます。源泉徴収が必要な支払いは 10.21%（100万円を超える部分は 20.42%）を自動で計算し、「外注費 ／ 普通預金・預り金」の仕訳を作ります。', `<button class="btn primary" data-act="payoutNew">${ic('plus')}外注費を払った</button>`)}</div>`;
}
async function editPayout(l0) {
  const prevOf = (p) => [...S.ledger].reverse().find((x) => x.type === 'payout' && x.partner === p);
  const l = l0 ? { ...l0 } : { type: 'payout', date: today(), partner: '', address: '', memo: '', site: '', gross: null, wh: 0, whOn: false, payFrom: '普通預金', debit: '外注費', invoiceNo: '' };
  if (l.whOn == null) l.whOn = !!l.wh;
  const r = await modal({
    title: l0 ? '外注費の支払いを直す' : '外注費を払った', width: 620,
    body: `<div class="pay-form">
      <datalist id="dlPay">${[...new Set(S.ledger.filter((x) => x.type === 'payout').map((x) => x.partner).filter(Boolean))].map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="row2"><label class="fld"><span class="lb">支払日</span><input type="date" id="pDate" value="${esc(l.date)}"></label>
        <label class="fld"><span class="lb">外注先</span><input id="pPartner" list="dlPay" value="${esc(l.partner)}" placeholder="例: 鈴木 一郎（鈴木塗装）" autofocus></label></div>
      <label class="fld"><span class="lb">住所（支払調書に使います）</span><input id="pAddr" value="${esc(l.address || '')}" placeholder="例: 東京都○○区…"></label>
      <div class="row2"><label class="fld"><span class="lb">内容</span><input id="pMemo" value="${esc(l.memo || '')}" placeholder="例: A邸 外壁塗装"></label>
        <label class="fld"><span class="lb">現場・案件</span><input id="pSite" list="dlSite" value="${esc(l.site || '')}"></label></div>
      <div class="row3"><label class="fld"><span class="lb">支払金額（税込・源泉を引く前）</span>${amtIn('pGross', l.gross)}</label>
        <label class="fld"><span class="lb"><label class="chk inline"><input type="checkbox" id="pWhOn" ${l.whOn ? 'checked' : ''}>源泉徴収する</label></span>${amtIn('pWh', l.wh, '0', 'sm')}</label>
        <label class="fld"><span class="lb">払った口座</span>${select('pFrom', ['普通預金', '現金', '未払金'], l.payFrom, 'card')}</label></div>
      <div class="pay-net" id="pNet"></div>
      <div class="row2"><label class="fld"><span class="lb">科目</span>${select('pDebit', ['外注費', '支払手数料', '雑費'], l.debit, 'tag')}</label>
        <label class="fld"><span class="lb">登録番号（あれば）</span><span class="amt-in sm"><em>T</em><input id="pInv" inputmode="numeric" data-raw="1" maxlength="13" value="${esc((l.invoiceNo || '').replace(/^T/, ''))}"></span></label></div>
      <p class="hint">${ic('spark')}源泉徴収が必要なのは、個人への「原稿料・デザイン料・講演料・弁護士や税理士の報酬」など。大工・左官などの工事代は、ふつう源泉徴収の対象外です。</p>
      <p class="form-err" hidden></p></div>`,
    actions: [...(l0 ? [{ label: '削除', value: 'del', kind: 'ghost danger' }] : []), { label: 'やめる', value: 'no' }, { label: '保存', value: 'ok', kind: 'primary' }],
    onMount: (el) => {
      let whTouched = !!l0;
      const read = () => {
        l.date = $('#pDate', el).value; l.partner = $('#pPartner', el).value.trim(); l.address = $('#pAddr', el).value.trim(); l.memo = $('#pMemo', el).value.trim(); l.site = $('#pSite', el).value.trim();
        l.gross = st.num($('#pGross', el).value); l.whOn = $('#pWhOn', el).checked; l.wh = l.whOn ? (st.num($('#pWh', el).value) || 0) : 0;
        l.payFrom = $('#pFrom', el).value; l.debit = $('#pDebit', el).value; const d = $('#pInv', el).value.replace(/\D/g, ''); l.invoiceNo = d ? `T${d}` : '';
      };
      const upd = (ev) => {
        if (ev && ev.target.id === 'pWh') whTouched = true;
        if (ev && ev.target.id === 'pPartner' && !l0) { const p = prevOf(ev.target.value.trim()); if (p) { $('#pWhOn', el).checked = !!p.wh; if (!$('#pAddr', el).value) $('#pAddr', el).value = p.address || ''; if (!$('#pInv', el).value) $('#pInv', el).value = (p.invoiceNo || '').replace(/^T/, ''); } }
        const g = st.num($('#pGross', el).value) || 0; const on = $('#pWhOn', el).checked;
        $('#pWh', el).disabled = !on;
        if (on && (!whTouched || (ev && (ev.target.id === 'pGross' || ev.target.id === 'pWhOn')))) { const w = withholding(g); $('#pWh', el).value = w ? w.toLocaleString('ja-JP') : ''; whTouched = false; }
        if (!on) $('#pWh', el).value = '';
        const w = on ? (st.num($('#pWh', el).value) || 0) : 0;
        $('#pNet', el).innerHTML = g ? `<span>振り込む額（差引支払額）</span><b>${yen(g - w)}</b>${w ? `<small>源泉所得税 ${yen(w)} は「預り金」にします</small>` : ''}` : '';
      };
      el.addEventListener('input', upd); el.addEventListener('change', upd); moneyBlur(el);
      guard(el, ['ok'], () => { read(); return !l.date ? '支払日を入れてください' : !l.partner ? '外注先を入れてください' : !l.gross ? '支払金額を入れてください' : l.wh >= l.gross ? '源泉が支払金額より大きくなっています' : ''; });
      upd();
    },
  });
  if (r === 'del') { await st.removeLedger(l0.id); toast('削除しました'); return; }
  if (r !== 'ok') return;
  await st.saveLedger(l);
  toast(`外注費を保存しました ${l.partner} ${yen(l.gross)}${l.wh ? `（源泉 ${yen(l.wh)}）` : ''}`, { kind: 'ok' });
}

// ---- 文章で仕訳（ルール・AI） --------------------------------------------------------
async function textJournal() {
  const ai = S.settings.ocrMode === 'ai' && S.settings.apiKey;
  let text = '';
  const r = await modal({
    title: '文章で振替を入れる', width: 560,
    body: `<p class="muted">お金の動きを、ふつうの文章で書いてください。借方・貸方の科目と金額を考えて、振替伝票の下書きを作ります。${ai ? 'AI（Claude）で考えます。' : '（設定で「AI で読む」にすると、もっと複雑な文章にも対応します）'}</p>
      <textarea id="tjText" rows="4" placeholder="例: 11/20 ○○工務店から 33万円 振り込みがあった\n例: 生活費として口座から 10万円 引き出した\n例: 銀行から 200万円 借りた" autofocus></textarea>
      <div class="chips">${['○○工務店から売掛金30万円が入金', '口座から生活費10万円を引き出した', '借入金の返済 5万円', 'カードの引き落とし 42,000円'].map((s) => `<button type="button" class="chip sm" data-ex="${esc(s)}">${esc(s)}</button>`).join('')}</div>`,
    actions: [{ label: 'やめる', value: 'no' }, { label: '仕訳を考える', value: 'ok', kind: 'primary', icon: 'spark' }],
    onMount: (el) => {
      el.addEventListener('input', (ev) => { if (ev.target.id === 'tjText') text = ev.target.value; });
      el.addEventListener('click', (ev) => { const b = ev.target.closest('[data-ex]'); if (b) { const t = $('#tjText', el); t.value = b.dataset.ex; text = t.value; t.focus(); } });
      el.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); $('[data-m="ok"]', el).click(); } });
    },
  });
  if (r !== 'ok' || !text.trim()) return;
  let j = null;
  if (ai) {
    const close = toast('AI が仕訳を考えています…', { ms: 60000 });
    try { j = await aiJournal(text, { apiKey: S.settings.apiKey, model: S.settings.aiModel, accounts: accountGroups(bk().mode, st.cats()).flatMap(([, l]) => l) }); } catch (e) { toast(`AI で考えられませんでした（${e.message || e}）。かんたんな読み方で作ります`, { kind: 'error' }); } finally { close(); }
  }
  if (!j) j = ruleJournal(text);
  if (!j) { toast('科目を決められませんでした。借方・貸方を選んでください'); X.editLedger({ type: 'journal', date: today(), memo: text.slice(0, 40), debit: '普通預金', credit: '売掛金' }); return; }
  X.editLedger({ type: 'journal', date: j.date || today(), amount: j.amount, debit: j.debit, credit: j.credit, memo: j.memo || text.slice(0, 40) });
}

// ---- 帳簿の設定に足すところ ---------------------------------------------------------
const ALLOC_CATS = ['地代家賃', '水道光熱費', '通信費', '車両費', '旅費交通費', '保険料', '修繕費', '消耗品費'];
export function setupExtra() {
  const b = bk(); const sole = b.mode === 'sole';
  const iss = S.settings.issuer || {};
  const alloc = b.allocation || {};
  const cats = [...new Set([...ALLOC_CATS.filter((c) => st.cats().includes(c) || ['地代家賃', '水道光熱費', '通信費'].includes(c))])];
  return `
    ${sole ? `<section class="card"><h2>家事按分</h2><p class="muted">家と事務所が同じ・車を私用にも使うなど、私用の分がある科目は「事業で使う割合」を入れてください。期末に、残りの割合を「事業主貸」に振り分けます（決算書の経費が減ります）。空欄は 100%（全部が事業）です。</p>
      <div class="alloc-grid">${cats.map((c, i) => `<label class="open-row"><span>${esc(c)}</span><span class="amt-in sm"><input id="al-${i}" data-alloc="${esc(c)}" inputmode="numeric" data-raw="1" value="${alloc[c] ?? ''}" placeholder="100"><em>%</em></span></label>`).join('')}</div>
      <p class="hint">固定資産（車など）の割合は［固定資産］で 1 つずつ決めます。</p></section>` : ''}
    <section class="card"><h2>消費税</h2>
      <label class="chk"><input type="checkbox" data-bx="taxable" ${b.taxable ? 'checked' : ''}><span><b>消費税の課税事業者（インボイス登録をしている）</b><small>決算書の画面で、納める消費税の見込みを計算します。経理は税込（税込経理）です。</small></span></label>
      ${b.taxable ? `<div class="choice">${Object.entries(TAX_METHODS).map(([k, v]) => `<label class="choice-card ${b.taxMethod === k ? 'on' : ''}"><input type="radio" name="taxm" value="${k}" ${b.taxMethod === k ? 'checked' : ''}><span><b>${v}</b><small>${{ general: '売上の消費税 − 経費の消費税（インボイスのない経費は控除が減ります）', simple: '売上の消費税 × (1 − みなし仕入率)。前々年の売上が 5,000万円以下で届出をした人', twoTenths: '売上の消費税 × 20%。インボイス登録で免税から課税になった人（個人は 2026年分まで、法人は 2026年9月30日を含む期まで）', threeTenths: '売上の消費税 × 30%。2割特例を使っていた個人事業者（令和8年度改正。2027年分から）' }[k]}</small></span></label>`).join('')}</div>
        ${b.taxMethod === 'simple' ? `<label class="fld narrow"><span class="lb">事業の区分（みなし仕入率）</span>${select('', SIMPLE_RATES.map(([v, l]) => [v, `${l} ${v}%`]), b.simpleRate, 'tag', 'data-b="simpleRate"')}</label>` : ''}` : ''}
    </section>
    <section class="card"><h2>請求書の発行元</h2><p class="muted">請求書の右上にのります。登録番号を入れると、適格請求書（インボイス）の形になります。</p>
      <div class="row3"><label class="fld"><span class="lb">名前（屋号・会社名）</span><input id="is-name" data-iss="name" value="${esc(iss.name || b.tradeName || '')}" placeholder="${esc(S.settings.company || '例: 山田工業')}"></label>
        <label class="fld"><span class="lb">登録番号</span><input id="is-reg" data-iss="regNo" value="${esc(iss.regNo || '')}" placeholder="T1234567890123"></label>
        <label class="fld"><span class="lb">電話</span><input id="is-tel" data-iss="tel" value="${esc(iss.tel || '')}"></label></div>
      <label class="fld"><span class="lb">住所</span><input id="is-addr" data-iss="address" value="${esc(iss.address || '')}"></label>
      <label class="fld"><span class="lb">振込先</span><textarea id="is-bank" data-iss="bank" rows="2" placeholder="例: ○○銀行 △△支店 普通 1234567 ヤマダコウギョウ">${esc(iss.bank || '')}</textarea></label>
    </section>`;
}

// ===========================================================================
// 決算書に足すところ（消費税・青色申告決算書の内訳・会計ソフトの形式）
// ===========================================================================
export function taxCard(from, to) {
  const b = bk(); if (!b.taxable) return '';
  const t = consumptionTax({ journals: X.allJournals(), from, to, settings: S.settings });
  const better = t.best !== t.method && t.byMethod[t.best] < t.byMethod[t.method];
  return `<section class="card tax-card"><h2>消費税の見込み <small>${TAX_METHODS[t.method]}</small></h2>
    <div class="tc-rows"><div><span>売上の消費税</span><b>${yen(t.salesTax)}</b></div>
      ${t.method === 'general' ? `<div><span>経費の消費税（控除）</span><b>${yen(t.buyTax)}</b></div>` : ''}
      <div class="net"><span>納める見込み</span><b>${yen(t.payable)}</b></div></div>
    ${t.method === 'general' && t.noInvCount ? `<p class="hint warn">${ic('warn')}登録番号のない経費 ${t.noInvCount}件は控除が減っています（約 ${yen(t.noInvoiceCut)}）</p>` : ''}
    <table class="mini-table"><tbody>${Object.keys(t.byMethod).map((k) => `<tr class="${k === t.method ? 'on' : ''}"><td>${TAX_METHODS[k]}</td><td class="num">${yen(t.byMethod[k])}</td></tr>`).join('')}</tbody></table>
    ${better ? `<p class="hint">${ic('spark')}${TAX_METHODS[t.best]}の方が ${yen(t.byMethod[t.method] - t.byMethod[t.best])} 少なくなります（選べる条件は税理士に確かめてください）</p>` : ''}
  </section>`;
}
export function extraFinPages(s, from, to) {
  const b = bk(); const out = [];
  if (b.taxable) out.push(['消費税', taxPage(consumptionTax({ journals: X.allJournals(), from, to, settings: S.settings }), s, S.settings, b)]);
  if (b.mode === 'sole') out.push(['決算書の内訳', bluePage(s, blueExtra(s, from, to), S.settings, b)]);
  return out;
}
function blueExtra(s, from, to) {
  const b = bk(); const r = { from, to };
  const assets = [];
  for (const a of b.fixedAssets || []) {
    const c = depreciationSchedule(a, { closeMonth: b.closeMonth }).find((x) => inR(x.fyEnd, r)); if (!c) continue;
    const ratio = a.ratio == null ? 100 : +a.ratio;
    assets.push({ name: a.name, acquired: a.acquired, cost: a.cost, life: a.method === 'straight' || a.method === 'declining' ? a.life : a.method === 'lump3' ? 3 : '-', rate: rateOf(a), months: c.months, amount: c.amount, ratio, biz: Math.round((c.amount * ratio) / 100), bookClose: c.bookClose });
  }
  const js = X.allJournals().filter((j) => inR(j.date, r));
  const rents = new Map(); let wages = 0; const cogs = {};
  for (const j of js) {
    if (j.debit === '地代家賃' && j.src !== 'alloc') { const k = (j.memo || '').split(' ')[0] || '（支払先なし）'; rents.set(k, (rents.get(k) || 0) + j.amount); }
    if (j.debit === '給料賃金') wages += j.amount;
    if (j.debit === '仕入高') cogs[j.date.slice(0, 7)] = (cogs[j.date.slice(0, 7)] || 0) + j.amount;
  }
  return { assets, rents: [...rents.entries()].sort((a, c) => c[1] - a[1]), wages, monthlyCogs: cogs };
}
export const FIN_CSV_ITEMS = [
  { divider: true },
  { label: '弥生会計 形式（仕訳日記帳）', icon: 'download', value: 'yayoi' },
  { label: 'マネーフォワード クラウド 形式（仕訳帳）', icon: 'download', value: 'mf' },
  { label: 'freee 用（弥生会計仕訳インポート）', icon: 'download', value: 'freee' },
  { divider: true },
  { label: '支払調書の一覧（外注先）', icon: 'pen', value: 'payout' },
];
export function finCsv(v, from, to) {
  const js = X.allJournals().filter((j) => j.date >= from && j.date <= to);
  const b = bk();
  if (v === 'yayoi') { csvOut(toYayoi(js, b), `弥生_仕訳_${from}_${to}.csv`, true); toast('弥生会計の［ファイル → インポート］で読み込めます（弥生インポート形式）', { kind: 'ok', ms: 7000 }); }
  if (v === 'mf') { csvOut(toMF(js, b), `MF_仕訳帳_${from}_${to}.csv`, true); toast('マネーフォワード クラウド会計の［仕訳帳 → インポート → 仕訳帳］で読み込めます', { kind: 'ok', ms: 7000 }); }
  if (v === 'freee') { csvOut(toYayoi(js, b), `freee用_弥生形式_${from}_${to}.csv`, true); toast('freee の［取引 → 振替伝票 → インポート → 弥生会計仕訳インポート］で読み込めます', { kind: 'ok', ms: 8000 }); }
  if (v === 'payout') csvOut(toPayoutCSV(payoutSummary({ ledger: S.ledger, from, to }), from, to), `支払調書_${from}_${to}.csv`);
}

// ===========================================================================
// 分析（現場別・予算・車両・外注先・年次まとめ）
// ===========================================================================
const AN_TABS = [['site', '現場別の損益', 'pin'], ['budget', '予算', 'chart'], ['vehicle', '車両', 'car'], ['partner', '外注先', 'pen'], ['year', '年次まとめ', 'calendar']];
const anRange = () => (X.P.an.from ? { from: X.P.an.from, to: X.P.an.to } : X.fyOf(today()));
export function viewAnalysis() {
  const A = X.P.an; const r = anRange();
  let body = '';
  if (A.tab === 'site') body = anSite(r);
  else if (A.tab === 'budget') body = anBudget();
  else if (A.tab === 'vehicle') body = anVehicle(r);
  else if (A.tab === 'partner') body = anPartner(r);
  else body = anYear();
  const usesFY = ['site', 'vehicle', 'partner'].includes(A.tab);
  return `<div class="books-page an-page">
    <div class="toolbar"><div class="tb-row">
      <div class="seg">${AN_TABS.map(([k, v, i]) => `<button class="${A.tab === k ? 'on' : ''}" data-act="anTab" data-id="${k}">${ic(i)}${v}</button>`).join('')}</div>
      ${usesFY ? `<div class="period"><button class="icon-btn" data-act="anPrev" title="前の期">${ic('chevL')}</button><span class="period-btn static">${ic('calendar')}<b>${X.fyLabel(r)}</b></span><button class="icon-btn" data-act="anNext" title="次の期">${ic('chevR')}</button></div>` : ''}
      ${A.tab === 'budget' ? `<div class="period"><button class="icon-btn" data-act="anYmPrev" title="前の月">${ic('chevL')}</button><span class="period-btn static">${ic('calendar')}<b>${jpYM(A.ym)}</b></span><button class="icon-btn" data-act="anYmNext" title="次の月">${ic('chevR')}</button></div>` : ''}
      <span class="grow"></span>
      ${A.tab === 'site' ? `<button class="btn" data-act="siteAdd">${ic('plus')}現場を追加</button>` : ''}
      ${A.tab === 'vehicle' ? `<button class="btn" data-act="vehAdd">${ic('plus')}車を登録</button>` : ''}
      ${A.tab === 'partner' ? `<button class="btn" data-act="payoutCsvAn">${ic('download')}支払調書 CSV</button>` : ''}
      ${A.tab === 'year' ? `<button class="btn" data-act="yearCsv">${ic('download')}科目別 CSV</button><button class="btn" data-view-go="statements">${ic('doc')}決算書へ</button>` : ''}
    </div></div>
    ${body}
  </div>`;
}
function anSite(r) {
  const rows = siteReport({ journals: X.allJournals(), from: r.from, to: r.to, settings: S.settings });
  const tot = rows.reduce((o, s) => ({ rev: o.rev + s.revenue, cost: o.cost + s.cost }), { rev: 0, cost: 0 });
  if (!rows.length) return X.emptyState('pin', '現場ごとの記録はまだありません', '経費・売上・請求書・外注費に「現場・案件」を入れると、現場ごとの売上・原価・粗利が出ます。請負金額と実行予算を入れると、見積とのくらべも見られます。', `<button class="btn primary" data-act="siteAdd">${ic('plus')}現場を追加</button>`);
  return `<div class="sumbar"><span>${rows.length}現場</span><span>売上 <b>${yen(tot.rev)}</b></span><span>原価 <b>${yen(tot.cost)}</b></span><span>粗利 <b>${signed(tot.rev - tot.cost)}</b></span><span class="muted">請負金額・実行予算は入れるとすぐ保存されます</span></div>
  <div class="table-wrap"><table class="grid ledger site-table">
    <thead><tr><th>現場・案件</th><th class="c-amt num">請負金額</th><th class="c-amt num">実行予算</th><th class="c-amt num">売上</th><th class="c-amt num">原価</th><th class="c-amt num">粗利</th><th class="num">粗利率</th><th class="c-bar">予算の消化</th><th class="c-bar">請求の進み</th><th class="c-check">完了</th></tr></thead>
    <tbody>${rows.map((s, i) => `<tr class="${s.closed ? 'closed' : ''}">
      <td class="c-payee"><button class="link" data-act="anSiteList" data-id="${esc(s.name)}"><b>${esc(s.name)}</b></button><small>${Object.entries(s.groups).map(([g, v]) => `${g} ${yen(v)}`).join(' ・ ')}</small></td>
      <td class="c-amt num"><span class="amt-in xs"><input id="sp-c-${i}" data-plan="${esc(s.name)}" data-k="contract" inputmode="numeric" value="${fmtN(s.contract)}" placeholder="—"></span></td>
      <td class="c-amt num"><span class="amt-in xs"><input id="sp-b-${i}" data-plan="${esc(s.name)}" data-k="budget" inputmode="numeric" value="${fmtN(s.budget)}" placeholder="—"></span></td>
      <td class="c-amt num">${yen(s.revenue)}</td><td class="c-amt num">${yen(s.cost)}</td>
      <td class="c-amt num"><b class="${s.profit < 0 ? 'neg' : ''}">${signed(s.profit)}</b></td>
      <td class="num">${pct(s.margin)}</td>
      <td class="c-bar">${s.budget ? `${pbar(s.used, s.used > 1 ? 'over' : s.used > 0.8 ? 'near' : '')}<small>${pct(s.used)}${s.used > 1 ? ` ・ ${yen(s.cost - s.budget)} 超過` : ` ・ 残り ${yen(s.budget - s.cost)}`}</small>` : '<small class="muted">予算なし</small>'}</td>
      <td class="c-bar">${s.contract ? `${pbar(s.billed)}<small>${pct(s.billed)} ・ 見込み粗利 ${signed(s.contract - (s.budget || s.cost))}</small>` : '<small class="muted">—</small>'}</td>
      <td class="c-check"><input type="checkbox" data-plan-closed="${esc(s.name)}" ${s.closed ? 'checked' : ''} title="完了した現場"></td>
    </tr>`).join('')}</tbody></table></div>`;
}
function anBudget() {
  const ym = X.P.an.ym; const budgets = S.settings.budgets || {};
  const used = {};
  for (const e of S.expenses) if (e.status !== 'draft' && st.ymOf(e.date) === ym && e.category) used[e.category] = (used[e.category] || 0) + (e.amount || 0);
  const cats = st.cats();
  const tb = cats.reduce((s, c) => s + (+budgets[c] || 0), 0); const tu = cats.reduce((s, c) => s + (used[c] || 0), 0);
  const nOK = typeof Notification !== 'undefined';
  return `<div class="sumbar"><span>${jpYM(ym)}</span><span>予算 <b>${yen(tb)}</b></span><span>使った額 <b>${yen(tu)}</b></span>${tb ? `<span>${pct(tu / tb)}</span>` : ''}<span class="grow"></span>
      ${nOK ? `<label class="chk inline"><input type="checkbox" data-notify ${S.settings.notify ? 'checked' : ''}>予算の 80%・100% をこえたらパソコンに通知する</label>` : ''}</div>
    <div class="budget-grid">${cats.map((c, i) => { const b = +budgets[c] || 0; const u = used[c] || 0; const r = b ? u / b : null; const lv = r == null ? '' : r > 1 ? 'over' : r >= 0.8 ? 'near' : ''; return `<div class="card budget ${lv}">
      <div class="bd-h"><b>${esc(c)}</b><span class="amt-in xs"><em>月</em><input id="bd-${i}" data-budget="${esc(c)}" inputmode="numeric" value="${fmtN(b)}" placeholder="予算なし"><em>円</em></span></div>
      <div class="bd-v"><b>${yen(u)}</b>${b ? `<small>/ ${yen(b)}</small>` : ''}</div>
      ${b ? `${pbar(r, lv)}<small class="bd-s">${r > 1 ? `${yen(u - b)} こえています` : `残り ${yen(b - u)}`}（${pct(r)}）</small>` : '<small class="bd-s muted">毎月の予算を入れると、使いすぎをお知らせします</small>'}
    </div>`; }).join('')}</div>`;
}
function anVehicle(r) {
  const vs = S.settings.vehicles || [];
  if (!vs.length) return X.emptyState('car', '車はまだ登録されていません', '車ごとに、ガソリン代・修理・保険などの経費と、燃費・1km あたりの費用を出せます。車を登録したら、経費の詳細で「車」「走行メーター」「給油量」を入れてください。', `<button class="btn primary" data-act="vehAdd">${ic('plus')}車を登録</button>`);
  const rows = vehicleReport({ expenses: S.expenses, from: r.from, to: r.to, vehicles: vs });
  return `<div class="veh-grid">${rows.map((v, i) => `<section class="card veh">
      <header><span class="veh-ic">${ic('car')}</span><input id="vh-${i}" class="ttl-in" data-veh="${esc(v.id)}" value="${esc(v.name)}"><button class="icon-btn sm" data-act="vehDel" data-id="${esc(v.id)}" title="登録をやめる">${ic('trash')}</button></header>
      <div class="veh-kpis">
        <div><span>経費の合計</span><b>${yen(v.total)}</b><small>${v.count}件</small></div>
        <div><span>燃料</span><b>${yen(v.fuel)}</b><small>${v.liters ? `${v.liters.toFixed(1)} L` : '給油量なし'}</small></div>
        <div><span>修理・保険など</span><b>${yen(v.other)}</b></div>
        <div><span>走った距離</span><b>${v.km ? `${v.km.toLocaleString('ja-JP')} km` : '—'}</b><small>${v.odoMin != null ? `メーター ${v.odoMin.toLocaleString('ja-JP')}〜${(v.odoMax || 0).toLocaleString('ja-JP')}` : 'メーターの記録なし'}</small></div>
        <div><span>燃費</span><b>${v.kmpl ? `${v.kmpl.toFixed(1)} km/L` : '—'}</b></div>
        <div><span>1km あたり</span><b>${v.yenPerKm ? `${v.yenPerKm.toFixed(1)} 円` : '—'}</b></div>
      </div>
      <button class="link sm" data-act="vehList" data-id="${esc(v.id)}">この車の経費を見る ${ic('arrowR')}</button>
    </section>`).join('')}</div>`;
}
function anPartner(r) {
  const rows = payoutSummary({ ledger: S.ledger, from: r.from, to: r.to });
  if (!rows.length) return X.emptyState('pen', 'この期の外注費の支払いはありません', '［帳簿 → 外注・源泉］で外注費を入れると、外注先ごとの支払金額・源泉徴収税額が集計され、支払調書の作成に使えます。', `<button class="btn primary" data-act="payoutNew">${ic('plus')}外注費を払った</button>`);
  return `<div class="sumbar"><span>${rows.length}人・社</span><span>支払金額 <b>${yen(rows.reduce((s, x) => s + x.gross, 0))}</b></span><span>源泉徴収 <b>${yen(rows.reduce((s, x) => s + x.wh, 0))}</b></span><span class="muted">報酬・料金の支払調書は、同じ人への年間の支払いが 5万円をこえると提出が必要です（源泉のない工事代は対象外）</span></div>
    <div class="table-wrap"><table class="grid ledger"><thead><tr><th>外注先</th><th>住所</th><th class="num">件数</th><th class="c-amt num">支払金額</th><th class="c-amt num">源泉徴収税額</th><th class="c-amt num">差引支払額</th><th class="c-site">支払調書</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td class="c-payee"><b>${esc(x.partner)}</b></td><td>${esc(x.address || '—')}</td><td class="num">${x.count}</td><td class="c-amt num">${yen(x.gross)}</td><td class="c-amt num">${x.wh ? yen(x.wh) : '—'}</td><td class="c-amt num"><b>${yen(x.net)}</b></td>
      <td class="c-site">${x.wh && x.gross > 50000 ? `<span class="badge draft">${ic('warn')}提出が必要</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}
function anYear() {
  const y = yearCompare({ journals: X.allJournals(), settings: S.settings, expenses: S.expenses, ledger: S.ledger, today: today() });
  const d = (a, b) => { if (!b) return ''; const r = (a - b) / Math.abs(b); return `<small class="${r > 0 ? 'up' : r < 0 ? 'down' : ''}">前期 ${signed(b)}（${r >= 0 ? '+' : ''}${Math.round(r * 100)}%）</small>`; };
  const corp = bk().mode === 'corp';
  return `<div class="year-page">
    <div class="kpis three">
      <section class="card kpi"><span class="kpi-l">売上（今期 ${md(y.cur.from)}〜）</span><b class="kpi-v">${yen(y.a.revenue)}</b>${d(y.a.revenue, y.p.revenue)}</section>
      <section class="card kpi"><span class="kpi-l">経費・費用</span><b class="kpi-v">${yen(y.a.expense)}</b>${d(y.a.expense, y.p.expense)}</section>
      <section class="card kpi hero"><span class="kpi-l">${corp ? '利益' : '所得（控除前）'}</span><b class="kpi-v">${signed(y.a.profit)}</b>${d(y.a.profit, y.p.profit)}</section>
    </div>
    <div class="dash two">
      <section class="card"><header><h2>科目ごと（前期とくらべて）</h2></header>
        ${y.cats.length ? `<table class="mini-table"><thead><tr><th>科目</th><th class="num">前期</th><th class="num">今期</th><th class="num">増減</th></tr></thead><tbody>${y.cats.slice(0, 20).map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${yen(c.prev)}</td><td class="num"><b>${yen(c.cur)}</b></td><td class="num ${c.diff > 0 ? 'up' : c.diff < 0 ? 'down' : ''}">${c.diff > 0 ? '+' : c.diff < 0 ? '−' : ''}${yen(Math.abs(c.diff))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">まだ記録がありません</p>'}
      </section>
      <section class="card"><header><h2>よく払った相手</h2><span class="muted">今期・経費</span></header>
        ${y.payees.length ? `<ol class="rank">${y.payees.map(([p, v]) => `<li><span>${esc(p)}</span><b>${yen(v)}</b></li>`).join('')}</ol>` : '<p class="muted">まだ記録がありません</p>'}
      </section>
    </div>
    <section class="card hints"><header><h2>${ic('spark')}今期のチェックと節税のヒント</h2></header>
      ${y.hints.length ? `<div class="hint-grid">${y.hints.map((h) => `<div class="hint-card"><b>${esc(h.title)}</b><p>${esc(h.text)}</p></div>`).join('')}</div>` : '<p class="muted">気になる点はありません</p>'}
      <p class="muted small">一般的な目安です。実際の申告・節税は税理士に相談してください。</p>
    </section>
  </div>`;
}

// ===========================================================================
// 承認
// ===========================================================================
let apvCache = null;
async function loadApprovals() { apvCache = await sh.listApprovals(); }
const APV = { submitted: ['提出済み', 'draft', 'clock'], approved: ['承認', 'done', 'checkCircle'], rejected: ['差し戻し', 'over', 'undo'], pending: ['未決', 'draft', 'clock'] };
export const apvBadge = (r) => { const a = r.approval; if (!a) return ''; const [l, c, i] = APV[a.status] || APV.submitted; return `<span class="badge ${c} xs" title="${esc(a.comment || '')}">${ic(i)}${l}</span>`; };
export const pendingApprovals = () => (apvCache || []).filter((a) => a.status === 'pending').length;
export function viewApprovals() {
  if (!apvCache) { loadApprovals().then(() => X.render()); return '<div class="empty"><span class="spin"></span></div>'; }
  const mine = [...S.reports].sort((a, b) => b.created - a.created).slice(0, 30);
  return `<div class="apv-page">
    <section class="card apv-how"><div class="ah-steps">
      <div><b>1</b><span>申請する人: 精算書を作ったあと「承認に出す」で提出ファイルを作り、メール・チャットで承認者に送る</span></div>
      <div><b>2</b><span>承認する人: 届いたファイルを取り込み、領収書を見て「承認」か「差し戻し」。結果ファイルを返す</span></div>
      <div><b>3</b><span>申請する人: 結果ファイルを取り込むと、精算に結果と、経費ごとのコメントがのる</span></div>
    </div><button class="btn primary" data-act="apvImport">${ic('upload')}提出ファイル・結果ファイルを取り込む</button></section>
    <div class="dash two">
      <section class="card"><header><h2>届いた申請</h2><span class="muted">承認する人</span></header>
        ${apvCache.length ? `<ul class="apv-list">${apvCache.map((a) => { const s = a.sub; const [l, c, i] = APV[a.status] || APV.pending; return `<li><button class="apv-row" data-act="apvOpen" data-id="${a.id}">
          <span class="ar-main"><b>${esc(s.applicant.name || '（名前なし）')}</b><small>${esc([s.applicant.company, s.applicant.dept].filter(Boolean).join(' '))} ・ ${md(s.from)}〜${md(s.to)} ・ ${s.sum.count}件</small></span>
          <b class="ar-amt">${yen(s.sum.reimb)}</b><span class="badge ${c}">${ic(i)}${l}</span></button></li>`; }).join('')}</ul>` : '<p class="muted">まだありません。申請する人から届いた「精算の提出」ファイルを取り込んでください。</p>'}
      </section>
      <section class="card"><header><h2>自分の精算</h2><span class="muted">申請する人</span></header>
        ${mine.length ? `<ul class="apv-list">${mine.map((r) => `<li class="apv-mine"><span class="ar-main"><b>${md(r.from)}〜${md(r.to)}</b><small>${r.ids.length}件 ・ ${new Date(r.created).toLocaleDateString('ja-JP')}${r.approval && r.approval.comment ? ` ・ 「${esc(r.approval.comment)}」` : ''}</small></span>
          <b class="ar-amt">${yen(r.reimb - (r.advance || 0))}</b>${apvBadge(r) || '<span class="muted small">未提出</span>'}
          <button class="btn sm" data-act="apvSubmit" data-id="${r.id}">${ic('send')}${r.approval ? '出し直す' : '承認に出す'}</button></li>`).join('')}</ul>` : `<p class="muted">精算書の画面で「精算済みにする」と、ここに並びます。</p><button class="btn" data-view-go="report">${ic('doc')}精算書へ</button>`}
      </section>
    </div>
  </div>`;
}
async function apvSubmit(id) {
  const rep = S.reports.find((r) => r.id === id); if (!rep) return;
  const blob = await sh.makeSubmission(rep);
  download(blob, `精算の提出_${safe(S.settings.name || '申請者')}_${rep.from}_${rep.to}.json`);
  toast('提出ファイルを保存しました。メールやチャットで承認する人に送ってください', { kind: 'ok', ms: 7000 });
  X.render();
}
async function apvOpen(id) {
  if (!apvCache) await loadApprovals();
  const rec = apvCache.find((a) => a.id === id); if (!rec) return;
  const s = rec.sub; const urls = [];
  const imgOf = (e) => { if (!e.imageId) return ''; const b = sh.approvalImage(rec, e.imageId); if (!b) return ''; const u = URL.createObjectURL(b); urls.push(u); return `<a href="${u}" target="_blank" rel="noopener" class="thumb"><img src="${u}" alt=""></a>`; };
  let comment = rec.comment || ''; const ic2 = { ...(rec.itemComments || {}) };
  const r = await modal({
    title: `${s.applicant.name || ''} さんの精算（${md(s.from)}〜${md(s.to)}）`, width: 980,
    body: `<div class="apv-detail">
      <div class="ad-sum"><div><span>立替の合計</span><b>${yen(s.sum.reimb)}</b></div>${s.sum.company ? `<div><span>会社払い</span><b>${yen(s.sum.company)}</b></div>` : ''}${s.advance ? `<div><span>仮払金</span><b>${yen(s.advance)}</b></div>` : ''}<div><span>件数</span><b>${s.sum.count}件</b></div><div><span>提出</span><b>${new Date(s.at).toLocaleDateString('ja-JP')}</b></div></div>
      <div class="table-wrap modal-table"><table class="grid"><thead><tr><th class="c-img"></th><th class="c-date">日付</th><th>支払先・内容</th><th class="c-cat">科目</th><th class="c-amt num">金額</th><th>コメント（差し戻しの理由など）</th></tr></thead>
      <tbody>${s.items.map((e) => `<tr><td class="c-img">${imgOf(e)}</td><td class="c-date"><b>${md(e.date)}</b></td>
        <td class="c-payee"><b>${esc(e.payee || '')}</b><small>${esc([e.site, e.memo].filter(Boolean).join(' ・ '))}${e.invoiceNo ? ` ・ ${esc(e.invoiceNo)}` : ''}</small></td>
        <td class="c-cat"><span class="tag">${esc(e.category || '')}</span></td><td class="c-amt num"><b>${yen(e.amount)}</b><small>${esc(e.method || '')}</small></td>
        <td><input data-ci="${e.id}" value="${esc(ic2[e.id] || '')}" placeholder="—"></td></tr>`).join('')}</tbody></table></div>
      <label class="fld"><span class="lb">全体へのコメント</span><textarea id="adCom" rows="2" placeholder="例: 11/5 の領収書の宛名をお願いします">${esc(comment)}</textarea></label>
    </div>`,
    actions: [{ label: '閉じる', value: 'no' }, { label: '差し戻す', value: 'rejected', kind: 'danger', icon: 'undo' }, { label: '承認する', value: 'approved', kind: 'primary', icon: 'check' }],
    onMount: (el) => { el.addEventListener('input', (ev) => { if (ev.target.id === 'adCom') comment = ev.target.value; if (ev.target.dataset.ci) ic2[ev.target.dataset.ci] = ev.target.value.trim(); }); },
  });
  setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 60000);
  if (r !== 'approved' && r !== 'rejected') return;
  const blob = await sh.decide(rec, { status: r, comment, itemComments: Object.fromEntries(Object.entries(ic2).filter(([, v]) => v)), by: S.settings.name || '' });
  download(blob, `精算の結果_${safe(s.applicant.name)}_${s.from}_${s.to}.json`);
  toast(`${r === 'approved' ? '承認しました' : '差し戻しました'}。結果ファイルを申請した人に送ってください`, { kind: 'ok', ms: 7000 });
  await loadApprovals(); X.render();
}
// JSON のファイル: 提出・結果なら扱って true。バックアップなら false
export async function importJson(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch (_) { return false; }
  if (!j || j.app !== 'rakukeihi') return false;
  if (j.kind === 'submission') {
    await sh.receiveSubmission(j); await loadApprovals();
    toast(`${j.applicant && j.applicant.name ? `${j.applicant.name} さんの` : ''}精算の提出を受け取りました`, { kind: 'ok' });
    X.go('approvals'); apvOpen(j.id);
    return true;
  }
  if (j.kind === 'decision') {
    try { const rep = await sh.applyDecision(j); toast(`精算（${md(rep.from)}〜${md(rep.to)}）は「${j.status === 'approved' ? '承認' : '差し戻し'}」でした${j.comment ? `: ${j.comment}` : ''}`, { kind: j.status === 'approved' ? 'ok' : 'error', ms: 9000 }); } catch (e) { toast(e.message, { kind: 'error' }); }
    X.render();
    return true;
  }
  return false;
}

// ===========================================================================
// 設定に足すところ（同期・自動バックアップ・電子帳簿保存法）
// ===========================================================================
export const SET_SECS = [['sync', '同期・自動バックアップ'], ['dencho', '電子帳簿保存法']];
export function settingsExtra() {
  const s = sh.syncState; const gd = sh.gd;
  let drive;
  if (gd.drive.used) {
    const ok = gd.connected();
    drive = `<div class="sync-box ${ok && !s.error ? 'ok' : 'warn'}">${ic(ok ? 'sync' : 'warn')}
        <span><b>Google ドライブ${gd.drive.email ? `（${esc(gd.drive.email)}）` : ''} ／ マイドライブ › ラク経費</b><small>${ok ? `最後に同期: ${s.lastWrite ? ago(s.lastWrite) : 'まだ'}${s.busy ? ` ・ ${esc(s.progress || '同期中…')}` : ''}` : 'つながりが切れています（1 時間ごとに、もう一度つなぐ必要があります）'}${s.error && ok ? ` ・ エラー: ${esc(s.error)}` : ''}</small></span></div>
      <div class="row-inline">${ok ? `<button class="btn primary" data-act="syncNow">${ic('sync')}今すぐ同期</button>` : `<button class="btn primary" data-act="driveConnect">${ic('key')}つなぎ直す</button>`}
        <button class="link sm" data-act="driveOff">Google ドライブとの同期をやめる</button></div>
      <p class="hint">スマホ版・ほかのパソコンでも同じ Google アカウントでつなぐと、自動でデータがそろいます。変更から 20 秒後・10 分ごと・アプリに戻ったときに同期します。画像は 1 枚ずつ一度だけ送ります。14 日分の控えも残ります（API キーは送りません）。</p>`;
  } else {
    drive = `<p class="muted">Google アカウントでつなぐと、マイドライブの「ラク経費」フォルダにデータと領収書の画像を自動で保存します。<b>スマホ版とパソコンのどちらからでも</b>同じデータになり、バックアップの心配もなくなります（このアプリが作ったファイルだけを読み書きします）。</p>
      <div class="row-inline"><button class="btn primary" data-act="driveConnect">${ic('sync')}Google ドライブにつなぐ</button>${gd.configured() ? '' : '<span class="muted small">はじめに OAuth クライアント ID が必要です</span>'}</div>`;
  }
  let sync;
  if (gd.drive.used) sync = '';
  else if (!sh.syncSupported()) sync = '';
  else if (!s.handle) {
    sync = `<details class="alt-sync"><summary>Google アカウントを使わない: パソコンのフォルダで同期する</summary><p class="muted">Google ドライブ・OneDrive・Dropbox などのパソコン上のフォルダを選ぶと、変更のたびに自動でそこへ保存します（画像も含む）。パソコンどうしで同期できます（スマホは対象外）。</p>
      <button class="btn" data-act="syncChoose">${ic('folder')}同期フォルダを選ぶ</button></details>`;
  } else {
    sync = `<h3 class="sub-h">パソコンのフォルダで同期</h3><div class="sync-box ${s.permission === 'granted' ? 'ok' : 'warn'}">${ic(s.permission === 'granted' ? 'sync' : 'warn')}
        <span><b>${esc(s.handle.name)}</b><small>${s.permission === 'granted' ? `最後に保存: ${s.lastWrite ? ago(s.lastWrite) : 'まだ'}${s.busy ? ' ・ 同期中…' : ''}` : 'ブラウザを開き直したので、フォルダへの許可がもう一度必要です'}${s.error ? ` ・ エラー: ${esc(s.error)}` : ''}</small></span></div>
      <div class="row-inline">${s.permission === 'granted' ? `<button class="btn primary" data-act="syncNow">${ic('sync')}今すぐ同期</button>` : `<button class="btn primary" data-act="syncReconnect">${ic('key')}フォルダを許可する</button>`}
        <button class="btn" data-act="syncChoose">${ic('folder')}別のフォルダにする</button><button class="link sm" data-act="syncForget">同期をやめる</button></div>
      <p class="hint">変更から 20 秒後と、10 分ごとに保存します。ほかのパソコンの変更も、そのときに取り込みます（API キーは保存しません）。</p>`;
  }
  sync = drive + sync;
  return `
    <section class="card" id="set-sync"><h2>同期・自動バックアップ</h2>${sync}</section>
    <section class="card" id="set-dencho"><h2>電子帳簿保存法</h2>
      <ul class="dencho">
        <li>${ic('checkCircle')}<span><b>改ざん防止（真実性）</b>確定した経費・帳簿の記録を直したり消したりすると、いつ・何を・どう変えたかを自動で記録します。事務処理規程を備えると、この要件を満たせます。</span></li>
        <li>${ic('checkCircle')}<span><b>検索（可視性）</b>経費一覧で「日付（期間）・金額（範囲）・取引先」で探せます。</span></li>
        <li>${ic('checkCircle')}<span><b>保存</b>領収書の画像・PDF・メールは元のファイルのまま残します。保存期間は原則 7 年（法人で赤字の年は 10 年）です。</span></li>
      </ul>
      <div class="row-inline"><button class="btn" data-act="histAll">${ic('clock')}変更の履歴を見る</button><button class="btn" data-act="ruleDoc">${ic('doc')}事務処理規程のひな形</button></div>
    </section>`;
}
async function histAll() {
  const list = (await st.allHistory()).slice(0, 500);
  const LBL = { create: ['登録', 'done'], update: ['変更', 'draft'], delete: ['削除', 'over'] };
  const v = (x) => (x == null || x === '' ? '（なし）' : String(x));
  const rows = list.map((h) => ({ h, txt: Object.entries(h.ch || {}).map(([f, [a, b]]) => `${FIELD_LABEL[f] || f}: ${v(a)} → ${v(b)}`).join(' / ') }));
  const r = await modal({ title: '変更の履歴', width: 900,
    body: list.length ? `<div class="table-wrap modal-table"><table class="grid"><thead><tr><th class="c-date">日時</th><th>種類</th><th>記録</th><th>内容</th></tr></thead><tbody>${rows.map(({ h, txt }) => { const [l, c] = LBL[h.action] || ['', '']; return `<tr><td class="c-date">${new Date(h.at).toLocaleString('ja-JP')}</td><td><span class="badge ${c}">${l}</span><small>${h.kind === 'ledger' ? '帳簿' : '経費'}</small></td><td class="c-payee"><b>${esc((h.summary && h.summary.payee) || '')}</b><small>${esc((h.summary && h.summary.date) || '')} ${h.summary && h.summary.amount ? yen(h.summary.amount) : ''}</small></td><td class="small">${h.action === 'update' ? esc(txt) : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">まだ履歴はありません。</p>',
    actions: [{ label: 'CSV に保存', value: 'csv', icon: 'download' }, { label: '閉じる', value: 'ok', kind: 'primary' }] });
  if (r === 'csv') {
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    csvOut([['日時', '操作', '種類', '日付', '支払先・取引先', '金額', '変更内容'], ...rows.map(({ h, txt }) => [new Date(h.at).toLocaleString('ja-JP'), (LBL[h.action] || [''])[0], h.kind === 'ledger' ? '帳簿' : '経費', h.summary && h.summary.date, h.summary && h.summary.payee, h.summary && h.summary.amount, txt])].map((x) => x.map(q).join(',')).join('\r\n'), `変更履歴_${today()}.csv`);
  }
}
function ruleDoc() {
  const co = S.settings.company || bk().tradeName || S.settings.name || '○○○○';
  const t = `電子取引データの訂正及び削除の防止に関する事務処理規程

${co}

（目的）
第1条　この規程は、電子計算機を使用して作成する国税関係帳簿書類の保存方法の特例に関する法律第7条に定められた電子取引の取引情報に係る電磁的記録の保存義務を履行するため、${co}において行った電子取引の取引情報に係る電磁的記録を適正に保存するために必要な事項を定め、これに基づき保存することを目的とする。

（適用範囲）
第2条　この規程は、${co}の役員及び従業員に対して適用する。

（管理責任者）
第3条　この規程の管理責任者は、＿＿＿＿＿＿＿＿とする。

（電子取引の範囲）
第4条　${co}における電子取引の範囲は以下のとおりとする。
　一　電子メールにより請求書・領収書等を受領する取引
　二　ウェブサイト上で請求書・領収書等をダウンロードする取引
　三　クレジットカード・電子マネー等の利用明細を電子データで受領する取引
２　前項に掲げる取引の取引情報は、経費精算アプリ「ラク経費」に取り込み保存する。

（取引データの保存）
第5条　取引先から受領した取引関係情報及び取引相手に提供した取引関係情報のうち、前条に定める電子取引の取引情報は、受領後速やかに保存するものとする。
２　保存期間は、法定の保存期間（7年。欠損金のある事業年度は10年）とする。

（対象となるデータ）
第6条　保存する取引関係情報は以下のとおりとする。
　一　見積依頼情報　二　見積回答情報　三　確定注文情報　四　契約情報　五　請求書　六　領収書　七　その他、取引に関する重要な情報

（運用体制）
第7条　保存する取引関係情報の管理責任者及び処理責任者は以下のとおりとする。
　一　管理責任者　＿＿＿＿＿＿＿＿
　二　処理責任者　＿＿＿＿＿＿＿＿

（訂正削除の原則禁止）
第8条　保存する取引関係情報の内容について、訂正及び削除をすることは原則禁止とする。

（訂正削除を行う場合）
第9条　業務処理上やむを得ない理由によって保存する取引関係情報を訂正又は削除する場合は、処理責任者は「取引情報訂正・削除申請書」に以下の内容を記載の上、管理責任者へ提出すること。
　一　申請日　二　取引伝票番号　三　取引件名　四　取引先名　五　訂正・削除日付　六　訂正・削除内容　七　訂正・削除理由　八　処理担当者名
２　管理責任者は、承認後、処理責任者に訂正・削除を行わせる。訂正・削除の記録は「ラク経費」の変更履歴に自動で残るほか、申請書を本規程に従い保存する。

附則
（施行）
第10条　この規程は、＿＿＿＿年＿＿月＿＿日から施行する。
`;
  download(new Blob([`\ufeff${t}`], { type: 'text/plain' }), `事務処理規程_ひな形_${safe(co)}.txt`);
  toast('事務処理規程のひな形を保存しました（空欄を埋めて使ってください）', { kind: 'ok' });
}
export function syncFoot() {
  const s = sh.syncState;
  if (sh.gd.drive.used) {
    const ok = sh.gd.connected() && !s.error;
    return `<div class="foot-card ${ok ? '' : 'warn'}">${ic(ok ? 'sync' : 'warn')}<span><b>${ok ? 'Google ドライブと同期中' : sh.gd.connected() ? '同期できませんでした' : 'Google ドライブにつなぎ直す'}</b><small>${s.busy ? esc(s.progress || '同期中…') : `最後: ${s.lastWrite ? ago(s.lastWrite) : 'まだ'}`}</small></span>
    <button class="icon-btn sm" data-act="${sh.gd.connected() ? 'syncNow' : 'driveConnect'}" title="${sh.gd.connected() ? '今すぐ同期' : 'つなぎ直す'}">${ic(sh.gd.connected() ? 'sync' : 'key')}</button></div>`;
  }
  if (!s.handle) return null;
  const ok = s.permission === 'granted' && !s.error;
  return `<div class="foot-card ${ok ? '' : 'warn'}">${ic(ok ? 'sync' : 'warn')}<span><b>${ok ? '自動で同期中' : s.permission !== 'granted' ? '同期の許可が必要です' : '同期できませんでした'}</b><small>${esc(s.handle.name)} ・ ${s.lastWrite ? ago(s.lastWrite) : 'まだ'}</small></span>
    <button class="icon-btn sm" data-act="${ok ? 'syncNow' : 'syncReconnect'}" title="${ok ? '今すぐ同期' : 'フォルダを許可する'}">${ic(ok ? 'sync' : 'key')}</button></div>`;
}

// ===========================================================================
// ホームのお知らせ・通知・定期の登録
// ===========================================================================
export function homeAlerts() {
  const out = [];
  const t = today();
  const od = overdueInvoices(S.ledger, t);
  if (od.length) out.push(`<button class="banner warn" data-act="goInvoices">${ic('warn')}<span><b>入金期日を過ぎた請求が ${od.length}件（${yen(od.reduce((s, l) => s + l.amount, 0))}）あります</b><small>${esc(od.slice(0, 3).map((l) => l.invoice.to || l.partner).join('・'))}</small></span><span class="banner-go">請求書を見る ${ic('arrowR')}</span></button>`);
  const bs = budgetStatus({ expenses: S.expenses, ym: t.slice(0, 7), settings: S.settings }).filter((b) => b.level !== 'ok');
  if (bs.length) out.push(`<button class="banner ${bs.some((b) => b.level === 'over') ? 'warn' : ''}" data-act="goBudget">${ic('chart')}<span><b>${bs.some((b) => b.level === 'over') ? '今月の予算をこえた科目があります' : '今月の予算の 80% をこえた科目があります'}</b><small>${bs.slice(0, 4).map((b) => `${esc(b.category)} ${pct(b.ratio)}`).join(' ・ ')}</small></span><span class="banner-go">予算を見る ${ic('arrowR')}</span></button>`);
  const s = sh.syncState;
  if (sh.gd.needsReconnect()) out.push(`<button class="banner" data-act="driveConnect">${ic('sync')}<span><b>Google ドライブにつなぎ直してください</b><small>つながりは 1 時間で切れます。押すとすぐ同期を再開します</small></span><span class="banner-go">つなぎ直す ${ic('arrowR')}</span></button>`);
  if (s.handle && s.permission !== 'granted' && !sh.gd.drive.used) out.push(`<button class="banner" data-act="syncReconnect">${ic('sync')}<span><b>同期フォルダ（${esc(s.handle.name)}）への許可が必要です</b><small>ブラウザを開き直すと、もう一度許可がいります</small></span><span class="banner-go">許可する ${ic('arrowR')}</span></button>`);
  if (pendingApprovals()) out.push(`<button class="banner" data-view-go="approvals">${ic('stamp')}<span><b>承認を待っている精算が ${pendingApprovals()}件あります</b></span><span class="banner-go">承認へ ${ic('arrowR')}</span></button>`);
  return out.join('');
}
export function checkNotify() {
  if (!S.settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const ym = today().slice(0, 7);
  let seen = {}; try { seen = JSON.parse(localStorage.getItem('rakukeihi.pc.notified') || '{}'); } catch (_) { /* なし */ }
  for (const b of budgetStatus({ expenses: S.expenses, ym, settings: S.settings })) {
    if (b.level === 'ok') continue;
    const k = `${ym}|${b.category}|${b.level}`; if (seen[k]) continue;
    seen[k] = 1;
    try { new Notification(b.level === 'over' ? `${b.category}が今月の予算をこえました` : `${b.category}が今月の予算の 80% をこえました`, { body: `${yen(b.used)} / 予算 ${yen(b.budget)}`, tag: k }); } catch (_) { /* 通知できない */ }
  }
  try { localStorage.setItem('rakukeihi.pc.notified', JSON.stringify(seen)); } catch (_) { /* 容量 */ }
}
export function recurringSection() {
  const list = S.recurring || [];
  if (!list.length) return '';
  return `<section class="card rec-card"><header><h2>${ic('calendar')}毎月の自動登録</h2><span class="muted">その日になると自動で入ります（アプリを開いたときに、まだの分をまとめて登録）</span></header>
    <ul class="rec-list">${list.map((r) => `<li class="${r.paused ? 'paused' : ''}"><span class="rc-k badge ${r.kind === 'income' ? 'done' : 'ok'}">${r.kind === 'income' ? '売上' : '経費'}</span>
      <span class="rc-main"><b>${esc(r.label || (r.data && (r.data.payee || r.data.partner || r.data.memo)) || '')}</b><small>毎月 ${r.day}日 ・ ${yen(r.data && r.data.amount)}${r.last ? ` ・ 最後 ${jpYM(r.last)}` : ''}</small></span>
      <button class="btn sm" data-act="recPause" data-id="${r.id}">${r.paused ? '再開' : '一時停止'}</button><button class="icon-btn sm" data-act="recDel" data-id="${r.id}" title="やめる">${ic('trash')}</button></li>`).join('')}</ul></section>`;
}
export function tplRecurringHTML(t) {
  const rule = (S.recurring || []).find((r) => r.tpl === t.id);
  const can = t.amount && t.category;
  return `<label class="chk sm tc-rec" ${can ? '' : 'title="金額と科目のある「よく使う」だけ自動で登録できます"'}><input type="checkbox" data-tplrec="${t.id}" ${rule ? 'checked' : ''} ${can ? '' : 'disabled'}>毎月<input class="day-in" data-tplday="${t.id}" inputmode="numeric" value="${rule ? rule.day : 25}" ${rule ? '' : 'disabled'}>日に自動で登録</label>`;
}
export function addIncomeRecurring(l) {
  const ym = l.date.slice(0, 7);
  const data = { ...l }; for (const k of ['id', 'created', 'updated', '__repeat', 'date', 'invoice', 'bankKey']) delete data[k];
  st.addRecurring({ kind: 'income', label: l.partner || l.memo || '売上', day: +l.date.slice(8), start: st.addMonth(ym, 1), last: ym, data });
}

// ===========================================================================
// 入力・変更・操作
// ===========================================================================
export function onInput(el) {
  if (el.dataset.alloc != null) { const b = bk(); const a = { ...(b.allocation || {}) }; const n = st.num(el.value); if (n == null || n >= 100) delete a[el.dataset.alloc]; else a[el.dataset.alloc] = Math.max(0, n); saveBooks({ allocation: a }); return true; }
  if (el.dataset.iss) { S.settings.issuer = { ...(S.settings.issuer || {}), [el.dataset.iss]: el.value }; st.saveSettings(); return true; }
  if (el.dataset.plan) { const p = { ...(S.settings.sites || {}) }; p[el.dataset.plan] = { ...(p[el.dataset.plan] || {}), [el.dataset.k]: st.num(el.value) || 0 }; S.settings.sites = p; st.saveSettings(); return true; }
  if (el.dataset.budget) { const b = { ...(S.settings.budgets || {}) }; const n = st.num(el.value); if (n) b[el.dataset.budget] = n; else delete b[el.dataset.budget]; S.settings.budgets = b; st.saveSettings(); return true; }
  if (el.dataset.veh) { S.settings.vehicles = (S.settings.vehicles || []).map((v) => (v.id === el.dataset.veh ? { ...v, name: el.value } : v)); st.saveSettings(); return true; }
  if (el.dataset.tplday) return true;
  return false;
}
export function onChange(el) {
  if (el.dataset.alloc != null || el.dataset.iss || el.dataset.veh) { onInput(el); return true; }
  if (el.dataset.plan || el.dataset.budget) { onInput(el); X.render(); checkNotify(); return true; }
  if (el.dataset.bx) { saveBooks({ [el.dataset.bx]: el.checked }); X.render(); return true; }
  if (el.name === 'taxm') { saveBooks({ taxMethod: el.value }); X.render(); return true; }
  if (el.dataset.planClosed) { const p = { ...(S.settings.sites || {}) }; p[el.dataset.planClosed] = { ...(p[el.dataset.planClosed] || {}), closed: el.checked }; S.settings.sites = p; st.saveSettings(); X.render(); return true; }
  if (el.matches('[data-notify]')) {
    if (el.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      Notification.requestPermission().then((p) => { S.settings.notify = p === 'granted'; st.saveSettings(); if (p !== 'granted') toast('ブラウザの通知が許可されませんでした', { kind: 'error' }); X.render(); checkNotify(); });
      return true;
    }
    S.settings.notify = el.checked; st.saveSettings(); checkNotify(); return true;
  }
  if (el.dataset.tplrec) {
    const t = S.templates.find((x) => x.id === el.dataset.tplrec); if (!t) return true;
    const rule = (S.recurring || []).find((r) => r.tpl === t.id);
    if (!el.checked) { if (rule) st.removeRecurring(rule.id); toast(`「${t.label}」の自動登録をやめました`); return true; }
    const day = Math.min(28, Math.max(1, st.num(el.closest('label').querySelector('[data-tplday]').value) || 25));
    const e = st.expenseFromTemplate(t, today()); const data = { ...e }; for (const k of ['id', 'date', 'created', 'updated', 'status', 'auto']) delete data[k];
    const ym = today().slice(0, 7);
    st.addRecurring({ kind: 'expense', tpl: t.id, label: t.label, day, start: +today().slice(8) <= day ? ym : st.addMonth(ym, 1), last: '', data });
    toast(`「${t.label}」を毎月 ${day}日に自動で登録します`, { kind: 'ok' });
    return true;
  }
  if (el.dataset.tplday) { const rule = (S.recurring || []).find((r) => r.tpl === el.dataset.tplday); const d = Math.min(28, Math.max(1, st.num(el.value) || 25)); el.value = d; if (rule) st.updateRecurring(rule.id, { day: d }); return true; }
  return false;
}

async function promptText(title, label, ph = '') {
  let v = '';
  const r = await modal({ title, width: 420, body: `<label class="fld"><span class="lb">${esc(label)}</span><input id="ptIn" placeholder="${esc(ph)}" autofocus></label>`, actions: [{ label: 'やめる', value: 'no' }, { label: 'OK', value: 'ok', kind: 'primary' }],
    onMount: (el) => { const i = $('#ptIn', el); i.addEventListener('input', () => { v = i.value; }); i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('[data-m="ok"]', el).click(); } }); } });
  return r === 'ok' ? v.trim() : '';
}
const findL = (id) => S.ledger.find((x) => x.id === id);
const syncDone = (r) => { if (r && r.auth && sh.gd.drive.used) { X.renderChrome(); if (X.P.view === 'home' || X.P.view === 'settings') X.render(); return; } if (r && r.merged) toast(`ほかのパソコンの変更を ${r.merged}件取り込みました`, { kind: 'ok' }); X.renderChrome(); if (X.P.view === 'settings') X.render(); };
export const actions = {
  invNew: () => { if (X.P.view !== 'books' || X.P.books.tab !== 'invoice') { X.P.books.tab = 'invoice'; X.go('books'); } editInvoice(null); },
  invEdit: (b) => { const l = findL(b.dataset.id); if (l) editInvoice(l); },
  invPdf: async (b) => { const l = findL(b.dataset.id); if (l) await invoicePdf(l); },
  goInvoices: () => { X.P.books.tab = 'invoice'; X.P.books.from = ''; X.go('books'); },
  bankPick: async () => { const [f] = await pickFile('.csv,.txt,text/csv'); if (f) bankImportFile(f); },
  assetNew: () => editAsset(null),
  assetEdit: (b) => { const a = (bk().fixedAssets || []).find((x) => x.id === b.dataset.id); if (a) editAsset(a); },
  assetDel: async (b) => { const list = bk().fixedAssets || []; const a = list.find((x) => x.id === b.dataset.id); if (!a || !(await confirmDialog(`「${a.name}」を固定資産から消しますか？`, '消す', { danger: true }))) return; saveBooks({ fixedAssets: list.filter((x) => x.id !== a.id) }); X.render(); toast('消しました', { action: { label: '元に戻す', run: () => { saveBooks({ fixedAssets: [...(bk().fixedAssets || []), a] }); X.render(); } } }); },
  payoutNew: () => { if (X.P.view !== 'books' || X.P.books.tab !== 'payout') { X.P.books.tab = 'payout'; X.go('books'); } editPayout(null); },
  payoutEdit: (b) => { const l = findL(b.dataset.id); if (l) editPayout(l); },
  payoutCsv: () => { const r = X.booksRange(); finCsv('payout', r.from, r.to); },
  payoutCsvAn: () => { const r = anRange(); finCsv('payout', r.from, r.to); },
  textJournal: () => textJournal(),
  anTab: (b) => { X.P.an.tab = b.dataset.id; X.render(); },
  anPrev: () => { Object.assign(X.P.an, X.shiftFY(anRange(), -1)); X.render(); },
  anNext: () => { Object.assign(X.P.an, X.shiftFY(anRange(), 1)); X.render(); },
  anYmPrev: () => { X.P.an.ym = st.addMonth(X.P.an.ym, -1); X.render(); },
  anYmNext: () => { X.P.an.ym = st.addMonth(X.P.an.ym, 1); X.render(); },
  anSiteList: (b) => { Object.assign(X.P.list, { mode: 'all', status: 'all', cat: '', site: b.dataset.id, method: '', q: '' }); X.go('list'); },
  goBudget: () => { X.P.an.tab = 'budget'; X.P.an.ym = today().slice(0, 7); X.go('analysis'); },
  siteAdd: async () => { const n = await promptText('現場を追加', '現場・案件の名前', '例: A邸 新築工事'); if (!n) return; S.settings.sites = { ...(S.settings.sites || {}), [n]: (S.settings.sites || {})[n] || { budget: 0, contract: 0 } }; st.saveSettings(); X.P.an.tab = 'site'; if (X.P.view !== 'analysis') X.go('analysis'); else X.render(); },
  vehAdd: async () => { const n = await promptText('車を登録', '車の名前', '例: 軽トラ（品川 480 あ 12-34）'); if (!n) return; S.settings.vehicles = [...(S.settings.vehicles || []), { id: newId('v'), name: n }]; st.saveSettings(); X.render(); },
  vehDel: async (b) => { const v = (S.settings.vehicles || []).find((x) => x.id === b.dataset.id); if (!v || !(await confirmDialog(`「${v.name}」の登録をやめますか？（経費は消えません）`, 'やめる', { danger: true }))) return; S.settings.vehicles = S.settings.vehicles.filter((x) => x.id !== v.id); st.saveSettings(); X.render(); },
  vehList: (b) => { const v = (S.settings.vehicles || []).find((x) => x.id === b.dataset.id); Object.assign(X.P.list, { mode: 'all', status: 'all', cat: '', site: '', method: '', q: '', vehicle: b.dataset.id }); X.go('list'); if (v) toast(`${v.name} の経費だけを表示しています`); },
  yearCsv: () => { const y = yearCompare({ journals: X.allJournals(), settings: S.settings, expenses: S.expenses, ledger: S.ledger, today: today() }); csvOut([['科目', '前期', '今期', '増減'], ...y.cats.map((c) => [c.name, c.prev, c.cur, c.diff]), ['売上', y.p.revenue, y.a.revenue, y.a.revenue - y.p.revenue], ['利益', y.p.profit, y.a.profit, y.a.profit - y.p.profit]].map((r) => r.join(',')).join('\r\n'), `年次まとめ_${y.cur.from}_${y.cur.to}.csv`); },
  apvImport: async () => { const [f] = await pickFile('.json,application/json'); if (f && !(await importJson(f))) toast('提出ファイル・結果ファイルではありません（バックアップは［設定 → データ］から取り込めます）', { kind: 'error' }); },
  apvSubmit: (b) => apvSubmit(b.dataset.id),
  apvOpen: (b) => apvOpen(b.dataset.id),
  syncChoose: async () => { try { await sh.chooseSyncFolder(); const r = await sh.syncNow(); toast(r.ok ? `「${sh.syncState.handle.name}」に保存しました。これから自動で同期します` : `同期できませんでした: ${r.error || ''}`, { kind: r.ok ? 'ok' : 'error' }); syncDone(r); } catch (e) { if (e.name !== 'AbortError') toast(`フォルダを選べませんでした: ${e.message || e}`, { kind: 'error' }); } },
  syncReconnect: async () => { if (await sh.reconnectSync()) { const r = await sh.syncNow(); syncDone(r); toast('同期フォルダにつながりました', { kind: 'ok' }); } X.render(); },
  syncNow: async (b) => { if (b) b.disabled = true; const r = await sh.syncNow(); if (b) b.disabled = false; if (r.ok) toast(`同期しました${r.merged ? `（${r.merged}件を取り込み）` : ''}`, { kind: 'ok' }); else toast(`同期できませんでした${r.error ? `: ${r.error}` : ''}`, { kind: 'error' }); syncDone(null); },
  driveConnect: async () => {
    const gd = sh.gd;
    if (!gd.configured()) {
      let id = '';
      const r = await modal({ title: 'Google ドライブにつなぐ準備', width: 600,
        body: `<p>Google ドライブにつなぐには、Google Cloud で作る「OAuth クライアント ID」が 1 つ必要です（無料・10 分ほど）。作り方は <code>keihi/docs/google-drive.md</code> にあります。公開するときに <code>config.js</code> に書いておけば、この手順は要りません。</p>
          <label class="fld"><span class="lb">OAuth クライアント ID</span><input id="gcid" placeholder="123456789-xxxx.apps.googleusercontent.com" autofocus></label><p class="form-err" hidden></p>`,
        actions: [{ label: 'やめる', value: 'no' }, { label: '保存してつなぐ', value: 'ok', kind: 'primary' }],
        onMount: (el) => { $('#gcid', el).addEventListener('input', (ev) => { id = ev.target.value.trim(); }); guard(el, ['ok'], () => (/\.apps\.googleusercontent\.com$/.test(id) ? '' : '「…apps.googleusercontent.com」で終わる ID を貼り付けてください')); } });
      if (r !== 'ok') return;
      gd.setClientId(id);
    }
    try { await gd.connect(); } catch (e) { toast(e.message, { kind: 'error', ms: 7000 }); X.render(); return; }
    const close = toast('Google ドライブと同期しています…（はじめは画像の数だけ時間がかかります）', { ms: 120000 });
    const r = await sh.syncNow(); close();
    toast(r.ok ? `Google ドライブ（${gd.drive.email || 'マイドライブ'}）と同期しました${r.merged ? `。${r.merged}件を取り込みました` : ''}${r.imgUp ? `。画像 ${r.imgUp}枚を送りました` : ''}` : `同期できませんでした: ${r.error || ''}`, { kind: r.ok ? 'ok' : 'error', ms: 7000 });
    syncDone(null); X.render();
  },
  driveOff: async () => { if (!(await confirmDialog('Google ドライブとの同期をやめますか？（ドライブのファイルは消えません。この端末のデータもそのままです）', 'やめる'))) return; sh.gd.disconnect(); X.render(); X.renderChrome(); },
  syncForget: async () => { if (!(await confirmDialog('同期フォルダへの自動保存をやめますか？（フォルダの中のファイルは消えません）', 'やめる'))) return; await sh.forgetSync(); X.render(); X.renderChrome(); },
  histAll: () => histAll(),
  ruleDoc: () => ruleDoc(),
  recPause: (b) => { const r = S.recurring.find((x) => x.id === b.dataset.id); if (r) st.updateRecurring(r.id, { paused: !r.paused }); },
  recDel: async (b) => { const r = S.recurring.find((x) => x.id === b.dataset.id); if (r && await confirmDialog(`「${r.label || ''}」の毎月の自動登録をやめますか？（登録済みの記録は消えません）`, 'やめる', { danger: true })) st.removeRecurring(r.id); },
};

// ---- はじめ ------------------------------------------------------------------
export async function startExtras() {
  try { const made = await st.runRecurring(); if (made.length) toast(`毎月の自動登録で ${made.length}件を入れました`, { kind: 'ok', ms: 6000 }); } catch (_) { /* なし */ }
  loadApprovals().then(() => X.renderChrome());
  try { await sh.loadSyncFolder(); } catch (_) { /* 使えない */ }
  if ((sh.syncState.handle && sh.syncState.permission === 'granted') || sh.gd.connected()) sh.syncNow().then(syncDone);
  sh.startAutoSync(syncDone);
  st.on('change', debounceNotify);
  checkNotify();
  X.renderChrome();
}
let nt = null;
function debounceNotify() { clearTimeout(nt); nt = setTimeout(checkNotify, 1500); }
export const accountTypeOf = (a) => accountType(a, bk().mode);
