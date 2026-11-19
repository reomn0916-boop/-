// 電子の領収書（PDF）の取り込み: 文字がある PDF はその文字をそのまま読み、1 ページ目を画像にする
const BASE = (globalThis.KEIHI_PDF_BASE || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/');

let libP = null;
function lib() {
  if (!libP) {
    libP = import(`${BASE}build/pdf.min.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;
      return m;
    });
    libP.catch(() => { libP = null; });
  }
  return libP;
}

export const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

// ページの文字を行にまとめる（同じ高さの文字を左から順に）
function linesOf(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4]; const y = it.transform[5]; const h = Math.abs(it.transform[3]) || it.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < h * 0.5);
    if (!row) { row = { y, h, parts: [] }; rows.push(row); }
    row.parts.push({ x, s: it.str, w: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = ''; let end = null;
    for (const p of r.parts) {
      if (end != null && p.x - end > r.h * 0.6) out += ' ';
      out += p.s; end = p.x + p.w;
    }
    return out;
  }).join('\n');
}

export async function readPdf(file) {
  const pdfjs = await lib().catch(() => { throw new Error('PDF を読む部品を取得できませんでした（はじめてはネット接続が必要です）'); });
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${BASE}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    wasmUrl: `${BASE}wasm/`,
  });
  const doc = await task.promise;
  try {
    let text = '';
    const n = Math.min(doc.numPages, 3);
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      text += `${linesOf((await p.getTextContent()).items)}\n`;
    }
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1600 / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp, canvas }).promise;
    return { canvas, text: text.trim(), pages: doc.numPages };
  } finally {
    task.destroy();
  }
}
