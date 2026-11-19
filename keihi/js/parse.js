// レシート・領収書の文字（OCR の結果）から、日付・金額・支払先・登録番号・税率ごとの額・科目を読み取る。
// 画面や端末に依存しない関数だけを置く（Node でもテストできる）。

export const DEFAULT_CATEGORIES = [
  '旅費交通費', '車両費', '消耗品費', '会議費', '接待交際費', '通信費',
  '新聞図書費', '荷造運賃', '租税公課', '支払手数料', '福利厚生費', '雑費',
];

// 店名・キーワード → 表示名（null は店名にしない）と勘定科目。上ほど優先。
const BRANDS = [
  [/EN[E3][O0]{1,2}S|エネオス/i, 'ENEOS', '車両費'],
  [/出光|apollo\s*station|アポロステーション/i, '出光（apollostation）', '車両費'],
  [/コスモ石油|C[O0]SM[O0]\s*[O0]IL/i, 'コスモ石油', '車両費'],
  [/昭和シェル/, '昭和シェル', '車両費'],
  [/キグナス/, 'キグナス石油', '車両費'],
  [/宇佐美/, '宇佐美', '車両費'],
  [/オートバックス|AUTOBACS/i, 'オートバックス', '車両費'],
  [/イエローハット/, 'イエローハット', '車両費'],
  [/コメリ/, 'コメリ', '消耗品費'],
  [/カインズ|CAINZ/i, 'カインズ', '消耗品費'],
  [/コーナン/, 'コーナン', '消耗品費'],
  [/DCM|ケーヨーデイツー|ホーマック/, 'DCM', '消耗品費'],
  [/ビバホーム/, 'ビバホーム', '消耗品費'],
  [/ナフコ/, 'ナフコ', '消耗品費'],
  [/ジョイフル本田/, 'ジョイフル本田', '消耗品費'],
  [/ロイヤルホームセンター/, 'ロイヤルホームセンター', '消耗品費'],
  [/島忠/, '島忠', '消耗品費'],
  [/モノタロウ|MonotaRO/i, 'モノタロウ', '消耗品費'],
  [/ワークマン|WORKMAN/i, 'ワークマン', '消耗品費'],
  [/アスクル|ASKUL/i, 'アスクル', '消耗品費'],
  [/ダイソー|DAISO/i, 'ダイソー', '消耗品費'],
  [/セリア/, 'セリア', '消耗品費'],
  [/キャンドゥ/, 'キャンドゥ', '消耗品費'],
  [/ヨドバシ/, 'ヨドバシカメラ', '消耗品費'],
  [/ビックカメラ/, 'ビックカメラ', '消耗品費'],
  [/ヤマダ電機|ヤマダデンキ/, 'ヤマダデンキ', '消耗品費'],
  [/ケーズデンキ/, 'ケーズデンキ', '消耗品費'],
  [/エディオン/, 'エディオン', '消耗品費'],
  [/Amazon|アマゾン/i, 'Amazon', '消耗品費'],
  [/セブン.?イレブン|7.?ELEVEN/i, 'セブン-イレブン', '消耗品費'],
  [/ファミリーマート|FamilyMart/i, 'ファミリーマート', '消耗品費'],
  [/ローソン|LAWSON/i, 'ローソン', '消耗品費'],
  [/ミニストップ/, 'ミニストップ', '消耗品費'],
  [/デイリーヤマザキ/, 'デイリーヤマザキ', '消耗品費'],
  [/セイコーマート/, 'セイコーマート', '消耗品費'],
  [/スターバックス|STARBUCKS/i, 'スターバックス', '会議費'],
  [/ドトール/, 'ドトールコーヒー', '会議費'],
  [/タリーズ/, 'タリーズコーヒー', '会議費'],
  [/コメダ/, 'コメダ珈琲店', '会議費'],
  [/サンマルク/, 'サンマルクカフェ', '会議費'],
  [/タイムズ|Times/, 'タイムズ', '旅費交通費'],
  [/リパーク/, '三井のリパーク', '旅費交通費'],
  [/名鉄協商/, '名鉄協商パーキング', '旅費交通費'],
  [/NEXCO|ネクスコ/i, 'NEXCO', '旅費交通費'],
  [/首都高/, '首都高速道路', '旅費交通費'],
  [/東横イン|東横INN/i, '東横イン', '旅費交通費'],
  [/ルートイン/, 'ルートイン', '旅費交通費'],
  [/アパホテル|APA\s*HOTEL/i, 'アパホテル', '旅費交通費'],
  [/ドーミーイン/, 'ドーミーイン', '旅費交通費'],
  [/日本郵便|郵便局/, '日本郵便', '通信費'],
  [/ヤマト運輸|宅急便/, 'ヤマト運輸', '荷造運賃'],
  [/佐川急便/, '佐川急便', '荷造運賃'],
  [/紀伊[國国]屋/, '紀伊國屋書店', '新聞図書費'],
  [/丸善|ジュンク堂/, '丸善ジュンク堂書店', '新聞図書費'],
  [/TSUTAYA|蔦屋/i, 'TSUTAYA', '新聞図書費'],
  // ここからは科目だけを決めるキーワード
  [/ガソリン|レギュラー|ハイオク|軽油|給油|石油/, null, '車両費'],
  [/駐車|パーキング|コインP|PARKING/i, null, '旅費交通費'],
  [/高速道路|通行料|ETC/, null, '旅費交通費'],
  [/タクシー|TAXI|交通株式会社|自動車交通/i, null, '旅費交通費'],
  [/旅客鉄道|鉄道|乗車券|特急券|新幹線|運賃|きっぷ/, null, '旅費交通費'],
  [/ホテル|旅館|宿泊/, null, '旅費交通費'],
  [/切手|レターパック|はがき|郵便/, null, '通信費'],
  [/宅配便|ゆうパック|運輸|配送料|送料/, null, '荷造運賃'],
  [/収入印紙|印紙|証紙|手数料.*(市|区|町|役所)/, null, '租税公課'],
  [/振込手数料/, null, '支払手数料'],
  [/書店|ブックス|書籍|図書/, null, '新聞図書費'],
  [/居酒屋|酒場|焼肉|寿司|鮨|割烹|料亭|焼鳥|やきとり|ビール|生中/, null, '接待交際費'],
  [/カフェ|CAFE|珈琲|コーヒー|喫茶/i, null, '会議費'],
  [/ホームセンター|金物|資材|建材|作業服|軍手|テープ|電池/, null, '消耗品費'],
];

