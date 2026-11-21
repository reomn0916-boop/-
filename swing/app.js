// スイングボード：data/latest.json（GitHub Actions が平日に更新）を表示する
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (x) => (x == null ? '—' : Number(x).toLocaleString('ja-JP', { maximumFractionDigits: x < 1000 ? 1 : 0 }));
const sgn = (x, d = 2) => {
  if (x == null) return '—';
  const t = Number(x).toFixed(d);
  return (+t === 0 ? Math.abs(0).toFixed(d) : (+t > 0 ? '+' : '') + t) + '%';
};
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');

const store = {
  get(k, d) { try { const v = localStorage.getItem('swing.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('swing.' + k, JSON.stringify(v)); } catch { /* 保存できない環境 */ } },
};

const S = {
  data: null,
  charts: null,
  tab: 'home',
  stockFilter: store.get('stockFilter', 'all'),
  sector: 'all',
  sort: store.get('sort', 'score'),
  query: '',
  newsFilter: 'all',
  watch: new Set(store.get('watch', [])),
  capital: store.get('capital', 1000000),
  riskPct: store.get('riskPct', 1),
  greenUp: store.get('greenUp', false),
  positions: store.get('positions', []),
  journal: store.get('journal', []),
  mode: store.get('mode', 'strict'),  // strict＝きびしめ（ルールどおり）／loose＝ゆるめ
  journalAll: false,
  trackFilter: 'all',
  trackAll: false,
  open: null,
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- 読み込み ---------------------------------------------------------------
async function load(force) {
  $('#btnReload').classList.add('spin');
  try {
    const r = await fetch('data/latest.json' + (force ? '?t=' + Date.now() : ''), { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    S.data = await r.json();
    S.charts = null;
    buildView();
    S.newsById = Object.fromEntries(S.data.news.map((n) => [n.id, n]));
    renderAll();
    renderUpd();
    if (force) toast('最新のデータにしました');
  } catch (e) {
    $('#updated').textContent = 'データを読み込めませんでした';
    if (!S.data) $('#v-home').innerHTML = `<div class="empty">データ（data/latest.json）がまだありません。<br>README の手順で GitHub Actions を動かしてください。</div>`;
  } finally {
    $('#btnReload').classList.remove('spin');
  }
}

// いまのモード（きびしめ・ゆるめ）で見た銘柄の一覧を作る
function buildView() {
  const loose = S.mode === 'loose';
  S.list = S.data.stocks.map((s) => (loose && s.loose ? { ...s, ...s.loose } : s));
  if (loose) S.list.sort((a, b) => b.score - a.score);
  S.byCode = Object.fromEntries(S.list.map((s) => [s.code, s]));
}
const isLoose = () => S.mode === 'loose' && S.data && S.data.picks_loose;
const modePicks = () => (isLoose() ? S.data.picks_loose : S.data.picks) || [];
const modeAlmost = () => (isLoose() ? S.data.almost_loose : S.data.almost) || [];
const modeTrack = () => {
  const t = S.data.track || {};
  return t.stats ? t : (t[isLoose() ? 'loose' : 'strict'] || { stats: {}, rows: [] });
};
const modeBt = () => S.data.backtest && (isLoose() ? S.data.backtest.loose : S.data.backtest.all);
const MODE_LABEL = { strict: 'きびしめ', loose: 'ゆるめ' };

function setMode(m) {
  if (S.mode === m) return;
  S.mode = m; store.set('mode', m);
  buildView(); renderAll();
  toast(m === 'loose' ? 'ゆるめのルールにしました' : 'きびしめ（ルールどおり）にしました');
}

function modeSeg() {
  return `<div class="seg modeseg"><button data-mode="strict" class="${S.mode === 'strict' ? 'on' : ''}">きびしめ<small>ルールどおり</small></button>
    <button data-mode="loose" class="${S.mode === 'loose' ? 'on' : ''}">ゆるめ<small>買える銘柄を増やす</small></button></div>`;
}

// ---- 今すぐ更新（GitHub Actions の「スイングデータ更新」を動かす） ----------------
const WORKFLOW = 'swing-update.yml';
function ghRepo() {
  const saved = store.get('ghRepo', '');
  if (saved) return saved;
  // GitHub Pages（owner.github.io/repo/）で開いていれば、そこから分かる
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m) return `${m[1]}/${location.pathname.split('/').filter(Boolean)[0] || ''}`;
  return '';
}
const ghToken = () => store.get('ghToken', '');
const wfUrl = () => `https://github.com/${ghRepo()}/actions/workflows/${WORKFLOW}`;

async function ghApi(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${ghRepo()}${path}`, {
    ...opt,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${ghToken()}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opt.headers || {}) },
  });
  if (!r.ok && r.status !== 204) {
    const msg = r.status === 401 ? '合い言葉（トークン）が正しくないか、期限切れです'
      : r.status === 403 || r.status === 404 ? '合い言葉に Actions の権限がないか、リポジトリ名が違います' : `GitHub の応答 ${r.status}`;
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

// 更新の進み具合（アプリを閉じても続きから見られるよう端末に残す）
const UPD = { get: () => store.get('upd', null), set: (v) => store.set('upd', v) };

function renderUpd() {
  const el = $('#updCard');
  if (!el || !S.data) return;
  const u = UPD.get();
  const when = fmtTime(S.data.generated_at);
  let status = '';
  if (u && u.state) {
    const min = Math.max(0, Math.round((Date.now() - u.since) / 6e4));
    const txt = { start: '更新を頼んでいます…', queued: '順番待ち', in_progress: `株価とニュースを集めています（${min}分経過・2〜3分かかります）`,
      publish: '仕上げ中（公開を待っています）', done: '更新しました', fail: '更新に失敗しました',
      wait: `GitHub で「Run workflow」→ 緑の「Run workflow」を押してください。終わると（2〜3分）ここが自動で新しくなります（${min}分経過）` }[u.state] || u.state;
    status = `<div class="upd-st ${u.state}">${u.state === 'done' || u.state === 'fail' ? '' : '<i class="spinner"></i>'}<span class="t">${esc(txt)}</span>${u.state === 'fail' && u.url ? ` <a href="${esc(u.url)}" target="_blank" rel="noopener">くわしく</a>` : ''}${u.err ? `<small>${esc(u.err)}</small>` : ''}${u.state === 'wait' ? `<small><a href="${esc(wfUrl())}" target="_blank" rel="noopener">GitHub をもう一度開く</a>・<a href="#" id="updCancel">待つのをやめる</a></small>` : ''}</div>`;
  }
  const busy = u && ['start', 'queued', 'in_progress', 'publish', 'wait'].includes(u.state);
  // 合い言葉なし：ボタンはそのまま GitHub の画面へのリンク（スマホでも確実に開くように）
  const btn = !busy && !ghToken() && ghRepo()
    ? `<a class="upd-btn" id="btnUpdateLink" href="${esc(wfUrl())}" target="_blank" rel="noopener">今すぐ更新</a>`
    : `<button class="upd-btn" id="btnUpdate" ${busy ? 'disabled' : ''}>${busy ? '更新中…' : '今すぐ更新'}</button>`;
  el.innerHTML = `<div class="upd">
    <div class="upd-l"><small>データ</small><b>${esc(when)}</b></div>
    ${btn}
  </div>${status}`;
}

async function startUpdate() {
  if (!ghRepo()) { toast('リポジトリが分かりません。「保有」タブの設定で入れてください'); setTab('watch'); return; }
  if (!ghToken()) { window.open(wfUrl(), '_blank', 'noopener'); startWaiting(); return; }
  const since = Date.now();
  UPD.set({ state: 'start', since, prevGen: S.data.generated_at });
  renderUpd();
  try {
    await ghApi(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    pollUpdate();
  } catch (e) {
    UPD.set({ state: 'fail', since, err: e.message });
    renderUpd();
  }
}

// 合い言葉なし：GitHub で動かしてもらい、新しいデータが公開されるのを待つ
function startWaiting() {
  UPD.set({ state: 'wait', since: Date.now(), prevGen: S.data.generated_at });
  renderUpd();
  clearTimeout(pollT);
  pollT = setTimeout(pollUpdate, 20000);
}

let pollT;
async function pollUpdate() {
  clearTimeout(pollT);
  const u = UPD.get();
  if (!u || !['start', 'queued', 'in_progress', 'publish', 'wait'].includes(u.state)) return;
  if (Date.now() - u.since > 40 * 6e4) {
    UPD.set({ ...u, state: 'fail', err: u.state === 'wait' ? '40分待っても新しいデータが来ませんでした。GitHub で Run workflow を押したか、赤い ✗ になっていないかを見てください' : '40分たっても終わりませんでした' });
    renderUpd(); return;
  }
  try {
    if (u.state !== 'publish' && u.state !== 'wait') {
      const res = await ghApi(`/actions/workflows/${WORKFLOW}/runs?per_page=5&event=workflow_dispatch`);
      const run = (res.workflow_runs || []).find((x) => new Date(x.created_at).getTime() >= u.since - 60e3);
      if (run) {
        if (run.status === 'completed') {
          if (run.conclusion === 'success') UPD.set({ ...u, state: 'publish', url: run.html_url });
          else { UPD.set({ ...u, state: 'fail', url: run.html_url, err: '「くわしく」で赤い ✗ の場所を見てください' }); renderUpd(); return; }
        } else UPD.set({ ...u, state: run.status === 'queued' ? 'queued' : 'in_progress', url: run.html_url });
      }
    } else {
      // 保存されたデータが GitHub Pages に出るまで待つ
      const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      if (d && d.generated_at !== u.prevGen) {
        UPD.set({ ...u, state: 'done' });
        await load(true);
        renderUpd();
        setTimeout(() => { const x = UPD.get(); if (x && x.state === 'done') { UPD.set(null); renderUpd(); } }, 8000);
        return;
      }
    }
  } catch (e) {
    UPD.set({ ...u, err: e.message });
  }
  renderUpd();
  pollT = setTimeout(pollUpdate, u.state === 'wait' ? 20000 : 15000);
}

async function testToken() {
  try {
    const wf = await ghApi(`/actions/workflows/${WORKFLOW}`);
    toast(`つながりました（${wf.name}）`);
  } catch (e) { toast(e.message); }
}

async function loadCharts() {
  if (S.charts) return S.charts;
  try {
    const r = await fetch('data/charts.json', { cache: 'no-cache' });
    S.charts = r.ok ? await r.json() : {};
  } catch { S.charts = {}; }
  return S.charts;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const h = (now - d) / 36e5;
  if (h < 1) return Math.max(1, Math.round(h * 60)) + '分前';
  if (h < 24) return Math.round(h) + '時間前';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- 描画 -------------------------------------------------------------------
function renderAll() {
  const d = S.data;
  $('#updated').textContent = '更新 ' + fmtTime(d.generated_at) + '（' + d.generated_at.slice(0, 16).replace('T', ' ') + '）';
  $('#demoBar').hidden = !d.demo;
  renderHome();
  renderStocks();
  renderNews();
  renderTrack();
  renderWatch();
  if (S.open) openStock(S.open, true);
}

function spark(arr) {
  if (!arr || arr.length < 2) return '';
  const mn = Math.min(...arr), mx = Math.max(...arr), w = 100, h = 26;
  const pts = arr.map((v, i) => `${(i / (arr.length - 1)) * w},${h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)}`).join(' ');
  const c = arr[arr.length - 1] >= arr[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" stroke="${c}" vector-effect="non-scaling-stroke"/></svg>`;
}

const SETUP_NAME = { pullback: '押し目', breakout: '高値ブレイク', rebound: '売られすぎ反発', trend: '上昇トレンド', none: '様子見' };
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pctf = (x, d = 0) => (x == null ? '—' : Number(x).toFixed(d) + '%');

// 検証結果の一行（勝率・平均損益）
function btLine(st, prefix = '') {
  if (!st || !st.n) return '';
  return `${prefix}勝率 <b class="num">${pctf(st.win_rate)}</b>・平均 <b class="num ${cls(st.avg_ret)}">${sgn(st.avg_ret, 1)}</b>（${st.n}回）`;
}

function regimeClass(label) {
  return label.includes('追い風') ? 'rg-good' : (label === '向かい風' || label === '買わない日') ? 'rg-bad' : 'rg-mid';
}

// ---- 自分の売買ルール（ルール一覧.xlsx） ----
const MY_RULES = [
  ['銘柄選び', '日経平均が下向きの時は買わない', '相場全体の流れに逆らわない'],
  ['銘柄選び', '25日線が上向きで、株価がその上にある銘柄だけ狙う', 'チャートは日足3〜6か月、週足で大きな流れも確認'],
  ['銘柄選び', '出来高が少なすぎる銘柄は避ける', '1日の売買代金が数億円以上'],
  ['銘柄選び', '話題で急に上がった株を高値で追いかけない', 'ニュース銘柄の飛びつき買いは一番やられやすい'],
  ['買い方', '上昇トレンド中の押し目（支持線・25日線付近）で買う', '陽線で反発したのを確認してから'],
  ['買い方', '支持線は2回以上、できれば3回以上跳ね返った値段', '反発時に出来高が増えていれば信頼度アップ'],
  ['買い方', '決算発表をまたいで持ち越さない', '決算で損切りラインを飛び越えて下がることがある'],
  ['損切り・利確', '買う前に損切りと利確の値段を決める', '決めずに買わない'],
  ['損切り・利確', '損切りは支持線の少し下に置く', '支持線1,150円なら1,130円あたり'],
  ['損切り・利確', '利確幅は損切り幅の2倍以上', '損50円なら利益100円。勝率34%でトントン'],
  ['損切り・利確', '利確の目安は抵抗線', '何度も上がりきれずに止まった値段'],
  ['資金管理', '1回の損は資金の1〜2%まで', '資金100万円なら1〜2万円。株数＝許せる損÷損切り幅'],
  ['資金管理', '負けを取り返そうと株数を増やさない', ''],
  ['注文', '前日の夜にIFDOCO注文で仕込む', '買い・利確・損切りの3つを同時に入れる'],
  ['保有中', '利益が損切り幅くらい出たら、損切りを買値まで上げる', '960円で買い→1,000円超えたら損切りを960円に'],
  ['保有中', 'さらに上がったら直近安値の少し下へ損切りを上げていく', 'トレーリングストップ'],
  ['保有中', '損切りラインは絶対に下げない', '「もうちょっと待てば戻る」が一番危ない'],
  ['メンタル', '損切りは失敗ではなく経費', '材料費と同じ。払わないと利益も出ない'],
  ['メンタル', '3連敗したら1週間休んで記録を見直す', ''],
  ['記録', '全トレードを記録する。ルールを守れたかを必ず書く', '守って負け＝OK、破って勝ち＝失敗'],
  ['記録', '20回ごとに勝率と勝ち・負けパターンを見直す', '集計シートで確認'],
  ['口座', 'スイングは特定口座（源泉徴収あり）でやる', 'NISAは売った枠が翌年まで戻らず、損の相殺もできない'],
];

// 3連敗したら1週間休む：休みの最終日（なければ null）
function restUntil() {
  const done = [...S.journal].sort((a, b) => (a.sellDate < b.sellDate ? -1 : 1));
  const last3 = done.slice(-3);
  if (last3.length < 3 || !last3.every((t) => t.pl < 0)) return null;
  const end = new Date(last3[2].sellDate);
  end.setDate(end.getDate() + 7);
  return end > new Date() ? end : null;
}
const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

const CHECK_ICON = { true: '✓', false: '✗', null: '？' };
function failText(s) {
  const f = s.checks.filter((c) => c.ok === false && c.req !== false).map((c) => c.label);
  return f.length ? 'ルールに足りない：' + f.join('・') : '';
}

function pickCard(s) {
  const why = s.reasons[0] || '';
  const bt = modeBt();
  const earn = s.earnings_days == null ? '<span class="chip warn">決算日 要確認</span>' : '';
  return `<button class="pick ${s.rule_ok ? '' : 'almost'}" data-code="${s.code}">
    <div class="l1">
      <span class="chip setup-${s.setup}">${esc(s.setup_label)}</span>
      ${s.new_pick ? '<span class="chip new">新</span>' : ''}
      <span class="nm">${esc(s.name)}<small>${s.code}・${esc(s.sector)}</small></span>
      <span class="score num">${Math.round(s.score)}<small>点</small></span>
    </div>
    <div class="l2 num">
      <span class="px">${yen(s.close)}円</span>
      <span class="${cls(s.chg_pct)}">${sgn(s.chg_pct)}</span>
      <span class="muted">RSI ${s.rsi.toFixed(0)}</span>
      <span class="muted">出来高 ${s.vol_ratio.toFixed(1)}倍</span>
      ${s.news_score ? `<span class="chip ${s.news_score > 0 ? 'pos' : 'neg'}">ニュース ${s.news_score > 0 ? '+' : ''}${s.news_score}</span>` : ''}
    </div>
    <div class="plan num">
      <div>買い目安<b>${yen(s.entry)}</b></div>
      <div>利確目安<b class="up">${yen(s.target)}</b></div>
      <div>損切り<b class="down">${yen(s.stop)}</b></div>
    </div>
    ${s.rule_ok ? '' : `<div class="why warn">${esc(failText(s))}</div>`}
    ${why ? `<div class="why">${esc(why)}</div>` : ''}
    <div class="why small">リスク:リワード 1:${s.rr.toFixed(1)}${s.support ? `・支持線 ${yen(s.support[0])}円（${s.support[1]}回）` : ''} ${earn}</div>
    ${s.rule_ok && bt && bt.n ? `<div class="why small">このルールの過去2年：${btLine(bt)}</div>` : ''}
  </button>`;
}

function renderHome() {
  const d = S.data, rg = d.market.regime;
  const picks = modePicks().map((c) => S.byCode[c]).filter(Boolean);
  const topNews = [...d.news].filter((n) => n.codes.length || n.themes.length)
    .sort((a, b) => Math.abs(b.sentiment) * (b.codes.length ? 1.5 : 1) - Math.abs(a.sentiment) * (a.codes.length ? 1.5 : 1)).slice(0, 5);
  const alerts = S.positions.map((p) => ({ p, st: posStatus(p) })).filter((x) => x.st.alerts.length);
  const almost = modeAlmost().map((c) => S.byCode[c]).filter(Boolean);
  const rest = restUntil();
  const ms = d.market_state || { up: rg.nikkei_up, above: rg.nikkei_up };
  const noTrade = isLoose() ? (ms.up === false && ms.above === false) : rg.nikkei_up === false;
  const rgLabel = isLoose() && rg.label === '買わない日' && !noTrade ? '中立' : rg.label;
  const rgText = isLoose() && rg.label === '買わない日' && !noTrade
    ? '日経平均の25日線は下向きですが、日経平均は25日線の上にあるので、ゆるめのルールでは買えます。株数は控えめに。' : rg.text;
  const tr = modeTrack().stats;
  const secs = d.sectors || [];
  const secMax = Math.max(1, ...secs.map((x) => Math.abs(x.ret20)));
  const secRow = (x) => `<button class="secrow" data-code="${x.best}"><span class="sn">${esc(x.sector)}</span>
      <span class="sbar"><i class="${x.ret20 >= 0 ? 'p' : 'm'}" style="width:${Math.abs(x.ret20) / secMax * 50}%"></i></span>
      <span class="sv num ${cls(x.ret20)}">${sgn(x.ret20, 1)}</span></button>`;
  $('#v-home').innerHTML = `
    ${rest ? `<div class="card banner bad"><b>3連敗中：${fmtDate(rest)} まで休みます</b><br>ルール「3連敗したら1週間休んで記録を見直す」。「保有」タブの取引記録を見直しましょう。</div>` : ''}
    ${noTrade ? `<div class="card banner bad"><b>今日は買わない日</b><br>${isLoose() ? '日経平均の25日線が下向きで、日経平均も25日線の下です（ゆるめのルールでも買わない）。' : '日経平均の25日線が下向きです（ルール：日経平均が下向きの時は買わない）。'}</div>` : ''}
    ${alerts.length ? `<h2>保有銘柄のお知らせ</h2><div class="picks">${alerts.map(({ p, st }) => `<button class="pick alert" data-tab-go="watch">
      <div class="l1"><span class="nm">${esc(p.name)}</span><span class="num ${cls(st.retPct)}">${sgn(st.retPct, 1)}</span></div>
      ${st.alerts.map((a) => `<div class="why ${a.level}">${esc(a.text)}</div>`).join('')}</button>`).join('')}</div>` : ''}
    <h2>相場の地合い</h2>
    <div class="card regime">
      <div class="badge ${regimeClass(rgLabel)}"><small>買いには</small>${esc(rgLabel)}</div>
      <div><p>${esc(rgText)}</p><ul>${rg.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
    </div>
    <div class="indices" style="margin-top:10px">
      ${d.market.indices.map((ix) => `<div class="ix"><div class="n">${esc(ix.name)}</div>
        <div class="p num">${ix.close.toLocaleString('ja-JP', { maximumFractionDigits: ix.kind === 'fx' || ix.kind === 'rate' ? 2 : 0 })}</div>
        <div class="c num ${cls(ix.chg_pct)}">${sgn(ix.chg_pct)}</div>${spark(ix.spark)}</div>`).join('')}
    </div>
    ${d.themes.length ? `<h2>話題のテーマ<small>ニュースの見出しから</small></h2>
    <div class="themes">${d.themes.slice(0, 5).map((t) => `<div class="theme"><b>${esc(t.theme)}</b><span class="muted">${t.count}件</span>
      <div class="secs">${t.up.map((s) => `<span class="chip pos">↑ ${esc(s)}</span>`).join('')}${t.down.map((s) => `<span class="chip neg">↓ ${esc(s)}</span>`).join('')}</div>
      <div class="hl">${esc(t.headline)}</div></div>`).join('')}</div>` : ''}
    ${secs.length ? `<h2>業種の強さ<small>20日の騰落の平均・押すと業種で一番点数の高い銘柄</small></h2>
    <div class="card secs">${secs.slice(0, 5).map(secRow).join('')}<div class="secgap">…</div>${secs.slice(-3).map(secRow).join('')}</div>` : ''}
    <h2>ルールに合う銘柄<small>${S.data.price_date || ''} 終値・${picks.length}銘柄・${MODE_LABEL[S.mode]}</small></h2>
    ${modeSeg()}
    ${!isLoose() && !picks.length && (d.picks_loose || []).length ? `<button class="card trackmini" data-mode="loose">ゆるめのルールなら <b>${d.picks_loose.length} 銘柄</b> あります<span class="muted"> ›</span></button>` : ''}
    ${tr && tr.n ? `<button class="card trackmini" data-tab-go="track">これまでの注目銘柄の成績：${btLine(tr)}<span class="muted"> ›</span></button>` : ''}
    ${picks.length ? `<div class="picks">${picks.map(pickCard).join('')}</div>` : `<div class="card empty">${noTrade ? '今日は買わない日です。' : `今日は${MODE_LABEL[S.mode]}のルールに全部合う銘柄がありません。`}無理に買わないのもルールのうちです。</div>`}
    ${almost.length ? `<h2>あと1つの銘柄<small>買わずに見張る</small></h2><div class="picks">${almost.map(pickCard).join('')}</div>` : ''}
    <h2>材料になりそうなニュース</h2>
    <div class="newslist">${topNews.map(newsItem).join('') || '<div class="card empty">ニュースはありません</div>'}</div>
    <p class="note">「ルールに合う銘柄」は、あなたの売買ルール（「保有」タブの下に一覧）のうち自動で判定できるものを全部満たした銘柄です。点数・売買の目安は、株価の動きとニュースの見出しから機械的に計算したものです。売買をすすめるものではありません。決算発表日・権利日などはご自身で確認し、投資は自己責任で行ってください。</p>
  `;
}

const SETUPS = [['all', '全部'], ['rule', 'ルールに合う'], ['almost', 'あと1つ'], ['pullback', '押し目'], ['breakout', '高値ブレイク'], ['rebound', '売られすぎ反発'], ['trend', '上昇トレンド'], ['none', '様子見']];
const SORTS = [['score', '点数'], ['chg_pct', '前日比'], ['ret20', '20日の騰落'], ['vol_ratio', '出来高の増え方'], ['rsi_low', 'RSI（低い順）'], ['news_score', 'ニュース']];

function stockRow(s) {
  return `<button class="row" data-code="${s.code}">
    <div class="main"><b>${s.rule_ok ? '<span class="ok-dot">✓</span>' : ''}${esc(s.name)}</b><small>${s.code}・${esc(s.sector)}　<span class="chip setup-${s.setup}">${esc(s.setup_label)}</span>${s.rule_ok ? '' : ` <span class="muted">✗${s.fails.length}</span>`}</small></div>
    <div class="rt num"><b>${yen(s.close)}</b><span class="${cls(s.chg_pct)}">${sgn(s.chg_pct)}</span></div>
    <div class="sc num">${Math.round(s.score)}</div>
  </button>`;
}

function renderStocks() {
  const d = S.data;
  const sectors = [...new Set(S.list.map((s) => s.sector))].sort();
  const sf = S.stockFilter;
  let list = S.list.filter((s) => (sf === 'all' || (sf === 'rule' && s.rule_ok) || (sf === 'almost' && !s.rule_ok && s.fails.length === 1)
    || s.setup === sf) && (S.sector === 'all' || s.sector === S.sector));
  if (S.query) {
    const q = S.query.toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().includes(q) || s.code.includes(q)
      || (s.aliases || []).some((a) => a.toLowerCase().includes(q)));
  }
  const key = S.sort;
  list.sort((a, b) => (key === 'rsi_low' ? a.rsi - b.rsi : b[key] - a[key]));
  const el = $('#v-stocks');
  const keepFocus = document.activeElement && document.activeElement.id === 'q';
  el.innerHTML = `
    <div class="filters">${SETUPS.map(([k, l]) => `<button data-setup="${k}" class="${S.stockFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="tools">
      <input id="q" type="search" placeholder="銘柄名・コード" value="${esc(S.query)}">
      <select id="sector"><option value="all">業種：全部</option>${sectors.map((s) => `<option ${S.sector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select id="sort">${SORTS.map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="list">${list.map(stockRow).join('') || '<div class="empty">該当なし</div>'}</div>
    <p class="note">いまは「${MODE_LABEL[S.mode]}」のルールで判定しています（今日の画面で切り替え）。${d.stocks.length} 銘柄を毎日チェックしています（対象は scripts/universe.json で変更できます）。</p>`;
  if (keepFocus) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function newsItem(n) {
  const k = n.sentiment > 0.2 ? 'pos' : n.sentiment < -0.2 ? 'neg' : '';
  const mark = k === 'pos' ? '<span class="chip pos">プラス</span>' : k === 'neg' ? '<span class="chip neg">マイナス</span>' : '';
  const stocks = n.codes.map((c) => S.byCode[c]).filter(Boolean)
    .map((s) => `<button class="chip" data-code="${s.code}">${esc(s.name)}</button>`).join('');
  const link = n.link ? `<a class="t" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : `<span class="t" style="font-weight:600">${esc(n.title)}</span>`;
  return `<div class="nw ${k}">${link}
    <div class="meta">${mark}${n.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}${n.themes.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}${stocks}
    <span>${esc(n.source)}・${fmtTime(n.published)}</span></div></div>`;
}

const NEWS_FILTERS = [['all', '全部'], ['stock', '銘柄の材料'], ['pos', 'プラス'], ['neg', 'マイナス'], ['theme', 'テーマ'], ['watch', 'ウォッチ銘柄']];

function renderNews() {
  const d = S.data;
  const f = S.newsFilter;
  const list = d.news.filter((n) => f === 'all' || (f === 'stock' && n.codes.length) || (f === 'pos' && n.sentiment > 0.2)
    || (f === 'neg' && n.sentiment < -0.2) || (f === 'theme' && n.themes.length) || (f === 'watch' && n.codes.some((c) => S.watch.has(c))));
  $('#v-news').innerHTML = `
    <div class="filters">${NEWS_FILTERS.map(([k, l]) => `<button data-nf="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="newslist">${list.map(newsItem).join('') || '<div class="card empty">該当するニュースはありません</div>'}</div>
    <p class="note">プラス・マイナスは見出しの言葉（上方修正・増配・下方修正など）から自動で判定しています。本文は必ずリンク先で確認してください。</p>`;
}

// ---- 成績（注目銘柄のその後・過去2年の検証） -----------------------------------
const TRACK_STATUS = { win: ['利確', 'pos'], loss: ['損切り', 'neg'], timeout: ['期限で手じまい', ''], open: ['保有中', 'open'], wait: ['明日の寄りから', ''], skip: ['寄りで見送り', ''] };

function statGrid(st) {
  if (!st || !st.n) return '<div class="empty">まだ結果の出た取引がありません</div>';
  return `<div class="kv num">
    <div>勝率<b>${pctf(st.win_rate)}</b></div>
    <div>1回の平均<b class="${cls(st.avg_ret)}">${sgn(st.avg_ret, 2)}</b></div>
    <div>プロフィットファクター<b>${st.pf ?? '—'}</b></div>
    <div>勝ちの平均<b class="up">${sgn(st.avg_win, 1)}</b></div>
    <div>負けの平均<b class="down">${sgn(st.avg_loss, 1)}</b></div>
    <div>平均の保有<b>${st.avg_days}日</b></div>
  </div>`;
}

function renderTrack() {
  const d = S.data, tr = modeTrack(), bt = d.backtest;
  const f = S.trackFilter;
  const rows = tr.rows.filter((r) => f === 'all' || (f === 'closed' && ['win', 'loss', 'timeout'].includes(r.status)) || (f === 'open' && r.status === 'open'));
  const sim = tr.rows.some((r) => r.src === 'sim');
  $('#v-track').innerHTML = `
    <h2>注目銘柄のその後<small>${MODE_LABEL[S.mode]}・翌日の寄り付きで買い、目安どおり売ったとして計算</small></h2>
    ${modeSeg()}
    ${statGrid(tr.stats)}
    <p class="muted" style="font-size:12px;margin:6px 0 0">結果が出た ${tr.stats.n || 0} 回・保有中 ${tr.stats.open || 0} 回。最長 ${bt ? bt.hold_days : 15} 営業日で手じまい。${sim ? '記録を始める前の分は、同じルールで過去の日に選んだ銘柄を再現しています。' : ''}</p>
    <div class="filters" style="margin-top:12px">${[['all', '全部'], ['open', '保有中'], ['closed', '結果が出た']].map(([k, l]) => `<button data-tf="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="list">${rows.slice(0, S.trackAll ? 999 : 20).map((r) => {
      const [lb, k] = TRACK_STATUS[r.status] || [r.status, ''];
      return `<button class="row" data-code="${r.code}">
        <div class="main"><b>${esc(r.name)}</b><small>${r.date.slice(5).replace('-', '/')} 選出・${SETUP_NAME[r.setup] || ''}・${Math.round(r.score)}点</small></div>
        <div class="rt num"><span class="chip ${k}">${lb}</span><b class="${cls(r.ret)}">${r.ret == null ? '—' : sgn(r.ret, 1)}</b></div>
      </button>`;
    }).join('') || '<div class="empty">記録はまだありません</div>'}</div>
    ${rows.length > 20 && !S.trackAll ? `<button class="btn-sm" id="trackMore" style="width:100%;margin-top:8px">もっと見る（全 ${rows.length} 件）</button>` : ''}
    ${bt && bt.all && bt.all.n ? `
    <h2>自分のルールの検証<small>過去2年（${bt.period[0] || ''}〜）・全 ${S.data.stocks.length} 銘柄</small></h2>
    ${statGrid(modeBt())}
    <div class="card" style="margin-top:10px;font-size:13px">
      <table class="bt num"><tr><th></th><th>回数</th><th>勝率</th><th>平均</th><th>PF</th></tr>
      ${[['きびしめ（ルールどおり）', bt.all], ['きびしめ・日経平均の条件なし', bt.nomkt], ['ゆるめ', bt.loose]].filter(([, st]) => st && st.n).map(([lb, st]) => `<tr><td>${lb}</td><td>${st.n}</td><td>${pctf(st.win_rate)}</td><td class="${cls(st.avg_ret)}">${sgn(st.avg_ret, 2)}</td><td>${st.pf ?? '—'}</td></tr>`).join('')}
      <tr><td colspan="5" class="muted" style="text-align:left;font-size:11px">${MODE_LABEL[S.mode]}の点数別</td></tr>
      ${((isLoose() ? bt.loose_by_score : bt.by_score) || []).filter((st) => st.n).map((st) => `<tr class="sub"><td>${st.label}</td><td>${st.n}</td><td>${pctf(st.win_rate)}</td><td class="${cls(st.avg_ret)}">${sgn(st.avg_ret, 2)}</td><td>${st.pf ?? '—'}</td></tr>`).join('')}
      </table>
      <p class="muted" style="margin:8px 0 0">ゆるめは回数が増えるかわりに、勝率や1回の平均が下がりやすくなります。どちらが自分に合うかは、ここと「注目銘柄のその後」で比べてください。「日経平均の条件なし」と比べると、ルール「日経平均が下向きの時は買わない」の効き目が分かります。点数別（字下げの行）は、ルールに合った銘柄の中で点数が高いほど成績が良いかの確認です。</p>
      <p class="muted" style="margin:8px 0 0">比べるもの：いつ買っても ${bt.hold_days} 日持った場合の平均は <b class="${cls(bt.baseline_avg_ret)}">${sgn(bt.baseline_avg_ret, 2)}</b>。これを上回っていればルールに意味がある目安です。PF（プロフィットファクター）は「勝ちの合計 ÷ 負けの合計」で、1 を超えるとプラス。</p>
    </div>` : ''}
    <p class="note">検証は株価だけで判定できるルール（日経平均・25日線・週足・売買代金・急騰・押し目と陽線・支持線・リスク:リワード）で行い、決算のルールとニュースは使っていません（過去の決算日が取れないため）。手数料・税金は含みません。同じ日に損切りと利確の両方に届いたときは損切りとして数えています（厳しめ）。過去の成績は将来を約束しません。</p>`;
}

// ---- 保有銘柄 -----------------------------------------------------------------
function savePositions() { store.set('positions', S.positions); }

function posStatus(p) {
  const s = S.byCode && S.byCode[p.code];
  const now = s ? s.close : p.price;
  const retPct = (now / p.price - 1) * 100;
  const pl = (now - p.price) * p.shares;
  const days = Math.floor((Date.now() - new Date(p.date)) / 864e5);
  const alerts = [];
  if (s) {
    if (now <= p.stop) alerts.push({ level: 'bad', text: `終値 ${yen(now)} 円が損切りライン ${yen(p.stop)} 円を下回りました` });
    else if (now >= p.target) alerts.push({ level: 'good', text: `終値 ${yen(now)} 円が利確目安 ${yen(p.target)} 円に届きました` });
    else if (p.stop < p.price && now - p.price >= (p.initStop ? p.price - p.initStop : p.price - p.stop)) alerts.push({ level: 'info', text: `損切り幅と同じだけ上がりました。損切りを買値 ${yen(p.price)} 円に上げます（ルール）`, act: ['stop', p.price] });
    if (s.trail_stop && s.trail_stop > p.stop && s.trail_stop >= p.price && s.trail_stop < now) {
      alerts.push({ level: 'info', text: `直近安値の少し下（${yen(s.trail_stop)} 円）まで損切りを上げられます（トレーリングストップ）`, act: ['stop', s.trail_stop] });
    }
    if (s.earnings_days != null && s.earnings_days >= 0 && s.earnings_days <= 10) {
      alerts.push({ level: 'bad', text: `決算発表が ${s.earnings_days} 日後（${s.earnings}）。ルール：決算をまたがない → 前日までに売る` });
    }
    (s.exit_warn || []).forEach((w) => alerts.push({ level: 'warn', text: w }));
  }
  if (days > 21) alerts.push({ level: 'warn', text: `買ってから ${days} 日。スイングの目安（3週間）を過ぎています` });
  const span = p.target - p.stop;
  const prog = span > 0 ? Math.max(0, Math.min(100, ((now - p.stop) / span) * 100)) : 50;
  return { now, retPct, pl, days, alerts, prog, entryProg: span > 0 ? ((p.price - p.stop) / span) * 100 : 50 };
}

function posCard(p) {
  const st = posStatus(p);
  return `<div class="card pos-card">
    <div class="l1"><button class="nm linklike" data-code="${p.code}">${esc(p.name)}<small>${p.code}</small></button>
      <span class="num ${cls(st.pl)}"><b>${st.pl >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(st.pl)))}円</b>（${sgn(st.retPct, 1)}）</span></div>
    <div class="muted num" style="font-size:12px">${p.date} に ${yen(p.price)} 円 × ${p.shares.toLocaleString()} 株・今 ${yen(st.now)} 円</div>
    <div class="range"><i class="track"></i><i class="ent" style="left:${st.entryProg}%"></i><i class="now" style="left:${st.prog}%"></i></div>
    <div class="range-l num"><span class="down">損切り ${yen(p.stop)}</span><span class="up">利確 ${yen(p.target)}</span></div>
    ${st.alerts.map((a) => `<div class="why ${a.level}">${esc(a.text)}${a.act ? ` <button class="btn-sm" data-pos-raise="${p.id}" data-v="${a.act[1]}">${yen(a.act[1])} 円にする</button>` : ''}</div>`).join('')}
    <div class="pos-acts">
      <label>損切り（上げるだけ）<input type="number" inputmode="decimal" data-pos-stop="${p.id}" value="${p.stop}"></label>
      <label>利確<input type="number" inputmode="decimal" data-pos-target="${p.id}" value="${p.target}"></label>
      <button class="btn-sm" data-pos-sell="${p.id}">売った</button>
    </div>
    <div class="sellform" data-sellform="${p.id}" hidden>
      <div class="calc">
        <label class="field">売値（円）<input type="number" inputmode="decimal" data-sf="price" value="${st.now}"></label>
        <label class="field">売った日<input type="date" data-sf="date" value="${localDate()}"></label>
      </div>
      <div class="field" style="margin-top:8px">ルールを守れた？
        <div class="seg"><button data-sf-kept="1">守れた</button><button data-sf-kept="0">破った</button></div>
      </div>
      <label class="field" style="margin-top:8px">メモ（なぜ買った・なぜ売った）<input type="text" data-sf="memo" placeholder="例：支持線で反発、利確ラインで売り"></label>
      <div class="pos-acts"><button class="btn-main" data-sf-save="${p.id}">記録して保有から外す</button></div>
      <button class="linkbtn" data-pos-del="${p.id}">記録せずに消す（間違えて登録したとき）</button>
    </div>
  </div>`;
}

// ---- 取引記録 ---------------------------------------------------------------
function saveJournal() { store.set('journal', S.journal); }

function journalStats(js) {
  const n = js.length;
  if (!n) return null;
  const wins = js.filter((t) => t.pl > 0), losses = js.filter((t) => t.pl <= 0);
  const kept = js.filter((t) => t.kept);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const gl = -sum(losses, (t) => t.pl);
  let streak = 0;
  for (const t of [...js].sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1))) { if (t.pl < 0) streak++; else break; }
  return {
    n, winRate: wins.length / n * 100, total: sum(js, (t) => t.pl), avgRet: sum(js, (t) => t.ret) / n,
    avgWin: wins.length ? sum(wins, (t) => t.ret) / wins.length : 0, avgLoss: losses.length ? sum(losses, (t) => t.ret) / losses.length : 0,
    pf: gl > 0 ? sum(wins, (t) => t.pl) / gl : null, keptRate: kept.length / n * 100, streak,
    m: { kw: js.filter((t) => t.kept && t.pl > 0).length, kl: js.filter((t) => t.kept && t.pl <= 0).length,
      bw: js.filter((t) => !t.kept && t.pl > 0).length, bl: js.filter((t) => !t.kept && t.pl <= 0).length },
  };
}

function journalHtml() {
  const js = [...S.journal].sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1));
  const st = journalStats(js);
  if (!st) return '<div class="card empty">保有銘柄の「売った」から記録すると、勝率やルールを守れた割合をここで集計します。</div>';
  const review = st.n % 20 === 0 ? `<div class="card banner info"><b>${st.n}回たまりました：見直しの時期です</b><br>ルール「20回ごとに勝率と勝ち・負けパターンを見直す」。破って勝った取引がないか確認しましょう。</div>` : '';
  return `${review}
    <div class="kv num">
      <div>回数<b>${st.n}回</b></div>
      <div>勝率<b>${pctf(st.winRate)}</b></div>
      <div>損益の合計<b class="${cls(st.total)}">${st.total >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(st.total)))}円</b></div>
      <div>勝ちの平均<b class="up">${sgn(st.avgWin, 1)}</b></div>
      <div>負けの平均<b class="down">${sgn(st.avgLoss, 1)}</b></div>
      <div>ルールを守れた<b>${pctf(st.keptRate)}</b></div>
    </div>
    ${['strict', 'loose'].map((m) => { const x = journalStats(js.filter((t) => (t.mode || 'strict') === m)); return x ? `<div class="why small">${MODE_LABEL[m]}で買った分：${x.n}回・勝率 ${pctf(x.winRate)}・損益 <span class="${cls(x.total)}">${x.total >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(x.total)))}円</span></div>` : ''; }).join('')}
    <div class="card matrix" style="margin-top:8px">
      <div></div><div class="h">勝ち</div><div class="h">負け</div>
      <div class="h">守った</div><div class="good">${st.m.kw}<small>理想</small></div><div class="good">${st.m.kl}<small>OK（経費）</small></div>
      <div class="h">破った</div><div class="bad">${st.m.bw}<small>失敗（たまたま）</small></div><div class="bad">${st.m.bl}<small>失敗</small></div>
    </div>
    ${st.streak >= 2 ? `<div class="why warn" style="margin-top:6px">いま ${st.streak} 連敗中${st.streak >= 3 ? '（1週間休むルール）' : '。次も負けたら1週間休みます'}</div>` : ''}
    <div class="list" style="margin-top:8px">${js.slice(0, S.journalAll ? 999 : 10).map((t) => `<div class="row">
      <div class="main"><b>${t.kept ? '' : '<span class="chip neg">破</span> '}${t.mode === 'loose' ? '<span class="chip">ゆるめ</span> ' : ''}${esc(t.name)}</b><small>${t.buyDate.slice(5).replace('-', '/')}→${t.sellDate.slice(5).replace('-', '/')}・${yen(t.price)}→${yen(t.sellPrice)}円×${t.shares}${t.memo ? '・' + esc(t.memo) : ''}</small></div>
      <div class="rt num"><b class="${cls(t.pl)}">${t.pl >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(t.pl)))}</b><span class="${cls(t.ret)}">${sgn(t.ret, 1)}</span></div>
      <button class="xbtn" data-j-del="${t.id}" aria-label="消す">×</button></div>`).join('')}</div>
    ${js.length > 10 && !S.journalAll ? `<button class="btn-sm" id="journalMore" style="width:100%;margin-top:8px">もっと見る（全 ${js.length} 件）</button>` : ''}
    <button class="btn-sm" id="journalCsv" style="width:100%;margin-top:8px">CSV で書き出す（Excel で開ける）</button>`;
}

function renderWatch() {
  const list = [...S.watch].map((c) => S.byCode[c]).filter(Boolean).sort((a, b) => b.score - a.score);
  const tot = S.positions.reduce((a, p) => a + posStatus(p).pl, 0);
  $('#v-watch').innerHTML = `
    <h2>保有銘柄${S.positions.length ? `<small class="num ${cls(tot)}">合計 ${tot >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(tot)))}円</small>` : ''}</h2>
    ${S.positions.length ? `<div class="picks">${S.positions.map(posCard).join('')}</div>` : '<div class="card empty">銘柄の画面の「買った」から登録すると、損切り・利確・売りのサインをお知らせします。</div>'}
    <h2>取引記録<small>全トレードを記録し、ルールを守れたかを書く</small></h2>
    ${journalHtml()}
    <h2>ウォッチ銘柄</h2>
    ${list.length ? `<div class="list">${list.map(stockRow).join('')}</div>` : '<div class="card empty">銘柄の画面の ☆ を押すと、ここに並びます。</div>'}
    <details class="card settings advanced" ${ghToken() ? 'open' : ''}><summary>上級者向け：GitHub を開かずにボタンだけで更新する</summary>
      <p class="muted" style="font-size:12px">ふだんは設定いりません。「今すぐ更新」で GitHub の画面が開くので、Run workflow を押すだけです。GitHub の合い言葉（トークン）を登録すると、その手間も省けます。</p>
      <label class="field">リポジトリ（持ち主/名前）<input id="ghRepo" type="text" autocapitalize="off" autocomplete="off" placeholder="例：reomn0916-boop/-" value="${esc(ghRepo())}"></label>
      <label class="field">合い言葉（GitHub のアクセストークン）<input id="ghToken" type="password" autocapitalize="off" autocomplete="off" placeholder="${ghToken() ? '登録済み（変えるときだけ入れる）' : 'github_pat_ で始まる文字'}"></label>
      <div class="pos-acts" style="margin-top:0"><button class="btn-sm" id="ghSave">保存</button><button class="btn-sm" id="ghTest" ${ghToken() ? '' : 'disabled'}>つながるか確かめる</button><button class="btn-sm" id="ghDel" ${ghToken() ? '' : 'disabled'}>合い言葉を消す</button></div>
      <details class="howto"><summary>合い言葉の作り方（はじめの1回だけ）</summary>
        <ol>
          <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub の新しいトークンの画面</a>を開く（GitHub にログインした状態で）</li>
          <li><b>Token name</b>：「スイングボード」など好きな名前</li>
          <li><b>Expiration</b>：期限（90日など。切れたら作り直す）</li>
          <li><b>Repository access</b>：<b>Only select repositories</b> を選び、このリポジトリ（<code>${esc(ghRepo().split('/')[1] || '-')}</code>）だけを選ぶ</li>
          <li><b>Permissions</b> → <b>Repository permissions</b> → <b>Actions</b> を <b>Read and write</b> にする（ほかは触らない）</li>
          <li>いちばん下の <b>Generate token</b> を押し、出てきた <code>github_pat_…</code> をコピーして、上の欄に貼って「保存」</li>
        </ol>
        <p class="muted">合い言葉はこのスマホの中だけに保存され、GitHub に更新を頼むときにだけ使います。この権限でできるのは Actions の操作（更新を動かす・止めるなど）だけで、ファイルの書きかえはできません。人に見せたり送ったりしないでください。</p>
      </details>
    </details>
    <h2>設定</h2>
    <div class="card settings">
      <div class="field">銘柄を選ぶルール${modeSeg()}</div>
      <label class="field">投資に使う資金（円）<input id="capital" type="number" inputmode="numeric" min="0" step="10000" value="${S.capital}"></label>
      <label class="field">1回の取引で許せる損失（資金の %）<input id="riskPct" type="number" inputmode="decimal" min="0.1" max="10" step="0.1" value="${S.riskPct}"></label>
      ${S.riskPct > 2 ? '<p class="why bad" style="margin:0 0 10px">ルール：1回の損は資金の1〜2%まで</p>' : ''}
      <div class="field">上がったときの色
        <div class="seg"><button data-color="red" class="${S.greenUp ? '' : 'on'}">赤</button><button data-color="green" class="${S.greenUp ? 'on' : ''}">緑</button></div>
      </div>
      <p class="muted" style="font-size:12px;margin:0">資金と損失の割合から、銘柄の画面で「買える株数」を計算します（100株単位）。</p>
    </div>
    <h2>マイルール<small>ルール一覧.xlsx より</small></h2>
    <div class="card rules">${MY_RULES.map((r, i) => `${i === 0 || MY_RULES[i - 1][0] !== r[0] ? `<div class="rg">${esc(r[0])}</div>` : ''}
      <div class="rl"><b>${esc(r[1])}</b>${r[2] ? `<small>${esc(r[2])}</small>` : ''}</div>`).join('')}</div>
    <h2>ゆるめのルール<small>きびしめとの違い</small></h2>
    <div class="card" style="font-size:13px">
      <table class="bt cmp"><tr><th></th><th>きびしめ</th><th>ゆるめ</th></tr>
        <tr><td>日経平均</td><td>25日線が上向き</td><td>25日線が上向き<b>か</b>、25日線の上</td></tr>
        <tr><td>トレンド</td><td>25日線が上向きで株価がその上</td><td>＋25日線＞75日線で株価が75日線の上（25日線の−2%まで可）</td></tr>
        <tr><td>週足</td><td>必須</td><td>参考</td></tr>
        <tr><td>押し目</td><td>3日以内に25日線+1.2%まで。陽線かつ前日比プラス</td><td>5日以内に25日線+3%まで。陽線か前日比プラス</td></tr>
        <tr><td>支持線</td><td>2回以上の反発が必須</td><td>1回でよい。なければ25日線の少し下で損切り</td></tr>
        <tr><td>利確幅</td><td>損切り幅の2倍以上</td><td>1.5倍以上</td></tr>
        <tr><td>急騰</td><td>5日で+10%未満・窓+5%未満</td><td>5日で+15%未満・窓+7%未満</td></tr>
        <tr><td>決算</td><td>3週間以内なら買わない</td><td>1週間以内なら買わない（決算の前に売る）</td></tr>
      </table>
      <p class="muted" style="margin:8px 0 0">売買代金・IFDOCO・損切りを下げない・1回の損は1〜2%・3連敗で休む、などはどちらも同じです。</p>
    </div>
    <h2>アプリでの判定のしかた</h2>
    <div class="card" style="font-size:13px">
      <ul style="padding-left:18px;margin:0">
        <li><b>日経平均が下向き</b>：日経平均の25日線が5営業日前より下がっていたら「買わない日」</li>
        <li><b>25日線</b>：25日線が5営業日前より上向きで、終値がその上。週足は13週線（65日線）が上向きで、その上</li>
        <li><b>売買代金</b>：直近20日の平均が 3億円/日 以上</li>
        <li><b>急騰を追わない</b>：5日で +10% 未満、直近3日に +5% 以上の窓あけがない、25日線から +8% 未満</li>
        <li><b>押し目と陽線</b>：直近3日の安値が25日線（+1.2%以内）か支持線まで下がり、当日が陽線で前日比プラス</li>
        <li><b>支持線・抵抗線</b>：過去120日で「前後3日でいちばん安い（高い）日」を反発とみなし、近い値段（値動きの半日分か1.2%以内）をまとめて、2回以上なら線とする</li>
        <li><b>損切り</b>：株価のすぐ下の支持線から、値動きの1/4日分か1%の少し下。<b>利確</b>：上の抵抗線の少し手前（抵抗線がなければ損切り幅の2倍）。2倍に届かなければ買わない</li>
        <li><b>決算</b>：3週間以内に決算発表があれば買わない。決算日が取れない銘柄は「要確認」</li>
        <li>点数（0〜100）は、ルールに合う銘柄どうしの順番づけに使います（出来高を伴う反発・MACD・日経平均より強いか・ニュースなど）</li>
      </ul>
    </div>
    <p class="note">データは平日の朝（7時ごろ）と大引け後（16時半ごろ）に更新されます。株価は Yahoo! Finance、ニュースは NHK・Yahoo!ニュース・Google ニュースの RSS と適時開示（TDnet）から取得しています。保有・ウォッチ・設定はこの端末の中だけに保存されます。売買をすすめるものではありません。</p>`;
}

// ---- 銘柄の詳細 ---------------------------------------------------------------
function sharesFor(s) {
  const per = s.entry - s.stop;
  if (!(per > 0) || !(S.capital > 0)) return null;
  const byRisk = Math.floor((S.capital * S.riskPct / 100) / per / 100) * 100;
  const byCash = Math.floor(S.capital / s.entry / 100) * 100;
  const n = Math.max(0, Math.min(byRisk, byCash));
  return { n, cost: n * s.entry, loss: n * per, gain: n * (s.target - s.entry), limited: byCash < byRisk };
}

function calcHtml(s) {
  const r = sharesFor(s);
  if (!r) return '資金を入れてください';
  if (r.n === 0) return `この資金と損失の割合では 100 株を買えません（100株で損切り時 ${yen((s.entry - s.stop) * 100)} 円の損）`;
  return `<b>${r.n.toLocaleString()} 株</b>（約 ${yen(r.cost)} 円）<br>
    損切りなら <span class="down">−${yen(r.loss)} 円</span>・利確なら <span class="up">+${yen(r.gain)} 円</span>${r.limited ? '<br><small class="muted">資金の上限で株数を抑えています</small>' : ''}`;
}

async function openStock(code, keepScroll) {
  const s = S.byCode[code];
  if (!s) return;
  S.open = code;
  const sheet = $('#sheet');
  const y = sheet.scrollTop;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!keepScroll && location.hash !== '#' + code) history.pushState({ code }, '', '#' + code);
  $('#sheetName').textContent = s.name;
  $('#sheetSub').textContent = `${s.code}・${s.sector}・${s.date} 終値`;
  $('#sheetStar').classList.toggle('on', S.watch.has(code));
  const news = s.news_ids.map((id) => S.newsById[id]).filter(Boolean);
  const pctTo = (x) => sgn((x / s.entry - 1) * 100, 1);
  $('#sheetBody').innerHTML = `
    <div class="hero">
      <div><span class="chip setup-${s.setup}">${esc(s.setup_label)}</span>
        <div class="px num">${yen(s.close)}<small style="font-size:14px">円</small></div>
        <div class="num ${cls(s.chg_pct)}">${sgn(s.chg_pct)}（前日比）</div></div>
      <div class="scbox"><span class="muted" style="font-size:12px">総合点</span><br><b class="num">${Math.round(s.score)}</b><span class="muted">/100</span>
        <div class="muted num" style="font-size:12px">テクニカル ${s.tech_score}・ニュース ${s.news_score > 0 ? '+' : ''}${s.news_score}</div></div>
    </div>
    <div class="bar"><i style="width:${s.score}%"></i></div>
    <div class="card verdict ${s.rule_ok ? 'ok' : 'ng'}">${s.rule_ok
      ? `<b>✓ ルールに合っています</b>${s.earnings_days == null ? '<br><small>決算日だけは取れなかったので、自分で確認してください</small>' : ''}`
      : `<b>✗ ルールに合っていません（${s.fails.length}つ）</b><br><small>買わずに見張りましょう。</small>`}</div>
    <h2>ルールチェック<small>${MODE_LABEL[S.mode]}${isLoose() ? '・きびしめとの違いは「保有」タブの下' : ''}</small></h2>
    <ul class="checks">${s.checks.map((c) => `<li class="c-${c.req === false ? 'ref' : c.ok}"><i>${CHECK_ICON[c.ok]}</i><span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
    <div class="chartbox"><canvas id="chart"></canvas>
      <div class="legend"><span><i style="background:#f0a020"></i>25日線</span><span><i style="background:#8a63d2"></i>75日線</span>
      <span><i style="background:var(--up)"></i>利確</span><span><i style="background:var(--down)"></i>損切り</span>
      <span><i style="background:#2bb0a0"></i>支持線</span><span><i style="background:#c060a0"></i>抵抗線</span></div></div>
    <h2>売買の目安<small>リスク:リワード 1:${s.rr.toFixed(2)}</small></h2>
    <div class="planbig num">
      <div>買い目安<b>${yen(s.entry)}</b><span class="muted">終値基準</span></div>
      <div class="tg">利確目安<b>${yen(s.target)}</b><span>${pctTo(s.target)}</span></div>
      <div class="st">損切り<b>${yen(s.stop)}</b><span>${pctTo(s.stop)}</span></div>
    </div>
    <h2>IFDOCO 注文<small>前日の夜に3つ同時に入れる</small></h2>
    <div class="card ifdoco num">
      <div><span>① 買い（指値）</span><b>${yen(s.limit || s.entry)} 円</b></div>
      <div><span>② 利確（指値・売り）</span><b class="up">${yen(s.target)} 円</b></div>
      <div><span>③ 損切り（逆指値・売り）</span><b class="down">${yen(s.stop)} 円以下で成行</b></div>
      <small class="muted">損切りは${s.support ? `支持線 ${yen(s.support[0])} 円（${s.support[1]}回反発）の少し下` : '値動きの大きさから計算'}、利確は${s.resistance ? `抵抗線 ${yen(s.resistance[0])} 円の少し手前` : '損切り幅の2倍（上に抵抗線なし）'}。
      翌朝 ${yen(s.chase)} 円より高く寄りそうなら取り消す（損切りまでが遠くなり割に合わない）。</small>
      <button class="btn-sm" id="copyOrder">注文の値段をコピー</button>
    </div>
    <div class="card orderhint" style="display:block">決算発表：${s.earnings ? `<b>${s.earnings}</b>（${s.earnings_days} 日後）` : '<b>不明</b>（下の「決算発表日を調べる」で確認）'}</div>
    ${s.bt && s.bt.all && s.bt.all.n ? `<h2>この銘柄での過去の成績<small>過去2年・同じルール</small></h2>
    <div class="card" style="font-size:14px">${btLine(s.bt.all, 'すべての型：')}${s.bt.same && s.bt.same.n ? `<br>${btLine(s.bt.same, esc(s.setup_label) + '：')}` : ''}</div>` : ''}
    ${s.exit_warn && s.exit_warn.length ? `<h2>持っている人へ（売りのサイン）</h2><ul class="pts bad">${s.exit_warn.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <h2>買える株数</h2>
    <div class="card calc">
      <label class="field">資金（円）<input id="cCap" type="number" inputmode="numeric" value="${S.capital}"></label>
      <label class="field">許せる損失（%）<input id="cRisk" type="number" inputmode="decimal" step="0.1" value="${S.riskPct}"></label>
      <div class="res num" id="cRes">${calcHtml(s)}</div>
      <button class="btn-main" id="btnBought">買った（保有に追加）</button>
    </div>
    <div class="card buyform" id="buyForm" hidden>
      <div class="calc">
        <label class="field">買値（円）<input id="bPrice" type="number" inputmode="decimal" value="${s.entry}"></label>
        <label class="field">株数<input id="bShares" type="number" inputmode="numeric" step="100" value="${(sharesFor(s) || {}).n || 100}"></label>
        <div class="why warn" id="bWarn" style="grid-column:1/-1" hidden></div>
        <label class="field">損切り（円）<input id="bStop" type="number" inputmode="decimal" value="${s.stop}"></label>
        <label class="field">利確（円）<input id="bTarget" type="number" inputmode="decimal" value="${s.target}"></label>
        <label class="field">買った日<input id="bDate" type="date" value="${localDate()}"></label>
        <button class="btn-main" id="btnSavePos" style="align-self:end">保有に追加</button>
      </div>
    </div>
    ${s.reasons.length || s.theme_notes.some((t) => t.includes('追い風')) ? `<h2>注目する理由</h2><ul class="pts good">${[...s.reasons, ...s.theme_notes.filter((t) => t.includes('追い風'))].map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${s.cautions.length || s.theme_notes.some((t) => t.includes('向かい風')) ? `<h2>注意すること</h2><ul class="pts bad">${[...s.cautions, ...s.theme_notes.filter((t) => t.includes('向かい風'))].map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <h2>指標</h2>
    <div class="kv num">
      <div>RSI(14)<b>${s.rsi.toFixed(1)}</b></div>
      <div>25日線乖離<b class="${cls(s.dev25)}">${sgn(s.dev25, 1)}</b></div>
      <div>出来高(20日比)<b>${s.vol_ratio.toFixed(2)}倍</b></div>
      <div>5日の騰落<b class="${cls(s.ret5)}">${sgn(s.ret5, 1)}</b></div>
      <div>20日の騰落<b class="${cls(s.ret20)}">${sgn(s.ret20, 1)}</b></div>
      <div>52週高値まで<b>${sgn(s.hi52_gap, 1)}</b></div>
      <div>1日の値幅(ATR)<b>${s.atr_pct.toFixed(1)}%</b></div>
      <div>売買代金/日<b>${s.turnover_oku.toFixed(0)}億円</b></div>
      <div>型<b style="font-size:13px">${esc(s.setup_label)}</b></div>
    </div>
    <h2>関連ニュース</h2>
    <div class="newslist">${news.map(newsItem).join('') || '<div class="card empty">直近の関連ニュースは見つかりませんでした</div>'}</div>
    <h2>外部で確認</h2>
    <div class="links">
      <a href="https://finance.yahoo.co.jp/quote/${s.code}.T" target="_blank" rel="noopener">Yahoo!ファイナンス</a>
      <a href="https://kabutan.jp/stock/?code=${s.code}" target="_blank" rel="noopener">株探</a>
      <a href="https://www.google.com/search?q=${encodeURIComponent(s.name + ' 決算発表日')}" target="_blank" rel="noopener">決算発表日を調べる</a>
    </div>
    <p class="note">目安は終値と値動きの大きさから機械的に出したものです。翌日の寄り付きで大きく離れた場合は計画を見直してください。</p>`;
  if (keepScroll) sheet.scrollTop = y; else sheet.scrollTop = 0;
  const charts = await loadCharts();
  if (S.open === code) drawChart($('#chart'), charts[code], s);
}

function closeStock() {
  S.open = null;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---- チャート（ローソク足＋移動平均＋出来高） -------------------------------------
function drawChart(cv, ch, s) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const up = col('--up'), down = col('--down'), muted = col('--muted'), line = col('--line');
  if (!ch || !ch.c || !ch.c.length) {
    g.fillStyle = muted; g.font = '13px sans-serif'; g.textAlign = 'center';
    g.fillText('チャートのデータがありません', W / 2, H / 2);
    return;
  }
  const n = Math.min(ch.c.length, Math.max(40, Math.floor(W / 4.2)));
  const k0 = ch.c.length - n;
  const sl = (a) => a.slice(k0);
  const o = sl(ch.o), h = sl(ch.h), l = sl(ch.l), c = sl(ch.c), v = sl(ch.v), m25 = sl(ch.ma25), m75 = sl(ch.ma75), d = sl(ch.d);
  const padR = 52, padB = 18, volH = 44;
  const padT = 10, pw = W - padR, ph = H - padB - volH - 6;
  const vals = [...h, ...l, s.target, s.stop, ...(s.support ? [s.support[0]] : []), ...m25.filter((x) => x != null), ...m75.filter((x) => x != null)];
  let mx = Math.max(...vals), mn = Math.min(...vals);
  const pad = (mx - mn) * 0.05; mx += pad; mn -= pad;
  const Y = (p) => ph - ((p - mn) / (mx - mn)) * (ph - padT);
  const bw = pw / n, X = (i) => i * bw + bw / 2;

  // 目盛り
  g.strokeStyle = line; g.fillStyle = muted; g.font = '10px sans-serif'; g.lineWidth = 1; g.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const p = mn + ((mx - mn) * i) / 4, y = Y(p);
    g.beginPath(); g.moveTo(0, y); g.lineTo(pw, y); g.stroke();
    if (Math.abs(y - Y(s.target)) > 14 && Math.abs(y - Y(s.stop)) > 14) g.fillText(yen(p), pw + 4, y + 3);
  }
  g.textAlign = 'center';
  for (let i = Math.ceil(n / 8); i < n - 6; i += Math.ceil(n / 4)) {
    const s6 = String(d[i]);
    g.fillText(`${+s6.slice(2, 4)}/${+s6.slice(4, 6)}`, X(i), H - 4);
  }
  // 出来高
  const vmx = Math.max(...v) || 1;
  for (let i = 0; i < n; i++) {
    const vh = (v[i] / vmx) * volH;
    g.fillStyle = (c[i] >= o[i] ? up : down) + '66';
    g.fillRect(X(i) - bw * 0.35, ph + 6 + volH - vh, bw * 0.7, vh);
  }
  // ローソク
  for (let i = 0; i < n; i++) {
    const cc = c[i] >= o[i] ? up : down;
    g.strokeStyle = cc; g.fillStyle = cc;
    g.beginPath(); g.moveTo(X(i), Y(h[i])); g.lineTo(X(i), Y(l[i])); g.stroke();
    const y1 = Y(Math.max(o[i], c[i])), y2 = Y(Math.min(o[i], c[i]));
    g.fillRect(X(i) - bw * 0.35, y1, bw * 0.7, Math.max(1, y2 - y1));
  }
  // 移動平均
  const ma = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
    let st = false;
    arr.forEach((p, i) => { if (p == null) return; if (!st) { g.moveTo(X(i), Y(p)); st = true; } else g.lineTo(X(i), Y(p)); });
    g.stroke();
  };
  ma(m25, '#f0a020'); ma(m75, '#8a63d2');
  // 目安の線
  const hl = (p, color, label) => {
    g.setLineDash([4, 3]); g.strokeStyle = color; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, Y(p)); g.lineTo(pw, Y(p)); g.stroke(); g.setLineDash([]);
    g.fillStyle = color; g.fillRect(pw, Y(p) - 7, padR, 14);
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = 'bold 10px sans-serif'; g.fillText(label + ' ' + yen(p), pw + 2, Y(p) + 3.5);
  };
  const vis = (p) => p != null && p > mn && p < mx;
  if (s.support && vis(s.support[0])) hl(s.support[0], '#2bb0a0', '支');
  if (s.resistance && vis(s.resistance[0])) hl(s.resistance[0], '#c060a0', '抵');
  hl(s.target, up, '利'); hl(s.stop, down, '損');
}

// ---- 操作 -------------------------------------------------------------------
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + t; });
  window.scrollTo(0, 0);
}

let rwT;
function renderWatchSoon() { clearTimeout(rwT); rwT = setTimeout(() => { if (document.activeElement && document.activeElement.id === 'riskPct') return; renderWatch(); }, 800); }

function exportCsv() {
  const head = ['ルール', '銘柄コード', '銘柄', '買った日', '買値', '株数', '損切り（最初）', '利確', '売った日', '売値', '損益（円）', '損益（%）', 'ルールを守れた', 'メモ'];
  const rows = [...S.journal].sort((a, b) => (a.sellDate < b.sellDate ? -1 : 1)).map((t) => [MODE_LABEL[t.mode || 'strict'], t.code, t.name, t.buyDate, t.price, t.shares, t.stop, t.target,
    t.sellDate, t.sellPrice, Math.round(t.pl), t.ret.toFixed(2), t.kept ? '守った' : '破った', t.memo || '']);
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv' });  // Excel で文字化けしないよう BOM をつける
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `取引記録_${localDate()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function applyColor() { document.documentElement.classList.toggle('green-up', S.greenUp); }

document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return setTab(tab.dataset.tab);
  if (e.target.closest('#btnUpdate')) return startUpdate();
  if (e.target.closest('#btnUpdateLink')) return startWaiting();  // リンクはそのまま GitHub を開く
  if (e.target.closest('#updCancel')) { e.preventDefault(); clearTimeout(pollT); UPD.set(null); renderUpd(); return; }
  if (e.target.closest('#ghSave')) {
    const repo = $('#ghRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    const tok = $('#ghToken').value.trim();
    if (repo) store.set('ghRepo', repo);
    if (tok) store.set('ghToken', tok);
    renderWatch();
    toast(tok ? '保存しました。「つながるか確かめる」を押してください' : '保存しました');
    return;
  }
  if (e.target.closest('#ghTest')) return testToken();
  if (e.target.closest('#ghDel')) { if (confirm('合い言葉を消しますか？')) { store.set('ghToken', ''); renderWatch(); toast('消しました'); } return; }
  const md = e.target.closest('[data-mode]');
  if (md) return setMode(md.dataset.mode);
  const go = e.target.closest('[data-tab-go]');
  if (go) return setTab(go.dataset.tabGo);
  const tf = e.target.closest('[data-tf]');
  if (tf) { S.trackFilter = tf.dataset.tf; S.trackAll = false; return renderTrack(); }
  if (e.target.closest('#trackMore')) { S.trackAll = true; return renderTrack(); }
  if (e.target.closest('#btnBought')) {
    const f = $('#buyForm'); f.hidden = !f.hidden;
    if (!f.hidden) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (e.target.closest('#btnSavePos')) {
    const s = S.byCode[S.open];
    const p = { id: Date.now().toString(36), code: s.code, name: s.name, price: +$('#bPrice').value, shares: +$('#bShares').value,
      stop: +$('#bStop').value, target: +$('#bTarget').value, date: $('#bDate').value || localDate() };
    if (!(p.price > 0 && p.shares > 0)) return toast('買値と株数を入れてください');
    if (!(p.stop > 0 && p.target > 0) || p.stop >= p.price || p.target <= p.price) return toast('ルール：損切りと利確の値段を決めてから買う');
    const warns = [];
    const rest = restUntil();
    if (rest) warns.push(`3連敗中で ${fmtDate(rest)} まで休む期間です`);
    if (!s.rule_ok) warns.push(`この銘柄は${MODE_LABEL[S.mode]}のルールに合っていません（` + s.checks.filter((c) => c.ok === false && c.req !== false).map((c) => c.label).join('・') + '）');
    const rr = (p.target - p.price) / (p.price - p.stop);
    const minRr = isLoose() ? 1.5 : 2;
    if (rr < minRr - 1e-9) warns.push(`利確幅が損切り幅の ${rr.toFixed(1)} 倍しかありません（${MODE_LABEL[S.mode]}のルールは${minRr}倍以上）`);
    const lossPct = (p.price - p.stop) * p.shares / (S.capital || 1) * 100;
    if (lossPct > 2) warns.push(`損切りになると資金の ${lossPct.toFixed(1)}% の損です（ルールは1〜2%まで）`);
    if (warns.length && !confirm('ルールに合っていません。\n\n・' + warns.join('\n・') + '\n\nそれでも記録しますか？（「破った」取引として記録されます）')) return;
    p.ruleOkAtBuy = !warns.length;
    p.mode = S.mode;
    p.initStop = p.stop;
    S.positions.push(p); savePositions();
    $('#buyForm').hidden = true;
    toast('保有に追加しました（「保有」タブ）');
    renderWatch(); renderHome();
    return;
  }
  const raise = e.target.closest('[data-pos-raise]');
  if (raise) {
    const p = S.positions.find((x) => x.id === raise.dataset.posRaise);
    const v = +raise.dataset.v;
    if (p && v > p.stop) { p.stop = v; savePositions(); renderWatch(); renderHome(); toast(`損切りを ${yen(v)} 円に上げました`); }
    return;
  }
  const sell = e.target.closest('[data-pos-sell]');
  if (sell) { const f = document.querySelector(`[data-sellform="${sell.dataset.posSell}"]`); f.hidden = !f.hidden; return; }
  const kept = e.target.closest('[data-sf-kept]');
  if (kept) {
    kept.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === kept));
    return;
  }
  const sfs = e.target.closest('[data-sf-save]');
  if (sfs) {
    const p = S.positions.find((x) => x.id === sfs.dataset.sfSave);
    const f = document.querySelector(`[data-sellform="${p.id}"]`);
    const sp = +f.querySelector('[data-sf=price]').value;
    const k = f.querySelector('[data-sf-kept].on');
    if (!(sp > 0)) return toast('売値を入れてください');
    if (!k) return toast('ルールを守れたかを選んでください（ルール：必ず書く）');
    const t = { id: p.id, code: p.code, name: p.name, buyDate: p.date, sellDate: f.querySelector('[data-sf=date]').value || localDate(),
      price: p.price, sellPrice: sp, shares: p.shares, stop: p.initStop || p.stop, target: p.target,
      pl: (sp - p.price) * p.shares, ret: (sp / p.price - 1) * 100, kept: k.dataset.sfKept === '1', mode: p.mode || 'strict',
      memo: f.querySelector('[data-sf=memo]').value.trim() };
    S.journal.push(t); saveJournal();
    S.positions = S.positions.filter((x) => x !== p); savePositions();
    renderWatch(); renderHome();
    toast(t.pl >= 0 ? '記録しました' : (t.kept ? '記録しました。ルールどおりの損切りは経費です' : '記録しました'));
    return;
  }
  const jd = e.target.closest('[data-j-del]');
  if (jd) {
    if (confirm('この取引記録を消しますか？')) { S.journal = S.journal.filter((t) => t.id !== jd.dataset.jDel); saveJournal(); renderWatch(); renderHome(); }
    return;
  }
  if (e.target.closest('#journalMore')) { S.journalAll = true; return renderWatch(); }
  if (e.target.closest('#journalCsv')) return exportCsv();
  if (e.target.closest('#copyOrder')) {
    const s = S.byCode[S.open];
    const txt = `${s.name}（${s.code}）IFDOCO\n買い指値 ${s.limit || s.entry}円\n利確指値 ${s.target}円\n損切り逆指値 ${s.stop}円`;
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast('コピーしました'), () => toast(txt));
    return;
  }
  const del = e.target.closest('[data-pos-del]');
  if (del) {
    const p = S.positions.find((x) => x.id === del.dataset.posDel);
    if (p && confirm(`${p.name} を保有から外しますか？`)) {
      S.positions = S.positions.filter((x) => x !== p); savePositions(); renderWatch(); renderHome();
    }
    return;
  }
  const code = e.target.closest('[data-code]');
  if (code) { e.preventDefault(); return openStock(code.dataset.code); }
  const st = e.target.closest('[data-setup]');
  if (st) { S.stockFilter = st.dataset.setup; store.set('stockFilter', S.stockFilter); return renderStocks(); }
  const nf = e.target.closest('[data-nf]');
  if (nf) { S.newsFilter = nf.dataset.nf; return renderNews(); }
  const colr = e.target.closest('[data-color]');
  if (colr) {
    S.greenUp = colr.dataset.color === 'green'; store.set('greenUp', S.greenUp); applyColor(); renderWatch();
    if (S.data) { renderHome(); renderStocks(); }
  }
});

document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'q') { S.query = e.target.value.trim(); renderStocks(); }
  if (id === 'capital' || id === 'cCap') { S.capital = Math.max(0, +e.target.value || 0); store.set('capital', S.capital); }
  if (id === 'riskPct' || id === 'cRisk') { S.riskPct = Math.max(0, +e.target.value || 0); store.set('riskPct', S.riskPct); }
  if ((id === 'cCap' || id === 'cRisk') && S.open) $('#cRes').innerHTML = calcHtml(S.byCode[S.open]);
  if (id === 'bShares' && S.open) {
    const r = sharesFor(S.byCode[S.open]);
    const w = $('#bWarn');
    if (w) { w.hidden = !(r && +e.target.value > r.n); w.textContent = `ルール：負けを取り返そうと株数を増やさない（計算では ${r ? r.n : 0} 株まで）`; }
  }
  if (id === 'riskPct') renderWatchSoon();
});

document.addEventListener('change', (e) => {
  const ps = e.target.dataset.posStop, pt = e.target.dataset.posTarget;
  if (ps || pt) {
    const p = S.positions.find((x) => x.id === (ps || pt));
    const v = +e.target.value;
    if (p && ps && v < p.stop) {
      toast('ルール：損切りラインは絶対に下げない');
      e.target.value = p.stop;
      return;
    }
    if (p && v > 0) { p[ps ? 'stop' : 'target'] = v; savePositions(); renderWatch(); renderHome(); }
    return;
  }
  if (e.target.id === 'riskPct') renderWatch();
  if (e.target.id === 'sector') { S.sector = e.target.value; renderStocks(); }
  if (e.target.id === 'sort') { S.sort = e.target.value; store.set('sort', S.sort); renderStocks(); }
});

$('#btnReload').addEventListener('click', () => load(true));
$('#sheetBack').addEventListener('click', () => (history.state && history.state.code ? history.back() : closeStock()));
$('#sheetStar').addEventListener('click', () => {
  const c = S.open;
  if (!c) return;
  if (S.watch.has(c)) { S.watch.delete(c); toast('ウォッチから外しました'); } else { S.watch.add(c); toast('ウォッチに追加しました'); }
  store.set('watch', [...S.watch]);
  $('#sheetStar').classList.toggle('on', S.watch.has(c));
  renderWatch();
});
window.addEventListener('popstate', () => {
  const c = location.hash.slice(1);
  if (c && S.byCode && S.byCode[c]) openStock(c, true); else closeStock();
});
let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { if (S.open && S.charts) drawChart($('#chart'), S.charts[S.open], S.byCode[S.open]); }, 150);
});
document.addEventListener('visibilitychange', () => {
  // 開きっぱなしで日をまたいだら読み直す
  if (document.visibilityState === 'visible' && S.data && Date.now() - new Date(S.data.generated_at) > 6 * 36e5) load(false);
  if (document.visibilityState === 'visible') { renderUpd(); pollUpdate(); }
});

applyColor();
load(false).then(() => {
  pollUpdate();
  const c = location.hash.slice(1);
  if (c && S.byCode && S.byCode[c]) openStock(c, true);
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
