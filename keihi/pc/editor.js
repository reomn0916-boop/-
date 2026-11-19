// 経費の詳細（右のパネル・確認画面で使う）と、領収書の画像ビューア
import {
  S, METHODS, cats, byId, validate, commit, computeAmount, findDup, recentSites, isReading,
  removeExpenses, restoreSnapshot, templateFrom, addTemplate, rotateImage, reread, imageRecord, newExpense, todayISO, addDays, num, dec, fillFromOcr, on, historyOf,
} from '../js/store.js';
import { modal } from './ui.js';
import { checkInvoiceNo, guessCategory } from '../js/parse.js';
import { $, $$, esc, ic, yen, kbd, MOD, toast, confirmDialog, mdw } from './ui.js';

export const FIELD_LABEL = { date: '日付', amount: '金額', payee: '支払先', category: '勘定科目', method: '支払方法', invoiceNo: '登録番号', tax10: '10%対象', tax8: '8%対象', memo: '内容', site: '現場', status: '状態', debit: '借方', credit: '貸方', partner: '取引先', gross: '支払金額', wh: '源泉' };

// ---- 画像ビューア（ホイールで拡大・ドラッグで移動・ダブルクリックで全体） ----------------------------
export class Viewer {
  constructor(host, { onRotate = null, onOriginal = null } = {}) {
    this.host = host; this.onRotate = onRotate; this.onOriginal = onOriginal;
    this.s = 1; this.x = 0; this.y = 0; this.w = 0; this.h = 0;
    host.innerHTML = `<div class="vw">
      <div class="vw-stage"><img alt="領収書の画像" draggable="false"><div class="vw-msg"></div></div>
      <div class="vw-tools" role="toolbar" aria-label="画像の表示">
        <button class="icon-btn sm" data-v="out" title="縮小">${ic('zoomOut')}</button>
        <button class="vw-pct" data-v="fit" title="全体を表示（ダブルクリックでも）">100%</button>
        <button class="icon-btn sm" data-v="in" title="拡大（ホイールでも）">${ic('zoomIn')}</button>
        <span class="vw-sep"></span>
        <button class="icon-btn sm" data-v="rot" title="右に回して読み直す">${ic('rotate')}</button>
        <button class="icon-btn sm" data-v="orig" title="元のファイル（PDF）を開く" hidden>${ic('external')}</button>
      </div></div>`;
    this.host = $('.vw', host);
    host = this.host;
    this.stage = $('.vw-stage', host); this.img = $('img', host); this.msg = $('.vw-msg', host);
    this.img.addEventListener('load', () => { this.w = this.img.naturalWidth; this.h = this.img.naturalHeight; this.fit(); this.host.classList.add('ready'); });
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-v]'); if (!b) return;
      const v = b.dataset.v;
      if (v === 'in') this.zoom(1.25); if (v === 'out') this.zoom(0.8); if (v === 'fit') this.fit();
      if (v === 'rot' && this.onRotate) this.onRotate();
      if (v === 'orig' && this.onOriginal) this.onOriginal();
    });
    this.stage.addEventListener('wheel', (ev) => {
      if (!this.w) return;
      ev.preventDefault();
      const r = this.stage.getBoundingClientRect();
      this.zoom(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022)), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    let drag = null;
    this.stage.addEventListener('pointerdown', (ev) => { if (!this.w || ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, ox: this.x, oy: this.y }; this.stage.setPointerCapture(ev.pointerId); this.stage.classList.add('drag'); });
    this.stage.addEventListener('pointermove', (ev) => { if (!drag) return; this.x = drag.ox + ev.clientX - drag.x; this.y = drag.oy + ev.clientY - drag.y; this.apply(); });
    const end = () => { drag = null; this.stage.classList.remove('drag'); };
    this.stage.addEventListener('pointerup', end); this.stage.addEventListener('pointercancel', end);
    this.stage.addEventListener('dblclick', (ev) => { const r = this.stage.getBoundingClientRect(); if (this.s > this.fitScale() * 1.05) this.fit(); else this.zoom(2.2, ev.clientX - r.left, ev.clientY - r.top); });
    this.ro = new ResizeObserver(() => { if (this.w) this.fit(); });
    this.ro.observe(this.stage);
  }
  set(url, { original = false, message = '' } = {}) {
    this.host.classList.toggle('ready', false);
    $('[data-v="orig"]', this.host).hidden = !original;
    this.msg.textContent = message;
    if (url) { this.img.hidden = false; this.img.src = url; } else { this.img.hidden = true; this.img.removeAttribute('src'); this.w = 0; }
  }
  fitScale() { const r = this.stage.getBoundingClientRect(); return Math.min((r.width - 24) / this.w, (r.height - 24) / this.h) || 1; }
  fit() { if (!this.w) return; const r = this.stage.getBoundingClientRect(); this.s = this.fitScale(); this.x = (r.width - this.w * this.s) / 2; this.y = (r.height - this.h * this.s) / 2; this.apply(); }
  zoom(f, cx, cy) {
    if (!this.w) return;
    const r = this.stage.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const s2 = Math.min(8, Math.max(this.fitScale() * 0.5, this.s * f));
    this.x = cx - ((cx - this.x) * s2) / this.s; this.y = cy - ((cy - this.y) * s2) / this.s; this.s = s2;
    this.apply();
  }
  apply() { this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.s})`; $('.vw-pct', this.host).textContent = `${Math.round(this.s * 100)}%`; }
  destroy() { this.ro.disconnect(); }
}

// ---- 経費の詳細 ----------------------------------------------------------------
const KINDS = [['receipt', 'レシート・領収書', 'receipt'], ['transit', '電車・バス', 'train'], ['car', '車（距離）', 'car']];
const METHOD_ICON = { 現金: 'cash', 個人カード: 'card', 電子マネー: 'phone', 会社カード: 'card', 請求書払い: 'doc' };

export class Editor {
  // mode: 'drawer'（右のパネル）| 'review'（確認待ちを順に確認）
  constructor(root, e, { mode = 'drawer', isNew = false, onClose, onSaved, onNav, position = '' } = {}) {
    this.root = root; this.mode = mode; this.isNew = isNew; this.onClose = onClose; this.onSaved = onSaved; this.onNav = onNav; this.position = position;
    this.cur = JSON.parse(JSON.stringify(e)); this.touched = new Set(); this.dirty = false; this.url = '';
    this.mount();
    this.off = [
      on('ocr', (id) => { if (id === this.cur.id) this.renderOcr(); }),
      on('ocr-result', (id, f, engine) => { if (id === this.cur.id) this.sync(fillFromOcr(this.cur, f, engine, this.touched)); }),
      on('image', (imgId) => { if (imgId === this.cur.imageId) this.loadImage(); }),
    ];
  }

  get id() { return this.cur.id; }

  mount() {
    const c = this.cur;
    this.root.innerHTML = `
      <div class="ed ${c.imageId ? 'has-img' : 'no-img'} mode-${this.mode}">
        <header class="ed-head">
          <div class="ed-title"><b>${this.isNew ? '経費を追加' : c.status === 'draft' ? '確認して確定' : '経費の詳細'}</b><span class="ed-pos">${esc(this.position)}</span></div>
          <div class="ed-headacts">
            ${this.onNav ? `<button class="icon-btn" data-a="prev" title="前へ（Alt+↑）">${ic('chevU')}</button><button class="icon-btn" data-a="next" title="次へ（Alt+↓）">${ic('chevD')}</button>` : ''}
            <button class="icon-btn" data-a="close" title="閉じる（Esc）">${ic('x')}</button>
          </div>
        </header>
        <div class="ed-main">
          ${c.imageId ? '<div class="ed-img"></div>' : ''}
          <div class="ed-form" tabindex="-1"></div>
        </div>
        <footer class="ed-foot">
          <div class="l">
            <button class="btn ghost sm" data-a="template" title="毎回同じ経費をワンクリックで入れられるようにする">${ic('star')}よく使うに登録</button>
            ${this.isNew ? '' : `<button class="btn ghost sm" data-a="copy">${ic('copy')}複製</button>`}
            ${this.isNew ? '' : `<button class="btn ghost sm danger" data-a="delete">${ic('trash')}削除</button>`}
          </div>
          <div class="r">
            ${this.mode === 'review'
              ? `<button class="btn" data-a="skip" title="あとで確認する">あとで</button><button class="btn primary" data-a="save" data-next="1">${ic('check')}確定して次へ ${kbd(MOD, 'Enter')}</button>`
              : `<button class="btn" data-a="close">キャンセル</button><button class="btn primary" data-a="save">${ic('check')}${c.status === 'draft' ? '確定して保存' : '保存'} ${kbd(MOD, 'Enter')}</button>`}
          </div>
        </footer>
      </div>`;
    this.form = $('.ed-form', this.root);
    if (c.imageId) {
      this.viewer = new Viewer($('.ed-img', this.root), {
        onRotate: () => { rotateImage(c.id, 90); toast('右に回しました。読み直しています'); },
        onOriginal: () => this.openOriginal(),
      });
      this.loadImage();
    }
    this.root.onclick = (ev) => this.click(ev);
    this.root.oninput = (ev) => { if (ev.target.dataset.f) this.input(ev.target); };
    this.root.onchange = (ev) => { if (ev.target.dataset.f) this.change(ev.target); };
    this.root.onkeydown = (ev) => this.key(ev);
    this.render();
  }

  async loadImage() {
    const rec = await imageRecord(this.cur.imageId);
    if (!rec || !this.viewer) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(rec.blob);
    this.orig = rec.orig || null; this.origName = rec.origName || '';
    this.viewer.set(this.url, { original: !!rec.orig });
  }

  openOriginal() {
    if (!this.orig) return;
    const u = URL.createObjectURL(this.orig);
    window.open(u, '_blank');
    setTimeout(() => URL.revokeObjectURL(u), 120000);
  }

  focusFirst() {
    const c = this.cur;
    const k = c.kind === 'receipt' ? (c.amount ? 'payee' : 'amount') : c.kind === 'transit' ? 'route.from' : 'route.from';
    const el = $(`[data-f="${k}"]`, this.form) || $('input', this.form);
    if (el) { el.focus(); if (el.select) el.select(); }
  }

  render() {
    const c = this.cur;
    const sure = (c.ocr && c.ocr.sure) || {};
    const fromOcr = (c.ocr && c.ocr.filled) || [];
    const chk = (k) => (fromOcr.includes(k) && !this.touched.has(k) && sure[k] === false ? ' check' : '');
    const amt = computeAmount(c);
    const dup = findDup({ ...c, amount: amt });
    const showPeople = c.category === '会議費' || c.category === '接待交際費';
    const perHead = c.people && amt ? Math.round(amt / c.people) : null;
    const inv = (c.invoiceNo || '').replace(/^T/, '');
    const invOk = c.invoiceNo ? checkInvoiceNo(c.invoiceNo) : null;
    const route = c.route || { from: '', to: '', round: false };
    const sites = recentSites().slice(0, 5);
    const rate = c.rate != null ? c.rate : S.settings.carRate;
    const scroll = this.form.scrollTop;
    this.form.innerHTML = `
      <div class="ocr-line" data-ocr></div>
      ${c.ocr && c.ocr.notReceipt ? `<div class="note warn">${ic('warn')}レシート・領収書ではないかもしれません</div>` : ''}
      ${c.reviewComment ? `<div class="note warn">${ic('warn')}<span><b>承認者からのコメント</b>${esc(c.reviewComment)}</span></div>` : ''}
      ${c.status === 'done' ? `<div class="note">${ic('checkCircle')}精算済みです。直すと提出した精算書と合わなくなります</div>` : ''}
      <div class="seg kinds" role="radiogroup" aria-label="種類">
        ${KINDS.map(([k, l, icn]) => `<button role="radio" aria-checked="${c.kind === k}" class="${c.kind === k ? 'on' : ''}" data-kind="${k}">${ic(icn)}${l}</button>`).join('')}
      </div>
      ${c.kind === 'receipt' ? `
        <label class="fld amt${chk('amount')}"><span class="lb">金額（税込）</span>
          <span class="amt-in"><em>¥</em><input data-f="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${c.amount != null ? c.amount.toLocaleString('ja-JP') : ''}"></span></label>` : `
        <div class="fld"><span class="lb">区間</span>
          <div class="route"><input data-f="route.from" list="dlPlace" placeholder="出発（例: 本社）" value="${esc(route.from)}"><span>→</span><input data-f="route.to" list="dlPlace" placeholder="到着（例: A現場）" value="${esc(route.to)}">
          <label class="check-pill"><input type="checkbox" data-f="route.round" ${route.round ? 'checked' : ''}><span>往復</span></label></div></div>
        ${c.kind === 'transit' ? `
          <label class="fld"><span class="lb">片道の運賃</span><span class="amt-in sm"><em>¥</em><input data-f="fare" inputmode="numeric" placeholder="0" value="${c.fare ?? ''}"></span></label>` : `
          <div class="row2">
            <label class="fld"><span class="lb">片道の距離</span><span class="amt-in sm"><input data-f="km" inputmode="decimal" placeholder="0" value="${c.km ?? ''}"><em>km</em></span></label>
            <label class="fld"><span class="lb">1km あたり</span><span class="amt-in sm"><input data-f="rate" inputmode="decimal" value="${rate}"><em>円</em></span></label>
          </div>`}
        <div class="calc"><span>金額</span><b data-calc>${amt != null ? yen(amt) : '—'}</b></div>`}
      <div class="row2 date-row">
        <div class="fld${chk('date')}"><span class="lb">日付<span class="lb-acts"><button class="link sm" data-a="date" data-d="0" tabindex="-1">今日</button><button class="link sm" data-a="date" data-d="-1" tabindex="-1">昨日</button></span></span>
          <input type="date" data-f="date" value="${esc(c.date || '')}" max="${addDays(todayISO(), 2)}">
        </div>
        <label class="fld${chk('method')}"><span class="lb">支払方法</span>
          <span class="select">${ic(METHOD_ICON[c.method] || 'cash')}<select data-f="method">${METHODS.map((m) => `<option ${c.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
      </div>
      <div data-dup>${dup ? this.dupHTML(dup) : ''}</div>
      <label class="fld${chk('payee')}"><span class="lb">支払先</span><input data-f="payee" list="dlPayee" autocomplete="off" placeholder="${c.kind === 'car' ? '自家用車' : c.kind === 'transit' ? '例: JR東日本' : '店名・会社名'}" value="${esc(c.payee)}"></label>
      <div class="fld${chk('category')}"><span class="lb">勘定科目</span>
        <div class="chips" role="radiogroup" aria-label="勘定科目">${cats().map((k) => `<button role="radio" aria-checked="${c.category === k}" class="chip ${c.category === k ? 'on' : ''}" data-cat="${esc(k)}">${esc(k)}</button>`).join('')}</div></div>
      <div class="fld"><span class="lb">現場・案件</span>
        <input data-f="site" list="dlSite" autocomplete="off" placeholder="例: ○○邸新築工事（なしでも可）" value="${esc(c.site)}">
        ${sites.length ? `<div class="chips sm">${sites.map((s) => `<button class="chip sm ${c.site === s ? 'on' : ''}" data-site="${esc(s)}" tabindex="-1">${esc(s)}</button>`).join('')}</div>` : ''}</div>
      <label class="fld"><span class="lb">内容・目的</span><input data-f="memo" autocomplete="off" placeholder="例: 養生テープ・軍手 / ○○様と打合せ" value="${esc(c.memo)}"></label>
      ${showPeople ? `
        <div class="row2">
          <label class="fld"><span class="lb">人数（自分を含む）</span><input data-f="people" inputmode="numeric" value="${c.people ?? ''}" placeholder="例: 3"></label>
          <label class="fld"><span class="lb">相手先</span><input data-f="guests" value="${esc(c.guests)}" placeholder="例: ○○工務店 山田様"></label>
        </div>
        ${perHead ? `<p class="hint">1人あたり ${yen(perHead)}${c.category === '接待交際費' && perHead <= 10000 ? '　— 1人 1万円以下の飲食は、相手先・人数を書けば交際費から外せます' : ''}</p>` : ''}` : ''}
      ${(S.settings.vehicles || []).length && (c.kind === 'car' || c.vehicle || ['車両費', '旅費交通費', '修繕費', '保険料', '租税公課'].includes(c.category)) ? `
      <fieldset class="group">
        <legend>車両</legend>
        <div class="row3">
          <label class="fld"><span class="lb">車</span><span class="select">${ic('car')}<select data-f="vehicle"><option value="">（なし）</option>${S.settings.vehicles.map((v) => `<option value="${esc(v.id)}" ${c.vehicle === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>${ic('chevD', 'caret')}</span></label>
          <label class="fld"><span class="lb">走行メーター</span><span class="amt-in sm"><input data-f="odometer" inputmode="numeric" placeholder="例: 52310" value="${c.odometer ?? ''}"><em>km</em></span></label>
          <label class="fld"><span class="lb">給油量</span><span class="amt-in sm"><input data-f="liters" inputmode="decimal" placeholder="0" value="${c.liters ?? ''}"><em>L</em></span></label>
        </div>
      </fieldset>` : ''}
      <fieldset class="group">
        <legend>インボイス</legend>
        <div class="row3">
          <label class="fld${chk('invoiceNo')}"><span class="lb">登録番号</span>
            <span class="amt-in sm inv ${invOk === false ? 'bad' : invOk ? 'good' : ''}"><em>T</em><input data-f="invoiceNo" inputmode="numeric" maxlength="16" placeholder="13桁" value="${esc(inv)}">${invOk === true ? ic('checkCircle', 'ok') : invOk === false ? ic('warn', 'ng') : ''}</span></label>
          <label class="fld"><span class="lb">10%対象</span><span class="amt-in sm"><em>¥</em><input data-f="tax10" inputmode="numeric" value="${c.tax10 ?? ''}"></span></label>
          <label class="fld"><span class="lb">8%対象</span><span class="amt-in sm"><em>¥</em><input data-f="tax8" inputmode="numeric" value="${c.tax8 ?? ''}"></span></label>
        </div>
        ${invOk === false ? '<p class="hint warn">番号の読みまちがいがないか確認してください（検査用数字が合いません）</p>' : ''}
        ${c.invoiceNo && /^T\d{13}$/.test(c.invoiceNo) ? `<a class="hint link" href="https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=${c.invoiceNo.slice(1)}" target="_blank" rel="noopener">${ic('external')}国税庁の公表サイトで確認</a>` : ''}
      </fieldset>
      ${c.created ? `<p class="meta">登録 ${new Date(c.created).toLocaleString('ja-JP')}${c.fileName ? ` ・ ${esc(c.fileName)}` : ''}${c.updated && c.updated - c.created > 60000 ? ` ・ 更新 ${new Date(c.updated).toLocaleString('ja-JP')}` : ''} <button class="link sm" data-a="history" tabindex="-1">${ic('clock')}変更の履歴</button></p>` : ''}`;
    this.form.scrollTop = scroll;
    this.renderOcr();
  }

  async showHistory() {
    const list = await historyOf(this.cur.id);
    const LABEL = { create: '登録', update: '変更', delete: '削除' };
    const v = (x) => (x == null || x === '' ? '（なし）' : typeof x === 'object' ? JSON.stringify(x) : String(x));
    modal({ title: '変更の履歴（電子帳簿保存法）', width: 620,
      body: list.length ? `<ol class="hist-list">${list.map((h) => `<li><span class="hl-when">${new Date(h.at).toLocaleString('ja-JP')}</span><b>${LABEL[h.action] || esc(h.action)}</b>${h.action === 'update' ? `<ul>${Object.entries(h.ch || {}).map(([f, [a, b]]) => `<li><span>${esc(FIELD_LABEL[f] || f)}</span><s>${esc(v(a))}</s>${ic('arrowR')}<em>${esc(v(b))}</em></li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>`
        : '<p class="muted">まだ履歴はありません（確定したあとの変更・削除を記録します）。</p>',
      actions: [{ label: '閉じる', value: 'ok', kind: 'primary' }] });
  }

  dupHTML(dup) {
    return `<div class="note warn">${ic('warn')}<span>同じ日・同じ金額の経費があります: <b>${esc(dup.payee || '（支払先なし）')}</b> ${yen(dup.amount)}（${mdw(dup.date)}）</span></div>`;
  }

  renderOcr() {
    const el = $('[data-ocr]', this.form); if (!el) return;
    const o = S.ocr.get(this.cur.id);
    const c = this.cur;
    if (o && (o.state === 'run' || o.state === 'wait')) {
      el.className = 'ocr-line run';
      el.innerHTML = `<span class="spin"></span><span>${esc(o.msg || '読み取り中')}</span><span class="bar"><i style="width:${Math.round((o.p || 0) * 100)}%"></i></span>`;
    } else if (o && o.state === 'error') {
      el.className = 'ocr-line err'; el.innerHTML = `${ic('warn')}<span>${esc(o.msg)}</span>`;
    } else if (c.ocr) {
      const eng = { ai: 'AI（Claude）', device: '端末内の文字認識', pdf: 'PDF の文字' }[c.ocr.engine] || '自動';
      const unsure = ['amount', 'date', 'payee'].filter((k) => (c.ocr.filled || []).includes(k) && c.ocr.sure && c.ocr.sure[k] === false && !this.touched.has(k));
      el.className = `ocr-line ${unsure.length ? 'warn' : 'ok'}`;
      el.innerHTML = `${ic(unsure.length ? 'warn' : 'spark')}<span>${eng}で読み取りました${unsure.length ? '。黄色の欄を確かめてください' : ''}${o && o.msg ? `（${esc(o.msg)}）` : ''}</span>${c.imageId ? `<button class="link sm" data-a="reread">${ic('redo')}読み直す</button>` : ''}`;
    } else { el.className = 'ocr-line'; el.innerHTML = ''; }
  }

  sync(filled) {
    if (!filled.length) return;
    const f = document.activeElement;
    const typing = f && this.form.contains(f) && /INPUT|SELECT|TEXTAREA/.test(f.tagName);
    if (!typing) this.render();
    else {
      for (const k of filled) {
        const el = $(`[data-f="${k}"]`, this.form); if (!el) continue;
        const v = this.cur[k];
        el.value = v == null ? '' : k === 'amount' ? v.toLocaleString('ja-JP') : k === 'invoiceNo' ? String(v).replace(/^T/, '') : String(v);
      }
      $$('[data-cat]', this.form).forEach((b) => { const on = b.dataset.cat === this.cur.category; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
      this.renderOcr();
    }
    filled.forEach((k) => { const el = $(`[data-f="${k}"]`, this.form); if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } });
  }

  input(el) {
    const k = el.dataset.f; const c = this.cur;
    this.dirty = true;
    this.touched.add(k.startsWith('route') ? 'route' : k);
    c.auto = (c.auto || []).filter((x) => x !== k);
    if (k.startsWith('route.')) { c.route = c.route || { from: '', to: '', round: false }; c.route[k.slice(6)] = el.type === 'checkbox' ? el.checked : el.value.trim(); } else if (['amount', 'fare', 'tax10', 'tax8', 'people', 'odometer'].includes(k)) c[k] = num(el.value);
    else if (['km', 'rate', 'liters'].includes(k)) c[k] = dec(el.value);
    else if (k === 'invoiceNo') { const d = el.value.normalize('NFKC').replace(/\D/g, ''); c.invoiceNo = d ? `T${d}` : ''; } else c[k] = el.value;
    if (k === 'payee' && !this.touched.has('category')) {
      const g = guessCategory(c.payee, c.memo, S.learned, cats());
      if (g && g !== c.category) { c.category = g; $$('[data-cat]', this.form).forEach((b) => b.classList.toggle('on', b.dataset.cat === g)); }
    }
    const calc = $('[data-calc]', this.form); if (calc) { const a = computeAmount(c); calc.textContent = a != null ? yen(a) : '—'; }
    if (['amount', 'date', 'fare', 'km', 'route.round', 'payee'].includes(k)) {
      const dup = findDup({ ...c, amount: computeAmount(c) });
      $('[data-dup]', this.form).innerHTML = dup ? this.dupHTML(dup) : '';
    }
  }

  change(el) {
    const k = el.dataset.f;
    this.input(el);
    if (k === 'amount' && el.value) { const n = num(el.value); el.value = n != null ? n.toLocaleString('ja-JP') : ''; }
    if (['route.round', 'people', 'invoiceNo', 'method'].includes(k)) this.render();
  }

  click(ev) {
    const t = ev.target;
    const a = t.closest('[data-a]');
    if (a) {
      ev.preventDefault();
      const act = a.dataset.a;
      if (act === 'close') this.requestClose();
      else if (act === 'save') this.save({ next: !!a.dataset.next });
      else if (act === 'skip') this.onNav && this.onNav(1, { skip: true });
      else if (act === 'prev') this.onNav && this.onNav(-1);
      else if (act === 'next') this.onNav && this.onNav(1);
      else if (act === 'date') { const el = $('[data-f="date"]', this.form); el.value = addDays(todayISO(), +a.dataset.d); this.input(el); this.render(); }
      else if (act === 'reread') { this.touched.clear(); this.cur.auto = ['date', 'method', 'amount', 'payee', 'category', 'memo', 'invoiceNo', 'tax10', 'tax8']; reread(this.cur.id); this.renderOcr(); }
      else if (act === 'template') this.addTemplate();
      else if (act === 'copy') this.copy();
      else if (act === 'delete') this.remove();
      else if (act === 'history') this.showHistory();
      return;
    }
    const kind = t.closest('[data-kind]');
    if (kind) {
      const c = this.cur; c.kind = kind.dataset.kind; this.dirty = true;
      if (c.kind !== 'receipt' && !c.route) c.route = { from: '', to: '', round: true };
      if (c.kind === 'car') { if (!c.payee) c.payee = '自家用車'; if (!this.touched.has('category')) c.category = S.settings.carCategory; }
      if (c.kind === 'transit' && !this.touched.has('category')) c.category = '旅費交通費';
      this.render(); return;
    }
    const cat = t.closest('[data-cat]');
    if (cat) { this.cur.category = cat.dataset.cat; this.touched.add('category'); this.dirty = true; this.render(); return; }
    const site = t.closest('[data-site]');
    if (site) { this.cur.site = site.dataset.site; this.dirty = true; this.render(); }
  }

  key(ev) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); this.save({ next: this.mode === 'review' }); return; }
    if (ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && this.onNav) { ev.preventDefault(); ev.stopPropagation(); this.onNav(ev.key === 'ArrowDown' ? 1 : -1); return; }
    if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.f && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
      ev.preventDefault();
      ev.target.dispatchEvent(new Event('change', { bubbles: true }));
      const inputs = $$('input:not([type=checkbox]):not([tabindex="-1"]), select', this.form);
      const i = inputs.indexOf(ev.target);
      if (i >= 0 && inputs[i + 1]) inputs[i + 1].focus();
    }
  }

  async requestClose() {
    if (this.dirty && this.cur.status !== 'draft') {
      const save = await confirmDialog('変更が保存されていません。保存しますか？', '保存する', { detail: '「やめる」を押すと変更を捨てて閉じます。' });
      if (save) { await this.save(); return; }
    }
    this.onClose && this.onClose();
  }

  async save({ next = false } = {}) {
    const c = this.cur;
    const bad = validate(c);
    if (bad) {
      toast(bad.msg, { kind: 'error' });
      const el = $(`[data-f="${bad.field}"]`, this.form) || $('.chips', this.form); if (el && el.focus) el.focus();
      return false;
    }
    const wasNew = this.isNew;
    await commit(c);
    this.dirty = false;
    this.onSaved && this.onSaved(c, { next, wasNew });
    return true;
  }

  addTemplate() {
    const t = templateFrom(this.cur);
    if (!t.amount) { toast('金額を入れてから登録してください', { kind: 'error' }); return; }
    addTemplate(t);
    toast(`「${t.label}」をよく使うに登録しました`, { kind: 'ok' });
  }

  copy() {
    const { id, ...rest } = JSON.parse(JSON.stringify(this.cur)); void id;
    const e = newExpense({ ...rest, status: 'ok', date: todayISO(), imageId: null, ocr: null, reportId: null, auto: [], created: Date.now() });
    this.onClose && this.onClose({ open: e });
    toast('今日の日付で複製しました（画像は付きません）');
  }

  async remove() {
    const stored = byId(this.cur.id); if (!stored) { this.onClose && this.onClose(); return; }
    if (stored.status === 'done' && !(await confirmDialog('精算済みの経費です。削除しますか？', '削除', { danger: true }))) return;
    this.onClose && this.onClose({ deleted: true });
    const snap = await removeExpenses([stored.id]);
    toast('削除しました', { action: { label: '元に戻す', run: () => restoreSnapshot(snap) } });
  }

  destroy() {
    this.off.forEach((f) => f());
    if (this.viewer) this.viewer.destroy();
    if (this.url) URL.revokeObjectURL(this.url);
    this.root.onclick = this.root.oninput = this.root.onchange = this.root.onkeydown = null;
  }
}

export const isBusy = (id) => isReading(id);
