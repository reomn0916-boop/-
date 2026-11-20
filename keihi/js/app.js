// ラク経費（スマホ版）: 画面と操作。データの扱いは store.js（パソコン版と共通）
import { db, usage } from './db.js';
import { readWithClaude, AI_MODELS, AiError } from './ocr.js';
import { DEFAULT_CATEGORIES, checkInvoiceNo, toISODate, guessCategory } from './parse.js';
import { renderReport, pagesToPdf, toCSV, summarize, yen, isCompanyPaid } from './report.js';
import {
  S, on, METHODS, saveSettings, saveTemplates, byId, cats, loadAll, saveExpense, newExpense,
  recentSites, recentPayees, recentPlaces, thumbURL, importFiles as storeImport, enqueue, isReading, readingCount,
  fillFromOcr, reread, learn, findDup, computeAmount, validate, commit, removeExpenses, restoreSnapshot,
  templateFrom, addTemplate, removeTemplate, expenseFromTemplate, createReport, undoReport as storeUndoReport,
  makeBackup, readBackup, mergeBackup, wipeAll, resumePending, DEF_SETTINGS,
} from './store.js';
import * as sh from './share.js';

// ---- 小さな道具 --------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => toISODate(new Date());
const ymOf = (iso) => (iso || '').slice(0, 7);
const jpYM = (ym) => `${+ym.slice(0, 4)}年${+ym.slice(5, 7)}月`;
const addMonth = (ym, k) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthEnd = (ym) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0); return toISODate(d); };
const WD = '日月火水木金土';
const mdw = (iso) => { if (!iso) return '日付なし'; const d = new Date(`${iso}T00:00:00`); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : '');
const num = (v) => { const n = parseInt(String(v ?? '').normalize('NFKC').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const dec = (v) => { const n = parseFloat(String(v ?? '').normalize('NFKC').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };

const ICONS = {
  camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H7l1.6-2.2A1.5 1.5 0 0 1 9.8 3h4.4a1.5 1.5 0 0 1 1.2.8L17 6h1.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.8"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10.5h14M9 21l1.5-4M15 21l-1.5-4"/><path d="M9 14h.01M15 14h.01"/>',
  car: '<path d="M5 17H3.5v-4.5L5.6 7.6A1.5 1.5 0 0 1 7 6.7h10a1.5 1.5 0 0 1 1.4.9l2.1 4.9V17H19"/><path d="M9.5 17h5M3.5 12.5h17"/><circle cx="7.2" cy="17" r="2"/><circle cx="16.8" cy="17" r="2"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  doc: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12.5h7M9 16.5h7"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12"/>',
  download: '<path d="M12 3.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  spark: '<path d="M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z"/><path d="M19 15.5c.3 1.8 1 2.5 2.5 2.8-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.8z"/>',
  receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  redo: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M18.5 4.5 21 7"/>',
};
const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
function paintIcons(root = document) { $$('i[data-ic]', root).forEach((el) => { el.outerHTML = ic(el.dataset.ic); }); }

// ---- 保存しておく設定 ------------------------------------------------------------

// 画面の状態（データそのものは store.js の S）
Object.assign(S, {
  tab: 'home',
  list: { ym: ymOf(todayISO()), all: false, q: '', status: 'all' },
  rep: { mode: 'unsettled', from: '', to: '', includeDone: false, advance: '' },
  lastPdf: null,
});

// ---- トースト・シート -----------------------------------------------------------

let toastTimer = null;
function toast(msg, action = null, ms = 3200) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-toast="1">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  if (action) $('button', t).onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

let sheetClose = null;
function openSheet(html, { onClose = null, cls = '' } = {}) {
  const sh = $('#sheet');
  sh.className = `sheet ${cls}`;
  sh.innerHTML = `<div class="sheet-back" data-act="sheetClose"></div><div class="sheet-card" role="dialog" aria-modal="true">${html}</div>`;
  sh.hidden = false;
  document.body.classList.add('modal');
  paintIcons(sh);
  sheetClose = onClose;
  requestAnimationFrame(() => sh.classList.add('open'));
  return $('.sheet-card', sh);
}
function closeSheet() {
  const sh = $('#sheet');
  if (sh.hidden) return;
  const cb = sheetClose; sheetClose = null;
  sh.classList.remove('open');
  sh.hidden = true; sh.innerHTML = '';
  document.body.classList.remove('modal');
  if (cb) cb();
}

function confirmBox(msg, okLabel = 'OK', { danger = false } = {}) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'confirm';
    box.innerHTML = `<div class="confirm-card" role="alertdialog"><p>${esc(msg)}</p><div class="row end"><button class="btn" data-c="0">やめる</button><button class="btn ${danger ? 'danger' : 'primary'}" data-c="1">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-c]');
      if (!b && ev.target !== box) return;
      ev.stopPropagation();
      box.remove();
      resolve(!!b && b.dataset.c === '1');
    });
  });
}

// ---- 入力候補・サムネイル ----------------------------------------------------------

function fillDatalists() {
  $('#dlPayee').innerHTML = recentPayees().map((p) => `<option value="${esc(p)}">`).join('');
  $('#dlSite').innerHTML = recentSites().map((p) => `<option value="${esc(p)}">`).join('');
  $('#dlPlace').innerHTML = recentPlaces().map((p) => `<option value="${esc(p)}">`).join('');
}

// サムネイル（画像はあとから非同期に入れる）
function hydrateThumbs(root = document) {
  $$('img[data-thumb]', root).forEach(async (img) => {
    const url = await thumbURL(img.dataset.thumb);
    if (url) img.src = url;
    img.removeAttribute('data-thumb');
  });
}

// ---- 画像・PDF の取り込み（読み取りの順番待ちは store.js） -------------------------------------

async function importFiles(files, { single = false } = {}) {
  const r = await storeImport(files);
  r.failed.forEach((f) => toast(`読み込めませんでした: ${f.name} ${f.error}`));
  if (!r.made.length) { if (!r.failed.length) toast('画像か PDF のファイルを選んでください'); return; }
  if (single && r.made.length === 1) openEditor(r.made[0], { isNew: true, fromCamera: true });
  else {
    toast(`${r.made.length}件を読み取っています。終わったら「確認待ち」で確かめてください`);
    go('home');
  }
  render();
}

function updateOcrViews(id) {
  const o = S.ocr.get(id);
  $$(`[data-ocr="${id}"]`).forEach((el) => {
    if (!o) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.className = `ocr ocr-${o.state}`;
    const label = o.state === 'done' ? (o.msg || '読み取りました') : o.msg || '読み取り中';
    el.innerHTML = `${o.state === 'run' || o.state === 'wait' ? '<span class="spin"></span>' : o.state === 'error' ? ic('warn') : ic('check')}<span>${esc(label)}</span>${o.state === 'run' ? `<b>${Math.round(o.p * 100)}%</b>` : ''}`;
  });
  const n = readingCount();
  $('#topInfo').innerHTML = n ? `<span class="pill"><span class="spin"></span>読み取り中 ${n}</span>` : '';
}

// store からの知らせ
on('ocr', (id) => updateOcrViews(id));
on('ocr-result', (id, f, engine) => {
  if (ED && ED.cur.id === id) syncEditor(fillFromOcr(ED.cur, f, engine, ED.touched));
});
let renderQueued = false;
on('change', () => { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); });
on('error', (msg) => toast(msg));

// ---- 経費の編集 --------------------------------------------------------------

let ED = null;
const KIND_LABEL = { receipt: 'レシート', transit: '電車・バス', car: '車（km）' };

function openEditor(e, { isNew = false, fromCamera = false } = {}) {
  ED = { cur: JSON.parse(JSON.stringify(e)), isNew, fromCamera, touched: new Set(), imageURL: '' };
  const card = openSheet('<div class="ed" id="ed"></div>', {
    cls: 'full',
    onClose: () => { if (ED && ED.imageURL) URL.revokeObjectURL(ED.imageURL); ED = null; render(); },
  });
  void card;
  renderEditor();
  if (e.imageId) {
    db.get('images', e.imageId).then((rec) => {
      if (!rec || !ED || ED.cur.id !== e.id) return;
      ED.imageURL = URL.createObjectURL(rec.blob);
      const img = $('#edImg'); if (img) img.src = ED.imageURL;
    });
  }
}

function renderEditor() {
  const c = ED.cur;
  const host = $('#ed');
  if (!host) return;
  const o = S.ocr.get(c.id);
  const sure = (c.ocr && c.ocr.sure) || {};
  const fromOcr = (c.ocr && c.ocr.filled) || [];
  const chk = (k) => (fromOcr.includes(k) && !ED.touched.has(k) && sure[k] === false ? ' check' : '');
  const dup = findDup({ ...c, amount: computeAmount(c) });
  const showPeople = c.category === '会議費' || c.category === '接待交際費';
  const perHead = c.people && computeAmount(c) ? Math.round(computeAmount(c) / c.people) : null;
  const inv = (c.invoiceNo || '').replace(/^T/, '');
  const invOk = c.invoiceNo ? checkInvoiceNo(c.invoiceNo) : true;
  const route = c.route || { from: '', to: '', round: false };
  const siteChips = recentSites().slice(0, 6);
  const rate = c.rate != null ? c.rate : S.settings.carRate;

  host.innerHTML = `
    <div class="ed-head">
      <button class="icon-btn" data-act="sheetClose" aria-label="閉じる">${ic('x')}</button>
      <b>${ED.isNew ? '経費を追加' : c.status === 'draft' ? '確認して保存' : '経費の編集'}</b>
      <button class="btn primary sm" data-act="edSave">保存</button>
    </div>
    <div class="ed-body">
      ${c.imageId ? `
        <div class="rimg">
          <img id="edImg" alt="領収書の画像" data-act="zoom">
          <div class="ocr" data-ocr="${c.id}" ${o ? '' : 'hidden'}></div>
          <div class="rimg-acts">
            <button class="chip" data-act="edReread">${ic('redo')}読み直す</button>
          </div>
        </div>` : ''}
      ${c.ocr && c.ocr.notReceipt ? `<div class="note warn">${ic('warn')}レシート・領収書ではないかもしれません</div>` : ''}
      ${c.status === 'done' ? `<div class="note">${ic('check')}精算済みの経費です（直すと精算書と合わなくなります）</div>` : ''}
      <div class="seg kind" role="group" aria-label="種類">
        ${Object.entries(KIND_LABEL).map(([k, v]) => `<button data-kind="${k}" class="${c.kind === k ? 'on' : ''}">${ic(k === 'receipt' ? 'receipt' : k === 'transit' ? 'train' : 'car')}${v}</button>`).join('')}
      </div>
      ${c.kind === 'receipt' ? `
        <label class="f amt${chk('amount')}"><span class="lb">金額（税込）</span>
          <span class="amt-in"><em>¥</em><input data-f="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${c.amount != null ? c.amount.toLocaleString('ja-JP') : ''}"></span>
        </label>` : `
        <div class="f route">
          <span class="lb">区間</span>
          <div class="route-in">
            <input data-f="route.from" placeholder="出発（例: 自宅）" list="dlPlace" value="${esc(route.from)}">
            <span class="arrow">→</span>
            <input data-f="route.to" placeholder="到着（例: A現場）" list="dlPlace" value="${esc(route.to)}">
          </div>
          <label class="toggle"><input type="checkbox" data-f="route.round" ${route.round ? 'checked' : ''}><span>往復</span></label>
        </div>
        ${c.kind === 'transit' ? `
          <label class="f"><span class="lb">片道の運賃</span><span class="amt-in sm"><em>¥</em><input data-f="fare" inputmode="numeric" placeholder="0" value="${c.fare ?? ''}"></span></label>` : `
          <div class="f two">
            <label><span class="lb">片道の距離</span><span class="amt-in sm"><input data-f="km" inputmode="decimal" placeholder="0" value="${c.km ?? ''}"><em>km</em></span></label>
            <label><span class="lb">1km あたり</span><span class="amt-in sm"><input data-f="rate" inputmode="decimal" value="${rate}"><em>円</em></span></label>
          </div>`}
        <div class="calc">金額 <b id="edCalc">${computeAmount(c) != null ? yen(computeAmount(c)) : '—'}</b></div>`}
      <div class="f${chk('date')}"><span class="lb">日付</span>
        <div class="row"><input type="date" data-f="date" value="${esc(c.date || '')}" max="${addDays(todayISO(), 2)}">
        <button class="chip" data-act="edDate" data-d="0">今日</button><button class="chip" data-act="edDate" data-d="-1">昨日</button></div>
      </div>
      ${dup ? `<div class="note warn" id="edDup">${ic('warn')}<span>同じ日・同じ金額の経費があります: ${esc(dup.payee || '（支払先なし）')} ${yen(dup.amount)}</span><button class="chip" data-act="edDupOpen" data-id="${dup.id}">見る</button></div>` : '<div id="edDup"></div>'}
      <label class="f${chk('payee')}"><span class="lb">支払先</span><input data-f="payee" list="dlPayee" placeholder="${c.kind === 'car' ? '自家用車' : c.kind === 'transit' ? '例: JR東日本' : '店名・会社名'}" value="${esc(c.payee)}" autocomplete="off"></label>
      <div class="f${chk('category')}"><span class="lb">勘定科目</span>
        <div class="chips" id="edCat">${cats().map((k) => `<button class="chip ${c.category === k ? 'on' : ''}" data-cat="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      </div>
      <div class="f"><span class="lb">現場・案件</span>
        <input data-f="site" list="dlSite" placeholder="例: ○○邸新築工事（なしでも可）" value="${esc(c.site)}" autocomplete="off">
        ${siteChips.length ? `<div class="chips sm">${siteChips.map((s) => `<button class="chip ${c.site === s ? 'on' : ''}" data-site="${esc(s)}">${esc(s)}</button>`).join('')}${c.site ? '<button class="chip ghost" data-site="">なし</button>' : ''}</div>` : ''}
      </div>
      <div class="f${chk('method')}"><span class="lb">支払方法</span>
        <div class="seg wrap" id="edMethod">${METHODS.map((m) => `<button class="${c.method === m ? 'on' : ''}" data-method="${m}">${m}</button>`).join('')}</div>
        ${isCompanyPaid(c) ? '<small class="hint">会社払いは精算額に入りません（記録と領収書の保管用）</small>' : ''}
      </div>
      <label class="f"><span class="lb">内容・目的</span><input data-f="memo" placeholder="例: 養生テープ・軍手 / 打合せ" value="${esc(c.memo)}" autocomplete="off"></label>
      ${showPeople ? `
        <div class="f two">
          <label><span class="lb">人数（自分を含む）</span><input data-f="people" inputmode="numeric" value="${c.people ?? ''}" placeholder="例: 3"></label>
          <label><span class="lb">相手先</span><input data-f="guests" value="${esc(c.guests)}" placeholder="例: ○○工務店 山田様"></label>
        </div>
        ${perHead ? `<small class="hint">1人あたり ${yen(perHead)}${c.category === '接待交際費' && perHead <= 10000 ? '（1人 1万円以下の飲食は、相手先・人数を書けば交際費から外せます）' : ''}</small>` : ''}` : ''}
      <details class="more" ${c.invoiceNo || c.tax10 || c.tax8 ? 'open' : ''}>
        <summary>インボイス（登録番号・税率）</summary>
        <label class="f${chk('invoiceNo')}"><span class="lb">登録番号</span>
          <span class="amt-in sm"><em>T</em><input data-f="invoiceNo" inputmode="numeric" maxlength="16" placeholder="13桁の数字" value="${esc(inv)}"></span>
        </label>
        ${c.invoiceNo && !invOk ? `<small class="hint warn">番号が読みまちがっていないか確認してください</small>` : ''}
        ${c.invoiceNo && /^T\d{13}$/.test(c.invoiceNo) ? `<a class="hint link" href="https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=${c.invoiceNo.slice(1)}" target="_blank" rel="noopener">国税庁の公表サイトで確認する</a>` : ''}
        <div class="f two">
          <label><span class="lb">10%対象額</span><span class="amt-in sm"><em>¥</em><input data-f="tax10" inputmode="numeric" value="${c.tax10 ?? ''}"></span></label>
          <label><span class="lb">8%対象額</span><span class="amt-in sm"><em>¥</em><input data-f="tax8" inputmode="numeric" value="${c.tax8 ?? ''}"></span></label>
        </div>
      </details>
      <div class="ed-more">
        <button class="btn ghost" data-act="edTemplate">${ic('star')}よく使うに登録</button>
        ${ED.isNew ? '' : `<button class="btn ghost" data-act="edCopy">${ic('copy')}複製</button>`}
        <button class="btn ghost danger" data-act="edDelete">${ic('trash')}削除</button>
      </div>
    </div>
    <div class="ed-foot">
      ${c.kind === 'receipt' && (ED.fromCamera || c.status === 'draft') ? `<button class="btn" data-act="edSaveNext">${ic('camera')}保存して次へ</button>` : ''}
      <button class="btn primary" data-act="edSave">${ic('check')}保存</button>
    </div>`;
  updateOcrViews(c.id);
  if (ED.imageURL) { const img = $('#edImg'); if (img) img.src = ED.imageURL; }
}

function addDays(iso, k) { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + k); return toISODate(d); }

// OCR の結果を入力欄に反映（触った欄は変えない）
function fieldText(k) {
  const v = ED.cur[k];
  if (v == null) return '';
  if (k === 'amount') return v.toLocaleString('ja-JP');
  if (k === 'invoiceNo') return String(v).replace(/^T/, '');
  return String(v);
}
function syncEditor(filled) {
  if (!ED || !filled.length) return;
  const f = document.activeElement;
  const typing = f && f.closest && f.closest('#ed') && /INPUT|SELECT|TEXTAREA/.test(f.tagName);
  if (!typing) {
    const y = $('.ed-body') ? $('.ed-body').scrollTop : 0;
    renderEditor();
    if ($('.ed-body')) $('.ed-body').scrollTop = y;
  } else {
    // 入力中は作り直さず、値だけ入れる（カーソルを動かさない）
    for (const k of filled) { const el = $(`#ed [data-f="${k}"]`); if (el) el.value = fieldText(k); }
    $$('#edCat [data-cat]').forEach((b) => b.classList.toggle('on', b.dataset.cat === ED.cur.category));
    $$('#edMethod [data-method]').forEach((b) => b.classList.toggle('on', b.dataset.method === ED.cur.method));
  }
  filled.forEach((k) => { const el = $(`#ed [data-f="${k}"]`); if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } });
}

function edInput(el) {
  const k = el.dataset.f; const c = ED.cur;
  ED.touched.add(k.split('.')[0] === 'route' ? 'route' : k);
  c.auto = (c.auto || []).filter((x) => x !== k);
  if (k.startsWith('route.')) {
    c.route = c.route || { from: '', to: '', round: false };
    const kk = k.slice(6);
    c.route[kk] = el.type === 'checkbox' ? el.checked : el.value.trim();
  } else if (['amount', 'fare', 'tax10', 'tax8', 'people'].includes(k)) c[k] = num(el.value);
  else if (['km', 'rate'].includes(k)) c[k] = dec(el.value);
  else if (k === 'invoiceNo') { const d = el.value.normalize('NFKC').replace(/\D/g, ''); c.invoiceNo = d ? `T${d}` : ''; } else c[k] = el.value;
  // 支払先を入れたら科目を自動で選ぶ（自分で選んだ科目は変えない）
  if (k === 'payee' && !ED.touched.has('category')) {
    const g = guessCategory(c.payee, c.memo, S.learned, cats());
    if (g && g !== c.category) {
      c.category = g;
      $$('#edCat [data-cat]').forEach((b) => b.classList.toggle('on', b.dataset.cat === g));
    }
  }
  if (c.kind !== 'receipt') { const calc = $('#edCalc'); if (calc) { const a = computeAmount(c); calc.textContent = a != null ? yen(a) : '—'; } }
  if (k === 'amount' || k === 'date' || k === 'fare' || k === 'km' || k.startsWith('route')) {
    const dup = findDup({ ...c, amount: computeAmount(c) });
    const box = $('#edDup');
    if (box) box.outerHTML = dup ? `<div class="note warn" id="edDup">${ic('warn')}<span>同じ日・同じ金額の経費があります: ${esc(dup.payee || '（支払先なし）')} ${yen(dup.amount)}</span><button class="chip" data-act="edDupOpen" data-id="${dup.id}">見る</button></div>` : '<div id="edDup"></div>';
  }
}

function edSave({ next = false } = {}) {
  const c = ED.cur;
  const bad = validate(c);
  if (bad) {
    toast(bad.msg);
    const el = $(`[data-f="${bad.field}"]`); if (el) el.focus();
    return;
  }
  const wasNew = ED.isNew;
  // カメラはタップの流れの中で開かないと iPhone では開かない
  if (next) $('#camIn').click();
  closeSheet();
  commit(c).then(() => {
    toast(wasNew ? `保存しました ${yen(c.amount)}` : '保存しました');
  }).catch((err) => toast(`保存できませんでした: ${err.message || err}`));
}

// ---- よく使う（ワンタップで追加） -------------------------------------------------------

async function useTemplate(t) {
  const e = expenseFromTemplate(t);
  if (!e.amount || !e.category) { openEditor(e, { isNew: true }); return; }
  await saveExpense(e);
  toast(`今日の分を追加しました: ${t.label} ${yen(e.amount)}`, { label: '元に戻す', run: () => removeExpenses([e.id]) });
}

// ---- 画面: ホーム ------------------------------------------------------------------

function rowHTML(e) {
  const o = S.ocr.get(e.id);
  const icon = e.imageId ? `<img data-thumb="${e.imageId}" alt="">` : ic(e.kind === 'car' ? 'car' : e.kind === 'transit' ? 'train' : 'pen');
  const title = e.payee || (e.kind === 'receipt' ? (o ? '読み取り中…' : '支払先なし') : '');
  const sub = [e.category, e.site, e.route && (e.route.from || e.route.to) ? `${e.route.from || ''}→${e.route.to || ''}${e.route.round ? '（往復）' : ''}` : '', e.memo].filter(Boolean).join(' ・ ');
  const badge = e.status === 'draft' ? '<span class="badge draft">確認待ち</span>' : e.status === 'done' ? '<span class="badge done">精算済</span>' : '';
  return `<button class="row-item ${e.status}" data-open="${e.id}">
    <span class="thumb">${icon}</span>
    <span class="mid"><span class="t">${esc(title)}</span><span class="s">${esc(sub) || '&nbsp;'}</span><span class="ocr" data-ocr="${e.id}" hidden></span></span>
    <span class="end"><span class="a ${isCompanyPaid(e) ? 'co' : ''}">${e.amount != null ? yen(e.amount) : '—'}</span>${badge}</span>
  </button>`;
}

function groupByDate(list) {
  const g = new Map();
  for (const e of list) { const k = e.date || ''; if (!g.has(k)) g.set(k, []); g.get(k).push(e); }
  return [...g.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function viewHome() {
  const ym = ymOf(todayISO());
  const confirmed = S.expenses.filter((e) => e.status !== 'draft');
  const month = confirmed.filter((e) => ymOf(e.date) === ym);
  const monthSum = month.reduce((s, e) => s + (e.amount || 0), 0);
  const unsettled = confirmed.filter((e) => e.status === 'ok' && !isCompanyPaid(e));
  const unsettledSum = unsettled.reduce((s, e) => s + (e.amount || 0), 0);
  const drafts = S.expenses.filter((e) => e.status === 'draft').sort((a, b) => b.created - a.created);
  const old = unsettled.filter((e) => ymOf(e.date) < ym);
  const recent = confirmed.sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 8);
  const ready = drafts.filter((e) => e.amount && e.date && e.category && !isReading(e.id)).length;

  return `
    <section class="sum-card">
      <div class="sum-main"><span>${+ym.slice(5)}月の経費</span><b>${yen(monthSum)}</b><small>${month.length}件</small></div>
      <div class="sum-sub">
        <button data-act="goReport"><span>未精算（立替）</span><b>${yen(unsettledSum)}</b></button>
        <button data-act="goList" data-status="draft"><span>確認待ち</span><b>${drafts.length}件</b></button>
      </div>
    </section>
    ${!S.settings.name ? `<button class="note link-note" data-tab="settings">${ic('pen')}精算書にのせる名前を設定する</button>` : ''}
    <button class="big-cam" data-act="camera">
      ${ic('camera')}<span><b>レシートを撮る</b><small>金額・日付・お店を自動で読み取り</small></span>
    </button>
    <div class="quick">
      <button data-act="pick">${ic('image')}<span>写真から<small>まとめて</small></span></button>
      <button data-act="newTransit">${ic('train')}<span>電車・バス<small>領収書なし</small></span></button>
      <button data-act="newCar">${ic('car')}<span>車の距離<small>km で計算</small></span></button>
      <button data-act="newManual">${ic('pen')}<span>手で入力<small>画像なし</small></span></button>
    </div>
    ${S.templates.length ? `
      <section class="block">
        <h2>${ic('star')}よく使う<small>タップで今日の分を追加</small></h2>
        <div class="tpl">${S.templates.map((t) => `<button class="tpl-chip" data-tpl="${t.id}"><span>${esc(t.label)}</span><b>${t.amount ? yen(t.amount) : ''}</b></button>`).join('')}</div>
      </section>` : ''}
    ${old.length ? `
      <button class="note banner" data-act="settleOld">
        ${ic('doc')}<span><b>先月までの未精算が ${old.length}件（${yen(old.reduce((s, e) => s + e.amount, 0))}）あります</b><small>タップして精算書を作る</small></span>${ic('chevR')}
      </button>` : ''}
    ${drafts.length ? `
      <section class="block">
        <h2>${ic('check')}確認待ち <span class="cnt">${drafts.length}</span>
          ${ready ? `<button class="chip on" data-act="confirmAll">${ready}件をまとめて確定</button>` : ''}</h2>
        <div class="rows">${drafts.map(rowHTML).join('')}</div>
      </section>` : ''}
    <section class="block">
      <h2>${ic('list')}最近の経費</h2>
      ${recent.length ? `<div class="rows">${recent.map(rowHTML).join('')}</div>` : `
        <div class="empty">
          <p>まだ経費はありません。</p>
          <p>レシートをもらったら、その場で「撮る」を押すだけ。<br>月末は「精算」から精算書 PDF を作って送れます。</p>
        </div>`}
    </section>`;
}

// ---- 画面: 一覧 --------------------------------------------------------------------

function filteredList() {
  const L = S.list;
  const q = L.q.trim().normalize('NFKC').toLowerCase();
  const qn = num(q);
  return S.expenses.filter((e) => {
    if (!L.all && ymOf(e.date) !== L.ym) return false;
    if (L.status !== 'all' && e.status !== L.status) return false;
    if (!q) return true;
    const hay = [e.payee, e.memo, e.site, e.category, e.method, e.guests, e.invoiceNo, e.route && e.route.from, e.route && e.route.to].join(' ').normalize('NFKC').toLowerCase();
    return hay.includes(q) || (qn != null && e.amount === qn);
  });
}

function viewList() {
  const L = S.list;
  const list = filteredList();
  const sum = summarize(list.filter((e) => e.status !== 'draft'));
  const groups = groupByDate(list);
  const st = [['all', 'すべて'], ['ok', '未精算'], ['done', '精算済み'], ['draft', '確認待ち']];
  return `
    <div class="list-head">
      <div class="month">
        <button class="icon-btn" data-act="ym" data-k="-1" ${L.all ? 'disabled' : ''} aria-label="前の月">${ic('chevL')}</button>
        <b>${L.all ? 'すべての期間' : jpYM(L.ym)}</b>
        <button class="icon-btn" data-act="ym" data-k="1" ${L.all ? 'disabled' : ''} aria-label="次の月">${ic('chevR')}</button>
        <button class="chip ${L.all ? 'on' : ''}" data-act="allPeriod">全期間</button>
      </div>
      <label class="search">${ic('search')}<input id="q" type="search" placeholder="支払先・内容・現場・金額で探す" value="${esc(L.q)}"></label>
      <div class="seg wrap">${st.map(([k, v]) => `<button data-status="${k}" class="${L.status === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="list-sum">${list.length}件　立替 <b>${yen(sum.reimb)}</b>${sum.company ? `　会社払い ${yen(sum.company)}` : ''}
        <button class="chip" data-act="csvList">${ic('table')}CSV</button></div>
    </div>
    ${groups.length ? groups.map(([d, items]) => `
      <section class="day"><h3>${mdw(d)}<span>${yen(items.reduce((s, e) => s + (e.amount || 0), 0))}</span></h3>
        <div class="rows">${items.sort((a, b) => b.created - a.created).map(rowHTML).join('')}</div></section>`).join('') : '<div class="empty"><p>該当する経費はありません。</p></div>'}`;
}

// ---- 画面: 精算 --------------------------------------------------------------------

function repRange() {
  const R = S.rep; const ym = ymOf(todayISO());
  if (R.mode === 'this') return { from: `${ym}-01`, to: monthEnd(ym) };
  if (R.mode === 'last') { const p = addMonth(ym, -1); return { from: `${p}-01`, to: monthEnd(p) }; }
  if (R.mode === 'custom') return { from: R.from || `${ym}-01`, to: R.to || todayISO() };
  const un = S.expenses.filter((e) => e.status === 'ok' && e.date).map((e) => e.date).sort();
  return { from: un[0] || `${ym}-01`, to: un[un.length - 1] || todayISO() };
}
function repItems() {
  const { from, to } = repRange();
  return S.expenses.filter((e) => e.date >= from && e.date <= to && (e.status === 'ok' || (S.rep.includeDone && e.status === 'done')));
}

function viewReport() {
  const R = S.rep;
  const { from, to } = repRange();
  const items = repItems();
  const sum = summarize(items);
  const adv = num(R.advance) || 0;
  const net = sum.reimb - adv;
  const drafts = S.expenses.filter((e) => e.status === 'draft' && e.date >= from && e.date <= to).length;
  const modes = [['unsettled', '未精算すべて'], ['this', '今月'], ['last', '先月'], ['custom', '期間を指定']];
  const reps = [...S.reports].sort((a, b) => b.created - a.created);
  return `
    <section class="block">
      <h2>${ic('doc')}精算書を作る</h2>
      <div class="seg wrap">${modes.map(([k, v]) => `<button data-rmode="${k}" class="${R.mode === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      ${R.mode === 'custom' ? `<div class="row dates"><input type="date" id="rFrom" value="${esc(from)}"><span>〜</span><input type="date" id="rTo" value="${esc(to)}"></div>` : `<p class="period">${mdw(from)} 〜 ${mdw(to)}</p>`}
      <label class="toggle"><input type="checkbox" id="rDone" ${R.includeDone ? 'checked' : ''}><span>精算済みの経費も入れる（作り直し用）</span></label>
      <label class="f inline"><span class="lb">仮払金（先にもらったお金）</span><span class="amt-in sm"><em>¥</em><input id="rAdv" inputmode="numeric" placeholder="0" value="${esc(R.advance)}"></span></label>
      <div class="rep-sum">
        <div><span>件数</span><b>${sum.count}件</b></div>
        <div><span>立替合計</span><b>${yen(sum.reimb)}</b></div>
        ${sum.company ? `<div><span>会社払い（参考）</span><b>${yen(sum.company)}</b></div>` : ''}
        <div class="net"><span>${net >= 0 ? '差引支給額' : '差引返金額'}</span><b>${yen(Math.abs(net))}</b></div>
      </div>
      ${sum.byCat.length ? `<div class="bars">${sum.byCat.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><i style="--w:${Math.max(2, Math.round((v / Math.max(1, sum.total)) * 100))}%"></i><b>${yen(v)}</b></div>`).join('')}</div>` : ''}
      ${drafts ? `<button class="note warn" data-act="goList" data-status="draft">${ic('warn')}<span>この期間に確認待ちが ${drafts}件あります（精算書に入りません）</span>${ic('chevR')}</button>` : ''}
      ${!S.settings.name ? `<button class="note" data-tab="settings">${ic('pen')}名前が未設定です（設定で入れると精算書にのります）</button>` : ''}
      <div class="stack">
        <button class="btn primary big" data-act="makePdf" ${sum.count ? '' : 'disabled'}>${ic('doc')}精算書 PDF を作る<small>明細・集計・領収書の台紙つき</small></button>
        <button class="btn" data-act="csvReport" ${sum.count ? '' : 'disabled'}>${ic('table')}CSV（Excel）で書き出す</button>
      </div>
    </section>
    ${reps.length ? `
      <section class="block">
        <h2>${ic('check')}これまでの精算</h2>
        <div class="rows">${reps.map((r) => `
          <div class="rep-item">
            <div><b>${md(r.from)}〜${md(r.to)}</b><small>${new Date(r.created).toLocaleDateString('ja-JP')} 作成 ・ ${r.ids.length}件</small></div>
            <b class="a">${yen(r.reimb)}</b>
            <button class="chip" data-repPdf="${r.id}">${ic('doc')}PDF</button>
            <button class="chip ghost" data-repUndo="${r.id}">${ic('undo')}戻す</button>
          </div>`).join('')}</div>
      </section>` : ''}`;
}

async function makePdf(items, { from, to, advance, reportId = null } = {}) {
  if (!items.length) { toast('対象の経費がありません'); return; }
  const card = openSheet(`<div class="busy"><span class="spin big"></span><p>精算書を作っています…</p><small id="pdfProg"></small></div>`);
  void card;
  try {
    const { pages, sum } = await renderReport({
      items, settings: S.settings, from, to, advance,
      getImage: async (id) => { const r = await db.get('images', id); return r && r.blob; },
      onProgress: (p) => { const el = $('#pdfProg'); if (el) el.textContent = `領収書 ${Math.round(p * 100)}%`; },
    });
    const name = `経費精算書_${S.settings.name ? `${S.settings.name}_` : ''}${from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : `${from}_${to}`}.pdf`;
    const pdf = await pagesToPdf(pages, name.replace(/\.pdf$/, ''));
    const previews = pages.map((p) => { const c = document.createElement('canvas'); c.width = 248; c.height = 351; c.getContext('2d').drawImage(p, 0, 0, 248, 351); return c.toDataURL('image/jpeg', 0.7); });
    S.lastPdf = { blob: pdf, name, items, from, to, advance, sum, reportId };
    closeSheet();
    const settledAlready = reportId || items.every((e) => e.status === 'done');
    openSheet(`
      <div class="ed-head"><button class="icon-btn" data-act="sheetClose" aria-label="閉じる">${ic('x')}</button><b>精算書ができました</b><span></span></div>
      <div class="pdf-res">
        <p class="pdf-meta">${esc(name)}<br>${pages.length}ページ ・ ${(pdf.size / 1024 / 1024).toFixed(1)}MB ・ 精算額 <b>${yen(sum.reimb - (advance || 0))}</b></p>
        <div class="pages">${previews.map((u, i) => `<img src="${u}" alt="${i + 1}ページ目" data-act="openPdf">`).join('')}</div>
        <div class="stack">
          <button class="btn primary big" data-act="sharePdf">${ic('share')}送る（LINE・メールなど）</button>
          <div class="row2"><button class="btn" data-act="savePdf">${ic('download')}保存</button><button class="btn" data-act="openPdf">${ic('print')}開く・印刷</button></div>
          ${settledAlready ? '' : `<button class="btn ok" data-act="settle">${ic('check')}提出したので「精算済み」にする</button>`}
        </div>
      </div>`, { cls: 'full' });
  } catch (err) {
    closeSheet();
    toast(`精算書を作れませんでした: ${err.message || err}`);
  }
}

async function settleLast() {
  const L = S.lastPdf; if (!L) return;
  const rep = await createReport(L.items, { from: L.from, to: L.to, advance: L.advance || 0, sum: L.sum });
  S.rep.advance = '';
  closeSheet();
  toast(`${rep.ids.length}件を精算済みにしました`, { label: '元に戻す', run: () => undoReport(rep.id, true) });
}

async function undoReport(id, silent = false) {
  if (!silent && !(await confirmBox('この精算を取り消して、経費を「未精算」に戻しますか？', '未精算に戻す'))) return;
  await storeUndoReport(id);
  toast('未精算に戻しました');
}

// ---- 共有・保存 ---------------------------------------------------------------------

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  download(blob, name);
  toast('この端末では送る機能が使えないので、保存しました');
}

// ---- 画面: 設定 --------------------------------------------------------------------

function viewSettings() {
  const st = S.settings;
  return `
    <section class="block">
      <h2>${ic('pen')}申請者（精算書にのります）</h2>
      <label class="f"><span class="lb">会社名</span><input data-s="company" value="${esc(st.company)}" placeholder="例: 株式会社○○建設"></label>
      <label class="f"><span class="lb">所属</span><input data-s="dept" value="${esc(st.dept)}" placeholder="例: 工事部"></label>
      <label class="f"><span class="lb">氏名</span><input data-s="name" value="${esc(st.name)}" placeholder="例: 山田 太郎"></label>
    </section>
    <section class="block">
      <h2>${ic('spark')}読み取り方</h2>
      <div class="radio-cards">
        <label class="rc ${st.ocrMode !== 'ai' ? 'on' : ''}"><input type="radio" name="ocr" value="device" ${st.ocrMode !== 'ai' ? 'checked' : ''}>
          <b>端末内で読む（無料）</b><small>画像は外に送りません。はじめての読み取りだけ、読み取り用データ（約6MB）をダウンロードします。</small></label>
        <label class="rc ${st.ocrMode === 'ai' ? 'on' : ''}"><input type="radio" name="ocr" value="ai" ${st.ocrMode === 'ai' ? 'checked' : ''}>
          <b>AI で読む（高精度）</b><small>Claude（Anthropic）に画像を送って読み取ります。手書き・しわ・斜めでも強い。API キーが必要で、料金は Anthropic への支払いです（1枚あたり数円程度・Haiku なら1円未満）。</small></label>
      </div>
      ${st.ocrMode === 'ai' ? `
        <label class="f"><span class="lb">API キー</span>
          <span class="key-in">${ic('key')}<input data-s="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(st.apiKey)}"><button class="chip" data-act="toggleKey">表示</button></span></label>
        <small class="hint">キーはこの端末の中だけに保存し、Anthropic 以外には送りません。キーは console.anthropic.com で作れます。共用の端末では使わないでください。</small>
        <label class="f"><span class="lb">モデル</span><select data-s="aiModel">${AI_MODELS.map((m) => `<option value="${m.id}" ${st.aiModel === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
        <button class="btn" data-act="testAi">${ic('spark')}接続をテストする</button>` : ''}
    </section>
    <section class="block">
      <h2>${ic('sliders')}入力の初期値</h2>
      <label class="f"><span class="lb">支払方法の初期値</span><select data-s="defaultMethod">${METHODS.map((m) => `<option ${st.defaultMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label class="f"><span class="lb">レシートが「カード払い」のとき</span><select data-s="cardMethod">${['個人カード', '会社カード'].map((m) => `<option ${st.cardMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <div class="f two">
        <label><span class="lb">車の単価（1km）</span><span class="amt-in sm"><input data-s="carRate" inputmode="decimal" value="${st.carRate}"><em>円</em></span></label>
        <label><span class="lb">車の科目</span><select data-s="carCategory">${cats().map((m) => `<option ${st.carCategory === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      </div>
    </section>
    <section class="block">
      <h2>${ic('list')}勘定科目</h2>
      <div class="chips">${cats().map((k) => `<span class="chip on">${esc(k)}<button class="x" data-delcat="${esc(k)}" aria-label="${esc(k)}を消す">×</button></span>`).join('')}</div>
      <div class="row"><input id="newCat" placeholder="科目を追加（例: 外注費）"><button class="btn sm" data-act="addCat">${ic('plus')}追加</button></div>
      <button class="link" data-act="resetCat">初期の科目に戻す</button>
    </section>
    <section class="block">
      <h2>${ic('star')}よく使う</h2>
      ${S.templates.length ? `<div class="rows">${S.templates.map((t) => `<div class="rep-item"><div><b>${esc(t.label)}</b><small>${esc([t.category, t.site].filter(Boolean).join(' ・ '))}</small></div><b class="a">${t.amount ? yen(t.amount) : ''}</b><button class="chip ghost" data-deltpl="${t.id}">${ic('trash')}消す</button></div>`).join('')}</div>` : '<p class="muted">経費の編集画面の「よく使うに登録」で増やせます。毎日の通勤や駐車場など、決まった経費をワンタップで入れられます。</p>'}
    </section>
    ${driveBlock()}
    <section class="block">
      <h2>${ic('box')}データ</h2>
      <p class="muted" id="usage">${sh.gd.drive.used ? 'データはこの端末と Google ドライブに保存しています。' : 'データはこの端末の中だけに保存しています。機種変更やもしものために、ときどきバックアップしてください。'}</p>
      <p class="muted">パソコン版（このアドレスの最後に pc/ を付けたページ）では、送ったファイルをドラッグするだけで取り込めます。同じ経費は新しい方が残ります。</p>
      <div class="stack">
        <button class="btn primary" data-act="sendPc">${ic('share')}パソコンへ送る（LINE・メール・ドライブ）</button>
        <button class="btn" data-act="backup">${ic('download')}バックアップを保存（画像も含む）</button>
        <button class="btn" data-act="restore">${ic('undo')}バックアップから戻す</button>
        <button class="btn ghost danger" data-act="wipe">${ic('trash')}すべてのデータを消す</button>
      </div>
    </section>
    <p class="foot muted">ラク経費 ・ 端末内保存（サーバーなし）</p>`;
}

// ---- Google ドライブ（パソコン版と自動でそろえる） -------------------------------------------
function driveBlock() {
  const gd = sh.gd; const s = sh.syncState;
  if (!gd.drive.used) {
    return `<section class="block" id="drive">
      <h2>${ic('share')}Google ドライブで同期</h2>
      <p class="muted">Google アカウントでつなぐと、マイドライブの「ラク経費」フォルダにデータと領収書を自動で保存します。パソコン版でも同じアカウントでつなぐと、撮ったレシートがそのままパソコンに出ます。機種変更しても消えません。</p>
      <button class="btn primary" data-act="driveConnect">${ic('share')}Google ドライブにつなぐ</button>
    </section>`;
  }
  const ok = gd.connected();
  return `<section class="block" id="drive">
    <h2>${ic('share')}Google ドライブで同期</h2>
    <div class="drive-st ${ok && !s.error ? 'ok' : 'warn'}"><b>${ok ? '同期しています' : 'つながりが切れています'}</b><small>${gd.drive.email ? esc(gd.drive.email) + ' ・ ' : ''}${s.busy ? esc(s.progress || '同期中…') : `最後: ${s.lastWrite ? new Date(s.lastWrite).toLocaleString('ja-JP') : 'まだ'}`}${s.error && ok ? ` ・ ${esc(s.error)}` : ''}</small></div>
    <div class="stack">${ok ? `<button class="btn primary" data-act="driveSync">${ic('share')}今すぐ同期</button>` : `<button class="btn primary" data-act="driveConnect">${ic('share')}つなぎ直す</button>`}
      <button class="link" data-act="driveOff">同期をやめる</button></div>
  </section>`;
}
async function driveAfter(r, quiet = false) {
  if (r && r.ok && (r.merged || r.imgDown)) toast(`パソコン・ほかの端末の変更を取り込みました${r.merged ? `（${r.merged}件）` : ''}`);
  else if (r && !r.ok && !r.busy && !quiet) toast(r.error || '同期できませんでした');
  if (S.tab === 'settings') render(); else renderBadges();
}
function renderBadges() { const b = $('#driveBadge'); if (b) b.hidden = !sh.gd.needsReconnect(); }

// ---- 描画 --------------------------------------------------------------------

function render() {
  const v = $('#view');
  const y = window.scrollY;
  // 入力中の欄があれば、描き直したあとも同じ欄・同じカーソル位置に戻す
  const a = document.activeElement;
  let keep = null;
  if (a && v.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) {
    const sel = a.id ? `#${a.id}` : a.dataset.s ? `[data-s="${a.dataset.s}"]` : null;
    if (sel) { let caret = null; try { caret = a.selectionStart; } catch (_) { /* date など */ } keep = { sel, caret }; }
  }
  v.innerHTML = S.tab === 'home' ? viewHome() : S.tab === 'list' ? viewList() : S.tab === 'report' ? viewReport() : viewSettings();
  $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  hydrateThumbs(v);
  for (const id of S.ocr.keys()) updateOcrViews(id);
  fillDatalists();
  window.scrollTo(0, y);
  if (keep) {
    const el = $(keep.sel, v);
    if (el) { el.focus({ preventScroll: true }); if (keep.caret != null) { try { el.setSelectionRange(keep.caret, keep.caret); } catch (_) { /* 選べない欄 */ } } }
  }
  if (S.tab === 'settings') usage().then((u) => { if (u && $('#usage')) $('#usage').textContent = `データはこの端末の中だけに保存しています（使用量 約${(u.usage / 1024 / 1024).toFixed(1)}MB）。機種変更やもしものために、ときどきバックアップしてください。`; });
}

function go(tab) {
  if (S.tab !== tab) { S.tab = tab; window.scrollTo(0, 0); }
  render();
}

// ---- 操作 --------------------------------------------------------------------

const ACTIONS = {
  sheetClose: () => closeSheet(),
  camera: () => $('#camIn').click(),
  pick: () => $('#pickIn').click(),
  newManual: () => openEditor(newExpense({ kind: 'receipt', auto: [] }), { isNew: true }),
  newTransit: () => openEditor(newExpense({ kind: 'transit', category: '旅費交通費', route: { from: '', to: '', round: true }, auto: [] }), { isNew: true }),
  newCar: () => openEditor(newExpense({ kind: 'car', category: S.settings.carCategory, payee: '自家用車', memo: 'ガソリン代（距離）', route: { from: '', to: '', round: true }, rate: S.settings.carRate, auto: [] }), { isNew: true }),
  goReport: () => { S.rep.mode = 'unsettled'; go('report'); },
  goList: (b) => { S.list.status = b.dataset.status || 'all'; S.list.all = true; closeSheet(); go('list'); },
  settleOld: () => { S.rep.mode = 'custom'; S.rep.from = ''; const p = addMonth(ymOf(todayISO()), -1); const un = S.expenses.filter((e) => e.status === 'ok').map((e) => e.date).sort(); S.rep.from = un[0] || `${p}-01`; S.rep.to = monthEnd(p); go('report'); },
  confirmAll: async () => {
    const ready = S.expenses.filter((e) => e.status === 'draft' && e.amount && e.date && e.category && !isReading(e.id));
    for (const e of ready) await commit(e);
    toast(`${ready.length}件を確定しました`);
  },
  help: () => openSheet(`
    <div class="ed-head"><button class="icon-btn" data-act="sheetClose" aria-label="閉じる">${ic('x')}</button><b>使い方</b><span></span></div>
    <div class="help">
      <ol>
        <li><b>レシートを撮る</b>　下の「撮る」を押して撮影。金額・日付・お店・科目が自動で入ります。黄色の欄だけ確かめて「保存」。続けて撮るなら「保存して次を撮る」。</li>
        <li><b>まとめて取り込む</b>　たまったレシートは「写真から」で何枚でも選べます。読み取りが終わると「確認待ち」に並ぶので、「まとめて確定」でおしまい。パソコンなら画像をドラッグ＆ドロップ、Android なら写真アプリの「共有」からも送れます。</li>
        <li><b>電車・車</b>　領収書のない交通費は「電車・バス」、自家用車は「車の距離」（km × 単価）。毎日同じものは「よく使うに登録」しておけば、ホームのボタン 1 回で今日の分が入ります。</li>
        <li><b>精算</b>　月末は「精算」→「精算書 PDF を作る」→「送る」。明細・科目別の集計・領収書の台紙（1ページ6枚）が 1 つの PDF になります。提出したら「精算済みにする」。</li>
      </ol>
      <p class="muted">データはこの端末の中だけに保存しています。ホーム画面に追加するとアプリのように使え、電波がなくても記録できます。紙の領収書は、会社の決まりに合わせて保管してください。</p>
    </div>`, { cls: 'full' }),
  edSave: () => edSave(),
  edSaveNext: () => edSave({ next: true }),
  edDate: (b) => { const el = $('[data-f="date"]'); el.value = addDays(todayISO(), +b.dataset.d); edInput(el); },
  edReread: () => { if (ED) { ED.touched.clear(); ED.cur.auto = ['date', 'method', 'amount', 'payee', 'category', 'memo', 'invoiceNo', 'tax10', 'tax8']; reread(ED.cur.id); } },
  edDupOpen: (b) => { const d = byId(b.dataset.id); if (d) { closeSheet(); openEditor(d); } },
  edTemplate: () => {
    const c = ED.cur;
    const t = templateFrom(c);
    if (!t.amount) { toast('金額を入れてから登録してください'); return; }
    addTemplate(t);
    toast(`「${t.label}」をよく使うに登録しました`);
  },
  edCopy: async () => {
    const c = ED.cur;
    const { id, ...rest } = JSON.parse(JSON.stringify(c)); void id;
    const e = newExpense({ ...rest, status: 'ok', date: todayISO(), imageId: null, ocr: null, reportId: null, auto: [], created: Date.now() });
    closeSheet();
    openEditor(e, { isNew: true });
    toast('今日の日付で複製しました（画像は付きません）');
  },
  edDelete: async () => {
    const c = ED.cur;
    const stored = byId(c.id);
    if (!stored) { closeSheet(); return; }
    if (stored.status === 'done' && !(await confirmBox('精算済みの経費です。削除しますか？', '削除', { danger: true }))) return;
    closeSheet();
    const snap = await removeExpenses([stored.id]);
    toast('削除しました', { label: '元に戻す', run: () => restoreSnapshot(snap) });
  },
  zoom: () => { if (!ED || !ED.imageURL) return; const v = $('#viewer'); v.innerHTML = `<img src="${ED.imageURL}" alt="領収書の画像"><button class="icon-btn close" aria-label="閉じる">${ic('x')}</button>`; v.hidden = false; v.onclick = (ev) => { if (ev.target.tagName === 'IMG') ev.target.classList.toggle('big'); else { v.hidden = true; v.innerHTML = ''; } }; },
  ym: (b) => { S.list.ym = addMonth(S.list.ym, +b.dataset.k); render(); },
  allPeriod: () => { S.list.all = !S.list.all; render(); },
  csvList: () => { const l = filteredList(); if (!l.length) { toast('書き出す経費がありません'); return; } shareFile(new Blob([toCSV(l)], { type: 'text/csv' }), `経費一覧_${S.list.all ? '全期間' : S.list.ym}.csv`); },
  csvReport: () => { const { from, to } = repRange(); shareFile(new Blob([toCSV(repItems())], { type: 'text/csv' }), `経費精算_${from}_${to}.csv`); },
  makePdf: () => { const { from, to } = repRange(); makePdf(repItems(), { from, to, advance: num(S.rep.advance) || 0 }); },
  sharePdf: () => S.lastPdf && shareFile(S.lastPdf.blob, S.lastPdf.name),
  savePdf: () => S.lastPdf && download(S.lastPdf.blob, S.lastPdf.name),
  openPdf: () => { if (!S.lastPdf) return; const u = URL.createObjectURL(S.lastPdf.blob); const w = window.open(u, '_blank'); if (!w) download(S.lastPdf.blob, S.lastPdf.name); setTimeout(() => URL.revokeObjectURL(u), 120000); },
  settle: () => settleLast(),
  toggleKey: (b) => { const i = b.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? '表示' : '隠す'; },
  testAi: async (b) => {
    if (!S.settings.apiKey) { toast('API キーを入れてください'); return; }
    b.disabled = true; b.innerHTML = '<span class="spin"></span>テスト中…';
    try {
      const c = document.createElement('canvas'); c.width = 480; c.height = 360;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#000';
      g.font = '28px sans-serif'; ['テスト商店', '2026年1月5日', '合計 ¥1,234'].forEach((t, i) => g.fillText(t, 40, 80 + i * 70));
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const f = await readWithClaude(blob, { apiKey: S.settings.apiKey, model: S.settings.aiModel, categories: cats() });
      toast(f.amount === 1234 ? 'つながりました。AI で読み取れます' : `つながりました（読み取り結果: ${f.amount ?? '—'}）`);
    } catch (err) {
      toast(err instanceof AiError ? err.message : `つながりませんでした: ${err.message || err}`);
    } finally { b.disabled = false; b.innerHTML = `${ic('spark')}接続をテストする`; }
  },
  addCat: () => { const i = $('#newCat'); const v = i.value.trim(); if (!v) return; if (!cats().includes(v)) { S.settings.categories = [...cats(), v]; saveSettings(); } render(); },
  resetCat: () => { S.settings.categories = DEFAULT_CATEGORIES.slice(); saveSettings(); render(); },
  driveConnect: async () => {
    const gd = sh.gd;
    if (!gd.configured()) {
      const id = (prompt('Google の OAuth クライアント ID を貼り付けてください（…apps.googleusercontent.com）。作り方は keihi/docs/google-drive.md にあります。') || '').trim();
      if (!/\.apps\.googleusercontent\.com$/.test(id)) { if (id) toast('ID の形がちがいます'); return; }
      gd.setClientId(id);
    }
    try { await gd.connect(); } catch (e) { toast(e.message); render(); return; }
    toast('Google ドライブと同期しています…');
    render();
    driveAfter(await sh.syncNow());
  },
  driveSync: async (b) => { b.disabled = true; const r = await sh.syncNow(); if (r.ok && !r.merged) toast('同期しました'); driveAfter(r); },
  driveOff: async () => { if (!confirm('Google ドライブとの同期をやめますか？（ドライブのファイルとこの端末のデータは消えません）')) return; sh.gd.disconnect(); render(); },
  backup: async () => backup(),
  sendPc: async () => backup({ send: true }),
  restore: () => $('#restoreIn').click(),
  wipe: async () => {
    if (!(await confirmBox('すべての経費・画像・精算の記録を消します。元に戻せません。先にバックアップを保存しましたか？', 'すべて消す', { danger: true }))) return;
    await wipeAll();
    toast('すべて消しました');
  },
};

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  const act = t.closest('[data-act]');
  if (act && !act.disabled) { ev.preventDefault(); await ACTIONS[act.dataset.act]?.(act, ev); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { closeSheet(); go(tab.dataset.tab); return; }
  const open = t.closest('[data-open]');
  if (open) { const e = byId(open.dataset.open); if (e) openEditor(e); return; }
  const tpl = t.closest('[data-tpl]');
  if (tpl) { const x = S.templates.find((y) => y.id === tpl.dataset.tpl); if (x) useTemplate(x); return; }
  // 編集画面
  if (ED) {
    const kind = t.closest('[data-kind]');
    if (kind) {
      const c = ED.cur; c.kind = kind.dataset.kind;
      if (c.kind !== 'receipt' && !c.route) c.route = { from: '', to: '', round: true };
      if (c.kind === 'car') { if (!c.payee) c.payee = '自家用車'; if (!c.category) c.category = S.settings.carCategory; }
      if (c.kind === 'transit' && !c.category) c.category = '旅費交通費';
      renderEditor(); return;
    }
    const cat = t.closest('[data-cat]');
    if (cat) { ED.cur.category = cat.dataset.cat; ED.touched.add('category'); renderEditor(); return; }
    const site = t.closest('[data-site]');
    if (site) { ED.cur.site = site.dataset.site; ED.touched.add('site'); renderEditor(); return; }
    const m = t.closest('[data-method]');
    if (m) { ED.cur.method = m.dataset.method; ED.touched.add('method'); ED.cur.auto = (ED.cur.auto || []).filter((k) => k !== 'method'); renderEditor(); return; }
  }
  const st = t.closest('[data-status]');
  if (st && S.tab === 'list') { S.list.status = st.dataset.status; render(); return; }
  const rm = t.closest('[data-rmode]');
  if (rm) { S.rep.mode = rm.dataset.rmode; render(); return; }
  const rp = t.closest('[data-reppdf]');
  if (rp) { const r = S.reports.find((x) => x.id === rp.dataset.reppdf); if (r) makePdf(r.ids.map(byId).filter(Boolean), { from: r.from, to: r.to, advance: r.advance, reportId: r.id }); return; }
  const ru = t.closest('[data-repundo]');
  if (ru) { undoReport(ru.dataset.repundo); return; }
  const dc = t.closest('[data-delcat]');
  if (dc) { S.settings.categories = cats().filter((k) => k !== dc.dataset.delcat); saveSettings(); render(); return; }
  const dt = t.closest('[data-deltpl]');
  if (dt) { S.templates = S.templates.filter((x) => x.id !== dt.dataset.deltpl); saveTemplates(); render(); }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (ED && el.dataset.f) { edInput(el); return; }
  if (el.dataset.s) {
    const k = el.dataset.s;
    S.settings[k] = k === 'carRate' ? (dec(el.value) ?? DEF_SETTINGS.carRate) : el.value;
    saveSettings();
    return;
  }
  if (el.id === 'q') { S.list.q = el.value; render(); return; }
  if (el.id === 'rAdv') { S.rep.advance = el.value; }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (ED && el.dataset.f) {
    edInput(el);
    if (el.dataset.f === 'amount' && el.value) { const n = num(el.value); el.value = n != null ? n.toLocaleString('ja-JP') : ''; }
    if (['date', 'route.round', 'people', 'invoiceNo'].includes(el.dataset.f)) {
      const y = $('.ed-body').scrollTop; renderEditor(); $('.ed-body').scrollTop = y;
    }
    return;
  }
  if (el.dataset.s) {
    if (el.dataset.s === 'aiModel' || el.dataset.s === 'carCategory' || el.dataset.s === 'defaultMethod' || el.dataset.s === 'cardMethod') { S.settings[el.dataset.s] = el.value; saveSettings(); }
    return;
  }
  if (el.name === 'ocr') { S.settings.ocrMode = el.value; saveSettings(); render(); return; }
  if (el.id === 'rDone') { S.rep.includeDone = el.checked; render(); return; }
  if (el.id === 'rFrom' || el.id === 'rTo') { S.rep[el.id === 'rFrom' ? 'from' : 'to'] = el.value; render(); return; }
  if (el.id === 'rAdv') { const n = num(el.value); S.rep.advance = n ? n.toLocaleString('ja-JP') : ''; render(); return; }
  if (el.id === 'camIn' || el.id === 'pickIn') {
    const files = [...el.files]; el.value = '';
    if (ED && files.length) closeSheet();
    if (files.length) await importFiles(files, { single: el.id === 'camIn' && files.length === 1 });
    return;
  }
  if (el.id === 'restoreIn') { const f = el.files[0]; el.value = ''; if (f) restore(f); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!$('#viewer').hidden) { $('#viewer').hidden = true; return; }
    closeSheet();
  }
  if (ev.key === 'Enter' && ED && ev.target.dataset && ev.target.dataset.f && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
    ev.preventDefault();
    ev.target.dispatchEvent(new Event('change', { bubbles: true }));
    const inputs = $$('.ed-body input:not([type=checkbox]):not([type=radio])');
    const i = inputs.indexOf(ev.target);
    if (i >= 0 && inputs[i + 1]) inputs[i + 1].focus(); else edSave();
  }
});

// パソコン: 画像のドラッグ＆ドロップ・貼り付け
let dragDepth = 0;
window.addEventListener('dragenter', (ev) => { if ([...(ev.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (ev) => { if ([...(ev.dataTransfer?.types || [])].includes('Files')) ev.preventDefault(); });
window.addEventListener('drop', (ev) => {
  if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
  ev.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  closeSheet();
  importFiles(ev.dataTransfer.files);
});
window.addEventListener('paste', (ev) => {
  if (ED || (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName))) return;
  const files = [...(ev.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
  if (files.length) { ev.preventDefault(); importFiles(files, { single: files.length === 1 }); }
});

// ---- バックアップ・パソコンへ送る ----------------------------------------------------------

async function backup({ send = false } = {}) {
  toast('バックアップを作っています…');
  const blob = await makeBackup();
  const name = `ラク経費_バックアップ_${todayISO()}.json`;
  if (send) await shareFile(blob, name); else download(blob, name);
}

async function restore(file) {
  let info;
  try { info = await readBackup(file); } catch (e) { toast(e.message); return; }
  const msg = `${info.total}件のうち、新しい経費 ${info.added}件・更新 ${info.updated}件を取り込みます。いまある経費は消えません。`;
  if (!(await confirmBox(msg, '取り込む'))) return;
  const n = await mergeBackup(info.j);
  toast(`${n}件を取り込みました`);
}

// ---- Android の「共有」から受け取った画像 --------------------------------------------------

async function takeShared() {
  const p = new URLSearchParams(location.search);
  if (!p.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('rakukeihi-share');
    const keys = await cache.keys();
    const files = [];
    for (const k of keys) { const r = await cache.match(k); if (r) { const t = r.headers.get('content-type') || 'image/jpeg'; files.push(new File([await r.blob()], t === 'application/pdf' ? 'shared.pdf' : 'shared.jpg', { type: t })); }; await cache.delete(k); }
    if (files.length) await importFiles(files, { single: files.length === 1 });
  } catch (_) { toast('共有された画像を受け取れませんでした'); }
}

// ---- はじめ ------------------------------------------------------------------

async function start() {
  paintIcons();
  await loadAll();
  resumePending();
  const tab = location.hash.replace('#', '');
  if (['home', 'list', 'report', 'settings'].includes(tab)) S.tab = tab;
  render();
  await takeShared();
  sh.startAutoSync((r) => driveAfter(r, true));
  if (sh.gd.connected()) sh.syncNow().then((r) => driveAfter(r, true));
  renderBadges();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start();