// 全角→半角・空白の整理をして行の配列にする
export function normalizeLines(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      let l = line.replace(/[\t　]/g, ' ');
      // OCR は日本語 1 文字ごとに空白を入れることがあるので詰める
      l = l.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1');
      // 「1, 234」「1 ,234」→「1,234」
      l = l.replace(/(\d)\s*([,.])\s*(?=\d{3}(?!\d))/g, '$1$2');
      // 「¥ 1,234」→「¥1,234」。\ や 半・羊（数字の前）は ¥ の読みまちがい
      l = l.replace(/[\\]/g, '¥').replace(/(^|[\s(])[半羊](?=\s*\d)/g, '$1¥').replace(/¥+/g, '¥').replace(/¥\s+(?=\d)/g, '¥');
      // 「合計 : 」などの記号
      l = l.replace(/\s*[:]\s*/g, ':');
      return l.replace(/\s{2,}/g, ' ').trim();
    })
    .filter(Boolean);
}

// 行の中の金額らしい数字を取り出す（日付・時刻・電話番号・数量などは除く）
export function amountsIn(line) {
  const out = [];
  const re = /(¥)?(\d[\d,.]*\d|\d)(\s*円|\s*[-ー―](?!\d))?/g;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[2];
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const yen = !!m[1] || !!m[3];
    // 小数（リットル・単価など）は金額ではない
    if (/\.\d{1,2}$/.test(raw) || /\.\d{1,2}\./.test(raw)) continue;
    if (/[,.]/.test(raw) && !/^\d{1,3}([,.]\d{3})+$/.test(raw)) continue;
    if (!yen) {
      if (/[/:]$/.test(before) || /^[/:]/.test(after)) continue; // 日付・時刻
      if (/^\s*(年|月|日|時|分|秒|%|個|点|枚|本|名|人|L|l|ℓ|km|kg|g|号|番|回|泊|台|件|才|歳|cm|mm|m\b)/.test(after)) continue;
      if (/-\d/.test(after.slice(0, 2)) || /\d-$/.test(before)) continue; // 電話番号
      if (/(No|NO|№|#|レジ|責|担当|取引|伝票|会員|TEL|Tel|電話|T)\s*\.?$/.test(before)) continue;
    }
    const value = parseInt(raw.replace(/[,.]/g, ''), 10);
    if (!Number.isFinite(value) || value <= 0 || value > 9999999) continue;
    out.push({ value, yen, index: m.index });
  }
  return out;
}

const EXCLUDE = /小計|対象|内税|外税|消費税|税額|税等|内訳|預り|預かり|お預|釣|おつり|ポイント|値引|割引|点数|数量|残高|単価|チャージ|ご利用可能|前回|今回付与|クーポン/;
const STRONG = /総合計|税込合計|合計|お買上げ?(合計|計|金額)|御買上(合計|計|金額)?|お会計|ご?請求(金)?額|領収金額|お?支払(い)?(金額|額|合計)|お支払い?計|ご利用(金)?額|利用金額|お買い?上げ?計|運賃|料金合計|駐車料金|TOTAL/i;
const WEAK = /金額|^計|^金|料金|代金/;

// 合計金額
export function findTotal(lines) {
  const cands = [];
  let deposit = null; let change = null;
  lines.forEach((line, i) => {
    if (/預り|預かり|お預/.test(line)) {
      const a = amountsIn(line).pop() || (lines[i + 1] && amountsIn(lines[i + 1]).pop());
      if (a) deposit = a.value;
    }
    if (/釣|おつり/.test(line)) {
      const a = amountsIn(line).pop() || (lines[i + 1] && amountsIn(lines[i + 1]).pop());
      if (a) change = a.value;
    }
    if (EXCLUDE.test(line)) return;
    let score = 0;
    if (STRONG.test(line)) score = 3;
    else if (WEAK.test(line)) score = 1;
    if (!score) return;
    let amts = amountsIn(line);
    if (!amts.length && lines[i + 1] && !EXCLUDE.test(lines[i + 1])) amts = amountsIn(lines[i + 1]);
    if (!amts.length) return;
    const a = amts.filter((x) => x.yen).pop() || amts[amts.length - 1];
    cands.push({ value: a.value, score: score + (a.yen ? 1 : 0), line: i });
  });
  if (deposit != null && change != null && deposit - change > 0) {
    const diff = deposit - change;
    const hit = cands.find((c) => c.value === diff);
    if (hit) hit.score += 2;
    else cands.push({ value: diff, score: 2.5, line: -1 });
  }
  if (cands.length) {
    cands.sort((a, b) => b.score - a.score || b.value - a.value);
    const best = cands[0];
    if (deposit != null && best.value > deposit && cands[1]) return { value: cands[1].value, sure: false };
    return { value: best.value, sure: best.score >= 3 };
  }
  // 見つからないときは ¥・円の付いた一番大きい金額
  let max = null;
  lines.forEach((line) => {
    if (EXCLUDE.test(line) || /TEL|電話|No\.|レジ/.test(line)) return;
    for (const a of amountsIn(line)) if (a.yen && (!max || a.value > max)) max = a.value;
  });
  return max ? { value: max, sure: false } : null;
}

function ymd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function toISODate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// 日付（西暦・令和・2桁年・月日だけ）
export function findDate(lines, today = new Date()) {
  const text = lines.join('\n');
  const max = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  const min = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  const ok = (s) => { if (!s) return false; const d = new Date(s + 'T00:00:00'); return d >= min && d <= max; };
  const found = [];
  const push = (s, prio, idx) => { if (ok(s)) found.push({ s, prio, idx }); };
  let m;
  const r1 = /(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/g;
  while ((m = r1.exec(text))) push(ymd(+m[1], +m[2], +m[3]), 0, m.index);
  const r2 = /(?:令和|R)\s*(元|\d{1,2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/g;
  while ((m = r2.exec(text))) push(ymd(2018 + (m[1] === '元' ? 1 : +m[1]), +m[2], +m[3]), 0, m.index);
  const r3 = /(?<![\d/.\-])(\d{2})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,2})(?![\d/.])/g;
  while ((m = r3.exec(text))) push(ymd(2000 + +m[1], +m[2], +m[3]), 1, m.index);
  const r4 = /(?<![\d/年.])(\d{1,2})\s*(?:月\s*(\d{1,2})\s*日|\/(\d{1,2})(?![\d/]))/g;
  while ((m = r4.exec(text))) {
    const mo = +m[1]; const d = +(m[2] || m[3]);
    let s = ymd(today.getFullYear(), mo, d);
    if (s && new Date(s + 'T00:00:00') > max) s = ymd(today.getFullYear() - 1, mo, d);
    push(s, 2, m.index);
  }
  if (!found.length) return null;
  found.sort((a, b) => a.prio - b.prio || a.idx - b.idx);
  return found[0].s;
}

// 適格請求書発行事業者の登録番号（T + 13 桁）
export function findInvoiceNo(lines) {
  const text = lines.join('\n');
  // 「登録番号」のあと: T は「「」「丁」「7」などに読みまちがえられやすい
  let m = text.match(/登録番号\s*:?\s*[^\d\s]?\s*-?\s*((?:\d[\s-]?){12,13}\d)(?!\d)/);
  if (m) {
    let d = m[1].replace(/\D/g, '');
    if (d.length === 14 && /^[17]/.test(d)) d = d.slice(1); // T を 7 や 1 と読んだ
    if (d.length === 13) return `T${d}`;
  }
  m = text.match(/(?<![A-Za-z0-9])T\s*-?\s*((?:\d[\s-]?){12}\d)(?!\d)/);
  if (m) return 'T' + m[1].replace(/\D/g, '');
  return '';
}

// 法人番号と同じ検査用数字（先頭 1 桁）で確かめる。読み取りまちがいの確認用
export function checkInvoiceNo(no) {
  const d = String(no || '').replace(/^T/i, '');
  if (!/^\d{13}$/.test(d)) return false;
  const body = d.slice(1);
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += +body[12 - n] * (n % 2 ? 1 : 2);
  return +d[0] === 9 - (sum % 9);
}

// 税率ごとの対象額（10% / 8%）
export function findTaxes(lines) {
  let tax10 = null; let tax8 = null;
  const pick = (i, keyRe) => {
    const line = lines[i];
    const k = line.search(keyRe);
    const rest = k >= 0 ? line.slice(k) : line;
    const amts = amountsIn(rest.replace(/\d+\s*%/g, ''));
    if (amts.length) return amts[0].value;
    const next = lines[i + 1] && amountsIn(lines[i + 1].replace(/\d+\s*%/g, ''));
    return next && next.length ? next[0].value : null;
  };
  lines.forEach((line, i) => {
    if (tax10 == null && /(10\s*%|標準税率).*(対象|計)/.test(line)) tax10 = pick(i, /10\s*%|標準/);
    if (tax8 == null && /((?<!\d)8\s*%|軽減税率).*(対象|計)/.test(line)) tax8 = pick(i, /(?<!\d)8\s*%|軽減/);
  });
  return { tax10, tax8 };
}

// 支払方法（現金・カード・電子マネー）
export function findPayment(lines) {
  const t = lines.join('\n');
  if (/Suica|PASMO|ICOCA|交通系|nanaco|WAON|Edy|QUICPay|iD(?![a-z])|PayPay|d払い|au\s*PAY|楽天ペイ|電子マネー|メルペイ|QR/i.test(t)) return '電子マネー';
  if (/クレジット|VISA|JCB|Master|AMEX|ダイナース|カード(?!会員)/i.test(t)) return 'カード';
  if (/現金|お預り|お預かり|預り/.test(t)) return '現金';
  return '';
}

// 支払先（店名）
export function findPayee(lines, learned = {}) {
  const text = withCompact(lines.join('\n'));
  for (const [re, name] of BRANDS) {
    if (name && re.test(text)) return { value: name, sure: true };
  }
  const skip = /領収|レシート|receipt|いらっしゃいませ|毎度|ありがとう|お買上|御買上|様|TEL|電話|FAX|〒|¥|円|合計|小計|\d{2,4}-\d{2,4}-\d{3,4}|登録番号|^[^\p{L}\p{N}]*$|^[\d\s¥,.:/\-年月日時分()]+$/iu;
  const corp = /(株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲)/;
  const shop = /(店|商店|ストア|SS|サービスステーション|薬局|ホテル|タクシー|食堂|商会|工業|建設|センター|堂|屋)$/;
  const head = lines.slice(0, 8);
  const corpLine = lines.find((l) => corp.test(l) && !/登録番号/.test(l));
  if (corpLine) return { value: corpLine.replace(/^[^\p{L}\p{N}(㈱㈲]+/u, '').slice(0, 40), sure: false };
  const shopLine = head.find((l) => shop.test(l) && !skip.test(l));
  if (shopLine) return { value: shopLine.slice(0, 40), sure: false };
  const first = head.find((l) => !skip.test(l) && /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}A-Za-z]{2,}/u.test(l) && l.length <= 30);
  return first ? { value: first, sure: false } : null;
}

// 科目の推定（学習した支払先 → 店名・キーワード）
export function guessCategory(payee, text, learned = {}, categories = DEFAULT_CATEGORIES) {
  const key = payeeKey(payee);
  if (key && learned.payeeCat && learned.payeeCat[key] && categories.includes(learned.payeeCat[key])) return learned.payeeCat[key];
  const src = withCompact(`${payee || ''}\n${text || ''}`);
  for (const [re, , cat] of BRANDS) if (re.test(src) && categories.includes(cat)) return cat;
  return '';
}

// 「E N E O S」のように 1 文字ずつ空いた行でも店名が見つかるよう、空白を除いた行も足す
function withCompact(text) {
  return `${text}\n${text.split('\n').map((l) => l.replace(/\s+/g, '')).join('\n')}`;
}

export function payeeKey(s) {
  return String(s || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲|\s/g, '').toLowerCase();
}

// 内容・目的のたたき台
export function findMemo(lines) {
  const t = lines.join('\n');
  const m = t.match(/但(?:し)?\s*:?\s*(.{1,30}?)\s*(?:代)?\s*として/);
  if (m) return m[1].replace(/代$/, '') + '代';
  if (/レギュラー|ハイオク|軽油|ガソリン|給油/.test(t)) return 'ガソリン代';
  if (/駐車|パーキング/.test(t)) return '駐車料金';
  if (/タクシー|TAXI/i.test(t)) return 'タクシー代';
  if (/高速|通行料/.test(t)) return '高速道路通行料';
  return '';
}

// まとめて読み取る
export function parseReceipt(raw, { today = new Date(), learned = {}, categories = DEFAULT_CATEGORIES } = {}) {
  const lines = normalizeLines(raw);
  const text = lines.join('\n');
  const total = findTotal(lines);
  const date = findDate(lines, today);
  const invoiceNo = findInvoiceNo(lines);
  let payee = findPayee(lines, learned);
  if (invoiceNo && learned.tnoPayee && learned.tnoPayee[invoiceNo]) payee = { value: learned.tnoPayee[invoiceNo], sure: true };
  const { tax10, tax8 } = findTaxes(lines);
  const category = guessCategory(payee && payee.value, text, learned, categories);
  return {
    date: date || '',
    amount: total ? total.value : null,
    payee: payee ? payee.value : '',
    invoiceNo,
    tax10, tax8,
    category,
    memo: findMemo(lines),
    liters: (() => { const m = text.match(/(\d{1,3}\.\d{1,2})\s*[Lℓl](?![a-z])/); return m && /レギュラー|ハイオク|軽油|給油|ガソリン|SS/.test(text) ? +m[1] : null; })(),
    payment: findPayment(lines),
    sure: { amount: !!(total && total.sure), date: !!date, payee: !!(payee && payee.sure) },
    text,
  };
}
