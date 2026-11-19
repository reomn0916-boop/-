// 領収書の画像の準備と読み取り（端末内の OCR / Claude による高精度読み取り）
import { parseReceipt, toISODate, payeeKey } from './parse.js';
import { findPaper } from './crop.js';

// ---- 画像 ----------------------------------------------------------------

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) { /* 下で読み直す */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function canvasOf(src, maxSide) {
  const w0 = src.width; const h0 = src.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(c, type = 'image/jpeg', q = 0.82) {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), type, q));
}

// 背景が写り込んでいたら、紙の範囲で切り抜く（見つからなければそのまま）
function cropToPaper(src) {
  const small = canvasOf(src, 360);
  const g = small.getContext('2d');
  const d = g.getImageData(0, 0, small.width, small.height).data;
  const gray = new Uint8Array(small.width * small.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
  const r = findPaper(gray, small.width, small.height);
  if (!r) return null;
  const k = src.width / small.width;
  return { x: Math.round(r.x * k), y: Math.round(r.y * k), w: Math.round(r.w * k), h: Math.round(r.h * k) };
}

// 保存用（長辺 1800px）とサムネイル（長辺 320px）
export async function prepareImage(file) {
  const src = await decode(file);
  let base = src;
  const r = cropToPaper(src);
  if (r) {
    const c = document.createElement('canvas');
    c.width = Math.min(r.w, src.width - r.x); c.height = Math.min(r.h, src.height - r.y);
    c.getContext('2d').drawImage(src, r.x, r.y, c.width, c.height, 0, 0, c.width, c.height);
    base = c;
  }
  const big = canvasOf(base, 1800);
  const blob = await canvasToBlob(big, 'image/jpeg', 0.8);
  const thumb = await canvasToBlob(canvasOf(big, 320), 'image/jpeg', 0.7);
  if (src.close) src.close();
  return { blob, thumb, width: big.width, height: big.height, cropped: !!r };
}

// 画像を 90° 単位で回す（横向きに撮った写真を直す）
export async function rotateBlob(blob, deg = 90) {
  const src = await decode(blob);
  const d = ((deg % 360) + 360) % 360;
  const c = document.createElement('canvas');
  const swap = d === 90 || d === 270;
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate((d * Math.PI) / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  if (src.close) src.close();
  const out = await canvasToBlob(c, 'image/jpeg', 0.85);
  const thumb = await canvasToBlob(canvasOf(c, 320), 'image/jpeg', 0.7);
  return { blob: out, thumb, width: c.width, height: c.height };
}

// OCR 用: 白黒にして明るさを伸ばし、文字が小さすぎないよう大きさをそろえる
async function ocrCanvas(blob) {
  const src = await decode(blob);
  const long = Math.max(src.width, src.height); const short = Math.min(src.width, src.height);
  let k = Math.min(2400 / long, Math.max(1, 1100 / short));
  if (long * k > 3200) k = 3200 / long;
  const c = canvasOf(src, Math.round(long * k));
  if (src.close) src.close();
  const g = c.getContext('2d');
  const im = g.getImageData(0, 0, c.width, c.height);
  const d = im.data; const n = d.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = y; hist[y]++;
  }
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const span = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.putImageData(im, 0, 0);
  return c;
}

// ---- 端末内の OCR（Tesseract.js。初回だけ読み取り用のデータ約 3MB をダウンロード） ----

const OCR_PATHS = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn/4.0.0_best_int',
  ...(globalThis.KEIHI_OCR_PATHS || {}),
};

let workerP = null;
let progressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('読み取りの部品を取得できませんでした（はじめての読み取りはネット接続が必要です）'));
    document.head.appendChild(s);
  });
}

