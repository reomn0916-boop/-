// 買った・売った の記入画面（下から出る入力画面）。app.js の S や関数を使う
'use strict';

const E = { open: false };  // 入力中の内容

// 値段を動かす幅（＋−ボタン）
function tickOf(p) {
  if (!(p > 0)) return 1;
  if (p < 1000) return 1;
  if (p < 5000) return 5;
  if (p < 10000) return 10;
  if (p < 50000) return 50;
  return 100;
}
const dayStr = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 最近見た銘柄（銘柄の画面を開いたときに覚える）
function noteRecent(code) {
  const r = store.get('recent', []).filter((c) => c !== code);
  r.unshift(code);
  store.set('recent', r.slice(0, 8));
}

function openEntry(kind, opt = {}) {
  Object.keys(E).forEach((k) => delete E[k]);
  Object.assign(E, { open: true, kind, q: '' });
  if (kind === 'buy') {
    E.date = dayStr(0);
    if (opt.code) pickStock(opt.code, false);
  } else {
    const p = S.positions.find((x) => x.id === opt.id);
    if (!p) return;
    E.pid = p.id;
    E.code = p.code;
    if (kind === 'edit') Object.assign(E, { price: p.price, shares: p.shares, stop: p.stop, target: p.target, date: p.date, minStop: p.stop });
    if (kind === 'sell') {
      const s = S.byCode[p.code];
      Object.assign(E, { price: s ? s.close : p.price, date: dayStr(0), kept: null, memo: '' });
    }
  }
  $('#entry').hidden = false;
  document.body.classList.add('entry-open');
  renderEntry();
}

function closeEntry() {
  E.open = false;
  $('#entry').hidden = true;
  document.body.classList.remove('entry-open');
}

function pickStock(code, rerender = true) {
  const s = S.byCode[code];
  if (!s) return;
  E.code = code;
  E.price = s.limit && s.limit < s.close ? s.close : s.entry;
  E.stop = s.stop;
  E.target = s.target;
  const r = sharesFor(s);
  E.shares = r && r.n ? r.n : 100;
  if (rerender) renderEntry();
}

// ---- 入力欄の部品 ----
function stepper(key, label, chips = [], step) {
  const st = step || tickOf(E[key]);
  return `<div class="ent-f">
    <div class="ent-l">${label}</div>
    <div class="ent-step">
      <button data-e-step="${key}" data-d="-${st}" aria-label="${label}を下げる">−${key === 'shares' ? st : ''}</button>
      <input data-e="${key}" type="number" inputmode="${key === 'shares' ? 'numeric' : 'decimal'}" value="${E[key] ?? ''}">
      <button data-e-step="${key}" data-d="${st}" aria-label="${label}を上げる">＋${key === 'shares' ? st : ''}</button>
    </div>
    ${chips.length ? `<div class="ent-chips">${chips.map(([lb, v]) => `<button data-e-set="${key}" data-v="${v}" class="${+E[key] === +v ? 'on' : ''}">${lb}</button>`).join('')}</div>` : ''}
  </div>`;
}

function dateField(key = 'date', label = '日付') {
  const opts = [['今日', dayStr(0)], ['昨日', dayStr(1)], ['おととい', dayStr(2)]];
  return `<div class="ent-f">
    <div class="ent-l">${label}</div>
    <div class="ent-chips">${opts.map(([lb, v]) => `<button data-e-set="${key}" data-v="${v}" class="${E[key] === v ? 'on' : ''}">${lb}</button>`).join('')}
      <input data-e="${key}" type="date" value="${E[key] || ''}" class="ent-date"></div>
  </div>`;
}

