// 固定資産の減価償却（定額法・少額減価償却資産・一括償却資産）と、外注費の源泉徴収（画面に依存しない）

// 定額法の償却率（耐用年数省令の値: 1000 分の 1 単位で切り上げ。3 年 → 0.334、6 年 → 0.167）
export const straightRate = (life) => Math.ceil(1000 / Math.max(1, life)) / 1000;

export const DEP_METHODS = {
  straight: '定額法',
  small: '少額減価償却資産（30万円未満を一度に経費）',
  lump3: '一括償却資産（20万円未満を3年で均等）',
};

// よく使う耐用年数（目安）
export const LIFE_HINTS = [
  ['軽トラック・バン（新車）', 4], ['普通自動車（新車）', 6], ['パソコン', 4], ['電動工具・測量機器', 5], ['足場・型枠', 3], ['建設用の重機', 6], ['エアコン・事務机', 6],
];

function fyEnds(fromISO, toISO, closeMonth) {
  // fromISO を含む期の期末から、toISO を含む期の期末までの期末日の一覧
  const out = [];
  const [y0, m0] = fromISO.split('-').map(Number);
  let y = m0 > closeMonth ? y0 + 1 : y0;
  const [ty, tm] = toISO.split('-').map(Number);
  const lastY = tm > closeMonth ? ty + 1 : ty;
  for (; y <= lastY; y++) {
    const d = new Date(y, closeMonth, 0);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// 1 つの資産の償却予定。[{ fyEnd, months, amount, bookOpen, bookClose }]
export function depreciationSchedule(asset, { closeMonth = 12, upto = '2100-12-31' } = {}) {
  const cost = Math.round(+asset.cost || 0);
  if (!cost || !asset.acquired) return [];
  const method = asset.method || 'straight';
  const life = Math.max(1, Math.round(+asset.life || 1));
  const ends = fyEnds(asset.acquired, upto, closeMonth);
  const rows = [];
  let book = cost;
  ends.forEach((end, i) => {
    if (book <= (method === 'straight' ? 1 : 0)) return;
    let months = 12;
    if (i === 0) {
      const [ay, am] = asset.acquired.split('-').map(Number);
      const [ey, em] = end.split('-').map(Number);
      months = (ey - ay) * 12 + (em - am) + 1; // 取得した月から期末の月まで（1 か月未満は 1 か月）
      months = Math.min(12, Math.max(1, months));
    }
    let amount;
    if (method === 'small') amount = book;
    else if (method === 'lump3') amount = i < 2 ? Math.floor(cost / 3) : book;
    else {
      amount = Math.floor((cost * straightRate(life) * months) / 12);
      if (book - amount < 1) amount = book - 1; // 最後は 1 円（備忘価額）を残す
    }
    rows.push({ fyEnd: end, months, amount, bookOpen: book, bookClose: book - amount });
    book -= amount;
  });
  return rows;
}

// 外注費の源泉徴収税額（報酬・料金。復興特別所得税を含む 10.21% / 100 万円を超える部分は 20.42%）
export function withholding(gross) {
  const g = Math.max(0, Math.round(+gross || 0));
  if (g <= 1000000) return Math.floor(g * 0.1021);
  return Math.floor((g - 1000000) * 0.2042 + 102100);
}
