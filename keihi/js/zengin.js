// 全銀協規定形式（総合振込）の振込データと、半角カナへの変換（画面に依存しない）
// 1 行 120 桁（半角）。ヘッダー(1) → データ(2) × 件数 → トレーラー(8) → エンド(9)。文字は半角の英数字・カナ（JIS）
// 実際に使う前に、取引銀行のネットバンキングで「全銀形式の取り込み」の条件（種別・改行の有無など）を確かめること

const FULL = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
const SMALL = { ァ: 'ｱ', ィ: 'ｲ', ゥ: 'ｳ', ェ: 'ｴ', ォ: 'ｵ', ッ: 'ﾂ', ャ: 'ﾔ', ュ: 'ﾕ', ョ: 'ﾖ', ヮ: 'ﾜ', ヵ: 'ｶ', ヶ: 'ｹ', ｧ: 'ｱ', ｨ: 'ｲ', ｩ: 'ｳ', ｪ: 'ｴ', ｫ: 'ｵ', ｯ: 'ﾂ', ｬ: 'ﾔ', ｭ: 'ﾕ', ｮ: 'ﾖ' };
const DAKU = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ'; const DAKU_BASE = 'カキクケコサシスセソタチツテトハヒフヘホ';
const HAN = 'パピプペポ'; const HAN_BASE = 'ハヒフヘホ';
const OK = /^[0-9A-Zｱ-ﾝﾞﾟ ()\-./,\\｢｣]*$/;

// 全角カナ・ひらがな・全角英数 → 振込データに使える半角カナ・英数（小さい字は大きく、ーは -）
export function toZenginKana(s) {
  let t = String(s || '').normalize('NFKC'); // 半角カナは全角カナに、全角英数は半角に
  t = t.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); // ひらがな → カタカナ
  t = t.toUpperCase().replace(/[ー－―‐]/g, '-').replace(/[　]/g, ' ').replace(/[・･]/g, '.').replace(/[（]/g, '(').replace(/[）]/g, ')');
  let out = '';
  for (const ch of t) {
    let i;
    if (SMALL[ch]) out += SMALL[ch];
    else if ((i = FULL.indexOf(ch)) >= 0) out += HALF[i];
    else if ((i = DAKU.indexOf(ch)) >= 0) out += `${HALF[FULL.indexOf(DAKU_BASE[i])]}ﾞ`;
    else if ((i = HAN.indexOf(ch)) >= 0) out += `${HALF[FULL.indexOf(HAN_BASE[i])]}ﾟ`;
    else if (ch === 'ヴ') out += 'ｳﾞ';
    else if (ch === 'ヰ') out += 'ｲ';
    else if (ch === 'ヱ') out += 'ｴ';
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
// 使えない文字（漢字など）
export const badKana = (s) => [...new Set([...String(s || '')].filter((c) => !OK.test(c)))];

const padR = (s, n) => { const t = [...String(s || '')]; return (t.length > n ? t.slice(0, n) : t).join('') + ' '.repeat(Math.max(0, n - t.length)); };
const padN = (v, n) => String(Math.max(0, Math.round(+v || 0))).padStart(n, '0').slice(-n);
const digits = (v, n) => String(v || '').replace(/\D/g, '').padStart(n, '0').slice(-n);

// 口座の入力チェック。戻り値: 問題の文（空なら OK）
export function checkAccount(a, { who = '' } = {}) {
  const out = [];
  const w = who ? `${who}: ` : '';
  if (!/^\d{4}$/.test(String(a.bankCode || ''))) out.push(`${w}銀行コード（4 けた）`);
  if (!/^\d{3}$/.test(String(a.branchCode || ''))) out.push(`${w}支店コード（3 けた）`);
  if (!/^\d{1,7}$/.test(String(a.number || ''))) out.push(`${w}口座番号（7 けたまで）`);
  if (!['1', '2', '4', '9'].includes(String(a.type || '1'))) out.push(`${w}預金の種類`);
  const holder = toZenginKana(a.holder || '');
  if (!holder) out.push(`${w}口座名義（カナ）`);
  else if (badKana(holder).length) out.push(`${w}口座名義に使えない文字（${badKana(holder).join('')}）`);
  return out;
}

// 総合振込のデータ（文字列。encodeSJIS で Shift_JIS にして保存する）
// sender: { code（委託者コード 10 けた）, name（委託者名カナ）, bankCode, bankName, branchCode, branchName, type, number }
// items: [{ bankCode, bankName, branchCode, branchName, type, number, holder, amount, custCode }]
export function zenginTransfer({ sender, date, items, kind = '21' }) {
  const mmdd = String(date || '').replace(/-/g, '').slice(4, 8);
  const lines = [];
  lines.push(['1', kind, '0', digits(sender.code, 10), padR(toZenginKana(sender.name), 40), mmdd, digits(sender.bankCode, 4), padR(toZenginKana(sender.bankName), 15), digits(sender.branchCode, 3), padR(toZenginKana(sender.branchName), 15), String(sender.type || '1'), digits(sender.number, 7), padR('', 17)].join(''));
  let total = 0;
  for (const it of items) {
    total += Math.round(it.amount);
    lines.push(['2', digits(it.bankCode, 4), padR(toZenginKana(it.bankName), 15), digits(it.branchCode, 3), padR(toZenginKana(it.branchName), 15), padR('', 4), String(it.type || '1'), digits(it.number, 7), padR(toZenginKana(it.holder), 30), padN(it.amount, 10), '0', padR(toZenginKana(it.custCode || ''), 10), padR('', 10), ' ', ' ', padR('', 7)].join(''));
  }
  lines.push(['8', padN(items.length, 6), padN(total, 12), padR('', 101)].join(''));
  lines.push(['9', padR('', 119)].join(''));
  return `${lines.join('\r\n')}\r\n`;
}
