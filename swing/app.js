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
    S.byCode = Object.fromEntries(S.data.stocks.map((s) => [s.code, s]));
    S.newsById = Object.fromEntries(S.data.news.map((n) => [n.id, n]));
    renderAll();
    if (force) toast('最新のデータにしました');
  } catch (e) {
    $('#updated').textContent = 'データを読み込めませんでした';
    if (!S.data) $('#v-home').innerHTML = `<div class="empty">データ（data/latest.json）がまだありません。<br>README の手順で GitHub Actions を動かしてください。</div>`;
  } finally {
    $('#btnReload').classList.remove('spin');
  }
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
  return label.includes('追い風') ? 'rg-good' : label === '向かい風' ? 'rg-bad' : 'rg-mid';
}

function pickCard(s) {
  const why = s.reasons[0] || '';
  const bt = S.data.backtest && S.data.backtest.by_setup[s.setup];
  return `<button class="pick" data-code="${s.code}">
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
    ${why ? `<div class="why">${esc(why)}</div>` : ''}
    <div class="why small">翌日 <b class="num">${yen(s.chase)}</b> 円より高く寄ったら見送り${s.limit ? `・指値なら <b class="num">${yen(s.limit)}</b> 円` : ''}</div>
    ${bt && bt.n ? `<div class="why small">この型の過去2年：${btLine(bt)}</div>` : ''}
  </button>`;
}

function renderHome() {
  const d = S.data, rg = d.market.regime;
  const picks = d.picks.map((c) => S.byCode[c]).filter(Boolean);
  const topNews = [...d.news].filter((n) => n.codes.length || n.themes.length)
    .sort((a, b) => Math.abs(b.sentiment) * (b.codes.length ? 1.5 : 1) - Math.abs(a.sentiment) * (a.codes.length ? 1.5 : 1)).slice(0, 5);
  const alerts = S.positions.map((p) => ({ p, st: posStatus(p) })).filter((x) => x.st.alerts.length);
  const tr = d.track && d.track.stats;
  const secs = d.sectors || [];
  const secMax = Math.max(1, ...secs.map((x) => Math.abs(x.ret20)));
  const secRow = (x) => `<button class="secrow" data-code="${x.best}"><span class="sn">${esc(x.sector)}</span>
      <span class="sbar"><i class="${x.ret20 >= 0 ? 'p' : 'm'}" style="width:${Math.abs(x.ret20) / secMax * 50}%"></i></span>
      <span class="sv num ${cls(x.ret20)}">${sgn(x.ret20, 1)}</span></button>`;
  $('#v-home').innerHTML = `
    ${alerts.length ? `<h2>保有銘柄のお知らせ</h2><div class="picks">${alerts.map(({ p, st }) => `<button class="pick alert" data-tab-go="watch">
      <div class="l1"><span class="nm">${esc(p.name)}</span><span class="num ${cls(st.retPct)}">${sgn(st.retPct, 1)}</span></div>
      ${st.alerts.map((a) => `<div class="why ${a.level}">${esc(a.text)}</div>`).join('')}</button>`).join('')}</div>` : ''}
    <h2>相場の地合い</h2>
    <div class="card regime">
      <div class="badge ${regimeClass(rg.label)}"><small>買いには</small>${esc(rg.label)}</div>
      <div><p>${esc(rg.text)}</p><ul>${rg.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
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
    <h2>今日の注目銘柄<small>点数の高い順・${picks.length}銘柄${rg.min_score ? `・${rg.min_score}点以上` : ''}</small></h2>
    ${tr && tr.n ? `<button class="card trackmini" data-tab-go="track">これまでの注目銘柄の成績：${btLine(tr)}<span class="muted"> ›</span></button>` : ''}
    ${picks.length ? `<div class="picks">${picks.map(pickCard).join('')}</div>` : '<div class="card empty">条件に合う銘柄がありません。地合いが悪い日は見送りも選択肢です。</div>'}
    <h2>材料になりそうなニュース</h2>
    <div class="newslist">${topNews.map(newsItem).join('') || '<div class="card empty">ニュースはありません</div>'}</div>
    <p class="note">このアプリの点数・売買の目安は、株価の動きとニュースの見出しから機械的に計算したものです。売買をすすめるものではありません。決算発表日・権利日などはご自身で確認し、投資は自己責任で行ってください。</p>
  `;
}

const SETUPS = [['all', '全部'], ['pullback', '押し目'], ['breakout', '高値ブレイク'], ['rebound', '売られすぎ反発'], ['trend', '上昇トレンド'], ['none', '様子見']];
const SORTS = [['score', '点数'], ['chg_pct', '前日比'], ['ret20', '20日の騰落'], ['vol_ratio', '出来高の増え方'], ['rsi_low', 'RSI（低い順）'], ['news_score', 'ニュース']];

