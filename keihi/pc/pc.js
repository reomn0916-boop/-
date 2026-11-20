// ラク経費 パソコン版: 画面と操作。データの扱いは ../js/store.js（スマホ版と共通・同じ保存場所）
import * as st from '../js/store.js';
import { usage } from '../js/db.js';
import { readWithClaude, AI_MODELS, AiError } from '../js/ocr.js';
import { DEFAULT_CATEGORIES, checkInvoiceNo } from '../js/parse.js';
import { renderReport, pagesToPdf, toCSV, toJournalCSV, summarize, sortForReport, memoOf, renderStatements, toTrialCSV, toJournalBookCSV } from '../js/report.js';
import { journalsFrom, buildStatements, fiscalRange, booksOf, accountGroups, ASSET_ACCOUNTS, LIABILITY_ACCOUNTS, REVENUE_ACCOUNTS, MODES } from '../js/books.js';
import {
  $, $$, esc, ic, kbd, MOD, yen, md, mdw, ymd, jpYM, wd, ago, debounce, toast, modal, confirmDialog, menu, closeTop, topLayer, hideTip, download,
} from './ui.js';
import { columnChart, barList } from './charts.js';
import { Editor } from './editor.js';
import * as FX from './features.js';

const { S } = st;
const today = () => st.todayISO();
const thisYM = () => st.ymOf(today());
const LSP = 'rakukeihi.pc.';
const pget = (k, d) => { try { const v = localStorage.getItem(LSP + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
const pset = (k, v) => { try { localStorage.setItem(LSP + k, JSON.stringify(v)); } catch (_) { /* 容量不足など */ } };

// ---- 画面の状態 ----------------------------------------------------------------
const P = {
  view: 'home',
  list: { mode: 'month', ym: thisYM(), from: '', to: '', status: 'all', cat: '', site: '', method: '', q: '', sort: 'date', dir: -1, sel: new Set(), cursor: null, anchor: null, limit: 300, ...pget('list', {}), ...{ sel: new Set(), cursor: null, anchor: null, q: '' } },
  ed: null, edIds: null,
  review: { id: null, skipped: [] },
  rep: { mode: 'unsettled', from: '', to: '', includeDone: false, advance: '', pages: null, sum: null, sig: '', token: 0, zoom: pget('zoom', 0.6) },
  books: { tab: 'income', from: '', to: '' },
  fin: { mode: 'this', from: '', to: '', pages: null, sig: '', zoom: pget('finZoom', 0.6) },
};
P.list.ym = thisYM();

const VIEWS = {
  home: { title: 'ホーム', sub: () => `${ymd(today())}（${wd(today())}）` },
  review: { title: '確認待ち', sub: () => '読み取った内容を確かめて確定します。Ctrl+Enter で確定して次へ。' },
  list: { title: '経費一覧', sub: () => '並べ替え・まとめて変更・CSV の書き出し' },
  report: { title: '精算書', sub: () => '期間を選ぶと、そのまま提出できる精算書ができます' },
  books: { title: '帳簿', sub: () => '売上・収入、振替伝票、仕訳帳、期首残高' },
  statements: { title: '決算書', sub: () => '損益計算書・貸借対照表をボタンひとつで' },
  analysis: { title: '分析', sub: () => '現場別の損益・予算・車両・外注先・年次まとめ' },
  approvals: { title: '承認', sub: () => '精算をファイルで提出して、承認・差し戻しを受け取ります' },
  templates: { title: 'よく使う', sub: () => '毎回同じ経費を、ワンクリックで入れられます' },
  settings: { title: '設定', sub: () => '申請者・読み取り方・データの管理' },
};

// ---- 集計の道具 ---------------------------------------------------------------
const confirmed = () => S.expenses.filter((e) => e.status !== 'draft');
const drafts = () => S.expenses.filter((e) => e.status === 'draft').sort((a, b) => (a.created || 0) - (b.created || 0));
const sumOf = (l) => l.reduce((s, e) => s + (e.amount || 0), 0);
const unsettled = () => confirmed().filter((e) => e.status === 'ok' && !st.isCompanyPaid(e));
function groupSum(list, key) {
  const m = new Map();
  for (const e of list) { const k = key(e) || '（なし）'; const g = m.get(k) || { label: k, value: 0, count: 0 }; g.value += e.amount || 0; g.count++; m.set(k, g); }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

// ---- 経費一覧の絞り込み ---------------------------------------------------------
function listRange() {
  const L = P.list;
  if (L.mode === 'month') return { from: `${L.ym}-01`, to: st.monthEnd(L.ym), label: jpYM(L.ym) };
  if (L.mode === 'year') { const y = L.ym.slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}年` }; }
  if (L.mode === 'range') return { from: L.from || '0000-01-01', to: L.to || '9999-12-31', label: `${L.from ? md(L.from) : ''}〜${L.to ? md(L.to) : ''}` };
  return { from: '0000-01-01', to: '9999-12-31', label: 'すべての期間' };
}
const SORTS = {
  date: (e) => `${e.date || ''}${String(e.created || 0).padStart(15, '0')}`,
  payee: (e) => e.payee || '', category: (e) => e.category || '', site: (e) => e.site || '', method: (e) => e.method || '',
  amount: (e) => e.amount || 0, status: (e) => ({ draft: 0, ok: 1, done: 2 }[e.status] ?? 3),
};
function listItems() {
  const L = P.list; const { from, to } = listRange();
  const q = L.q.trim().normalize('NFKC').toLowerCase(); const qn = st.num(q);
  const list = S.expenses.filter((e) => {
    if ((e.date || '') < from || (e.date || '') > to) { if (!(e.status === 'draft' && !e.date)) return false; }
    if (L.status !== 'all' && e.status !== L.status) return false;
    if (L.cat && e.category !== L.cat) return false;
    if (L.site && (e.site || '') !== (L.site === '（なし）' ? '' : L.site)) return false;
    if (L.method && e.method !== L.method) return false;
    if (L.amin && (e.amount ?? -1) < L.amin) return false;
    if (L.amax && (e.amount ?? Infinity) > L.amax) return false;
    if (L.vehicle && e.vehicle !== L.vehicle) return false;
    if (!q) return true;
    const hay = [e.payee, e.memo, e.site, e.category, e.method, e.guests, e.invoiceNo, e.route && e.route.from, e.route && e.route.to, e.fileName].join(' ').normalize('NFKC').toLowerCase();
    return hay.includes(q) || (qn != null && e.amount === qn);
  });
  const f = SORTS[L.sort] || SORTS.date;
  return list.sort((a, b) => { const x = f(a); const y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * L.dir; });
}
const saveListPrefs = () => { const { status, sort, dir, mode } = P.list; pset('list', { status, sort, dir, mode: mode === 'range' ? 'month' : mode }); };

// ---- 共通の部品 ---------------------------------------------------------------
const STATUS = { draft: ['確認待ち', 'draft', 'clock'], ok: ['未精算', 'ok', 'doc'], done: ['精算済み', 'done', 'checkCircle'] };
const badge = (s) => { const [l, c, i] = STATUS[s] || ['', '', '']; return `<span class="badge ${c}">${ic(i)}${l}</span>`; };
const kindIcon = (e) => (e.kind === 'car' ? 'car' : e.kind === 'transit' ? 'train' : e.source === 'pdf' ? 'doc' : 'receipt');
const routeText = (e) => (e.route && (e.route.from || e.route.to) ? `${e.route.from || ''} → ${e.route.to || ''}${e.route.round ? '（往復）' : ''}` : '');

function thumbHTML(e, size = '') {
  if (e.imageId) return `<span class="thumb ${size}"><img data-thumb="${e.imageId}" alt="">${e.source === 'pdf' ? '<b class="pdf">PDF</b>' : ''}</span>`;
  return `<span class="thumb ${size} icon">${ic(kindIcon(e))}</span>`;
}
function hydrate(root) {
  $$('img[data-thumb]', root).forEach(async (img) => {
    const id = img.dataset.thumb; img.removeAttribute('data-thumb');
    const url = await st.thumbURL(id); if (url) img.src = url;
  });
}
function ocrCell(e) {
  const o = S.ocr.get(e.id);
  if (!o || (o.state !== 'run' && o.state !== 'wait')) return '';
  return `<span class="mini-ocr"><span class="spin"></span>${o.state === 'wait' ? '順番待ち' : `読み取り中 ${Math.round((o.p || 0) * 100)}%`}</span>`;
}
function fillDatalists() {
  $('#dlPayee').innerHTML = st.recentPayees().map((p) => `<option value="${esc(p)}">`).join('');
  $('#dlSite').innerHTML = st.recentSites().map((p) => `<option value="${esc(p)}">`).join('');
  $('#dlPlace').innerHTML = st.recentPlaces().map((p) => `<option value="${esc(p)}">`).join('');
}
function emptyState(icon, title, text, actions = '') {
  return `<div class="empty"><div class="empty-ic">${ic(icon)}</div><h3>${esc(title)}</h3><p>${text}</p>${actions ? `<div class="empty-acts">${actions}</div>` : ''}</div>`;
}

// ===========================================================================
// ホーム
// ===========================================================================
function viewHome() {
  const ym = thisYM(); const prev = st.addMonth(ym, -1);
  const conf = confirmed();
  const month = conf.filter((e) => st.ymOf(e.date) === ym);
  const last = conf.filter((e) => st.ymOf(e.date) === prev);
  const mSum = sumOf(month); const lSum = sumOf(last);
  const un = unsettled(); const unSum = sumOf(un);
  const oldest = un.map((e) => e.date).sort()[0];
  const dr = drafts(); const reading = st.readingCount();
  const yearSum = sumOf(conf.filter((e) => (e.date || '').startsWith(ym.slice(0, 4))));
  const delta = lSum ? Math.round(((mSum - lSum) / lSum) * 100) : null;
  const old = un.filter((e) => st.ymOf(e.date) < ym);
  const recent = [...S.expenses].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 7);
  const noData = !S.expenses.length;

  if (noData) {
    return `<div class="home-empty">
      <div class="dropzone big" data-act="import">
        <div class="dz-ic">${ic('upload')}</div>
        <h2>レシートの画像や PDF を、ここにドラッグ</h2>
        <p>金額・日付・お店・勘定科目・登録番号を自動で読み取ります。何枚でもまとめてどうぞ。</p>
        <div class="dz-acts"><button class="btn primary lg" data-act="import">${ic('upload')}ファイルを選ぶ</button><button class="btn lg" data-act="importFolder">${ic('folder')}フォルダから</button></div>
      </div>
      <div class="start-grid">
        <button class="start-card" data-act="newTransit">${ic('train')}<b>電車・バスを入れる</b><span>区間と運賃だけ。往復も 1 回で</span></button>
        <button class="start-card" data-act="newCar">${ic('car')}<b>車の距離で入れる</b><span>km × 単価で自動計算</span></button>
        <button class="start-card" data-act="importBackup">${ic('phone')}<b>スマホのデータを取り込む</b><span>スマホ版の「パソコンへ送る」で作ったファイル</span></button>
        <button class="start-card" data-view-go="settings">${ic('pen')}<b>申請者を設定する</b><span>精算書にのる会社名・氏名</span></button>
      </div>
    </div>`;
  }

  return `
    ${FX.homeAlerts()}
    ${old.length ? `<button class="banner" data-act="settleOld">${ic('doc')}<span><b>先月までの未精算が ${old.length}件（${yen(sumOf(old))}）あります</b><small>精算書を作って提出しましょう</small></span><span class="banner-go">精算書を作る ${ic('arrowR')}</span></button>` : ''}
    <div class="kpis">
      <section class="card kpi hero">
        <span class="kpi-l">${+ym.slice(5)}月の経費</span>
        <b class="kpi-v">${yen(mSum)}</b>
        <span class="kpi-s">${month.length}件${delta != null ? ` ・ 先月 ${yen(lSum)}（${delta >= 0 ? '+' : ''}${delta}%）` : ''}</span>
      </section>
      <section class="card kpi">
        <span class="kpi-l">未精算の立替</span>
        <b class="kpi-v">${yen(unSum)}</b>
        <span class="kpi-s">${un.length}件${oldest ? ` ・ いちばん古い ${md(oldest)}` : ''}</span>
        <button class="kpi-act" data-act="goReport" ${un.length ? '' : 'disabled'}>精算書を作る ${ic('arrowR')}</button>
      </section>
      <section class="card kpi ${dr.length ? 'attn' : ''}">
        <span class="kpi-l">確認待ち</span>
        <b class="kpi-v">${dr.length}<small>件</small></b>
        <span class="kpi-s">${reading ? `<span class="spin"></span>読み取り中 ${reading}件` : dr.length ? '読み取りが終わっています' : 'すべて確認済み'}</span>
        <button class="kpi-act" data-view-go="review" ${dr.length ? '' : 'disabled'}>確認を始める ${ic('arrowR')}</button>
      </section>
      <section class="card kpi">
        <span class="kpi-l">${ym.slice(0, 4)}年の合計</span>
        <b class="kpi-v">${yen(yearSum)}</b>
        <span class="kpi-s">1月から今日まで</span>
        <button class="kpi-act" data-view-go="statements">決算書を作る ${ic('arrowR')}</button>
      </section>
    </div>
    <div class="dash">
      <section class="card chart-card span2">
        <header><h2>月ごとの経費</h2><span class="muted">直近12か月・確定した経費</span><button class="link sm" data-act="chartTable">${ic('table')}表で見る</button></header>
        <div id="chMonth" class="chart-host"></div>
        <div id="chMonthTable" hidden></div>
      </section>
      <section class="card">
        <header><h2>勘定科目別</h2><span class="muted">${+ym.slice(5)}月</span></header>
        <div id="chCat"></div>
      </section>
      <section class="card span2">
        <header><h2>最近の動き</h2><button class="link sm" data-view-go="list">すべて見る ${ic('arrowR')}</button></header>
        <div class="mini-list">${recent.map((e) => `
          <button class="mini-row" data-open="${e.id}">
            ${thumbHTML(e, 'sm')}
            <span class="mr-main"><b>${esc(e.payee || (S.ocr.has(e.id) ? '読み取り中…' : '支払先なし'))}</b><small>${esc([e.category, e.site].filter(Boolean).join(' ・ ')) || '&nbsp;'}</small></span>
            <span class="mr-date">${md(e.date)}</span>
            <span class="mr-amt">${e.amount != null ? yen(e.amount) : '—'}</span>
            ${badge(e.status)}
          </button>`).join('')}</div>
      </section>
      <section class="card">
        <header><h2>現場・案件別</h2><span class="muted">${+ym.slice(5)}月</span></header>
        <div id="chSite"></div>
      </section>
      <section class="card span3 quick-card">
        <div class="dropzone" data-act="import">${ic('upload')}<span><b>画像・PDF をドラッグして取り込む</b><small>貼り付け（${MOD}+V）・フォルダ（${MOD}+Shift+O）でも取り込めます</small></span></div>
        <div class="tpl-strip">
          <h3>${ic('star')}よく使う</h3>
          ${S.templates.length ? S.templates.slice(0, 6).map((t) => `<button class="tpl" data-tpl="${t.id}" title="今日の分を追加"><span>${esc(t.label)}</span><b>${t.amount ? yen(t.amount) : ''}</b></button>`).join('') : '<p class="muted">経費の詳細で「よく使うに登録」すると、ここからワンクリックで入れられます。</p>'}
        </div>
      </section>
    </div>`;
}

function afterHome() {
  const host = $('#chMonth'); if (!host) return;
  const ym = thisYM();
  const conf = confirmed();
  const months = [];
  for (let k = 11; k >= 0; k--) {
    const m = st.addMonth(ym, -k);
    const l = conf.filter((e) => st.ymOf(e.date) === m);
    months.push({ key: m, label: jpYM(m), short: `${+m.slice(5)}月`, value: sumOf(l), count: l.length });
  }
  columnChart(host, months, { current: ym, onPick: (d) => { Object.assign(P.list, { mode: 'month', ym: d.key, status: 'all', cat: '', site: '', method: '' }); go('list'); } });
  $('#chMonthTable').innerHTML = `<table class="mini-table"><thead><tr><th>月</th><th class="num">件数</th><th class="num">合計</th></tr></thead><tbody>${months.map((d) => `<tr><td>${d.label}</td><td class="num">${d.count}</td><td class="num">${yen(d.value)}</td></tr>`).join('')}</tbody></table>`;
  const month = conf.filter((e) => st.ymOf(e.date) === ym);
  barList($('#chCat'), groupSum(month, (e) => e.category), { empty: '今月の経費はまだありません', onPick: (r) => { Object.assign(P.list, { mode: 'month', ym, cat: r.label, site: '', status: 'all' }); go('list'); } });
  barList($('#chSite'), groupSum(month, (e) => e.site), { empty: '今月の経費はまだありません', onPick: (r) => { Object.assign(P.list, { mode: 'month', ym, site: r.label, cat: '', status: 'all' }); go('list'); } });
}

// ===========================================================================
// 経費一覧
// ===========================================================================
function viewList() {
  const L = P.list;
  const items = listItems();
  const r = listRange();
  const sum = summarize(items.filter((e) => e.status !== 'draft'));
  const selItems = items.filter((e) => L.sel.has(e.id));
  const all = items.length && selItems.length === items.length;
  const shown = items.slice(0, L.limit);
  const sitesAll = [...new Set(S.expenses.map((e) => e.site).filter(Boolean))].sort();
  const th = (key, label, cls = '') => `<th class="${cls} sortable ${L.sort === key ? 'sorted' : ''}" data-sort="${key}" aria-sort="${L.sort === key ? (L.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button>${label}${L.sort === key ? ic(L.dir > 0 ? 'chevU' : 'chevD', 'sort-ic') : ''}</button></th>`;
  const st2 = [['all', 'すべて'], ['draft', '確認待ち'], ['ok', '未精算'], ['done', '精算済み']];
  const filterOn = L.cat || L.site || L.method || L.q || L.amin || L.amax || L.vehicle;
  const veh = L.vehicle && (S.settings.vehicles || []).find((v) => v.id === L.vehicle);
  return `
    <div class="list-page">
      <div class="toolbar">
       <div class="tb-row">
        <div class="period">
          <button class="icon-btn" data-act="listPrev" ${L.mode === 'month' ? '' : 'disabled'} title="前の月">${ic('chevL')}</button>
          <button class="period-btn" data-act="periodMenu">${ic('calendar')}<b>${esc(r.label)}</b>${ic('chevD', 'caret')}</button>
          <button class="icon-btn" data-act="listNext" ${L.mode === 'month' ? '' : 'disabled'} title="次の月">${ic('chevR')}</button>
        </div>
        <div class="seg">${st2.map(([k, v]) => `<button class="${L.status === k ? 'on' : ''}" data-lstatus="${k}">${v}${k === 'draft' && drafts().length ? `<em>${drafts().length}</em>` : ''}</button>`).join('')}</div>
        <span class="grow"></span>
        <label class="search">${ic('search')}<input id="q" type="search" placeholder="支払先・内容・現場・金額" value="${esc(L.q)}"><span class="kbd"><kbd>/</kbd></span></label>
        <button class="btn sm" data-act="exportMenu" title="CSV に書き出す">${ic('download')}<span>書き出す</span>${ic('chevD', 'caret')}</button>
       </div>
       <div class="tb-row filters">
        <label class="select sm">${ic('tag')}<select id="fCat"><option value="">すべての科目</option>${st.cats().map((c) => `<option ${L.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>${ic('chevD', 'caret')}</label>
        <label class="select sm">${ic('pin')}<select id="fSite"><option value="">すべての現場</option>${sitesAll.map((c) => `<option ${L.site === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option ${L.site === '（なし）' ? 'selected' : ''}>（なし）</option></select>${ic('chevD', 'caret')}</label>
        <label class="select sm">${ic('card')}<select id="fMethod"><option value="">すべての支払</option>${st.METHODS.map((c) => `<option ${L.method === c ? 'selected' : ''}>${c}</option>`).join('')}</select>${ic('chevD', 'caret')}</label>
        <span class="amt-range" title="金額の範囲（電子帳簿保存法の検索にも）">${ic('cash')}<input id="fAmin" inputmode="numeric" placeholder="金額 下限" value="${L.amin ? L.amin.toLocaleString('ja-JP') : ''}"><span>〜</span><input id="fAmax" inputmode="numeric" placeholder="上限" value="${L.amax ? L.amax.toLocaleString('ja-JP') : ''}"></span>
        ${veh ? `<span class="chip on sm">${ic('car')}${esc(veh.name)}</span>` : ''}
        ${filterOn ? `<button class="link sm" data-act="clearFilters">${ic('x')}条件をはずす</button>` : ''}
       </div>
      </div>
      <div class="sumbar">
        <span><b>${items.length}</b>件</span>
        <span>立替 <b>${yen(sum.reimb)}</b></span>
        ${sum.company ? `<span>会社払い <b>${yen(sum.company)}</b></span>` : ''}
        ${items.some((e) => e.status === 'draft') ? `<span class="muted">確認待ち ${items.filter((e) => e.status === 'draft').length}件は合計に入りません</span>` : ''}
      </div>
      <div class="table-wrap" id="tableWrap">
        ${items.length ? `
        <table class="grid" aria-label="経費の一覧" aria-rowcount="${items.length}">
          <thead><tr>
            <th class="c-check"><input type="checkbox" id="selAll" ${all ? 'checked' : ''} aria-label="すべて選ぶ"></th>
            <th class="c-img"></th>
            ${th('date', '日付', 'c-date')}${th('payee', '支払先・内容', 'c-payee')}${th('category', '勘定科目', 'c-cat')}${th('site', '現場・案件', 'c-site')}${th('method', '支払', 'c-method')}
            <th class="c-inv" title="適格請求書（登録番号）">適格</th>
            ${th('amount', '金額', 'c-amt num')}${th('status', '状態', 'c-status')}
          </tr></thead>
          <tbody>${shown.map((e) => rowHTML(e)).join('')}</tbody>
        </table>
        ${items.length > shown.length ? `<div class="more-rows"><button class="btn" data-act="moreRows">さらに表示（残り ${items.length - shown.length}件）</button></div>` : ''}`
        : emptyState('search', filterOn || L.status !== 'all' ? '条件に合う経費はありません' : 'この期間の経費はありません', filterOn ? '条件をはずすか、期間を変えてみてください。' : 'レシートの画像や PDF をドラッグすると、ここに並びます。', filterOn ? `<button class="btn" data-act="clearFilters">条件をはずす</button>` : `<button class="btn primary" data-act="import">${ic('upload')}取り込む</button>`)}
      </div>
      ${selItems.length ? `
      <div class="bulk" role="toolbar" aria-label="選んだ経費の操作">
        <span class="bulk-n"><b>${selItems.length}件</b>を選択 ・ ${yen(sumOf(selItems))}</span>
        <button class="btn sm" data-act="bulkCat">${ic('tag')}科目</button>
        <button class="btn sm" data-act="bulkSite">${ic('pin')}現場</button>
        <button class="btn sm" data-act="bulkMethod">${ic('card')}支払</button>
        ${selItems.some((e) => e.status === 'draft') ? `<button class="btn sm" data-act="bulkConfirm">${ic('check')}確定</button>` : ''}
        <button class="btn sm" data-act="bulkReport">${ic('doc')}精算書に</button>
        <button class="btn sm" data-act="bulkCsv">${ic('table')}CSV</button>
        <button class="btn sm danger-ghost" data-act="bulkDelete">${ic('trash')}削除</button>
        <button class="icon-btn sm" data-act="bulkClear" title="選択をやめる（Esc）">${ic('x')}</button>
      </div>` : ''}
    </div>`;
}

function rowHTML(e) {
  const L = P.list;
  const sel = L.sel.has(e.id); const cur = L.cursor === e.id; const open = P.ed && P.ed.id === e.id;
  const sub = [routeText(e), memoOf(e) && e.kind === 'receipt' ? e.memo : (e.kind === 'car' && e.km ? `${e.km}km` : '')].filter(Boolean).join(' ・ ');
  const invState = e.invoiceNo ? (checkInvoiceNo(e.invoiceNo) ? 'ok' : 'ng') : '';
  return `<tr data-id="${e.id}" class="${sel ? 'sel' : ''} ${cur ? 'cur' : ''} ${open ? 'open' : ''} st-${e.status}" aria-selected="${sel}">
    <td class="c-check"><input type="checkbox" data-sel="${e.id}" ${sel ? 'checked' : ''} aria-label="選ぶ"></td>
    <td class="c-img">${thumbHTML(e, 'xs')}</td>
    <td class="c-date">${e.date ? `<b>${md(e.date)}</b><small>${wd(e.date)}</small>` : '<span class="muted">—</span>'}</td>
    <td class="c-payee"><b>${esc(e.payee) || `<span class="muted">${S.ocr.has(e.id) ? '読み取り中…' : '支払先なし'}</span>`}</b>${ocrCell(e) || (sub ? `<small>${esc(sub)}</small>` : '')}</td>
    <td class="c-cat">${e.category ? `<span class="tag">${esc(e.category)}</span>` : '<span class="muted">—</span>'}</td>
    <td class="c-site">${esc(e.site) || '<span class="muted">—</span>'}</td>
    <td class="c-method">${esc(e.method)}</td>
    <td class="c-inv">${invState === 'ok' ? ic('checkCircle', 'inv-ok') : invState === 'ng' ? `<span title="番号を確認してください">${ic('warn', 'inv-ng')}</span>` : ''}</td>
    <td class="c-amt num">${e.amount != null ? `${st.isCompanyPaid(e) ? '<small class="co">会社</small>' : ''}<b>${yen(e.amount)}</b>` : '<span class="muted">—</span>'}</td>
    <td class="c-status">${badge(e.status)}</td>
  </tr>`;
}

function afterList() {
  const w = $('#tableWrap'); if (w && P.list.scroll) w.scrollTop = P.list.scroll;
  if (w) w.addEventListener('scroll', () => { P.list.scroll = w.scrollTop; }, { passive: true });
}

function setCursor(id, { scroll = true } = {}) {
  P.list.cursor = id;
  $$('#tableWrap tr[data-id]').forEach((tr) => tr.classList.toggle('cur', tr.dataset.id === id));
  if (scroll) { const tr = $(`#tableWrap tr[data-id="${id}"]`); if (tr) tr.scrollIntoView({ block: 'nearest' }); }
}

function toggleSel(id, { range = false, only = false } = {}) {
  const L = P.list;
  if (range && L.anchor) {
    const ids = listItems().map((e) => e.id);
    const a = ids.indexOf(L.anchor); const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) { const [x, y] = a < b ? [a, b] : [b, a]; ids.slice(x, y + 1).forEach((i) => L.sel.add(i)); }
  } else if (only) { L.sel = new Set([id]); L.anchor = id; } else {
    if (L.sel.has(id)) L.sel.delete(id); else L.sel.add(id);
    L.anchor = id;
  }
  render();
}

// ===========================================================================
// 確認待ち（読み取った内容を 1 件ずつ確定）
// ===========================================================================
let reviewEd = null;
function reviewQueue() {
  const d = drafts();
  const sk = P.review.skipped.filter((id) => d.some((e) => e.id === id));
  return [...d.filter((e) => !sk.includes(e.id)), ...sk.map((id) => d.find((e) => e.id === id))];
}
function viewReview() {
  const q = reviewQueue();
  if (!q.length) {
    destroyReview();
    return `<div class="review-empty">${emptyState('checkCircle', 'すべて確認しました', S.expenses.length ? '確認待ちの経費はありません。新しいレシートは、画像や PDF をドラッグするだけで取り込めます。' : 'レシートの画像や PDF を取り込むと、ここで 1 件ずつ確認できます。',
      `<button class="btn primary" data-act="import">${ic('upload')}取り込む</button>${unsettled().length ? `<button class="btn" data-act="goReport">${ic('doc')}精算書を作る</button>` : ''}`)}</div>`;
  }
  if (!P.review.id || !q.some((e) => e.id === P.review.id)) P.review.id = q[0].id;
  return `<div class="review">
    <aside class="rv-rail" id="rvRail"></aside>
    <div class="rv-ed" id="rvEd"></div>
  </div>`;
}
function railHTML(q) {
  const ready = q.filter((e) => e.amount && e.date && e.category && !st.isReading(e.id)).length;
  return `<div class="rv-head"><b>${q.length}件</b><span class="muted">${st.readingCount() ? `読み取り中 ${st.readingCount()}` : '読み取り完了'}</span>
      ${ready > 1 ? `<button class="link sm" data-act="confirmAll" title="金額・日付・科目がそろったものをまとめて確定">${ready}件をまとめて確定</button>` : ''}</div>
    <div class="rv-list">${q.map((e, i) => `
      <button class="rv-item ${e.id === P.review.id ? 'on' : ''}" data-rv="${e.id}">
        ${thumbHTML(e, 'sm')}
        <span class="rv-main"><b>${esc(e.payee) || (st.isReading(e.id) ? '読み取り中…' : '支払先なし')}</b><small>${ocrCell(e) || `${md(e.date)} ・ ${esc(e.category || '科目なし')}`}</small></span>
        <span class="rv-amt">${e.amount != null ? yen(e.amount) : '—'}</span>
        <span class="rv-no">${i + 1}</span>
      </button>`).join('')}</div>`;
}
function afterReview() {
  const q = reviewQueue(); if (!q.length) return;
  const rail = $('#rvRail');
  rail.innerHTML = railHTML(q);
  hydrate(rail);
  const on = $('.rv-item.on', rail); if (on) on.scrollIntoView({ block: 'nearest' });
  const id = P.review.id;
  if (!reviewEd || reviewEd.id !== id || !document.body.contains(reviewEd.root)) mountReviewEditor(id, q);
  else { const pos = `${q.findIndex((e) => e.id === id) + 1} / ${q.length}`; const p = $('.ed-pos', reviewEd.root); if (p) p.textContent = pos; }
}
function mountReviewEditor(id, q = reviewQueue()) {
  destroyReview();
  const e = st.byId(id); if (!e) return;
  const host = $('#rvEd'); if (!host) return;
  reviewEd = new Editor(host, e, {
    mode: 'review', position: `${q.findIndex((x) => x.id === id) + 1} / ${q.length}`,
    onClose: (o) => {
      if (o && o.open) { go('list'); openDrawer(o.open, { isNew: true }); } else if (o && o.deleted) { const i = q.findIndex((x) => x.id === id); const rest = q.filter((x) => x.id !== id); P.review.id = rest.length ? (rest[Math.min(i, rest.length - 1)] || rest[0]).id : null; } else go('home');
    },
    onSaved: (c) => {
      toast(`確定しました: ${c.payee || ''} ${yen(c.amount)}`, { kind: 'ok', ms: 2200 });
      P.review.skipped = P.review.skipped.filter((x) => x !== c.id);
      const rest = reviewQueue(); const i = q.findIndex((x) => x.id === c.id);
      P.review.id = rest.length ? (rest[Math.min(Math.max(0, i), rest.length - 1)] || rest[0]).id : null;
      reviewEd.destroy(); reviewEd = null;
      render();
      if (reviewEd) reviewEd.focusFirst();
    },
    onNav: (dir, { skip = false } = {}) => {
      const list = reviewQueue();
      let i = list.findIndex((x) => x.id === P.review.id);
      if (skip) { P.review.skipped = [...P.review.skipped.filter((x) => x !== P.review.id), P.review.id]; const l2 = reviewQueue(); P.review.id = (l2[i] || l2[0]).id; } else { i = (i + dir + list.length) % list.length; P.review.id = list[i].id; }
      reviewEd.destroy(); reviewEd = null; render();
      if (reviewEd) reviewEd.focusFirst();
    },
  });
  requestAnimationFrame(() => reviewEd && reviewEd.focusFirst());
}
function destroyReview() { if (reviewEd) { reviewEd.destroy(); reviewEd = null; } }

// ===========================================================================
// 精算書（左で条件、右に仕上がりをそのまま表示）
// ===========================================================================
function repRange() {
  const R = P.rep; const ym = thisYM();
  if (R.mode === 'this') return { from: `${ym}-01`, to: st.monthEnd(ym) };
  if (R.mode === 'last') { const p = st.addMonth(ym, -1); return { from: `${p}-01`, to: st.monthEnd(p) }; }
  if (R.mode === 'custom') return { from: R.from || `${ym}-01`, to: R.to || today() };
  if (R.mode === 'selected') return { from: R.from, to: R.to };
  const un = S.expenses.filter((e) => e.status === 'ok' && e.date).map((e) => e.date).sort();
  return { from: un[0] || `${ym}-01`, to: un[un.length - 1] || today() };
}
function repItems() {
  const R = P.rep;
  if (R.mode === 'selected') return (R.ids || []).map(st.byId).filter((e) => e && e.status !== 'draft');
  const { from, to } = repRange();
  return S.expenses.filter((e) => e.date >= from && e.date <= to && (e.status === 'ok' || (R.includeDone && e.status === 'done')));
}
function viewReport() {
  const R = P.rep; const { from, to } = repRange();
  const items = repItems(); const sum = summarize(items);
  const adv = st.num(R.advance) || 0; const net = sum.reimb - adv;
  const dr = S.expenses.filter((e) => e.status === 'draft' && e.date >= from && e.date <= to).length;
  const modes = [['unsettled', '未精算すべて'], ['this', '今月'], ['last', '先月'], ['custom', '期間を指定']];
  if (R.mode === 'selected') modes.push(['selected', `選んだ ${R.ids.length}件`]);
  const reps = [...S.reports].sort((a, b) => b.created - a.created);
  const settled = items.length && items.every((e) => e.status === 'done');
  const st3 = S.settings;
  return `<div class="report">
    <aside class="rep-side">
      <section class="card">
        <h2>対象</h2>
        <div class="seg wrap">${modes.map(([k, v]) => `<button class="${R.mode === k ? 'on' : ''}" data-rmode="${k}">${v}</button>`).join('')}</div>
        ${R.mode === 'custom' ? `<div class="date-range"><input type="date" id="rFrom" value="${esc(from)}"><span>〜</span><input type="date" id="rTo" value="${esc(to)}"></div>` : `<p class="period-text">${ic('calendar')}${ymd(from)} 〜 ${ymd(to)}</p>`}
        ${R.mode !== 'selected' ? `<label class="check"><input type="checkbox" id="rDone" ${R.includeDone ? 'checked' : ''}><span>精算済みの経費も入れる（作り直し用）</span></label>` : ''}
        ${dr ? `<button class="note warn" data-act="goReviewFromReport">${ic('warn')}<span>この期間に確認待ちが ${dr}件あります（精算書に入りません）</span>${ic('chevR')}</button>` : ''}
      </section>
      <section class="card">
        <h2>申請者</h2>
        <div class="row2"><label class="fld"><span class="lb">会社名</span><input data-s="company" value="${esc(st3.company)}" placeholder="株式会社○○建設"></label><label class="fld"><span class="lb">所属</span><input data-s="dept" value="${esc(st3.dept)}" placeholder="工事部"></label></div>
        <label class="fld"><span class="lb">氏名</span><input data-s="name" value="${esc(st3.name)}" placeholder="山田 太郎"></label>
        <label class="fld inline"><span class="lb">仮払金（先にもらったお金）</span><span class="amt-in sm"><em>¥</em><input id="rAdv" inputmode="numeric" placeholder="0" value="${esc(R.advance)}"></span></label>
      </section>
      <section class="card totals">
        <div><span>件数</span><b>${sum.count}件</b></div>
        <div><span>立替合計</span><b>${yen(sum.reimb)}</b></div>
        ${adv ? `<div><span>仮払金</span><b>− ${yen(adv)}</b></div>` : ''}
        ${sum.company ? `<div class="muted-row"><span>会社払い（参考）</span><b>${yen(sum.company)}</b></div>` : ''}
        <div class="net"><span>${net >= 0 ? '差引支給額' : '差引返金額'}</span><b>${yen(Math.abs(net))}</b></div>
      </section>
      <div class="rep-acts">
        <button class="btn primary lg" data-act="repPdf" ${items.length ? '' : 'disabled'}>${ic('download')}PDF を保存</button>
        <div class="row2">
          <button class="btn" data-act="repPrint" ${items.length ? '' : 'disabled'}>${ic('print')}印刷 ${kbd(MOD, 'P')}</button>
          <button class="btn" data-act="repCsvMenu" ${items.length ? '' : 'disabled'}>${ic('table')}CSV${ic('chevD', 'caret')}</button>
        </div>
        ${items.length && !settled ? `<button class="btn ok" data-act="repSettle">${ic('checkCircle')}提出したので「精算済み」にする</button>` : ''}
      </div>
      ${reps.length ? `
      <section class="card hist">
        <h2>これまでの精算</h2>
        <ul>${reps.slice(0, 12).map((r) => `<li>
          <span><b>${md(r.from)}〜${md(r.to)}</b><small>${new Date(r.created).toLocaleDateString('ja-JP')} ・ ${r.ids.length}件</small></span>
          <b class="a">${yen(r.reimb - (r.advance || 0))}</b>${FX.apvBadge(r)}
          <button class="icon-btn sm" data-act="apvSubmit" data-id="${r.id}" title="承認に出す（提出ファイルを作る）">${ic('send')}</button>
          <button class="icon-btn sm" data-reppdf="${r.id}" title="この精算書の PDF">${ic('download')}</button>
          <button class="icon-btn sm" data-repundo="${r.id}" title="未精算に戻す">${ic('undo')}</button>
        </li>`).join('')}</ul>
      </section>` : ''}
    </aside>
    <section class="rep-preview" aria-label="精算書の仕上がり">
      <div class="paper-tools">
        <span id="repStatus" class="muted"></span>
        <span class="grow"></span>
        <button class="icon-btn sm" data-act="repZoomOut" title="縮小">${ic('zoomOut')}</button>
        <span class="zoom-pct">${Math.round(R.zoom * 100)}%</span>
        <button class="icon-btn sm" data-act="repZoomIn" title="拡大">${ic('zoomIn')}</button>
      </div>
      <div class="paper-area" id="paperArea">${items.length ? '' : emptyState('doc', '対象の経費がありません', '期間を変えるか、確認待ちの経費を確定してください。')}</div>
    </section>
  </div>`;
}
function repSig() {
  const { from, to } = repRange(); const st3 = S.settings;
  return JSON.stringify([from, to, P.rep.advance, st3.name, st3.company, st3.dept, repItems().map((e) => `${e.id}:${e.updated}`)]);
}
const buildPreview = debounce(async () => {
  if (P.view !== 'report') return;
  const items = repItems(); if (!items.length) return;
  const sig = repSig(); if (sig === P.rep.sig && P.rep.pages) { placePages(); return; }
  const token = ++P.rep.token;
  const stEl = $('#repStatus'); if (stEl) stEl.innerHTML = '<span class="spin"></span>作っています…';
  const { from, to } = repRange();
  const { pages, sum } = await renderReport({ items, settings: S.settings, from, to, advance: st.num(P.rep.advance) || 0, getImage: async (id) => { const r = await st.imageRecord(id); return r && r.blob; } });
  if (token !== P.rep.token) return;
  Object.assign(P.rep, { pages, sum, sig });
  placePages();
}, 250);
function placePages() {
  const area = $('#paperArea'); if (!area || !P.rep.pages) return;
  area.innerHTML = '';
  P.rep.pages.forEach((c, i) => {
    const wrap = document.createElement('div'); wrap.className = 'paper';
    c.style.width = `${Math.round(794 * P.rep.zoom)}px`; c.style.height = 'auto';
    wrap.appendChild(c);
    const n = document.createElement('span'); n.className = 'paper-no'; n.textContent = `${i + 1} / ${P.rep.pages.length}`; wrap.appendChild(n);
    area.appendChild(wrap);
  });
  const stEl = $('#repStatus'); if (stEl) stEl.textContent = `A4 ・ ${P.rep.pages.length}ページ（明細・集計・領収書の台紙）`;
}
function repFileName() {
  const { from, to } = repRange();
  return `経費精算書_${S.settings.name ? `${S.settings.name}_` : ''}${from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : `${from}_${to}`}`;
}
async function ensurePages() {
  if (P.rep.pages && P.rep.sig === repSig()) return P.rep.pages;
  const items = repItems(); const { from, to } = repRange();
  const { pages, sum } = await renderReport({ items, settings: S.settings, from, to, advance: st.num(P.rep.advance) || 0, getImage: async (id) => { const r = await st.imageRecord(id); return r && r.blob; } });
  Object.assign(P.rep, { pages, sum, sig: repSig() });
  return pages;
}
async function printPages(pages, title = repFileName()) {
  const urls = pages.map((c) => c.toDataURL('image/jpeg', 0.92));
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><title>${esc(title)}</title><style>@page{size:A4;margin:0}html,body{margin:0;background:#fff}img{display:block;width:210mm;height:296.6mm;break-after:page}img:last-child{break-after:auto}</style></head><body>${urls.map((u) => `<img src="${u}">`).join('')}</body></html>`);
  d.close();
  await Promise.all([...d.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
  f.contentWindow.focus(); f.contentWindow.print();
  setTimeout(() => f.remove(), 60000);
}

// ===========================================================================
// 帳簿（売上・収入／振替伝票／仕訳帳／帳簿の設定）
// ===========================================================================
const SRC_LABEL = { expense: ['経費', 'ok'], income: ['売上・収入', 'done'], journal: ['振替', 'draft'], settle: ['精算', 'ok'], payout: ['外注', 'ok'], bank: ['明細', 'draft'], asset: ['固定資産', 'done'], dep: ['償却', 'ok'], alloc: ['家事按分', 'draft'] };
const bk = () => booksOf(S.settings);
const fyOf = (iso) => fiscalRange(iso, bk().closeMonth);
const fyLabel = (r) => `${ymd(r.from)} 〜 ${ymd(r.to)}`;
function allJournals() { return journalsFrom({ expenses: S.expenses, ledger: S.ledger, reports: S.reports, settings: S.settings }); }
function booksRange() { return P.books.from ? { from: P.books.from, to: P.books.to } : fyOf(today()); }
function shiftFY(r, k) { const [y, m] = r.from.split('-').map(Number); return fyOf(`${y + k}-${String(m).padStart(2, '0')}-15`); }

function accountOptions(selected, { only = null } = {}) {
  return accountGroups(bk().mode, st.cats()).filter(([g]) => !only || only.includes(g))
    .map(([g, list]) => `<optgroup label="${g}">${list.map((a) => `<option ${a === selected ? 'selected' : ''}>${esc(a)}</option>`).join('')}</optgroup>`).join('');
}

function viewBooks() {
  const tab = P.books.tab; const r = booksRange(); const b = bk();
  const tabs = FX.BOOK_TABS;
  const inR = (l) => l.date >= r.from && l.date <= r.to;
  let body = '';
  if (tab === 'income') {
    const list = S.ledger.filter((l) => l.type === 'income' && inR(l)).sort((a, c) => c.date.localeCompare(a.date));
    const paid = new Map(S.ledger.filter((l) => l.type === 'journal' && l.ref).map((l) => [l.ref, l]));
    const total = sumOf(list);
    const unpaid = list.filter((l) => l.debit === '売掛金' && !paid.has(l.id));
    body = `
      <div class="sumbar"><span>${list.length}件</span><span>合計 <b>${yen(total)}</b></span>${unpaid.length ? `<span class="warn-text">${ic('clock')}まだ入金されていない売掛金 ${unpaid.length}件 ${yen(sumOf(unpaid))}</span>` : ''}</div>
      <div class="table-wrap">${list.length ? `<table class="grid ledger">
        <thead><tr><th class="c-date">日付</th><th>取引先・内容</th><th class="c-cat">科目</th><th class="c-site">入金先</th><th class="c-amt num">金額</th><th class="c-act"></th></tr></thead>
        <tbody>${list.map((l) => { const p = paid.get(l.id); return `<tr data-led="${l.id}">
          <td class="c-date"><b>${md(l.date)}</b><small>${wd(l.date)}</small></td>
          <td class="c-payee"><b>${esc(l.partner || '（取引先なし）')}</b>${l.memo ? `<small>${esc(l.memo)}</small>` : ''}</td>
          <td class="c-cat"><span class="tag">${esc(l.credit)}</span></td>
          <td class="c-site">${l.debit === '売掛金' ? (p ? `<span class="badge done">${ic('checkCircle')}入金済み ${md(p.date)}</span>` : `<button class="chip sm" data-paid="${l.id}">${ic('clock')}入金を記録</button>`) : esc(l.debit)}</td>
          <td class="c-amt num"><b>${yen(l.amount)}</b></td>
          <td class="c-act"><button class="icon-btn sm" data-led-del="${l.id}" title="削除">${ic('trash')}</button></td>
        </tr>`; }).join('')}</tbody></table>`
        : emptyState('arrowR', 'この期の売上・収入はまだありません', '請求した売上や、入金された収入を入れると、損益計算書・貸借対照表に反映されます。', `<button class="btn primary" data-act="newIncome">${ic('plus')}売上・収入を入れる</button>`)}</div>`;
  } else if (['invoice', 'bank', 'assets', 'payout'].includes(tab)) {
    body = FX.bookTab(tab, r);
  } else if (tab === 'journal') {
    const list = S.ledger.filter((l) => l.type === 'journal' && l.src !== 'bank' && inR(l)).sort((a, c) => c.date.localeCompare(a.date));
    body = `
      <div class="sumbar"><span>${list.length}件</span><span class="muted">売掛金の入金・借入・返済・事業主貸／借・減価償却など、経費と売上以外のお金の動きを入れます</span></div>
      <div class="table-wrap">${list.length ? `<table class="grid ledger">
        <thead><tr><th class="c-date">日付</th><th>借方</th><th>貸方</th><th>摘要</th><th class="c-amt num">金額</th><th class="c-act"></th></tr></thead>
        <tbody>${list.map((l) => `<tr data-led="${l.id}">
          <td class="c-date"><b>${md(l.date)}</b><small>${wd(l.date)}</small></td>
          <td><span class="tag">${esc(l.debit)}</span></td><td><span class="tag">${esc(l.credit)}</span></td>
          <td class="c-payee"><b>${esc(l.memo || '')}</b>${l.partner ? `<small>${esc(l.partner)}</small>` : ''}</td>
          <td class="c-amt num"><b>${yen(l.amount)}</b></td>
          <td class="c-act"><button class="icon-btn sm" data-led-del="${l.id}" title="削除">${ic('trash')}</button></td>
        </tr>`).join('')}</tbody></table>`
        : emptyState('layers', 'この期の振替伝票はありません', '経費・売上・精算の仕訳は自動で作られます。それ以外（入金・借入・返済・生活費の引き出しなど）だけ入れてください。', `<button class="btn primary" data-act="newJournal">${ic('plus')}振替を入れる</button>`)}</div>`;
  } else if (tab === 'book') {
    const list = allJournals().filter(inR);
    body = `
      <div class="sumbar"><span>${list.length}行</span><span class="muted">経費・売上・振替・精算から自動で作った仕訳です（行をクリックすると元の記録を開きます）</span><span class="grow"></span><button class="btn sm" data-act="csvJournalBook">${ic('download')}仕訳帳 CSV</button></div>
      <div class="table-wrap">${list.length ? `<table class="grid ledger">
        <thead><tr><th class="c-date">日付</th><th>借方</th><th>貸方</th><th>摘要</th><th class="c-amt num">金額</th><th class="c-status">元の記録</th></tr></thead>
        <tbody>${list.slice(-1500).reverse().map((j) => { const [l, c] = SRC_LABEL[j.src] || ['', '']; return `<tr ${j.src === 'expense' ? `data-open="${j.ref}"` : j.src === 'settle' || j.src === 'alloc' ? '' : j.src === 'asset' || j.src === 'dep' ? `data-act="assetEdit" data-id="${j.ref}"` : j.src === 'payout' ? `data-act="payoutEdit" data-id="${j.ref}"` : `data-led="${j.ref}"`}>
          <td class="c-date"><b>${md(j.date)}</b><small>${wd(j.date)}</small></td>
          <td><span class="tag">${esc(j.debit)}</span></td><td><span class="tag">${esc(j.credit)}</span></td>
          <td class="c-payee"><b>${esc(j.memo || '')}</b></td>
          <td class="c-amt num"><b>${yen(j.amount)}</b></td>
          <td class="c-status"><span class="badge ${c}">${l}</span></td>
        </tr>`; }).join('')}</tbody></table>` : emptyState('list', 'この期の仕訳はありません', '経費を確定したり、売上を入れたりすると、ここに仕訳が並びます。')}</div>`;
  } else {
    const assets = ASSET_ACCOUNTS.map(([a]) => a); const liabs = LIABILITY_ACCOUNTS;
    const sumA = assets.reduce((s, a) => s + (+b.opening[a] || 0), 0); const sumL = liabs.reduce((s, a) => s + (+b.opening[a] || 0), 0);
    const corp = b.mode === 'corp';
    const credits = corp ? ['未払金', '普通預金', '現金', '買掛金'] : ['事業主借', '現金', '普通預金', '未払金', '買掛金'];
    body = `<div class="books-setup">
      <section class="card"><h2>帳簿の形</h2>
        <div class="choice">
          ${Object.entries(MODES).map(([k, v]) => `<label class="choice-card ${b.mode === k ? 'on' : ''}"><input type="radio" name="bmode" value="${k}" ${b.mode === k ? 'checked' : ''}><span class="cc-ic">${ic(k === 'corp' ? 'box' : 'pen')}</span><span><b>${v}</b><small>${k === 'corp' ? '損益計算書（売上総利益・営業利益・経常利益）と、資本金・繰越利益剰余金の貸借対照表を作ります。' : '青色申告決算書の形（売上・経費・所得）と、元入金・事業主貸・事業主借の貸借対照表を作ります。'}</small></span></label>`).join('')}
        </div>
        <div class="row3">
          <label class="fld"><span class="lb">${corp ? '会社名' : '屋号（なければ氏名）'}</span><input data-b="tradeName" value="${esc(b.tradeName)}" placeholder="${esc(S.settings.company || S.settings.name || '例: 山田工業')}"></label>
          <label class="fld"><span class="lb">決算月</span><span class="select">${ic('calendar')}<select data-b="closeMonth">${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${+b.closeMonth === m ? 'selected' : ''}>${m}月${!corp && m === 12 ? '（個人事業主はふつう12月）' : ''}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          ${corp ? `<label class="fld"><span class="lb">精算で払うときの口座</span><span class="select">${ic('card')}<select data-b="reimbAccount">${['普通預金', '現金'].map((a) => `<option ${b.reimbAccount === a ? 'selected' : ''}>${a}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>` : '<span></span>'}
        </div>
      </section>
      <section class="card"><h2>期首残高</h2><p class="muted">帳簿を始める日の残高を 1 回だけ入れます。次の期からは記録から自動で繰り越します。分からない科目は 0 のままで大丈夫です。</p>
        <div class="row3"><label class="fld"><span class="lb">期首残高の日付</span><input type="date" data-b="openDate" value="${esc(b.openDate)}"></label>
          ${corp ? `<label class="fld"><span class="lb">資本金</span><span class="amt-in sm"><em>¥</em><input data-b="capital" inputmode="numeric" value="${b.capital ? Number(b.capital).toLocaleString('ja-JP') : ''}" placeholder="0"></span></label>` : ''}</div>
        <div class="open-grid">
          <div><h3>資産</h3>${assets.map((a) => `<label class="open-row"><span>${a}</span><span class="amt-in sm"><em>¥</em><input data-open="${a}" inputmode="numeric" value="${b.opening[a] ? Number(b.opening[a]).toLocaleString('ja-JP') : ''}" placeholder="0"></span></label>`).join('')}<div class="open-sum"><span>資産合計</span><b>${yen(sumA)}</b></div></div>
          <div><h3>負債</h3>${liabs.map((a) => `<label class="open-row"><span>${a}</span><span class="amt-in sm"><em>¥</em><input data-open="${a}" inputmode="numeric" value="${b.opening[a] ? Number(b.opening[a]).toLocaleString('ja-JP') : ''}" placeholder="0"></span></label>`).join('')}<div class="open-sum"><span>負債合計</span><b>${yen(sumL)}</b></div>
            <div class="open-eq">${corp ? `<span>繰越利益剰余金（自動）</span><b>${yen(sumA - sumL - (+b.capital || 0))}</b>` : `<span>元入金（自動）＝ 資産 − 負債</span><b>${yen(sumA - sumL)}</b>`}</div></div>
        </div>
      </section>
      <section class="card"><h2>経費の支払方法と科目</h2><p class="muted">経費は「借方 = 勘定科目 ／ 貸方 = 下の科目」で仕訳します。${corp ? '従業員が立て替えた経費は「未払金」にして、精算したときに口座から払った仕訳を自動で作ります。' : '個人のお財布・カードで払った経費は「事業主借」にします。事業用の現金や口座を分けている人は変えてください。'}</p>
        <div class="row3 paymap">${st.METHODS.map((m) => `<label class="fld"><span class="lb">${m}で払った経費</span><span class="select">${ic('card')}<select data-pay="${m}">${[...new Set([b.payMap[m], ...credits])].map((a) => `<option ${b.payMap[m] === a ? 'selected' : ''}>${a}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>`).join('')}</div>
      </section>
      ${FX.setupExtra()}
    </div>`;
  }
  return `<div class="books-page">
    <div class="toolbar"><div class="tb-row">
      <div class="seg">${tabs.map(([k, v, i]) => `<button class="${tab === k ? 'on' : ''}" data-btab="${k}">${ic(i)}${v}</button>`).join('')}</div>
      ${tab !== 'setup' ? `<div class="period"><button class="icon-btn" data-act="fyPrev" title="前の期">${ic('chevL')}</button><span class="period-btn static">${ic('calendar')}<b>${fyLabel(r)}</b></span><button class="icon-btn" data-act="fyNext" title="次の期">${ic('chevR')}</button></div>` : ''}
      <span class="grow"></span>
      ${FX.tabButton(tab)}
      <button class="btn" data-view-go="statements">${ic('doc')}決算書へ</button>
    </div></div>
    ${body}
  </div>`;
}

function ledgerForm(l) {
  const income = l.type === 'income';
  const partners = [...new Set(S.ledger.map((x) => x.partner).filter(Boolean))];
  const presets = [
    ['売掛金の入金', '普通預金', '売掛金'], ['生活費などを引き出した', '事業主貸', '普通預金'], ['個人のお金を事業に入れた', '普通預金', '事業主借'],
    ['借入をした', '普通預金', '借入金'], ['借入の返済', '借入金', '普通預金'], ['カードの引き落とし', '未払金', '普通預金'], ['仮払いを渡した', '仮払金', '現金'], ['減価償却', '減価償却費', '車両運搬具'],
  ].filter(([, d, c]) => bk().mode === 'sole' || (!['事業主貸', '事業主借'].includes(d) && !['事業主貸', '事業主借'].includes(c)));
  return `<div class="led-form">
    <datalist id="dlPartner">${partners.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    ${income ? '' : `<div class="fld"><span class="lb">よくある振替</span><div class="chips">${presets.map(([n, d, c]) => `<button type="button" class="chip sm" data-preset="${esc(d)}|${esc(c)}|${esc(n)}">${esc(n)}</button>`).join('')}</div></div>`}
    <div class="row2">
      <label class="fld"><span class="lb">日付</span><input type="date" id="lDate" value="${esc(l.date)}"></label>
      <label class="fld"><span class="lb">金額</span><span class="amt-in"><em>¥</em><input id="lAmt" inputmode="numeric" placeholder="0" value="${l.amount ? Number(l.amount).toLocaleString('ja-JP') : ''}" autofocus></span></label>
    </div>
    ${income ? `
      <label class="fld"><span class="lb">取引先</span><input id="lPartner" list="dlPartner" value="${esc(l.partner || '')}" placeholder="例: ○○工務店"></label>
      <label class="fld"><span class="lb">内容</span><input id="lMemo" value="${esc(l.memo || '')}" placeholder="例: 11月分 A邸 内装工事"></label>
      <div class="row2">
        <label class="fld"><span class="lb">現場・案件</span><input id="lSite" list="dlSite" value="${esc(l.site || '')}" placeholder="現場別の損益に入ります"></label>
        <label class="fld"><span class="lb">消費税</span><span class="select">${ic('tag')}<select id="lRate">${[[10, '10%（ふつう）'], [8, '8%（軽減税率）'], [0, '対象外・非課税']].map(([v, t]) => `<option value="${v}" ${(l.taxRate ?? 10) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
      </div>
      <div class="row2">
        <label class="fld"><span class="lb">科目</span><span class="select">${ic('tag')}<select id="lCredit">${REVENUE_ACCOUNTS.map((a) => `<option ${l.credit === a ? 'selected' : ''}>${a}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
        <label class="fld"><span class="lb">入金先</span><span class="select">${ic('card')}<select id="lDebit">${[['売掛金', '売掛金（請求済み・まだ入金されていない）'], ['普通預金', '普通預金（振り込まれた）'], ['現金', '現金で受け取った']].concat(bk().mode === 'sole' ? [['事業主貸', '個人の口座に入った（事業主貸）']] : []).map(([a, t]) => `<option value="${a}" ${l.debit === a ? 'selected' : ''}>${t}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
      </div>
      ${l.id ? '' : `<label class="chk"><input type="checkbox" id="lRepeat"><span><b>毎月この日にくり返す</b><small>顧問料・家賃収入など、毎月同じ売上を自動で入れます</small></span></label>`}` : `
      <div class="row2">
        <label class="fld"><span class="lb">借方（増えた資産・費用／減った負債）</span><span class="select">${ic('tag')}<select id="lDebit">${accountOptions(l.debit)}</select>${ic('chevD', 'caret')}</span></label>
        <label class="fld"><span class="lb">貸方（減った資産／増えた負債・収益）</span><span class="select">${ic('tag')}<select id="lCredit">${accountOptions(l.credit)}</select>${ic('chevD', 'caret')}</span></label>
      </div>
      <label class="fld"><span class="lb">摘要</span><input id="lMemo" value="${esc(l.memo || '')}" placeholder="例: ○○工務店から入金"></label>`}
    <p class="form-err" id="lErr" hidden></p>
  </div>`;
}

async function editLedger(l) {
  const cur = { ...l };
  const r = await modal({
    title: cur.type === 'income' ? (l.id ? '売上・収入を直す' : '売上・収入を入れる') : (l.id ? '振替を直す' : '振替を入れる'), width: 560,
    body: ledgerForm(cur),
    actions: [...(l.id ? [{ label: '削除', value: 'del', kind: 'ghost danger' }] : []), { label: 'やめる', value: 'no' }, { label: '保存', value: 'ok', kind: 'primary' }],
    onMount: (el, layer) => {
      const read = () => {
        cur.date = $('#lDate', el).value; cur.amount = st.num($('#lAmt', el).value);
        cur.debit = $('#lDebit', el).value; cur.credit = $('#lCredit', el).value;
        cur.memo = $('#lMemo', el).value.trim(); if ($('#lPartner', el)) cur.partner = $('#lPartner', el).value.trim();
        if ($('#lSite', el)) cur.site = $('#lSite', el).value.trim(); if ($('#lRate', el)) cur.taxRate = +$('#lRate', el).value; if ($('#lRepeat', el)) cur.__repeat = $('#lRepeat', el).checked;
      };
      el.addEventListener('click', (ev) => {
        const p = ev.target.closest('[data-preset]');
        if (p) { const [d, c, n] = p.dataset.preset.split('|'); $('#lDebit', el).value = d; $('#lCredit', el).value = c; if (!$('#lMemo', el).value) $('#lMemo', el).value = n; $('#lAmt', el).focus(); }
      });
      const ok = $('[data-m="ok"]', el);
      ok.addEventListener('click', (ev) => {
        read();
        const err = !cur.date ? '日付を入れてください' : !cur.amount || cur.amount <= 0 ? '金額を入れてください' : cur.debit === cur.credit ? '借方と貸方が同じ科目です' : '';
        if (err) { ev.stopPropagation(); const e = $('#lErr', el); e.textContent = err; e.hidden = false; }
      }, true);
      $('#lAmt', el).addEventListener('change', (ev) => { const n = st.num(ev.target.value); ev.target.value = n ? n.toLocaleString('ja-JP') : ''; });
      el.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
      void layer;
    },
  });
  if (r === 'ok') {
    const repeat = cur.__repeat; delete cur.__repeat;
    await st.saveLedger(cur);
    if (repeat) { FX.addIncomeRecurring(cur); toast(`毎月 ${+cur.date.slice(8)}日に、この売上を自動で入れます`, { kind: 'ok' }); }
    toast(cur.type === 'income' ? `売上・収入を保存しました ${yen(cur.amount)}` : `振替を保存しました ${cur.debit} ／ ${cur.credit} ${yen(cur.amount)}`, { kind: 'ok' });
  } else if (r === 'del') deleteLedger(l.id);
}
async function deleteLedger(id) {
  const old = await st.removeLedger(id);
  if (old) toast('削除しました', { action: { label: '元に戻す', run: () => st.saveLedger(old) } });
}
async function recordPayment(incomeId) {
  const inc = S.ledger.find((l) => l.id === incomeId); if (!inc) return;
  let date = today(); let acc = '普通預金';
  const r = await modal({ title: '入金を記録する', width: 420,
    body: `<p class="muted">${esc(inc.partner || '')} ${yen(inc.amount)} の売掛金が入金されたことを記録します（借方 入金先 ／ 貸方 売掛金）。</p>
      <div class="row2"><label class="fld"><span class="lb">入金日</span><input type="date" id="pDate" value="${today()}"></label>
      <label class="fld"><span class="lb">入金先</span><span class="select">${ic('card')}<select id="pAcc"><option>普通預金</option><option>現金</option></select>${ic('chevD', 'caret')}</span></label></div>`,
    actions: [{ label: 'やめる', value: 'no' }, { label: '入金を記録', value: 'ok', kind: 'primary' }],
    onMount: (el) => { el.addEventListener('change', (ev) => { if (ev.target.id === 'pDate') date = ev.target.value; if (ev.target.id === 'pAcc') acc = ev.target.value; }); } });
  if (r !== 'ok') return;
  await st.saveLedger({ type: 'journal', date, amount: inc.amount, debit: acc, credit: '売掛金', memo: '入金', partner: inc.partner || '', ref: inc.id });
  toast(`入金を記録しました ${yen(inc.amount)}`, { kind: 'ok' });
}

// ===========================================================================
// 決算書（損益計算書・貸借対照表をボタンひとつで）
// ===========================================================================
function finRange() {
  const F = P.fin; const cur = fyOf(today());
  if (F.mode === 'last') return fyOf(st.addDays(cur.from, -1));
  if (F.mode === 'custom') return { from: F.from || cur.from, to: F.to || cur.to };
  return cur;
}
function finCompute() { const { from, to } = finRange(); return buildStatements({ journals: allJournals(), settings: S.settings, from, to }); }
const finName = () => { const { from, to } = finRange(); const b = bk(); return `決算書_${b.tradeName || S.settings.company || S.settings.name || 'ラク経費'}_${from}_${to}`; };

function viewStatements() {
  const F = P.fin; const b = bk(); const { from, to } = finRange();
  const s = finCompute();
  const dr = S.expenses.filter((e) => e.status === 'draft' && (!e.date || (e.date >= from && e.date <= to))).length;
  const corp = s.mode === 'corp';
  const notes = [...s.notes];
  if (dr) notes.unshift({ level: 'warn', msg: `確認待ちの経費 ${dr}件は入っていません`, go: 'review' });
  const hasRev = s.pl.revenue !== 0;
  if (!hasRev) notes.push({ level: 'info', msg: '売上・収入がまだありません（帳簿 → 売上・収入 で入れられます）', go: 'books' });
  const icon = { info: 'spark', warn: 'warn', error: 'warn' };
  return `<div class="report fin">
    <aside class="rep-side">
      <section class="card">
        <h2>期間</h2>
        <div class="seg wrap">${[['this', '今期'], ['last', '前期'], ['custom', '期間を指定']].map(([k, v]) => `<button class="${F.mode === k ? 'on' : ''}" data-fmode="${k}">${v}</button>`).join('')}</div>
        ${F.mode === 'custom' ? `<div class="date-range"><input type="date" id="fFrom" value="${esc(from)}"><span>〜</span><input type="date" id="fTo" value="${esc(to)}"></div>` : `<p class="period-text">${ic('calendar')}${ymd(from)} 〜 ${ymd(to)}</p>`}
        <p class="mode-line">${ic(corp ? 'box' : 'pen')}${MODES[b.mode]} ・ 決算月 ${b.closeMonth}月 <button class="link sm" data-act="booksSetup">帳簿の設定</button></p>
      </section>
      <section class="card totals fin-totals">
        <div><span>${corp ? '売上高' : '売上（収入）'}</span><b>${yen(s.pl.revenue)}</b></div>
        <div><span>経費・費用</span><b>${yen(s.pl.expense)}</b></div>
        <div class="net"><span>${corp ? '当期純利益' : '所得金額（控除前）'}</span><b class="${s.pl.netIncome < 0 ? 'neg' : ''}">${s.pl.netIncome < 0 ? '△' : ''}${yen(Math.abs(s.pl.netIncome))}</b></div>
        <div class="bs-mini">
          <div><span>資産合計</span><b>${yen(s.bs.totalAssets.close)}</b></div>
          <div><span>負債合計</span><b>${yen(s.bs.totalLiabs.close)}</b></div>
          <div><span>${corp ? '純資産' : '資本'}合計</span><b>${yen(s.bs.totalEquity.close)}</b></div>
        </div>
        <p class="balance ${s.bs.balanced ? 'ok' : 'ng'}">${ic(s.bs.balanced ? 'checkCircle' : 'warn')}${s.bs.balanced ? '貸借が一致しています' : '貸借が一致しません'}</p>
      </section>

      <div class="rep-acts">
        <button class="btn primary lg one" data-act="finPdf">${ic('doc')}<span>損益計算書・貸借対照表を作る<small>PDF ・ 月別推移つき</small></span></button>
        <div class="row2">
          <button class="btn" data-act="finPrint">${ic('print')}印刷</button>
          <button class="btn" data-act="finCsvMenu">${ic('table')}CSV${ic('chevD', 'caret')}</button>
        </div>
      </div>
      ${FX.taxCard(from, to)}
      ${notes.length ? `<section class="card checks"><h2>チェック</h2><ul>${notes.map((n) => `<li class="${n.level}">${ic(icon[n.level])}<span>${esc(n.msg)}</span>${n.go ? `<button class="link sm" data-view-go="${n.go}">開く</button>` : ''}</li>`).join('')}</ul></section>` : ''}
      <p class="muted small">記録から作る参考資料です（税込経理）。減価償却・棚卸・法人税等は振替伝票で入れてください。申告の前には税理士・会計ソフトで確かめてください。</p>
    </aside>
    <section class="rep-preview" aria-label="決算書の仕上がり">
      <div class="paper-tools"><span id="finStatus" class="muted"></span><span class="grow"></span>
        <button class="icon-btn sm" data-act="finZoomOut" title="縮小">${ic('zoomOut')}</button><span class="zoom-pct">${Math.round(P.fin.zoom * 100)}%</span><button class="icon-btn sm" data-act="finZoomIn" title="拡大">${ic('zoomIn')}</button></div>
      <div class="paper-area" id="finArea"></div>
    </section>
  </div>`;
}
function finSig() { const { from, to } = finRange(); return JSON.stringify([from, to, S.settings.books, S.settings.issuer, S.settings.company, S.settings.name, S.settings.categories, allJournals().length, S.expenses.reduce((m, e) => Math.max(m, e.updated || 0), 0), S.ledger.reduce((m, l) => Math.max(m, l.updated || 0), 0), S.reports.length]); }
function finPages() {
  const sig = finSig();
  if (P.fin.pages && P.fin.sig === sig) return P.fin.pages;
  const s = finCompute(); const { from, to } = finRange();
  const extra = FX.extraFinPages(s, from, to);
  P.fin.pages = [...renderStatements(s, S.settings, bk()), ...extra.map(([, c]) => c)]; P.fin.names = ['損益計算書', '貸借対照表', '月別推移', ...extra.map(([n]) => n)]; P.fin.sig = sig;
  return P.fin.pages;
}
function placeFin() {
  const area = $('#finArea'); if (!area) return;
  const pages = finPages();
  area.innerHTML = '';
  const names = P.fin.names || [];
  pages.forEach((c, i) => {
    const w = document.createElement('div'); w.className = 'paper';
    c.style.width = `${Math.round(794 * P.fin.zoom)}px`; c.style.height = 'auto';
    w.appendChild(c);
    const n = document.createElement('span'); n.className = 'paper-no'; n.textContent = `${names[i]}（${i + 1} / ${pages.length}）`; w.appendChild(n);
    area.appendChild(w);
  });
  const s = $('#finStatus'); if (s) s.textContent = `A4 ・ ${pages.length}ページ（${names.join("・")}）`;
}
async function finPdf() {
  const pages = finPages();
  const name = finName();
  download(await pagesToPdf(pages, name), `${name}.pdf`);
  toast(`${name}.pdf を保存しました`, { kind: 'ok' });
}

// ===========================================================================
// よく使う
// ===========================================================================
function viewTemplates() {
  if (!S.templates.length) {
    return FX.recurringSection() + emptyState('star', 'よく使う経費はまだありません', '毎日の通勤・駐車場・決まった現場への往復などは、経費の詳細で「よく使うに登録」しておくと、ここやホームからワンクリックで入れられます。',
      `<button class="btn primary" data-act="newTransit">${ic('train')}電車・バスを入れて登録する</button><button class="btn" data-act="newCar">${ic('car')}車で登録する</button>`);
  }
  return `<div class="tpl-grid">${S.templates.map((t) => `
    <article class="card tpl-card">
      <div class="tc-ic">${ic(t.kind === 'car' ? 'car' : t.kind === 'transit' ? 'train' : 'receipt')}</div>
      <div class="tc-main"><h3>${esc(t.label)}</h3><p>${esc([t.category, t.site, t.method].filter(Boolean).join(' ・ '))}</p></div>
      <b class="tc-amt">${t.amount ? yen(t.amount) : ''}</b>
      <div class="tc-acts">
        <button class="btn primary sm" data-tpl="${t.id}">${ic('plus')}今日の分を追加</button>
        <button class="btn sm" data-tpldate="${t.id}">${ic('calendar')}日付を選んで</button>
        <button class="icon-btn sm" data-tpldel="${t.id}" title="消す">${ic('trash')}</button>
      </div>
      ${FX.tplRecurringHTML(t)}
    </article>`).join('')}</div>${FX.recurringSection()}`;
}

// ===========================================================================
// 設定
// ===========================================================================
function viewSettings() {
  const s = S.settings;
  const lastBk = pget('lastBackup', 0);
  const theme = pget('theme', 'auto');
  const secs = [['who', '申請者'], ['ocr', '読み取り方'], ['input', '入力の初期値'], ['cats', '勘定科目'], ['data', 'データ・スマホ連携'], ...FX.SET_SECS, ['keys', 'キーボード'], ['about', 'このアプリについて']];
  return `<div class="settings">
    <nav class="set-nav">${secs.map(([k, v]) => `<a href="#settings" data-jump="${k}">${v}</a>`).join('')}</nav>
    <div class="set-body">
      <section class="card" id="set-who"><h2>申請者</h2><p class="muted">精算書の上にのります。</p>
        <div class="row3"><label class="fld"><span class="lb">会社名</span><input data-s="company" value="${esc(s.company)}" placeholder="株式会社○○建設"></label>
        <label class="fld"><span class="lb">所属</span><input data-s="dept" value="${esc(s.dept)}" placeholder="工事部"></label>
        <label class="fld"><span class="lb">氏名</span><input data-s="name" value="${esc(s.name)}" placeholder="山田 太郎"></label></div></section>

      <section class="card" id="set-ocr"><h2>読み取り方</h2>
        <div class="choice">
          <label class="choice-card ${s.ocrMode !== 'ai' ? 'on' : ''}"><input type="radio" name="ocr" value="device" ${s.ocrMode !== 'ai' ? 'checked' : ''}>
            <span class="cc-ic">${ic('shield')}</span><span><b>端末内で読む（無料）</b><small>画像は外に送りません。文字のある PDF は文字をそのまま読むので正確です。はじめてだけ読み取り用データ（約6MB）をダウンロードします。</small></span></label>
          <label class="choice-card ${s.ocrMode === 'ai' ? 'on' : ''}"><input type="radio" name="ocr" value="ai" ${s.ocrMode === 'ai' ? 'checked' : ''}>
            <span class="cc-ic">${ic('spark')}</span><span><b>AI で読む（高精度）</b><small>Claude（Anthropic）に画像を送って読みます。手書き・しわ・斜めでも強い。API キーが必要で、料金は Anthropic への支払いです（1枚あたり数円程度・Haiku なら1円未満）。</small></span></label>
        </div>
        ${s.ocrMode === 'ai' ? `
          <div class="row2">
            <label class="fld"><span class="lb">API キー</span><span class="key-in">${ic('key')}<input data-s="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(s.apiKey)}"><button class="link sm" data-act="toggleKey">表示</button></span></label>
            <label class="fld"><span class="lb">モデル</span><span class="select">${ic('spark')}<select data-s="aiModel">${AI_MODELS.map((m) => `<option value="${m.id}" ${s.aiModel === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          </div>
          <p class="hint">キーはこのパソコンの中だけに保存し、Anthropic 以外には送りません。キーは console.anthropic.com で作れます。共用のパソコンでは使わないでください。</p>
          <button class="btn" data-act="testAi">${ic('spark')}接続をテストする</button>` : ''}
      </section>

      <section class="card" id="set-input"><h2>入力の初期値</h2>
        <div class="row3">
          <label class="fld"><span class="lb">支払方法の初期値</span><span class="select">${ic('card')}<select data-s="defaultMethod">${st.METHODS.map((m) => `<option ${s.defaultMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          <label class="fld"><span class="lb">レシートが「カード払い」のとき</span><span class="select">${ic('card')}<select data-s="cardMethod">${['個人カード', '会社カード'].map((m) => `<option ${s.cardMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          <label class="fld"><span class="lb">仕訳 CSV の貸方科目</span><input data-s="creditAccount" value="${esc(s.creditAccount || '未払金')}"></label>
        </div>
        <div class="row3">
          <label class="fld"><span class="lb">車の単価（1km あたり）</span><span class="amt-in sm"><input data-s="carRate" inputmode="decimal" value="${s.carRate}"><em>円</em></span></label>
          <label class="fld"><span class="lb">車の科目</span><span class="select">${ic('tag')}<select data-s="carCategory">${st.cats().map((m) => `<option ${s.carCategory === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          <label class="fld"><span class="lb">表示の明るさ</span><span class="select">${ic('monitor')}<select id="themeSel"><option value="auto" ${theme === 'auto' ? 'selected' : ''}>パソコンの設定に合わせる</option><option value="light" ${theme === 'light' ? 'selected' : ''}>明るい</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>暗い</option></select>${ic('chevD', 'caret')}</span></label>
        </div>
      </section>

      <section class="card" id="set-cats"><h2>勘定科目</h2><p class="muted">選ぶ順に並びます。会社で使う科目に合わせてください。</p>
        <div class="chips">${st.cats().map((k) => `<span class="chip on">${esc(k)}<button class="x" data-delcat="${esc(k)}" aria-label="${esc(k)}を消す">${ic('x')}</button></span>`).join('')}</div>
        <div class="row-inline"><input id="newCat" placeholder="科目を追加（例: 外注費）"><button class="btn sm" data-act="addCat">${ic('plus')}追加</button><button class="link sm" data-act="resetCat">初期の科目に戻す</button></div>
      </section>

      <section class="card" id="set-data"><h2>データ・スマホ連携</h2>
        <p class="muted" id="usage">データはこのパソコンのブラウザの中だけに保存しています（サーバーには送りません）。</p>
        <div class="data-grid">
          <div class="data-box">
            <h3>${ic('phone')}スマホのデータを取り込む</h3>
            <p>スマホ版の［設定 → パソコンへ送る］で作ったファイルを、この画面にドラッグするか、下のボタンで選びます。同じ経費は新しい方が残り、ほかの経費は消えません。</p>
            <button class="btn primary" data-act="importBackup">${ic('upload')}ファイルを選んで取り込む</button>
          </div>
          <div class="data-box">
            <h3>${ic('box')}バックアップ</h3>
            <p>画像・PDF も含めて 1 つのファイルに保存します（API キーは含めません）。最後のバックアップ: <b>${ago(lastBk)}</b></p>
            <div class="row-inline"><button class="btn" data-act="backup">${ic('download')}バックアップを保存</button><button class="btn" data-act="importBackup">${ic('undo')}バックアップから戻す</button></div>
          </div>
        </div>
        <button class="btn ghost danger" data-act="wipe">${ic('trash')}すべてのデータを消す</button>
      </section>

      ${FX.settingsExtra()}
      <section class="card" id="set-keys"><h2>キーボード</h2>${shortcutsHTML()}</section>

      <section class="card" id="set-about"><h2>このアプリについて</h2>
        <p><a class="btn" href="../guide/?from=pc">${ic('search')}使い方ガイドを開く（検索できます）</a></p>
        <p>ラク経費 パソコン版。スマホ版（<a href="../">../</a>）と同じデータを使います（同じブラウザの場合）。インストールすると、エクスプローラーや Finder から画像・PDF を「このアプリで開く」で取り込めます。</p>
        <p class="muted">読み取り結果は必ず確かめてください。電子帳簿保存法への対応は会社の決まりと税理士の指示に従ってください。</p>
      </section>
    </div>
  </div>`;
}
function shortcutsHTML() {
  const rows = [
    ['全体', [[[MOD, 'K'], '検索・操作'], [[MOD, 'O'], '画像・PDF を取り込む'], [['N'], '手で入力'], [['1〜9', '0'], '画面を切り替える'], [['?'], 'この一覧']]],
    ['経費一覧', [[['↑', '↓'], '行を移動'], [['Enter'], '詳細を開く'], [['Space'], '選ぶ / はずす'], [['Shift', 'クリック'], '範囲を選ぶ'], [[MOD, 'A'], 'すべて選ぶ'], [['Delete'], '選んだ経費を削除'], [['/'], '検索']]],
    ['詳細・確認', [[[MOD, 'Enter'], '保存（確認待ちでは確定して次へ）'], [['Alt', '↑ ↓'], '前 / 次の経費'], [['Enter'], '次の欄へ'], [['Esc'], '閉じる']]],
  ];
  return `<div class="keys">${rows.map(([h, list]) => `<div><h3>${h}</h3><dl>${list.map(([k, v]) => `<dt>${kbd(...k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`).join('')}</div>`;
}

// ===========================================================================
// 描画と画面の切り替え
// ===========================================================================
let rendering = false;
function render() {
  // 描き直しの途中（入力欄が消えて change が起きたときなど）に、もう一度呼ばれたら次のフレームに回す
  if (rendering) { queueRender(); return; }
  rendering = true;
  try { renderNow(); } finally { rendering = false; }
}
function renderNow() {
  const v = $('#view');
  const meta = VIEWS[P.view];
  $('#pageTitle').textContent = meta.title;
  $('#pageSub').textContent = meta.sub();
  document.title = `${meta.title} - ラク経費`;
  $$('.nav [data-view]').forEach((a) => { const on = a.dataset.view === P.view; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  // 入力中の欄を描き直しのあとも保つ
  const a = document.activeElement; let keep = null;
  if (a && v.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) {
    const ds = a.dataset;
    const sel = a.id ? `#${CSS.escape(a.id)}` : ds.s ? `[data-s="${ds.s}"]` : ds.b ? `[data-b="${ds.b}"]` : ds.pay ? `[data-pay="${ds.pay}"]` : ds.open ? `[data-open="${ds.open}"]` : null;
    if (sel) { let caret = null; try { caret = a.selectionStart; } catch (_) { /* 日付など */ } keep = { sel, caret }; }
  }
  if (P.view === 'review') {
    // 確認画面は編集中の欄を壊さないよう、左の一覧だけを描き直す
    const q = reviewQueue();
    if (!reviewEd || !$('#rvRail') || !q.some((e) => e.id === reviewEd.id)) { destroyReview(); v.innerHTML = viewReview(); }
    afterReview();
  } else {
    destroyReview();
    const y = v.scrollTop;
    v.className = `view v-${P.view}`;
    v.innerHTML = P.view === 'home' ? viewHome() : P.view === 'list' ? viewList() : P.view === 'report' ? viewReport() : P.view === 'books' ? viewBooks() : P.view === 'statements' ? viewStatements() : P.view === 'analysis' ? FX.viewAnalysis() : P.view === 'approvals' ? FX.viewApprovals() : P.view === 'templates' ? viewTemplates() : viewSettings();
    v.scrollTop = y;
    if (P.view === 'home') afterHome();
    if (P.view === 'list') afterList();
    if (P.view === 'report') buildPreview();
    if (P.view === 'statements') placeFin();
    if (P.view === 'settings') usage().then((u) => { const el = $('#usage'); if (u && el) el.textContent = `データはこのパソコンのブラウザの中だけに保存しています（サーバーには送りません）。使用量 約${(u.usage / 1024 / 1024).toFixed(1)}MB ・ 経費 ${S.expenses.length}件。`; });
  }
  if (P.view === 'review') v.className = 'view v-review';
  hydrate(v);
  paint(v);
  renderChrome();
  if (keep) { const el = $(keep.sel, v); if (el) { el.focus({ preventScroll: true }); if (keep.caret != null) { try { el.setSelectionRange(keep.caret, keep.caret); } catch (_) { /* 選べない欄 */ } } } }
}

function renderChrome() {
  const dr = drafts().length; const n = st.readingCount();
  $('#navReview').textContent = dr ? String(dr) : '';
  $('#navReview').className = dr ? 'count' : '';
  const un = sumOf(unsettled());
  $('#navReport').textContent = un ? yen(un) : '';
  const pa = FX.pendingApprovals(); $('#navApv').textContent = pa ? String(pa) : ''; $('#navApv').className = pa ? 'count' : '';
  $('#reading').innerHTML = n ? `<span class="spin"></span>読み取り中 ${n}件` : '';
  const lastBk = pget('lastBackup', 0);
  const oldest = Math.min(...S.expenses.map((e) => e.created || Date.now()));
  const stale = S.expenses.length >= 10 && (lastBk ? Date.now() - lastBk > 14 * 86400000 : Date.now() - oldest > 3 * 86400000);
  $('#sideFoot').innerHTML = `
    ${FX.syncFoot() || `<div class="foot-card ${stale ? 'warn' : ''}">
      ${ic(stale ? 'warn' : 'shield')}
      <span><b>${stale ? 'バックアップをおすすめします' : 'このパソコンに保存'}</b><small>バックアップ: ${ago(lastBk)}</small></span>
      <button class="icon-btn sm" data-act="backup" title="バックアップを保存">${ic('download')}</button>
    </div>`}
    <div class="who">${S.settings.name ? `${ic('pen')}<span>${esc(S.settings.name)}<small>${esc([S.settings.company, S.settings.dept].filter(Boolean).join(' '))}</small></span>` : `<a href="#settings" class="link sm">${ic('pen')}申請者を設定する</a>`}</div>`;
  paint($('#sideFoot'));
  fillDatalists();
  const t = pget('theme', 'auto');
  $('#themeBtn').innerHTML = ic(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'monitor');
  $('#themeBtn').title = `表示の明るさ: ${{ auto: 'パソコンに合わせる', light: '明るい', dark: '暗い' }[t]}`;
}
const paint = (root) => $$('i[data-ic]', root).forEach((el) => { el.outerHTML = ic(el.dataset.ic); });

function go(view, { push = true } = {}) {
  if (!VIEWS[view]) view = 'home';
  const changed = P.view !== view;
  P.view = view;
  if (push && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  if (changed) { $('#view').scrollTop = 0; P.list.scroll = 0; }
  if (view !== 'list' && P.ed && changed) closeDrawer();
  render();
  if (changed) $('#view').focus({ preventScroll: true });
}
window.addEventListener('popstate', () => go(location.hash.slice(1) || 'home', { push: false }));

let renderQueued = false;
function queueRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
st.on('change', queueRender);
st.on('ocr', (id, o) => {
  // 読み取り中の表示だけを部分的に直す（全体の描き直しは重い）
  const tr = $(`#tableWrap tr[data-id="${id}"] .c-payee`);
  if (tr) { const e = st.byId(id); if (e) { const sm = $('small, .mini-ocr', tr); const html = ocrCell(e); if (html) { if (sm) sm.outerHTML = html; else tr.insertAdjacentHTML('beforeend', html); } } }
  const rv = $(`.rv-item[data-rv="${id}"] small`);
  if (rv) { const e = st.byId(id); if (e) rv.innerHTML = ocrCell(e) || `${md(e.date)} ・ ${esc(e.category || '科目なし')}`; }
  if (!o || o.state === 'done' || o.state === 'error') queueRender(); else renderChrome();
});
st.on('error', (m) => toast(m, { kind: 'error' }));

// ===========================================================================
// 右のパネル（経費の詳細）
// ===========================================================================
function openDrawer(e, { isNew = false } = {}) {
  if (P.ed) { P.ed.destroy(); P.ed = null; }
  const d = $('#drawer');
  d.hidden = false;
  $('#app').classList.add('with-drawer');
  P.edIds = P.view === 'list' ? listItems().map((x) => x.id) : null;
  P.ed = new Editor(d, e, {
    mode: 'drawer', isNew,
    onClose: (o) => { closeDrawer(); if (o && o.open) openDrawer(o.open, { isNew: true }); },
    onSaved: (c, { wasNew }) => { toast(wasNew ? `保存しました: ${c.payee || ''} ${yen(c.amount)}` : '保存しました', { kind: 'ok', ms: 2400 }); closeDrawer(); },
    onNav: P.edIds && P.edIds.length > 1 ? (dir) => navDrawer(dir) : null,
  });
  if (P.view === 'list') setCursor(e.id);
  $$('#tableWrap tr.open').forEach((tr) => tr.classList.remove('open'));
  const tr = $(`#tableWrap tr[data-id="${e.id}"]`); if (tr) tr.classList.add('open');
  requestAnimationFrame(() => P.ed && P.ed.focusFirst());
}
async function navDrawer(dir) {
  if (!P.ed || !P.edIds) return;
  if (P.ed.dirty) { const ok = await P.ed.save(); if (!ok) return; }
  const ids = P.edIds.filter((id) => st.byId(id));
  let i = ids.indexOf(P.ed.id); if (i < 0) i = 0;
  const next = ids[(i + dir + ids.length) % ids.length];
  const e = st.byId(next); if (e) openDrawer(e);
}
function closeDrawer() {
  if (P.ed) { P.ed.destroy(); P.ed = null; }
  const d = $('#drawer'); d.hidden = true; d.innerHTML = '';
  $('#app').classList.remove('with-drawer');
  $$('#tableWrap tr.open').forEach((tr) => tr.classList.remove('open'));
  if (P.view === 'list' && P.list.cursor) { const tr = $(`#tableWrap tr[data-id="${P.list.cursor}"]`); if (tr) tr.focus && tr.scrollIntoView({ block: 'nearest' }); }
}
function openExpense(id) {
  const e = st.byId(id); if (!e) return;
  if (e.status === 'draft' && P.view !== 'list') { P.review.id = id; go('review'); return; }
  if (P.view !== 'list' && P.view !== 'home') go('list');
  openDrawer(e);
}

// ===========================================================================
// 取り込み（ファイル・フォルダ・ドラッグ・貼り付け・「このアプリで開く」）
// ===========================================================================
async function doImport(files, { goReview = true } = {}) {
  const arr = [...files];
  const backups = arr.filter((f) => /\.json$/i.test(f.name || '') || f.type === 'application/json');
  const csvs = arr.filter((f) => /\.(csv|tsv)$/i.test(f.name || '') || f.type === 'text/csv');
  const others = arr.filter((f) => !backups.includes(f) && !csvs.includes(f));
  for (const b of backups) { if (!(await FX.importJson(b))) await importBackupFile(b); }
  for (const c of csvs) await FX.bankImportFile(c);
  if (!others.length) return;
  const importable = others.filter(st.isImportable);
  if (!importable.length) { toast('画像（JPEG・PNG など）か PDF を選んでください', { kind: 'error' }); return; }
  const prog = toast(`${importable.length}件を取り込んでいます…`, { ms: 60000 });
  const r = await st.importFiles(importable);
  prog();
  r.failed.forEach((f) => toast(`読み込めませんでした: ${f.name}（${f.error}）`, { kind: 'error', ms: 8000 }));
  if (r.skipped) toast(`画像・PDF ではないファイル ${r.skipped}件は飛ばしました`);
  if (!r.made.length) return;
  toast(`${r.made.length}件を取り込みました。読み取りが終わったものから確認できます`, { kind: 'ok' });
  if (goReview && P.view !== 'review') { P.review.id = r.made[0].id; go('review'); }
}
async function importBackupFile(file) {
  let info;
  try { info = await st.readBackup(file); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const ok = await confirmDialog(`${info.total}件のデータが入っています。新しい経費 ${info.added}件・更新 ${info.updated}件を取り込みます。`, '取り込む', { title: 'スマホ・バックアップのデータを取り込む', detail: 'いまある経費は消えません。同じ経費は新しい方が残ります。' });
  if (!ok) return;
  const n = await st.mergeBackup(info.j);
  toast(n ? `${n}件を取り込みました` : '新しい経費はありませんでした（すべて取り込み済みです）', { kind: 'ok' });
}
async function backupNow() {
  const prog = toast('バックアップを作っています…', { ms: 60000 });
  const blob = await st.makeBackup();
  prog();
  download(blob, `ラク経費_バックアップ_${today()}.json`);
  pset('lastBackup', Date.now());
  renderChrome();
  toast('バックアップを保存しました', { kind: 'ok' });
}

let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; dragDepth++; $('#drop').hidden = false; });
window.addEventListener('dragleave', (ev) => { if (!hasFiles(ev)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', async (ev) => {
  if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
  ev.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  doImport(ev.dataTransfer.files);
});
window.addEventListener('paste', (ev) => {
  if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
  const files = [...(ev.clipboardData?.files || [])].filter(st.isImportable);
  if (files.length) { ev.preventDefault(); doImport(files); }
});
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    doImport(files);
  });
}

// ===========================================================================
// 検索・操作パレット（Ctrl+K）
// ===========================================================================
const COMMANDS = [
  ['取り込む（画像・PDF）', 'upload', 'import', `${MOD}+O`], ['フォルダから取り込む', 'folder', 'importFolder', ''], ['スマホのデータを取り込む', 'phone', 'importBackup', ''],
  ['手で入力', 'pen', 'newManual', 'N'], ['電車・バスを入力', 'train', 'newTransit', ''], ['車（距離）を入力', 'car', 'newCar', ''],
  ['損益計算書・貸借対照表を作る（PDF）', 'doc', 'finNow', ''], ['売上・収入を入れる', 'arrowR', 'newIncome', ''], ['振替伝票を入れる', 'layers', 'newJournal', ''],
  ['ホーム', 'home', 'v:home', '1'], ['確認待ち', 'inbox', 'v:review', '2'], ['経費一覧', 'list', 'v:list', '3'], ['精算書を作る', 'doc', 'v:report', '4'], ['帳簿', 'layers', 'v:books', '5'], ['決算書', 'doc', 'v:statements', '6'], ['よく使う', 'star', 'v:templates', '7'], ['設定', 'sliders', 'v:settings', '8'],
  ['分析', 'chart', 'v:analysis', '7'], ['承認', 'stamp', 'v:approvals', '8'],
  ['請求書を作る', 'doc', 'invNew', ''], ['銀行・カードの明細を取り込む', 'bank', 'bankPick', ''], ['外注費を払った（源泉徴収）', 'pen', 'payoutNew', ''], ['固定資産を登録', 'box', 'assetNew', ''], ['文章で振替を入れる', 'spark', 'textJournal', ''],
  ['使い方ガイド（検索できる）', 'search', 'guide', ''],
  ['今すぐ同期', 'sync', 'syncNow', ''], ['変更の履歴（電子帳簿保存法）', 'clock', 'histAll', ''],
  ['今月の経費を見る', 'calendar', 'listThis', ''], ['先月の経費を見る', 'calendar', 'listLast', ''], ['未精算の経費を見る', 'doc', 'listUnsettled', ''],
  ['バックアップを保存', 'download', 'backup', ''], ['表示の明るさを切り替える', 'sun', 'theme', ''], ['キーボードの操作', 'keyboard', 'shortcuts', '?'],
];
function openPalette() {
  if (topLayer()) closeTop();
  const back = document.createElement('div');
  back.className = 'palette-back';
  back.innerHTML = `<div class="palette" role="dialog" aria-label="検索・操作">
    <label class="pal-in">${ic('search')}<input placeholder="経費を探す（支払先・金額・現場）・操作を選ぶ" autocomplete="off" spellcheck="false"><span class="kbd"><kbd>Esc</kbd></span></label>
    <div class="pal-list" role="listbox"></div>
    <div class="pal-foot"><span>${kbd('↑', '↓')} 選ぶ</span><span>${kbd('Enter')} 実行</span></div>
  </div>`;
  document.body.appendChild(back);
  const input = $('input', back); const list = $('.pal-list', back);
  let items = []; let k = 0;
  const layer = { close: () => close() };
  function close() { const i = layerStack.indexOf(layer); if (i >= 0) layerStack.splice(i, 1); back.remove(); }
  layerStack.push(layer);
  function draw() {
    const q = input.value.trim().normalize('NFKC').toLowerCase(); const qn = st.num(q);
    const cmds = COMMANDS.filter(([l]) => !q || l.toLowerCase().includes(q)).map(([label, icon, act, hint]) => ({ type: 'cmd', label, icon, act, hint }));
    let ex = [];
    if (q) {
      ex = S.expenses.filter((e) => [e.payee, e.memo, e.site, e.category].join(' ').normalize('NFKC').toLowerCase().includes(q) || (qn != null && e.amount === qn))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8)
        .map((e) => ({ type: 'exp', e }));
    }
    items = [...ex, ...cmds].slice(0, 14); k = Math.min(k, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? `${ex.length ? '<div class="pal-h">経費</div>' : ''}${items.map((it, i) => (it.type === 'exp'
      ? `<button class="pal-item ${i === k ? 'on' : ''}" data-i="${i}">${ic('receipt')}<span><b>${esc(it.e.payee || '支払先なし')}</b><small>${md(it.e.date)} ・ ${esc([it.e.category, it.e.site].filter(Boolean).join(' ・ '))}</small></span><em>${it.e.amount != null ? yen(it.e.amount) : ''}</em></button>`
      : `${i === ex.length && ex.length ? '<div class="pal-h">操作</div>' : ''}<button class="pal-item ${i === k ? 'on' : ''}" data-i="${i}">${ic(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<span class="kbd"><kbd>${esc(it.hint)}</kbd></span>` : ''}</button>`)).join('')}`
      : '<p class="pal-empty">見つかりませんでした</p>';
    const on = $('.pal-item.on', list); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function run(it) {
    close();
    if (!it) return;
    if (it.type === 'exp') openExpense(it.e.id);
    else if (it.act.startsWith('v:')) go(it.act.slice(2));
    else ACTIONS[it.act] && ACTIONS[it.act]();
  }
  input.addEventListener('input', () => { k = 0; draw(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); k = Math.min(items.length - 1, k + 1); draw(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); k = Math.max(0, k - 1); draw(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); run(items[k]); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
  });
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(); });
  list.addEventListener('click', (ev) => { const b = ev.target.closest('[data-i]'); if (b) run(items[+b.dataset.i]); });
  draw(); input.focus();
}
const layerStack = [];

// ===========================================================================
// 操作
// ===========================================================================
function newOf(kind) {
  const base = { auto: [] };
  if (kind === 'transit') Object.assign(base, { kind, category: '旅費交通費', route: { from: '', to: '', round: true } });
  else if (kind === 'car') Object.assign(base, { kind, category: S.settings.carCategory, payee: '自家用車', memo: 'ガソリン代（距離）', route: { from: '', to: '', round: true }, rate: S.settings.carRate });
  else base.kind = 'receipt';
  const e = st.newExpense(base);
  if (P.view !== 'list') go('list');
  openDrawer(e, { isNew: true });
}
async function useTemplate(t, date = today()) {
  const e = st.expenseFromTemplate(t, date);
  if (!e.amount || !e.category) { if (P.view !== 'list') go('list'); openDrawer(e, { isNew: true }); return; }
  await st.saveExpense(e);
  toast(`追加しました: ${t.label} ${yen(e.amount)}（${md(date)}）`, { kind: 'ok', action: { label: '元に戻す', run: () => st.removeExpenses([e.id]) } });
}
function selIds() { return listItems().filter((e) => P.list.sel.has(e.id)).map((e) => e.id); }
async function bulkPatch(patch, label) {
  const ids = selIds(); if (!ids.length) return;
  const before = await st.bulkUpdate(ids, patch);
  toast(`${ids.length}件の${label}を変えました`, { kind: 'ok', action: { label: '元に戻す', run: () => st.restoreVersions(before) } });
}
function csvName(prefix) { const r = listRange(); return `${prefix}_${r.label.replace(/[\/\\:*?"<>|〜]/g, '-')}.csv`; }
function exportItems(items, kind, name) {
  if (!items.length) { toast('書き出す経費がありません', { kind: 'error' }); return; }
  const csv = kind === 'journal' ? toJournalCSV(items.filter((e) => e.status !== 'draft'), { credit: S.settings.creditAccount || '未払金' }) : toCSV(items);
  download(new Blob([csv], { type: 'text/csv' }), name);
  toast(`${name} を保存しました`, { kind: 'ok' });
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark']; const t = order[(order.indexOf(pget('theme', 'auto')) + 1) % 3];
  setTheme(t);
  toast(`表示: ${{ auto: 'パソコンの設定に合わせる', light: '明るい', dark: '暗い' }[t]}`);
}
function setTheme(t) {
  pset('theme', t);
  try { localStorage.setItem('rakukeihi.pcTheme', t); } catch (_) { /* 使えない環境 */ }
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  renderChrome();
  if (P.view === 'home') render();
}
function showShortcuts() { modal({ title: 'キーボードの操作', body: shortcutsHTML(), width: 720 }); }

const ACTIONS = {
  newIncome: () => { if (P.view !== 'books') { P.books.tab = 'income'; go('books'); } editLedger({ type: 'income', date: today(), debit: '売掛金', credit: '売上高' }); },
  newJournal: () => { if (P.view !== 'books') { P.books.tab = 'journal'; go('books'); } editLedger({ type: 'journal', date: today(), debit: '普通預金', credit: '売掛金' }); },
  fyPrev: () => { const r = shiftFY(booksRange(), -1); Object.assign(P.books, r); render(); },
  fyNext: () => { const r = shiftFY(booksRange(), 1); Object.assign(P.books, r); render(); },
  booksSetup: () => { P.books.tab = 'setup'; go('books'); },
  csvJournalBook: () => { const r = booksRange(); const s = buildStatements({ journals: allJournals(), settings: S.settings, from: r.from, to: r.to }); download(new Blob([toJournalBookCSV(s)], { type: 'text/csv' }), `仕訳帳_${r.from}_${r.to}.csv`); },
  finPdf: async (b) => { b.disabled = true; try { await finPdf(); } finally { b.disabled = false; } },
  finNow: async () => { await finPdf(); },
  finPrint: () => printPages(finPages(), finName()),
  finCsvMenu: async (b) => {
    const v = await menu(b, [{ label: '試算表 CSV', icon: 'table', value: 'trial' }, { label: '仕訳帳 CSV', icon: 'list', value: 'book' }, ...FX.FIN_CSV_ITEMS], { width: 300 });
    const s = finCompute(); const { from, to } = finRange();
    if (v) FX.finCsv(v, from, to);
    if (v === 'trial') download(new Blob([toTrialCSV(s)], { type: 'text/csv' }), `試算表_${from}_${to}.csv`);
    if (v === 'book') download(new Blob([toJournalBookCSV(s)], { type: 'text/csv' }), `仕訳帳_${from}_${to}.csv`);
  },
  finZoomIn: () => { P.fin.zoom = Math.min(1.2, +(P.fin.zoom + 0.1).toFixed(2)); pset('finZoom', P.fin.zoom); placeFin(); $('.zoom-pct').textContent = `${Math.round(P.fin.zoom * 100)}%`; },
  finZoomOut: () => { P.fin.zoom = Math.max(0.3, +(P.fin.zoom - 0.1).toFixed(2)); pset('finZoom', P.fin.zoom); placeFin(); $('.zoom-pct').textContent = `${Math.round(P.fin.zoom * 100)}%`; },
  import: () => $('#fileIn').click(),
  importFolder: () => $('#folderIn').click(),
  importBackup: () => $('#backupIn').click(),
  importMenu: async (b) => {
    const v = await menu(b, [
      { label: 'ファイルを選ぶ（画像・PDF）', icon: 'upload', value: 'f', hint: `${MOD}+O` },
      { label: 'フォルダから取り込む', icon: 'folder', value: 'd', hint: `${MOD}+Shift+O` },
      { divider: true },
      { label: 'スマホのデータを取り込む', icon: 'phone', value: 'b' },
    ], { width: 280 });
    if (v === 'f') ACTIONS.import(); if (v === 'd') ACTIONS.importFolder(); if (v === 'b') ACTIONS.importBackup();
  },
  newManual: () => newOf('receipt'),
  newTransit: () => newOf('transit'),
  newCar: () => newOf('car'),
  palette: () => openPalette(),
  theme: () => cycleTheme(),
  shortcuts: () => showShortcuts(),
  guide: () => { location.href = '../guide/?from=pc'; },
  backup: () => backupNow(),
  goReport: () => { P.rep.mode = 'unsettled'; go('report'); },
  goReviewFromReport: () => go('review'),
  settleOld: () => { const p = st.addMonth(thisYM(), -1); const un = unsettled().map((e) => e.date).sort(); Object.assign(P.rep, { mode: 'custom', from: un[0] || `${p}-01`, to: st.monthEnd(p) }); go('report'); },
  listThis: () => { Object.assign(P.list, { mode: 'month', ym: thisYM(), status: 'all', cat: '', site: '', method: '' }); go('list'); },
  listLast: () => { Object.assign(P.list, { mode: 'month', ym: st.addMonth(thisYM(), -1), status: 'all', cat: '', site: '', method: '' }); go('list'); },
  listUnsettled: () => { Object.assign(P.list, { mode: 'all', status: 'ok', cat: '', site: '', method: '' }); go('list'); },
  chartTable: (b) => { const t = $('#chMonthTable'); const c = $('#chMonth'); t.hidden = !t.hidden; c.hidden = !t.hidden ? true : false; b.innerHTML = `${ic(t.hidden ? 'table' : 'layers')}${t.hidden ? '表で見る' : 'グラフで見る'}`; },
  confirmAll: async () => {
    const ready = drafts().filter((e) => e.amount && e.date && e.category && !st.isReading(e.id));
    if (!ready.length) return;
    if (!(await confirmDialog(`金額・日付・科目がそろった ${ready.length}件をまとめて確定します。`, '確定する', { detail: '読み取りの結果を見ないで確定するので、あとで一覧で確かめてください。' }))) return;
    for (const e of ready) await st.commit(e);
    toast(`${ready.length}件を確定しました`, { kind: 'ok' });
  },
  // 経費一覧
  listPrev: () => { P.list.ym = st.addMonth(P.list.ym, -1); P.list.sel.clear(); render(); },
  listNext: () => { P.list.ym = st.addMonth(P.list.ym, 1); P.list.sel.clear(); render(); },
  periodMenu: async (b) => {
    const L = P.list; const ym = thisYM();
    const v = await menu(b, [
      { label: '今月', value: 'this', checked: L.mode === 'month' && L.ym === ym },
      { label: '先月', value: 'last', checked: L.mode === 'month' && L.ym === st.addMonth(ym, -1) },
      { label: `${ym.slice(0, 4)}年`, value: 'year', checked: L.mode === 'year' },
      { label: 'すべての期間', value: 'all', checked: L.mode === 'all' },
      { divider: true },
      { label: '期間を指定…', icon: 'calendar', value: 'range', checked: L.mode === 'range' },
    ], { width: 220 });
    if (!v) return;
    if (v === 'this') Object.assign(L, { mode: 'month', ym });
    if (v === 'last') Object.assign(L, { mode: 'month', ym: st.addMonth(ym, -1) });
    if (v === 'year') Object.assign(L, { mode: 'year', ym });
    if (v === 'all') L.mode = 'all';
    if (v === 'range') {
      const r = await modal({ title: '期間を指定', width: 420, body: `<div class="date-range"><input type="date" id="mFrom" value="${esc(L.from || `${ym}-01`)}" autofocus><span>〜</span><input type="date" id="mTo" value="${esc(L.to || today())}"></div>`,
        actions: [{ label: 'やめる', value: 'no' }, { label: 'この期間にする', value: 'ok', kind: 'primary' }],
        onMount: (el) => { el.addEventListener('change', (ev) => { if (ev.target.id === 'mFrom') L._f = ev.target.value; if (ev.target.id === 'mTo') L._t = ev.target.value; }); } });
      if (r !== 'ok') return;
      Object.assign(L, { mode: 'range', from: L._f || L.from || `${ym}-01`, to: L._t || L.to || today() });
    }
    L.sel.clear(); saveListPrefs(); render();
  },
  clearFilters: () => { Object.assign(P.list, { cat: '', site: '', method: '', q: '', amin: null, amax: null, vehicle: '' }); render(); },
  moreRows: () => { P.list.limit += 500; render(); },
  exportMenu: async (b) => {
    const v = await menu(b, [
      { header: `いま表示している ${listItems().length}件` },
      { label: '一覧の CSV（Excel）', icon: 'table', value: 'csv' },
      { label: '会計ソフト用の仕訳 CSV', icon: 'layers', value: 'journal', hint: '確定分のみ' },
    ], { align: 'right', width: 260 });
    if (v === 'csv') exportItems(listItems(), 'csv', csvName('経費一覧'));
    if (v === 'journal') exportItems(listItems(), 'journal', csvName('仕訳'));
  },
  bulkClear: () => { P.list.sel.clear(); render(); },
  bulkCat: async (b) => { const v = await menu(b, st.cats().map((c) => ({ label: c, value: c, icon: 'tag' })), { width: 200 }); if (v) bulkPatch({ category: v }, '科目'); },
  bulkMethod: async (b) => { const v = await menu(b, st.METHODS.map((c) => ({ label: c, value: c, icon: 'card' })), { width: 200 }); if (v) bulkPatch({ method: v }, '支払方法'); },
  bulkSite: async () => {
    let val = '';
    const r = await modal({ title: `${selIds().length}件の現場・案件を変える`, width: 440, body: `<label class="fld"><span class="lb">現場・案件</span><input id="mSite" list="dlSite" placeholder="空にすると「なし」" autofocus></label>`,
      actions: [{ label: 'やめる', value: 'no' }, { label: '変える', value: 'ok', kind: 'primary' }],
      onMount: (el, layer) => { const i = $('#mSite', el); i.addEventListener('input', () => { val = i.value.trim(); }); i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); layer.close('ok'); } }); } });
    if (r === 'ok') bulkPatch({ site: val }, '現場');
  },
  bulkConfirm: async () => {
    const list = selIds().map(st.byId).filter((e) => e && e.status === 'draft');
    const bad = list.filter((e) => st.validate(e));
    for (const e of list.filter((x) => !bad.includes(x))) await st.commit(e);
    toast(`${list.length - bad.length}件を確定しました${bad.length ? `（${bad.length}件は金額・日付・科目が足りません）` : ''}`, { kind: bad.length ? '' : 'ok' });
  },
  bulkReport: () => {
    const items = selIds().map(st.byId).filter((e) => e && e.status !== 'draft');
    if (!items.length) { toast('確定した経費を選んでください', { kind: 'error' }); return; }
    const dates = items.map((e) => e.date).sort();
    Object.assign(P.rep, { mode: 'selected', ids: items.map((e) => e.id), from: dates[0], to: dates[dates.length - 1] });
    go('report');
  },
  bulkCsv: () => exportItems(selIds().map(st.byId), 'csv', csvName('経費_選択')),
  bulkDelete: async () => {
    const ids = selIds(); if (!ids.length) return;
    const done = ids.filter((id) => st.byId(id)?.status === 'done').length;
    if (!(await confirmDialog(`${ids.length}件の経費を削除しますか？`, '削除する', { danger: true, detail: done ? `うち ${done}件は精算済みです。` : '画像・PDF も消えます。直後なら元に戻せます。' }))) return;
    if (P.ed && ids.includes(P.ed.id)) closeDrawer();
    const snap = await st.removeExpenses(ids);
    P.list.sel.clear();
    toast(`${ids.length}件を削除しました`, { action: { label: '元に戻す', run: () => st.restoreSnapshot(snap) } });
  },
  // 精算書
  repZoomIn: () => { P.rep.zoom = Math.min(1.2, +(P.rep.zoom + 0.1).toFixed(2)); pset('zoom', P.rep.zoom); placePages(); $('.zoom-pct').textContent = `${Math.round(P.rep.zoom * 100)}%`; },
  repZoomOut: () => { P.rep.zoom = Math.max(0.3, +(P.rep.zoom - 0.1).toFixed(2)); pset('zoom', P.rep.zoom); placePages(); $('.zoom-pct').textContent = `${Math.round(P.rep.zoom * 100)}%`; },
  repPdf: async (b) => {
    b.disabled = true; const old = b.innerHTML; b.innerHTML = '<span class="spin"></span>作っています…';
    try { const pages = await ensurePages(); const pdf = await pagesToPdf(pages, repFileName()); download(pdf, `${repFileName()}.pdf`); toast(`${repFileName()}.pdf を保存しました（${pages.length}ページ）`, { kind: 'ok' }); } catch (e) { toast(`PDF を作れませんでした: ${e.message || e}`, { kind: 'error' }); } finally { b.disabled = false; b.innerHTML = old; }
  },
  repPrint: async () => { try { printPages(await ensurePages()); } catch (e) { toast(`印刷できませんでした: ${e.message || e}`, { kind: 'error' }); } },
  repCsvMenu: async (b) => {
    const v = await menu(b, [{ label: '明細の CSV（Excel）', icon: 'table', value: 'csv' }, { label: '会計ソフト用の仕訳 CSV', icon: 'layers', value: 'journal' }], { width: 240 });
    const { from, to } = repRange();
    if (v === 'csv') exportItems(repItems(), 'csv', `経費精算_${from}_${to}.csv`);
    if (v === 'journal') exportItems(repItems(), 'journal', `仕訳_${from}_${to}.csv`);
  },
  repSettle: async () => {
    const items = repItems().filter((e) => e.status === 'ok'); if (!items.length) return;
    const { from, to } = repRange();
    const sum = summarize(items);
    if (!(await confirmDialog(`${items.length}件（立替 ${yen(sum.reimb)}）を「精算済み」にします。`, '精算済みにする', { detail: 'あとから「これまでの精算」で未精算に戻せます。' }))) return;
    const rep = await st.createReport(items, { from, to, advance: st.num(P.rep.advance) || 0, sum });
    P.rep.advance = ''; if (P.rep.mode === 'selected') P.rep.mode = 'unsettled';
    toast(`${rep.ids.length}件を精算済みにしました`, { kind: 'ok', action: { label: '元に戻す', run: () => st.undoReport(rep.id) } });
  },
  // 設定
  toggleKey: (b) => { const i = b.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? '表示' : '隠す'; },
  testAi: async (b) => {
    if (!S.settings.apiKey) { toast('API キーを入れてください', { kind: 'error' }); return; }
    b.disabled = true; const old = b.innerHTML; b.innerHTML = '<span class="spin"></span>テスト中…';
    try {
      const c = document.createElement('canvas'); c.width = 480; c.height = 360;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#000';
      g.font = '28px sans-serif'; ['テスト商店', '2026年1月5日', '合計 ¥1,234'].forEach((t, i) => g.fillText(t, 40, 80 + i * 70));
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const f = await readWithClaude(blob, { apiKey: S.settings.apiKey, model: S.settings.aiModel, categories: st.cats() });
      toast(f.amount === 1234 ? 'つながりました。AI で読み取れます' : `つながりました（読み取り結果: ${f.amount ?? '—'}）`, { kind: 'ok' });
    } catch (err) {
      toast(err instanceof AiError ? err.message : `つながりませんでした: ${err.message || err}`, { kind: 'error' });
    } finally { b.disabled = false; b.innerHTML = old; }
  },
  addCat: () => { const i = $('#newCat'); const v = i.value.trim(); if (!v) return; if (!st.cats().includes(v)) { S.settings.categories = [...st.cats(), v]; st.saveSettings(); } i.value = ''; render(); },
  resetCat: () => { S.settings.categories = DEFAULT_CATEGORIES.slice(); st.saveSettings(); render(); },
  wipe: async () => {
    if (!(await confirmDialog('すべての経費・画像・精算の記録を消します。元に戻せません。', 'すべて消す', { danger: true, title: 'すべてのデータを消す', detail: '先にバックアップを保存してください。' }))) return;
    closeDrawer(); await st.wipeAll(); toast('すべて消しました');
  },
};

Object.assign(ACTIONS, FX.actions);

// ---- クリック ---------------------------------------------------------------
document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.closest('.modal, .menu, .palette')) return;
  if (P.ed && t.closest('#drawer')) return;
  if (reviewEd && t.closest('#rvEd')) return;
  const a = t.closest('[data-act]');
  if (a && !a.disabled) { ev.preventDefault(); await ACTIONS[a.dataset.act]?.(a, ev); return; }
  const vg = t.closest('[data-view-go]');
  if (vg) { ev.preventDefault(); go(vg.dataset.viewGo); return; }
  const nav = t.closest('.nav [data-view], .brand');
  if (nav) { ev.preventDefault(); go(nav.dataset.view || 'home'); return; }
  const op = t.closest('[data-open]');
  if (op) { openExpense(op.dataset.open); return; }
  const tpl = t.closest('[data-tpl]');
  if (tpl) { const x = S.templates.find((y) => y.id === tpl.dataset.tpl); if (x) useTemplate(x); return; }
  const tpd = t.closest('[data-tpldate]');
  if (tpd) {
    const x = S.templates.find((y) => y.id === tpd.dataset.tpldate); if (!x) return;
    let d = today();
    const r = await modal({ title: `「${x.label}」を追加する日`, width: 380, body: `<label class="fld"><span class="lb">日付</span><input type="date" id="mDate" value="${today()}" autofocus></label>`, actions: [{ label: 'やめる', value: 'no' }, { label: '追加する', value: 'ok', kind: 'primary' }], onMount: (el) => { $('#mDate', el).addEventListener('change', (e2) => { d = e2.target.value; }); } });
    if (r === 'ok' && d) useTemplate(x, d);
    return;
  }
  const tdl = t.closest('[data-tpldel]');
  if (tdl) { const x = S.templates.find((y) => y.id === tdl.dataset.tpldel); if (x && await confirmDialog(`「${x.label}」をよく使うから消しますか？`, '消す', { danger: true })) st.removeTemplate(x.id); return; }
  const jump = t.closest('[data-jump]');
  if (jump) { ev.preventDefault(); const el = $(`#set-${jump.dataset.jump}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const dc = t.closest('[data-delcat]');
  if (dc) { S.settings.categories = st.cats().filter((k) => k !== dc.dataset.delcat); st.saveSettings(); render(); return; }
  const bt = t.closest('[data-btab]');
  if (bt) { P.books.tab = bt.dataset.btab; render(); return; }
  const fm = t.closest('[data-fmode]');
  if (fm) { P.fin.mode = fm.dataset.fmode; render(); return; }
  const pd = t.closest('[data-paid]');
  if (pd) { recordPayment(pd.dataset.paid); return; }
  const ld = t.closest('[data-led-del]');
  if (ld) { deleteLedger(ld.dataset.ledDel); return; }
  const le = t.closest('[data-led]');
  if (le) { const l = S.ledger.find((x) => x.id === le.dataset.led); if (l && l.invoice) ACTIONS.invEdit({ dataset: { id: l.id } }); else if (l && l.type === 'payout') ACTIONS.payoutEdit({ dataset: { id: l.id } }); else if (l) editLedger(l); return; }
  const rm = t.closest('[data-rmode]');
  if (rm) { P.rep.mode = rm.dataset.rmode; render(); return; }
  const rp = t.closest('[data-reppdf]');
  if (rp) {
    const r = S.reports.find((x) => x.id === rp.dataset.reppdf); if (!r) return;
    const items = r.ids.map(st.byId).filter(Boolean);
    const { pages } = await renderReport({ items, settings: S.settings, from: r.from, to: r.to, advance: r.advance || 0, getImage: async (id) => { const x = await st.imageRecord(id); return x && x.blob; } });
    const name = `経費精算書_${S.settings.name ? `${S.settings.name}_` : ''}${r.from}_${r.to}`;
    download(await pagesToPdf(pages, name), `${name}.pdf`);
    return;
  }
  const ru = t.closest('[data-repundo]');
  if (ru) { if (await confirmDialog('この精算を取り消して、経費を「未精算」に戻しますか？', '未精算に戻す')) { await st.undoReport(ru.dataset.repundo); toast('未精算に戻しました'); } return; }
  const rv = t.closest('[data-rv]');
  if (rv) { if (reviewEd && reviewEd.dirty) await reviewEd.save(); P.review.id = rv.dataset.rv; destroyReview(); render(); return; }
  // 経費一覧
  const ls = t.closest('[data-lstatus]');
  if (ls) { P.list.status = ls.dataset.lstatus; P.list.sel.clear(); saveListPrefs(); render(); return; }
  const sortH = t.closest('th[data-sort]');
  if (sortH) { const k = sortH.dataset.sort; if (P.list.sort === k) P.list.dir *= -1; else { P.list.sort = k; P.list.dir = k === 'date' || k === 'amount' ? -1 : 1; } saveListPrefs(); render(); return; }
  if (t.id === 'selAll') { const ids = listItems().map((e) => e.id); P.list.sel = t.checked ? new Set(ids) : new Set(); render(); return; }
  if (t.dataset && t.dataset.sel) { toggleSel(t.dataset.sel, { range: ev.shiftKey }); return; }
  const tr = t.closest('#tableWrap tr[data-id]');
  if (tr) {
    const id = tr.dataset.id;
    if (ev.shiftKey) { toggleSel(id, { range: true }); return; }
    if (ev.ctrlKey || ev.metaKey) { toggleSel(id); return; }
    setCursor(id, { scroll: false });
    openExpense(id);
  }
});

document.addEventListener('dblclick', (ev) => { if (ev.target.closest('#tableWrap tr[data-id]')) ev.preventDefault(); });

// ---- 入力 ------------------------------------------------------------------
const searchRender = debounce(() => { P.list.sel.clear(); render(); }, 120);
function updateOpenSums() {
  const b = bk();
  const sumA = ASSET_ACCOUNTS.reduce((t, [a]) => t + (+b.opening[a] || 0), 0);
  const sumL = LIABILITY_ACCOUNTS.reduce((t, a) => t + (+b.opening[a] || 0), 0);
  const [ea, el2] = $$('.open-sum b'); if (ea) ea.textContent = yen(sumA); if (el2) el2.textContent = yen(sumL);
  const eq = $('.open-eq b'); if (eq) eq.textContent = yen(sumA - sumL - (b.mode === 'corp' ? (+b.capital || 0) : 0));
}
function setBooks(el) {
  const b = { ...(S.settings.books || {}) };
  if (el.dataset.b) { const k = el.dataset.b; b[k] = k === 'closeMonth' ? +el.value : k === 'capital' ? (st.num(el.value) || 0) : el.value; }
  if (el.dataset.open) { b.opening = { ...(b.opening || {}) }; const n = st.num(el.value); if (n) b.opening[el.dataset.open] = n; else delete b.opening[el.dataset.open]; }
  if (el.dataset.pay) { b.payMap = { ...(b.payMap || {}), [el.dataset.pay]: el.value }; }
  S.settings.books = b; st.saveSettings();
  P.fin.pages = null;
}
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.closest('#drawer, #rvEd, .modal, .palette')) return;
  if (el.dataset.s) {
    const k = el.dataset.s;
    S.settings[k] = k === 'carRate' ? (st.dec(el.value) ?? st.DEF_SETTINGS.carRate) : el.value;
    st.saveSettings();
    if (P.view === 'report' && ['name', 'company', 'dept'].includes(k)) buildPreview();
    if (['name', 'company', 'dept'].includes(k)) renderChrome();
    return;
  }
  if (FX.onInput(el)) return;
  if (el.dataset.b || el.dataset.open || el.dataset.pay) { setBooks(el); return; }
  if (el.id === 'q') { P.list.q = el.value; searchRender(); return; }
  if (el.id === 'rAdv') { P.rep.advance = el.value; debounceRep(); }
});
const debounceRep = debounce(() => { if (P.view === 'report') render(); }, 400);
document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.closest('#drawer, #rvEd, .modal, .palette')) return;
  if (el.dataset.s) { S.settings[el.dataset.s] = el.dataset.s === 'carRate' ? (st.dec(el.value) ?? st.DEF_SETTINGS.carRate) : el.value; st.saveSettings(); if (el.tagName === 'SELECT') render(); return; }
  if (FX.onChange(el)) return;
  if (el.id === 'fAmin' || el.id === 'fAmax') { const n = st.num(el.value); P.list[el.id === 'fAmin' ? 'amin' : 'amax'] = n || null; P.list.sel.clear(); render(); return; }
  if (el.name === 'ocr') { S.settings.ocrMode = el.value; st.saveSettings(); render(); return; }
  if (el.name === 'bmode') { S.settings.books = { ...(S.settings.books || {}), mode: el.value, payMap: {} }; st.saveSettings(); render(); return; }
  if (el.dataset.b || el.dataset.open || el.dataset.pay) { setBooks(el); if (el.tagName === 'SELECT' || el.type === 'date') render(); else if (el.inputMode === 'numeric') { const n = st.num(el.value); el.value = n ? n.toLocaleString('ja-JP') : ''; updateOpenSums(); } return; }
  if (el.id === 'fFrom' || el.id === 'fTo') { P.fin[el.id === 'fFrom' ? 'from' : 'to'] = el.value; render(); return; }
  if (el.id === 'themeSel') { setTheme(el.value); return; }
  if (el.id === 'fCat') { P.list.cat = el.value; P.list.sel.clear(); render(); return; }
  if (el.id === 'fSite') { P.list.site = el.value; P.list.sel.clear(); render(); return; }
  if (el.id === 'fMethod') { P.list.method = el.value; P.list.sel.clear(); render(); return; }
  if (el.id === 'rDone') { P.rep.includeDone = el.checked; render(); return; }
  if (el.id === 'rFrom' || el.id === 'rTo') { P.rep[el.id === 'rFrom' ? 'from' : 'to'] = el.value; render(); return; }
  if (el.id === 'rAdv') { const n = st.num(el.value); P.rep.advance = n ? n.toLocaleString('ja-JP') : ''; render(); return; }
  if (el.id === 'fileIn' || el.id === 'folderIn') { const files = [...el.files]; el.value = ''; if (files.length) doImport(files); return; }
  if (el.id === 'backupIn') { const f = el.files[0]; el.value = ''; if (f) importBackupFile(f); }
});

// ---- キーボード ---------------------------------------------------------------
document.addEventListener('keydown', (ev) => {
  const mod = ev.ctrlKey || ev.metaKey;
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); if (layerStack.length) layerStack[layerStack.length - 1].close(); else openPalette(); return; }
  if (ev.key === 'Escape') {
    if (layerStack.length) { layerStack[layerStack.length - 1].close(); return; }
    if (closeTop()) { ev.preventDefault(); return; }
    hideTip();
    if (P.ed) { ev.preventDefault(); P.ed.requestClose(); return; }
    if (typing) { document.activeElement.blur(); return; }
    if (P.view === 'list' && P.list.sel.size) { P.list.sel.clear(); render(); }
    return;
  }
  if (topLayer() || layerStack.length) return;
  if (mod && ev.key.toLowerCase() === 'o') { ev.preventDefault(); if (ev.shiftKey) ACTIONS.importFolder(); else ACTIONS.import(); return; }
  if (mod && ev.key.toLowerCase() === 'p' && P.view === 'report' && repItems().length) { ev.preventDefault(); ACTIONS.repPrint(); return; }
  if (typing) return;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#drawer, #rvEd')) return;
  if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) { ev.preventDefault(); showShortcuts(); return; }
  if (!mod && !ev.altKey && /^[0-9]$/.test(ev.key)) { ev.preventDefault(); go(['settings', 'home', 'review', 'list', 'report', 'books', 'statements', 'analysis', 'approvals', 'templates'][+ev.key]); return; }
  if (!mod && ev.key.toLowerCase() === 'n') { ev.preventDefault(); newOf('receipt'); return; }
  if (P.view === 'list') {
    const ids = listItems().slice(0, P.list.limit).map((e) => e.id);
    if (ev.key === '/') { ev.preventDefault(); $('#q')?.focus(); return; }
    if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); P.list.sel = new Set(ids); render(); return; }
    if (!ids.length) return;
    let i = ids.indexOf(P.list.cursor);
    if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); i = Math.min(ids.length - 1, i + 1); setCursor(ids[i]); if (ev.shiftKey) { P.list.sel.add(ids[i]); render(); } if (P.ed) openDrawer(st.byId(ids[i])); return; }
    if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); i = Math.max(0, i - 1); setCursor(ids[i]); if (ev.shiftKey) { P.list.sel.add(ids[i]); render(); } if (P.ed) openDrawer(st.byId(ids[i])); return; }
    if (ev.key === 'Enter' && P.list.cursor) { ev.preventDefault(); openExpense(P.list.cursor); return; }
    if ((ev.key === ' ' || ev.key === 'x') && P.list.cursor) { ev.preventDefault(); toggleSel(P.list.cursor); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && P.list.sel.size) { ev.preventDefault(); ACTIONS.bulkDelete(); }
  }
});

window.addEventListener('resize', debounce(() => { if (P.view === 'home') afterHome(); }, 150));

// ===========================================================================
// はじめ
// ===========================================================================
async function start() {
  paint(document);
  $('#paletteKey').innerHTML = `<kbd>${MOD}</kbd><kbd>K</kbd>`;
  await st.loadAll();
  FX.init({ P, render, renderChrome, go, allJournals, fyOf, shiftFY, fyLabel, booksRange, accountOptions, emptyState, editLedger, printPages });
  st.resumePending();
  P.view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  render();
  document.body.classList.add('ready');
  FX.startExtras();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
  }
}
start();