// ---- 入力中の計算とルールの確認 ----
function buyCalc() {
  const s = S.byCode[E.code];
  const price = +E.price, shares = +E.shares, stop = +E.stop, target = +E.target;
  const warns = [];
  if (!(price > 0 && shares > 0)) return { warns: ['買値と株数を入れてください'], block: true };
  if (!(stop > 0) || stop >= price) return { warns: ['損切りは買値より下に（ルール：買う前に損切りを決める）'], block: true };
  if (!(target > 0) || target <= price) return { warns: ['利確は買値より上に（ルール：買う前に利確を決める）'], block: true };
  const rr = (target - price) / (price - stop);
  const loss = (price - stop) * shares, gain = (target - price) * shares;
  const lossPct = loss / (S.capital || 1) * 100;
  if (E.kind === 'buy') {
    const rest = restUntil();
    if (rest) warns.push(`3連敗中で ${fmtDate(rest)} まで休む期間です`);
    if (s && !s.rule_ok) warns.push(`${MODE_LABEL[curMode()]}のルールに合っていない銘柄です（${s.checks.filter((c) => c.ok === false && c.req !== false).map((c) => c.label).join('・')}）`);
    const r = s && sharesFor(s);
    if (r && shares > r.n) warns.push(r.n ? `株数が計算（${r.n}株）より多い（ルール：株数を増やさない）` : '資金と許せる損失の割合では、100株でも損が大きすぎます（ルール：1回の損は資金の1〜2%まで）');
  }
  if (E.kind === 'edit' && stop < E.minStop) warns.push(`損切りは ${yen(E.minStop)} 円より下げられません（ルール：損切りラインは絶対に下げない）`);
  const minRr = MIN_RR[curMode()];
  if (rr < minRr - 1e-9) warns.push(`利確幅が損切り幅の ${rr.toFixed(1)} 倍（ルールは ${minRr} 倍以上）`);
  const maxLoss = isBear() ? S.riskPct / 2 : 2;
  if (lossPct > maxLoss + 1e-9) warns.push(`損切りになると資金の ${lossPct.toFixed(1)}% の損（ルールは ${maxLoss}% まで）`);
  return { price, shares, stop, target, rr, loss, gain, lossPct, cost: price * shares, warns,
    block: E.kind === 'edit' && stop < E.minStop };
}