function getWorker() {
  if (!workerP) {
    workerP = (async () => {
      if (!globalThis.Tesseract) await loadScript(OCR_PATHS.script);
      const w = await globalThis.Tesseract.createWorker('jpn', 1, {
        workerPath: OCR_PATHS.workerPath,
        corePath: OCR_PATHS.corePath,
        langPath: OCR_PATHS.langPath,
        logger: (m) => { if (progressCb) progressCb(m); },
      });
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

export function ocrDevice(blob, onProgress) {
  return serial(async () => {
    progressCb = (m) => {
      if (!onProgress) return;
      if (m.status === 'recognizing text') onProgress(0.3 + 0.7 * (m.progress || 0), '文字を読んでいます');
      else onProgress(0.1 + 0.2 * (m.progress || 0), '準備しています');
    };
    try {
      onProgress && onProgress(0.05, '準備しています');
      const w = await getWorker();
      const c = await ocrCanvas(blob);
      const { data } = await w.recognize(c);
      return data.text || '';
    } finally { progressCb = null; }
  });
}

// ---- Claude で読み取る（設定で API キーを入れたとき） ----------------------------

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（いちばん正確・標準）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（速い・正確）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（とても安い・速い）' },
];

const SYSTEM = `あなたは日本の経費精算を手伝う読み取り係です。渡された画像（レシート・領収書・利用明細）から、精算に必要な項目を読み取って JSON で返します。
- date: 取引日（YYYY-MM-DD）。和暦は西暦に直す。年が書かれていなければ、今日の日付から見て直近の過去の年にする。読めなければ空文字。
- total: 実際に支払った税込の合計金額（円・整数）。小計・お預り・お釣り・ポイント・税額とまちがえない。読めなければ 0。
- payee: 支払先の店名・会社名（短く、支店名は付けてよい）。読めなければ空文字。
- invoice_no: 適格請求書発行事業者の登録番号（T と数字 13 桁、例 T1234567890123）。なければ空文字。
- tax10_base / tax8_base: 10% / 8%（軽減税率）の対象額（レシートの表記どおり、円）。なければ 0。
- category: 勘定科目の候補から 1 つ。
- memo: 何を買った・何に払ったかを 20 文字以内で（例「軍手・養生テープ」「ガソリン代」「駐車料金」）。
- payment: 支払方法（現金 / カード / 電子マネー・QR / 不明）。
- is_receipt: 画像がレシート・領収書・明細なら true。`;

let sdkP = null;
function loadSdk() {
  if (!sdkP) sdkP = import('../vendor/anthropic-sdk.mjs').then((m) => m.default);
  return sdkP;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export class AiError extends Error {
  constructor(message, { retryDevice = false } = {}) { super(message); this.retryDevice = retryDevice; }
}

export async function readWithClaude(blob, { apiKey, model, categories, today = new Date() }) {
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 2 });
  const src = await decode(blob);
  const small = await canvasToBlob(canvasOf(src, 1568), 'image/jpeg', 0.85);
  if (src.close) src.close();
  const schema = {
    type: 'object',
    properties: {
      is_receipt: { type: 'boolean' },
      date: { type: 'string', description: 'YYYY-MM-DD または空文字' },
      total: { type: 'integer', description: '税込合計（円）。不明なら 0' },
      payee: { type: 'string' },
      invoice_no: { type: 'string', description: 'T+13桁 または空文字' },
      tax10_base: { type: 'integer' },
      tax8_base: { type: 'integer' },
      category: { type: 'string', enum: categories },
      memo: { type: 'string' },
      payment: { type: 'string', enum: ['現金', 'カード', '電子マネー・QR', '不明'] },
    },
    required: ['is_receipt', 'date', 'total', 'payee', 'invoice_no', 'tax10_base', 'tax8_base', 'category', 'memo', 'payment'],
    additionalProperties: false,
  };
  const params = {
    model: model || 'claude-opus-5-5',
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(small) } },
        { type: 'text', text: `今日は ${toISODate(today)} です。この画像を読み取ってください。` },
      ],
    }],
  };
  // Opus / Sonnet は安全上の理由で断られたとき、サーバー側で別のモデルに切り替えて続ける
  if (!/haiku/.test(params.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res;
  try {
    res = await client.beta.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('API キーが正しくありません（設定を確認してください）', { retryDevice: true });
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('この API キーでは使えません（権限を確認してください）', { retryDevice: true });
    if (e instanceof Anthropic.NotFoundError) throw new AiError('選んだモデルが使えません（設定でモデルを変えてください）', { retryDevice: true });
    if (e instanceof Anthropic.RateLimitError) throw new AiError('AI が混み合っています', { retryDevice: true });
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`AI に送れませんでした: ${e.message}`, { retryDevice: true });
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('AI に接続できません（オフライン？）', { retryDevice: true });
    if (e instanceof Anthropic.APIError) throw new AiError(`AI の読み取りに失敗しました（${e.status || 'エラー'}）`, { retryDevice: true });
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AiError('AI がこの画像の読み取りを断りました', { retryDevice: true });
  if (res.stop_reason === 'max_tokens') throw new AiError('AI の返事が途中で切れました', { retryDevice: true });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new AiError('AI の返事を読めませんでした', { retryDevice: true }); }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(j.date || '') ? j.date : '';
  return {
    date,
    amount: j.total > 0 ? j.total : null,
    payee: (j.payee || '').trim(),
    invoiceNo: /^T\d{13}$/.test((j.invoice_no || '').replace(/[\s-]/g, '')) ? j.invoice_no.replace(/[\s-]/g, '') : '',
    tax10: j.tax10_base > 0 ? j.tax10_base : null,
    tax8: j.tax8_base > 0 ? j.tax8_base : null,
    category: categories.includes(j.category) ? j.category : '',
    memo: (j.memo || '').trim(),
    payment: j.payment === 'カード' ? 'カード' : j.payment === '電子マネー・QR' ? '電子マネー' : j.payment === '現金' ? '現金' : '',
    sure: { amount: j.total > 0, date: !!date, payee: !!j.payee },
    notReceipt: j.is_receipt === false,
    text: '',
  };
}

// ---- まとめ: 設定に合わせて読み取る ---------------------------------------------

export async function readReceipt(blob, { settings, learned, categories, onProgress, today = new Date() }) {
  if (settings.ocrMode === 'ai' && settings.apiKey) {
    onProgress && onProgress(0.3, 'AI が読んでいます');
    try {
      const f = await readWithClaude(blob, { apiKey: settings.apiKey, model: settings.aiModel, categories, today });
      // 学習した支払先・科目を優先（自分で直した内容を覚えている）
      if (f.invoiceNo && learned.tnoPayee && learned.tnoPayee[f.invoiceNo]) f.payee = learned.tnoPayee[f.invoiceNo];
      const k = payeeKey(f.payee);
      if (k && learned.payeeCat && categories.includes(learned.payeeCat[k])) f.category = learned.payeeCat[k];
      return { fields: f, engine: 'ai' };
    } catch (e) {
      if (!(e instanceof AiError) || !e.retryDevice) throw e;
      onProgress && onProgress(0.05, `${e.message}。端末内で読み取ります`);
      const text = await ocrDevice(blob, onProgress);
      return { fields: parseReceipt(text, { today, learned, categories }), engine: 'device', warning: `${e.message}。端末内で読み取りました` };
    }
  }
  const text = await ocrDevice(blob, onProgress);
  return { fields: parseReceipt(text, { today, learned, categories }), engine: 'device' };
}