function stockRow(s) {
  return `<button class="row" data-code="${s.code}">
    <div class="main"><b>${esc(s.name)}</b><small>${s.code}・${esc(s.sector)}　<span class="chip setup-${s.setup}">${esc(s.setup_label)}</span></small></div>
    <div class="rt num"><b>${yen(s.close)}</b><span class="${cls(s.chg_pct)}">${sgn(s.chg_pct)}</span></div>
    <div class="sc num">${Math.round(s.score)}</div>
  </button>`;
}

function renderStocks() {
  const d = S.data;
  const sectors = [...new Set(d.stocks.map((s) => s.sector))].sort();
  let list = d.stocks.filter((s) => (S.stockFilter === 'all' || s.setup === S.stockFilter) && (S.sector === 'all' || s.sector === S.sector));
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
    <p class="note">${d.stocks.length} 銘柄を毎日チェックしています（対象は scripts/universe.json で変更できます）。</p>`;
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
  const d = S.data, tr = d.track || { stats: {}, rows: [] }, bt = d.backtest;
  const f = S.trackFilter;
  const rows = tr.rows.filter((r) => f === 'all' || (f === 'closed' && ['win', 'loss', 'timeout'].includes(r.status)) || (f === 'open' && r.status === 'open'));
  const sim = tr.rows.some((r) => r.src === 'sim');
  $('#v-track').innerHTML = `
    <h2>注目銘柄のその後<small>翌日の寄り付きで買い、目安どおり売ったとして計算</small></h2>
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
    <h2>ルールの検証<small>過去2年（${bt.period[0] || ''}〜）・全 ${S.data.stocks.length} 銘柄</small></h2>
    ${statGrid(bt.all)}
    <div class="card" style="margin-top:10px;font-size:13px">
      <table class="bt num"><tr><th>型</th><th>回数</th><th>勝率</th><th>平均</th><th>PF</th></tr>
      ${Object.entries(bt.by_setup).map(([k, st]) => `<tr><td>${SETUP_NAME[k]}</td><td>${st.n}</td><td>${pctf(st.win_rate)}</td><td class="${cls(st.avg_ret)}">${sgn(st.avg_ret, 2)}</td><td>${st.pf ?? '—'}</td></tr>`).join('')}
      ${(bt.by_score || []).map((st) => `<tr class="sub"><td>${st.label}</td><td>${st.n}</td><td>${pctf(st.win_rate)}</td><td class="${cls(st.avg_ret)}">${sgn(st.avg_ret, 2)}</td><td>${st.pf ?? '—'}</td></tr>`).join('')}
      </table>
      <p class="muted" style="margin:8px 0 0">比べるもの：いつ買っても ${bt.hold_days} 日持った場合の平均は <b class="${cls(bt.baseline_avg_ret)}">${sgn(bt.baseline_avg_ret, 2)}</b>。これを上回っていればルールに意味がある目安です。PF（プロフィットファクター）は「勝ちの合計 ÷ 負けの合計」で、1 を超えるとプラス。</p>
    </div>` : ''}
    <p class="note">検証はニュースを使わずテクニカルの点数だけで行い、手数料・税金は含みません。同じ日に損切りと利確の両方に届いたときは損切りとして数えています（厳しめ）。過去の成績は将来を約束しません。</p>`;
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
    else if (p.stop < p.price && now - p.price >= p.price - p.stop) alerts.push({ level: 'info', text: `損切り幅と同じだけ上がりました。損切りを買値 ${yen(p.price)} 円に上げると負けがなくなります` });
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
    ${st.alerts.map((a) => `<div class="why ${a.level}">${esc(a.text)}</div>`).join('')}
    <div class="pos-acts">
      <label>損切り<input type="number" inputmode="decimal" data-pos-stop="${p.id}" value="${p.stop}"></label>
      <label>利確<input type="number" inputmode="decimal" data-pos-target="${p.id}" value="${p.target}"></label>
      <button class="btn-sm" data-pos-del="${p.id}">売った・削除</button>
    </div>
  </div>`;
}

function renderWatch() {
  const list = [...S.watch].map((c) => S.byCode[c]).filter(Boolean).sort((a, b) => b.score - a.score);
  const tot = S.positions.reduce((a, p) => a + posStatus(p).pl, 0);
  $('#v-watch').innerHTML = `
    <h2>保有銘柄${S.positions.length ? `<small class="num ${cls(tot)}">合計 ${tot >= 0 ? '+' : '−'}${yen(Math.abs(Math.round(tot)))}円</small>` : ''}</h2>
    ${S.positions.length ? `<div class="picks">${S.positions.map(posCard).join('')}</div>` : '<div class="card empty">銘柄の画面の「買った」から登録すると、損切り・利確・売りのサインをお知らせします。</div>'}
    <h2>ウォッチ銘柄</h2>
    ${list.length ? `<div class="list">${list.map(stockRow).join('')}</div>` : '<div class="card empty">銘柄の画面の ☆ を押すと、ここに並びます。</div>'}
    <h2>設定</h2>
    <div class="card settings">
      <label class="field">投資に使う資金（円）<input id="capital" type="number" inputmode="numeric" min="0" step="10000" value="${S.capital}"></label>
      <label class="field">1回の取引で許せる損失（資金の %）<input id="riskPct" type="number" inputmode="decimal" min="0.1" max="10" step="0.1" value="${S.riskPct}"></label>
      <div class="field">上がったときの色
        <div class="seg"><button data-color="red" class="${S.greenUp ? '' : 'on'}">赤</button><button data-color="green" class="${S.greenUp ? 'on' : ''}">緑</button></div>
      </div>
      <p class="muted" style="font-size:12px;margin:0">資金と損失の割合から、銘柄の画面で「買える株数」を計算します（100株単位）。</p>
    </div>
    <h2>点数のつけ方</h2>
    <div class="card" style="font-size:13px">
      <p style="margin-top:0">50点を基準に、次の条件で足し引きします（0〜100点）。型（押し目・高値ブレイク・売られすぎ反発）に当てはまり、点数が基準以上の銘柄を「注目銘柄」に出します。基準は地合いで変わります（追い風 60点・10銘柄／中立 63点・8銘柄／向かい風 68点・5銘柄）。</p>
      <ul style="padding-left:18px;margin:0">
        <li><b>押し目</b>：25日線・75日線が上向きの上昇トレンド中に、25日線付近まで下げた（RSI 35〜58）</li>
        <li><b>高値ブレイク</b>：20日高値を出来高 1.3 倍以上で上抜けた</li>
        <li><b>売られすぎ反発</b>：RSI 32 未満・25日線から −7% 以上離れたところで陽線（逆張り・高リスク）</li>
        <li>加点：MACD の上抜け、日経平均より強い動き、プラスの材料ニュース、追い風テーマの業種</li>
        <li>減点：下降トレンド、RSI 75 超の過熱、25日線から +12% 超、売買代金が少ない、マイナスの材料</li>
        <li>損切りは値動きの大きさ（ATR）から、利確は損切り幅の 2 倍を目安にしています</li>
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
    <div class="chartbox"><canvas id="chart"></canvas>
      <div class="legend"><span><i style="background:#f0a020"></i>25日線</span><span><i style="background:#8a63d2"></i>75日線</span>
      <span><i style="background:var(--up)"></i>利確目安</span><span><i style="background:var(--down)"></i>損切り</span></div></div>
    <h2>売買の目安<small>リスク:リワード 1:${s.rr}</small></h2>
    <div class="planbig num">
      <div>買い目安<b>${yen(s.entry)}</b><span class="muted">終値基準</span></div>
      <div class="tg">利確目安<b>${yen(s.target)}</b><span>${pctTo(s.target)}</span></div>
      <div class="st">損切り<b>${yen(s.stop)}</b><span>${pctTo(s.stop)}</span></div>
    </div>
    <div class="card orderhint">
      <div>翌日 <b class="num">${yen(s.chase)}</b> 円より<b>高く寄ったら見送り</b>（損切りまでが遠くなり割に合わない）</div>
      ${s.limit ? `<div>押し目を待つなら <b class="num">${yen(s.limit)}</b> 円に指値</div>` : ''}
    </div>
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
  const vals = [...h, ...l, s.target, s.stop, ...m25.filter((x) => x != null), ...m75.filter((x) => x != null)];
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
  hl(s.target, up, '利'); hl(s.stop, down, '損');
}

// ---- 操作 -------------------------------------------------------------------
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + t; });
  window.scrollTo(0, 0);
}

function applyColor() { document.documentElement.classList.toggle('green-up', S.greenUp); }

document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return setTab(tab.dataset.tab);
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
    S.positions.push(p); savePositions();
    $('#buyForm').hidden = true;
    toast('保有に追加しました（「保有」タブ）');
    renderWatch(); renderHome();
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
});

document.addEventListener('change', (e) => {
  const ps = e.target.dataset.posStop, pt = e.target.dataset.posTarget;
  if (ps || pt) {
    const p = S.positions.find((x) => x.id === (ps || pt));
    if (p && +e.target.value > 0) { p[ps ? 'stop' : 'target'] = +e.target.value; savePositions(); renderWatch(); renderHome(); }
    return;
  }
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
});

applyColor();
load(false).then(() => {
  const c = location.hash.slice(1);
  if (c && S.byCode && S.byCode[c]) openStock(c, true);
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
