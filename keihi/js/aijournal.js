// 文章から仕訳を提案する（例:「軽トラを120万で買った、銀行から払った」）
// API キーがあれば Claude で、なければ決まった言い回しから推測する
import { toISODate } from './parse.js';

function amountOf(t) {
  const s = t.normalize('NFKC').replace(/,/g, '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*万\s*(\d+)?\s*(?:千)?/);
  if (m) return Math.round(+m[1] * 10000 + (m[2] ? +m[2] : 0));
  m = s.match(/(\d+(?:\.\d+)?)\s*千/); if (m) return Math.round(+m[1] * 1000);
  m = s.match(/[¥￥]?\s*(\d{2,})\s*円?/); return m ? +m[1] : null;
}
function dateOf(t, today) {
  const s = t.normalize('NFKC');
  if (/昨日/.test(s)) { const d = new Date(today); d.setDate(d.getDate() - 1); return toISODate(d); }
  if (/一昨日|おととい/.test(s)) { const d = new Date(today); d.setDate(d.getDate() - 2); return toISODate(d); }
  const m = s.match(/(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})日?/);
  if (m) return `${m[1] || today.getFullYear()}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return toISODate(today);
}

const PAY = [[/銀行|口座|振込|振り込|引き落|引落/, '普通預金'], [/現金|手渡し/, '現金'], [/カード/, '未払金'], [/個人|自腹|私の|プライベート/, '事業主借'], [/ローン|借りて/, '借入金'], [/後払い|月末払い|請求書/, '未払金']];
const RULES = [
  [/(軽トラ|トラック|車|バン|重機)(を|.*)(買|購入)/, (pay) => ['車両運搬具', pay]],
  [/(工具|機械|パソコン|PC|測量|発電機)(を|.*)(買|購入)/, (pay) => ['工具器具備品', pay]],
  [/借り(た|入れ)|借入|融資/, () => ['普通預金', '借入金']],
  [/返済|返した/, (pay) => ['借入金', pay]],
  [/生活費|引き出|私用|個人的/, (pay) => ['事業主貸', pay === '事業主借' ? '普通預金' : pay]],
  [/入金|振り込まれ|入った/, () => ['普通預金', '売掛金']],
  [/元入|資本金|入れた/, () => ['普通預金', '事業主借']],
  [/カード.*(引き落|引落)|(引き落|引落).*カード/, () => ['未払金', '普通預金']],
  [/外注|手間|応援|一人親方/, (pay) => ['外注費', pay]],
  [/家賃|地代|駐車場/, (pay) => ['地代家賃', pay]],
  [/保険/, (pay) => ['保険料', pay]],
  [/電気|ガス|水道/, (pay) => ['水道光熱費', pay]],
  [/減価償却/, () => ['減価償却費', '車両運搬具']],
  [/税金|印紙|固定資産税|自動車税/, (pay) => ['租税公課', pay]],
];

export function ruleJournal(text, today = new Date()) {
  const pay = (PAY.find(([re]) => re.test(text)) || [, '普通預金'])[1];
  const r = RULES.find(([re]) => re.test(text));
  if (!r) return null;
  const [debit, credit] = r[1](pay);
  return { date: dateOf(text, today), debit, credit, amount: amountOf(text), memo: text.slice(0, 40), engine: 'rule' };
}

export async function aiJournal(text, { apiKey, model = 'claude-opus-5-5', accounts, today = new Date() }) {
  const { default: Anthropic } = await import('../vendor/anthropic-sdk.mjs');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 60000, maxRetries: 2 });
  const schema = {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      debit: { type: 'string', enum: accounts }, credit: { type: 'string', enum: accounts },
      amount: { type: 'integer' }, memo: { type: 'string' }, note: { type: 'string', description: '注意点があれば短く（なければ空文字）' },
    },
    required: ['date', 'debit', 'credit', 'amount', 'memo', 'note'], additionalProperties: false,
  };
  const params = {
    model, max_tokens: 16000,
    system: '日本の小規模事業者の複式簿記の仕訳を 1 つ作ります。説明文から日付・借方科目・貸方科目・金額（円・税込）・摘要を決めます。科目は候補からだけ選びます。個人事業主の私用の支払いは事業主貸、個人のお金で払った事業の支払いは事業主借です。',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: `今日は ${toISODate(today)} です。次の取引の仕訳を作ってください。\n\n${text}` }],
  };
  if (!/haiku/.test(model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  const res = await client.beta.messages.create(params);
  if (res.stop_reason === 'refusal') throw new Error('AI が答えませんでした');
  const j = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { ...j, engine: 'ai' };
}