function summaryHtml() {
  if (E.kind === 'sell') {
    const p = S.positions.find((x) => x.id === E.pid);
    const sp = +E.price;
    if (!p || !(sp > 0)) return '<div class="ent-sum">売値を入れてください</div>';
    const pl = (sp - p.price) * p.shares, ret = (sp / p.price - 1) * 100;
    return `<div class="ent-sum num"><div>損益<b class="${cls(pl)}">${pl >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(pl)))}円</b></div>
      <div>率<b class="${cls(ret)}">${sgn(ret, 1)}</b></div><div>保有<b>${Math.max(0, Math.round((new Date(E.date) - new Date(p.date)) / 864e5))}日</b></div></div>`;
  }
  const c = buyCalc();
  if (c.price === undefined) return `<div class="ent-sum"><span class="why bad">${esc(c.warns[0])}</span></div>`;
  return `<div class="ent-sum num">
      <div>投資額<b>${yen(Math.round(c.cost))}円</b></div>
      <div>損切りで<b class="down">−${yen(Math.round(c.loss))}円</b><small>資金の ${c.lossPct.toFixed(1)}%</small></div>
      <div>利確で<b class="up">+${yen(Math.round(c.gain))}円</b><small>1 : ${c.rr.toFixed(1)}</small></div>
    </div>
    ${c.warns.length ? `<ul class="ent-warn">${c.warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<div class="ent-ok">✓ ルールどおりです</div>'}`;
}

function saveLabel() {
  if (E.kind === 'sell') return '記録して保有から外す';
  const c = buyCalc();
  if (c.block) return E.kind === 'edit' ? '直す' : '保存';
  if (E.kind === 'edit') return '直す';
  return c.warns.length ? 'ルールを破って記録する' : '保有に追加';
}

function updateSummary() {
  const el = $('#entSum');
  if (el) el.innerHTML = summaryHtml();
  const b = $('#entSave');
  if (b) {
    const c = E.kind === 'sell' ? { warns: [] } : buyCalc();
    b.textContent = saveLabel();
    b.classList.toggle('warn', E.kind === 'buy' && c.warns.length > 0 && !c.block);
  }
  document.querySelectorAll('#entry [data-e-set]').forEach((x) => {
    const k = x.dataset.eSet;
    x.classList.toggle('on', String(E[k]) === x.dataset.v || (+E[k] === +x.dataset.v && x.dataset.v !== ''));
  });
}

// ---- 画面 ----
function stockPicker() {
  const q = E.q.trim().toLowerCase();
  const chip = (c) => { const s = S.byCode[c]; return s ? `<button data-e-pick="${c}">${esc(s.name)}<small>${c}</small></button>` : ''; };
  let body;
  if (q) {
    const hits = S.list.filter((s) => s.name.toLowerCase().includes(q) || s.code.includes(q) || (s.aliases || []).some((a) => a.toLowerCase().includes(q))).slice(0, 10);
    body = hits.length ? `<div class="list">${hits.map((s) => `<button class="row" data-e-pick="${s.code}"><div class="main"><b>${esc(s.name)}</b><small>${s.code}・${esc(s.sector)}</small></div><div class="rt num"><b>${yen(s.close)}</b></div></button>`).join('')}</div>`
      : '<div class="empty">見つかりません。対象の銘柄は scripts/universe.json で増やせます</div>';
  } else {
    const groups = [['今日の注目銘柄', modePicks()], ['ウォッチ', [...S.watch]], ['最近見た銘柄', store.get('recent', [])]]
      .map(([t, cs]) => [t, cs.filter((c) => S.byCode[c]).slice(0, 8)]).filter(([, cs]) => cs.length);
    body = groups.map(([t, cs]) => `<div class="ent-l">${t}</div><div class="ent-chips big">${cs.map(chip).join('')}</div>`).join('')
      || '<div class="empty">銘柄名かコードを入れてください</div>';
  }
  return `<input id="entQ" type="search" placeholder="銘柄名・コードで探す（例：トヨタ、7203）" value="${esc(E.q)}" autocomplete="off">${body}`;
}

function renderEntry() {
  const el = $('#entryBody');
  const title = { buy: '買った銘柄を記入', edit: '保有銘柄を直す', sell: '売った' }[E.kind];
  let html = '';
  if (E.kind === 'buy' && !E.code) {
    html = stockPicker();
  } else if (E.kind === 'sell') {
    const p = S.positions.find((x) => x.id === E.pid);
    const s = S.byCode[p.code];
    html = `<div class="ent-stock"><b>${esc(p.name)}</b><small>${p.date} に ${yen(p.price)}円 × ${p.shares.toLocaleString()}株</small></div>
      ${stepper('price', '売値（円）', [['今の終値', s ? s.close : p.price], ['損切りライン', p.stop], ['利確ライン', p.target]])}
      ${dateField('date', '売った日')}
      <div class="ent-f"><div class="ent-l">ルールを守れた？（必ず書く）</div>
        <div class="seg"><button data-e-set="kept" data-v="1" class="${E.kept === '1' ? 'on' : ''}">守れた</button><button data-e-set="kept" data-v="0" class="${E.kept === '0' ? 'on' : ''}">破った</button></div></div>
      <div class="ent-f"><div class="ent-l">メモ</div>
        <div class="ent-chips">${['損切りラインで売り', '利確ラインで売り', '売りのサインで売り', '決算の前に売り', '期限（3週間）で売り'].map((m) => `<button data-e-memo="${m}">${m}</button>`).join('')}</div>
        <input data-e="memo" type="text" value="${esc(E.memo || '')}" placeholder="なぜ買った・なぜ売った"></div>`;
  } else {
    const s = S.byCode[E.code];
    const p = E.kind === 'edit' ? S.positions.find((x) => x.id === E.pid) : null;
    const name = s ? s.name : p.name;
    const r = s && sharesFor(s);
    html = `<div class="ent-stock"><b>${esc(name)}</b><small>${E.code}${s ? `・終値 ${yen(s.close)}円・${MODE_LABEL[curMode()]}のルール${s.rule_ok ? ' ✓' : ' ✗'}` : ''}</small>
        ${E.kind === 'buy' ? '<button class="linkbtn" id="entChange">銘柄を変える</button>' : ''}</div>
      ${stepper('price', '買値（円）', s ? [['終値', s.close], ['買い目安', s.entry], ...(s.limit ? [['指値', s.limit]] : [])].filter((x, i, a) => a.findIndex((y) => y[1] === x[1]) === i) : [])}
      ${stepper('shares', '株数', [...(r && r.n ? [[`計算どおり ${r.n}株`, r.n]] : []), ['100', 100], ['200', 200], ['300', 300], ['500', 500]], 100)}
      ${stepper('stop', E.kind === 'edit' ? '損切り（円・上げるだけ）' : '損切り（円）', s ? [['目安', s.stop], ...(E.kind === 'edit' && s.trail_stop && s.trail_stop > E.minStop ? [['直近安値の下', s.trail_stop]] : []), ...(E.kind === 'edit' ? [['買値（建値）', p.price]] : [])] : [])}
      ${stepper('target', '利確（円）', s ? [['目安', s.target]] : [])}
      ${dateField('date', '買った日')}
      ${E.kind === 'edit' ? `<button class="linkbtn" data-pos-del="${E.pid}">間違えて登録したので消す</button>` : ''}`;
  }
  el.innerHTML = `<div class="ent-head"><b>${title}</b><button class="icon" id="entClose" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="ent-scroll">${html}</div>
    ${E.code || E.kind !== 'buy' ? `<div class="ent-foot"><div id="entSum">${summaryHtml()}</div><button class="btn-main" id="entSave">${saveLabel()}</button></div>` : ''}`;
  updateSummary();
  if (E.kind === 'buy' && !E.code) { const q = $('#entQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function saveEntry() {
  if (E.kind === 'sell') {
    const p = S.positions.find((x) => x.id === E.pid);
    const sp = +E.price;
    if (!(sp > 0)) return toast('売値を入れてください');
    if (E.kept == null) return toast('ルールを守れたかを選んでください（ルール：必ず書く）');
    const t = { id: p.id, code: p.code, name: p.name, buyDate: p.date, sellDate: E.date || dayStr(0), price: p.price, sellPrice: sp,
      shares: p.shares, stop: p.initStop || p.stop, target: p.target, pl: (sp - p.price) * p.shares, ret: (sp / p.price - 1) * 100,
      kept: E.kept === '1', mode: p.mode || 'strict', memo: (E.memo || '').trim() };
    S.journal.push(t); saveJournal();
    S.positions = S.positions.filter((x) => x !== p); savePositions();
    closeEntry(); renderWatch(); renderHome();
    toast(t.pl >= 0 ? '記録しました' : (t.kept ? '記録しました。ルールどおりの損切りは経費です' : '記録しました'));
    return;
  }
  const c = buyCalc();
  if (c.price === undefined || c.block) return toast(c.warns[0]);
  if (E.kind === 'edit') {
    const p = S.positions.find((x) => x.id === E.pid);
    Object.assign(p, { price: c.price, shares: c.shares, stop: c.stop, target: c.target, date: E.date || p.date });
    savePositions(); closeEntry(); renderWatch(); renderHome();
    toast('直しました');
    return;
  }
  const s = S.byCode[E.code];
  S.positions.push({ id: Date.now().toString(36), code: s.code, name: s.name, price: c.price, shares: c.shares, stop: c.stop,
    target: c.target, date: E.date || dayStr(0), mode: curMode(), ruleOkAtBuy: !c.warns.length, initStop: c.stop });
  savePositions(); closeEntry(); renderWatch(); renderHome();
  toast(c.warns.length ? '記録しました（ルール外の取引です）' : '保有に追加しました');
}

// ---- 操作 ----
document.addEventListener('click', (e) => {
  const t = e.target;
  const ob = t.closest('[data-entry]');
  if (ob) { e.preventDefault(); e.stopPropagation(); return openEntry(ob.dataset.entry, { code: ob.dataset.code, id: ob.dataset.id }); }
  if (!E.open || !t.closest('#entry')) return;
  if (t.id === 'entry' || t.closest('#entClose')) return closeEntry();
  if (t.closest('#entChange')) { E.code = null; E.q = ''; return renderEntry(); }
  const pk = t.closest('[data-e-pick]');
  if (pk) return pickStock(pk.dataset.ePick);
  const st = t.closest('[data-e-step]');
  if (st) {
    const k = st.dataset.eStep;
    const v = Math.max(0, (+E[k] || 0) + +st.dataset.d);
    E[k] = k === 'shares' ? Math.round(v / 100) * 100 || 100 : Math.round(v * 10) / 10;
    const inp = document.querySelector(`#entry input[data-e="${k}"]`);
    if (inp) inp.value = E[k];
    return updateSummary();
  }
  const sv = t.closest('[data-e-set]');
  if (sv) {
    const k = sv.dataset.eSet;
    E[k] = ['date', 'kept'].includes(k) ? sv.dataset.v : +sv.dataset.v;
    const inp = document.querySelector(`#entry input[data-e="${k}"]`);
    if (inp) inp.value = E[k];
    return updateSummary();
  }
  const mm = t.closest('[data-e-memo]');
  if (mm) {
    E.memo = E.memo ? `${E.memo}・${mm.dataset.eMemo}` : mm.dataset.eMemo;
    const inp = document.querySelector('#entry input[data-e="memo"]');
    if (inp) inp.value = E.memo;
    return;
  }
  if (t.closest('#entSave')) return saveEntry();
  const del = t.closest('[data-pos-del]');
  if (del) {
    e.stopPropagation();
    const p = S.positions.find((x) => x.id === del.dataset.posDel);
    if (p && confirm(`${p.name} を保有から消しますか？（取引記録には残りません）`)) {
      S.positions = S.positions.filter((x) => x !== p); savePositions(); closeEntry(); renderWatch(); renderHome();
    }
  }
}, true);

document.addEventListener('input', (e) => {
  if (!E.open) return;
  if (e.target.id === 'entQ') { E.q = e.target.value; return renderEntry(); }
  const k = e.target.dataset && e.target.dataset.e;
  if (!k) return;
  E[k] = ['date', 'memo'].includes(k) ? e.target.value : e.target.value === '' ? '' : +e.target.value;
  updateSummary();
});

document.addEventListener('keydown', (e) => { if (E.open && e.key === 'Escape') closeEntry(); });
