// パソコン版の部品: アイコン・書式・トースト・ダイアログ・メニュー
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

// ---- 書式 ------------------------------------------------------------------
const WD = '日月火水木金土';
export const yen = (n) => `¥${Math.round(n || 0).toLocaleString('ja-JP')}`;
export const yenShort = (n) => (Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}万` : Math.round(n).toLocaleString('ja-JP'));
export const md = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : '');
export const mdw = (iso) => { if (!iso) return ''; const d = new Date(`${iso}T00:00:00`); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
export const ymd = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${y}年${m}月${d}日`; };
export const jpYM = (ym) => `${+ym.slice(0, 4)}年${+ym.slice(5, 7)}月`;
export const wd = (iso) => (iso ? WD[new Date(`${iso}T00:00:00`).getDay()] : '');
export function ago(t) {
  if (!t) return 'まだありません';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'たった今'; if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`; return `${Math.floor(s / 86400)}日前`;
}

// ---- アイコン（24 グリッドの線画） ----------------------------------------------------
const I = {
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  inbox: '<path d="M4 13.5 6.4 5.6A1 1 0 0 1 7.4 5h9.2a1 1 0 0 1 1 .6L20 13.5V19H4z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  doc: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12.5h7M9 16.5h7"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  download: '<path d="M12 3.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10.5h14M9 21l1.5-4M15 21l-1.5-4"/><path d="M9 14h.01M15 14h.01"/>',
  car: '<path d="M5 17H3.5v-4.5L5.6 7.6A1.5 1.5 0 0 1 7 6.7h10a1.5 1.5 0 0 1 1.4.9l2.1 4.9V17H19"/><path d="M9.5 17h5M3.5 12.5h17"/><circle cx="7.2" cy="17" r="2"/><circle cx="16.8" cy="17" r="2"/>',
  receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  chevD: '<path d="m6 9.5 6 6 6-6"/>',
  chevU: '<path d="m6 14.5 6-6 6 6"/>',
  sort: '<path d="M8 5v14M4.5 8.5 8 5l3.5 3.5M16 19V5M12.5 15.5 16 19l3.5-3.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8" cy="8" r="1.3"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  rotate: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V8H16"/>',
  redo: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  spark: '<path d="M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z"/><path d="M19 15.5c.3 1.8 1 2.5 2.5 2.8-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M18.5 4.5 21 7"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  more: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/>',
};
export const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[name] || ''}</svg>`;
export const kbd = (...keys) => `<span class="kbd">${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>`;

// ---- トースト（左下に積む） ---------------------------------------------------------
export function toast(msg, { action = null, kind = '', ms = kind === 'ok' ? 2600 : 3800 } = {}) {
  const host = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `${kind === 'error' ? ic('warn') : kind === 'ok' ? ic('checkCircle') : ''}<span class="msg">${esc(msg)}</span>${action ? `<button class="toast-act">${esc(action.label)}</button>` : ''}<button class="toast-x" aria-label="閉じる">${ic('x')}</button>`;
  host.appendChild(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 180); };
  if (action) $('.toast-act', t).onclick = () => { close(); action.run(); };
  $('.toast-x', t).onclick = close;
  const timer = setTimeout(close, action ? Math.max(ms, 7000) : ms);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  while (host.children.length > 3) host.firstChild.remove();
  return close;
}

// ---- ダイアログ ----------------------------------------------------------------
const stack = [];
export const topLayer = () => stack[stack.length - 1] || null;

export function modal({ title = '', body = '', actions = [], width = 480, onMount = null, dismiss = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const box = document.createElement('div');
    box.className = 'modal-back';
    box.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="width:min(${width}px, calc(100vw - 32px))">
      ${title ? `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-m="__x" aria-label="閉じる">${ic('x')}</button></div>` : ''}
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a) => `<button class="btn ${a.kind || ''}" data-m="${esc(a.value)}">${a.icon ? ic(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    document.body.appendChild(box);
    const layer = { close: (v) => done(v), el: box };
    stack.push(layer);
    function done(v) {
      const i = stack.indexOf(layer); if (i >= 0) stack.splice(i, 1);
      box.classList.add('out');
      setTimeout(() => box.remove(), 150);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    }
    box.addEventListener('mousedown', (ev) => { if (ev.target === box && dismiss) done(null); });
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-m]'); if (!b) return;
      const v = b.dataset.m;
      done(v === '__x' ? null : v);
    });
    const main = $('.modal-foot .btn.primary, .modal-foot .btn.danger', box) || $('.modal-foot .btn:last-child', box);
    if (onMount) onMount($('.modal', box), layer);
    requestAnimationFrame(() => { const f = $('[autofocus]', box) || main; if (f) f.focus(); });
  });
}

export function confirmDialog(message, okLabel = 'OK', { danger = false, title = '', detail = '' } = {}) {
  return modal({
    title, width: 440,
    body: `<p class="confirm-msg">${esc(message)}</p>${detail ? `<p class="muted">${esc(detail)}</p>` : ''}`,
    actions: [{ label: 'やめる', value: 'no' }, { label: okLabel, value: 'yes', kind: danger ? 'danger' : 'primary' }],
  }).then((v) => v === 'yes');
}

// ---- メニュー（ボタンの下に出る） --------------------------------------------------------
export function menu(anchor, items, { align = 'left', width = 0 } = {}) {
  return new Promise((resolve) => {
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map((it, i) => (it.divider ? '<div class="menu-sep"></div>' : it.header ? `<div class="menu-head">${esc(it.header)}</div>`
      : `<button role="menuitem" class="menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'on' : ''}" data-i="${i}">${it.icon ? ic(it.icon) : '<span class="ic"></span>'}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${it.checked ? ic('check', 'tick') : ''}</button>`)).join('');
    document.body.appendChild(el);
    if (width) el.style.minWidth = `${width}px`;
    const mw = el.offsetWidth; const mh = el.offsetHeight;
    let x = align === 'right' ? r.right - mw : r.left; let y = r.bottom + 6;
    if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
    if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    el.style.left = `${Math.max(8, x)}px`; el.style.top = `${y}px`;
    const layer = { close: () => done(null), el };
    stack.push(layer);
    const btns = $$('.menu-item', el);
    let k = Math.max(0, btns.findIndex((b) => b.classList.contains('on')));
    requestAnimationFrame(() => btns[k] && btns[k].focus());
    function done(v) {
      const i = stack.indexOf(layer); if (i >= 0) stack.splice(i, 1);
      el.remove(); document.removeEventListener('mousedown', outside, true);
      anchor.focus && anchor.focus();
      resolve(v);
    }
    function outside(ev) { if (!el.contains(ev.target)) done(null); }
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    el.addEventListener('click', (ev) => { const b = ev.target.closest('[data-i]'); if (b) done(items[+b.dataset.i].value); });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); k = (k + (ev.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length; btns[k].focus(); }
      if (ev.key === 'Tab') { ev.preventDefault(); done(null); }
    });
  });
}

// いちばん上の重なり（メニュー・ダイアログ）を閉じる。閉じたら true
export function closeTop() { const t = topLayer(); if (!t) return false; t.close(null); return true; }

// ---- ツールチップ（グラフ用） -------------------------------------------------------
let tipEl = null;
export function showTip(html, x, y) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
  tipEl.innerHTML = html; tipEl.hidden = false;
  const w = tipEl.offsetWidth; const h = tipEl.offsetHeight;
  let left = x + 14; let top = y - h - 10;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 16;
  tipEl.style.left = `${left}px`; tipEl.style.top = `${top}px`;
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }

// ---- 保存・共有 ---------------------------------------------------------------
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
