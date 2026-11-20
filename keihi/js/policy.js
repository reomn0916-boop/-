// 会社の経費ルール（総務が決めて、ファイルで社員に配る）とチェック（画面に依存しない）

export const POLICY_DEFAULT = {
  name: '',             // 例: 山田工業 経費規程 2026年版
  deadlineDay: 5,       // 毎月この日までに前の月の分を提出（0 = 決めない）
  requireMemo: true,    // 内容・目的を必ず書く
  requireSite: false,   // 現場・案件を必ず入れる
  requireImage: true,   // レシートの経費は画像が必要（電車・車の距離は除く）
  requireGuests: true,  // 会議費・接待交際費は人数と相手先が必要
  perHeadLimit: 0,      // 会議費・接待交際費の 1 人あたりの上限（0 = なし）
  maxAgeDays: 90,       // 何日より古い経費は出せない（0 = なし）
  limits: {},           // 科目ごとの 1 件の上限 { 消耗品費: 30000 }
  allowedCats: [],      // 使ってよい科目（空 = 制限なし）
  note: '',             // 社員へのお知らせ
};
export const asPolicy = (p) => (p ? { ...POLICY_DEFAULT, ...p, limits: { ...(p.limits || {}) }, allowedCats: [...(p.allowedCats || [])] } : null);

const days = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
const yen = (n) => `¥${Math.round(n || 0).toLocaleString('ja-JP')}`;

// 1 件の経費がルールに合っているか: [{ level: 'error' | 'warn', msg }]
export function policyIssues(e, policy, today = '') {
  const p = asPolicy(policy); if (!p || !e) return [];
  const out = [];
  const amt = e.amount || 0;
  const food = e.category === '会議費' || e.category === '接待交際費';
  if (p.requireMemo && !(e.memo || '').trim() && e.kind !== 'transit' && e.kind !== 'car') out.push({ level: 'error', msg: '内容・目的を書いてください（会社のルール）' });
  if (p.requireSite && !(e.site || '').trim()) out.push({ level: 'error', msg: '現場・案件を入れてください（会社のルール）' });
  if (p.requireImage && (e.kind || 'receipt') === 'receipt' && !e.imageId) out.push({ level: 'warn', msg: '領収書の画像がありません。領収書がないときは理由を内容に書いてください' });
  if (p.requireGuests && food && (!e.people || !(e.guests || '').trim())) out.push({ level: 'error', msg: '飲食は人数と相手先を書いてください（会社のルール）' });
  if (p.perHeadLimit && food && e.people && amt / e.people > p.perHeadLimit) out.push({ level: 'warn', msg: `1 人あたり ${yen(amt / e.people)}。会社の上限 ${yen(p.perHeadLimit)} をこえています` });
  const lim = +p.limits[e.category] || 0;
  if (lim && amt > lim) out.push({ level: 'warn', msg: `${e.category}は 1 件 ${yen(lim)} までのルールです（${yen(amt)}）。事前に許可をもらった場合は内容に書いてください` });
  if (p.allowedCats.length && e.category && !p.allowedCats.includes(e.category)) out.push({ level: 'error', msg: `「${e.category}」は会社で使わない科目です` });
  if (p.maxAgeDays && today && e.date && days(e.date, today) > p.maxAgeDays) out.push({ level: 'warn', msg: `${p.maxAgeDays} 日より前の経費です。遅れた理由を内容に書いてください` });
  return out;
}

// 提出の締切: 毎月 deadlineDay 日までに、前の月までの分を出す
// 戻り値: { date: 'YYYY-MM-DD', daysLeft, month: 'YYYY-MM'（対象の月） } または null
export function deadlineInfo(policy, today) {
  const p = asPolicy(policy); if (!p || !p.deadlineDay || !today) return null;
  const [y, m, d] = today.split('-').map(Number);
  let dy = y; let dm = m;
  if (d > p.deadlineDay) { dm += 1; if (dm > 12) { dm = 1; dy += 1; } }
  const last = new Date(dy, dm, 0).getDate();
  const date = `${dy}-${String(dm).padStart(2, '0')}-${String(Math.min(p.deadlineDay, last)).padStart(2, '0')}`;
  const tm = dm === 1 ? `${dy - 1}-12` : `${dy}-${String(dm - 1).padStart(2, '0')}`;
  return { date, daysLeft: days(today, date), month: tm };
}

// 配るファイル
export function policyFile({ policy, categories, company, from }) {
  return { app: 'rakukeihi', kind: 'policy', at: Date.now(), from: from || '', company: company || '', categories: categories || [], policy: asPolicy(policy) };
}

// ルールを短い文の一覧に
export function ruleLines(pol) {
  const p = asPolicy(pol); if (!p) return [];
  const out = [];
  if (p.deadlineDay) out.push(`毎月 ${p.deadlineDay} 日までに前の月の分を提出`);
  if (p.requireMemo) out.push('内容・目的を必ず書く');
  if (p.requireSite) out.push('現場・案件を必ず入れる');
  if (p.requireImage) out.push('レシートの経費は画像を付ける');
  if (p.requireGuests) out.push('飲食は人数と相手先を書く');
  if (p.perHeadLimit) out.push(`飲食は 1 人 ${yen(p.perHeadLimit)} まで`);
  for (const [c, v] of Object.entries(p.limits)) if (+v) out.push(`${c}は 1 件 ${yen(v)} まで`);
  if (p.maxAgeDays) out.push(`${p.maxAgeDays} 日より前の経費は理由を書く`);
  if (p.allowedCats.length) out.push(`使える科目: ${p.allowedCats.join('・')}`);
  return out;
}
