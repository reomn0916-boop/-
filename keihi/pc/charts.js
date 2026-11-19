// ダッシュボードのグラフ（SVG・HTML で描く。色は 1 色＝金額の大きさだけを表す）
import { esc, yen, yenShort, showTip, hideTip } from './ui.js';

function niceStep(max, n = 4) {
  if (max <= 0) return 1000;
  const raw = max / n; const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// 月ごとの縦棒。data: [{ key, label, value, count }]、current の月だけ濃い色と金額のラベル
export function columnChart(host, data, { current = '', onPick = null, height = 232 } = {}) {
  const W = Math.max(320, host.clientWidth); const H = height;
  const m = { l: 52, r: 12, t: 26, b: 30 };
  const pw = W - m.l - m.r; const ph = H - m.t - m.b;
  const max = Math.max(0, ...data.map((d) => d.value));
  const step = niceStep(max); const top = Math.max(step, Math.ceil(max / step) * step);
  const band = pw / data.length; const bw = Math.min(24, band * 0.56);
  const y = (v) => m.t + ph - (v / top) * ph;
  const ticks = []; for (let v = 0; v <= top + 1e-6; v += step) ticks.push(v);
  const bar = (x, v) => {
    const h = Math.max(0, (v / top) * ph); if (h < 0.5) return '';
    const r = Math.min(4, h, bw / 2); const yb = m.t + ph; const yt = yb - h;
    return `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${yb}Z`;
  };
  let s = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="月ごとの経費の合計">`;
  for (const v of ticks) s += `<line class="grid${v === 0 ? ' base' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${y(v) + 0.5}" y2="${y(v) + 0.5}"/><text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? '0' : yenShort(v)}</text>`;
  data.forEach((d, i) => {
    const cx = m.l + band * i + band / 2; const x = cx - bw / 2;
    const cur = d.key === current;
    s += `<g class="col${cur ? ' cur' : ''}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(d.label)} ${yen(d.value)}（${d.count}件）">
      <rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>
      <path class="bar" d="${bar(x, d.value)}"/>
      <text class="xl" x="${cx}" y="${H - 9}" text-anchor="middle">${esc(d.short || d.label)}</text>
      ${cur && d.value ? `<text class="vl" x="${cx}" y="${y(d.value) - 8}" text-anchor="middle">${yen(d.value)}</text>` : ''}
    </g>`;
  });
  s += '</svg>';
  host.innerHTML = s;
  const tipFor = (g, ev) => {
    const d = data[+g.dataset.i];
    const r = g.querySelector('.hit').getBoundingClientRect();
    const px = ev && ev.clientX != null ? ev.clientX : r.left + r.width / 2;
    const py = ev && ev.clientY != null ? ev.clientY : r.top + 20;
    showTip(`<b>${yen(d.value)}</b><span>${esc(d.label)}・${d.count}件</span>${onPick ? '<small>クリックで一覧を開く</small>' : ''}`, px, py);
  };
  host.querySelectorAll('.col').forEach((g) => {
    g.addEventListener('pointermove', (ev) => tipFor(g, ev));
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', () => tipFor(g));
    g.addEventListener('blur', hideTip);
    if (onPick) {
      g.addEventListener('click', () => { hideTip(); onPick(data[+g.dataset.i]); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); hideTip(); onPick(data[+g.dataset.i]); } });
    }
  });
}

// 横棒の一覧（科目別・現場別）。rows: [{ label, value, count }]
export function barList(host, rows, { onPick = null, empty = 'まだありません', limit = 8 } = {}) {
  if (!rows.length) { host.innerHTML = `<p class="chart-empty">${esc(empty)}</p>`; return; }
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  let list = rows;
  if (rows.length > limit) {
    const rest = rows.slice(limit - 1);
    list = [...rows.slice(0, limit - 1), { label: `ほか ${rest.length}件`, value: rest.reduce((s, r) => s + r.value, 0), count: rest.reduce((s, r) => s + r.count, 0), other: true }];
  }
  const max = Math.max(...list.map((r) => r.value)) || 1;
  host.innerHTML = `<ul class="bars">${list.map((r, i) => `
    <li class="${onPick && !r.other ? 'pick' : ''}" data-i="${i}" ${onPick && !r.other ? 'tabindex="0" role="button"' : ''} title="${esc(r.label)} ${yen(r.value)}（${r.count}件）">
      <span class="bl">${esc(r.label)}</span>
      <span class="bt"><i style="width:${Math.max(1.5, (r.value / max) * 100)}%"></i></span>
      <span class="bv">${yen(r.value)}</span>
      <span class="bp">${Math.round((r.value / total) * 100)}%</span>
    </li>`).join('')}</ul>`;
  if (onPick) {
    host.querySelectorAll('li.pick').forEach((li) => {
      const go = () => onPick(list[+li.dataset.i]);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    });
  }
}
