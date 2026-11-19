// 請求書の金額計算（適格請求書: 税率ごとに 1 回だけ端数を切り捨て）と番号（画面に依存しない）

// items: [{ name, qty, unit, price（税抜の単価）, rate: 10 | 8 | 0 }]
export function invoiceTotals(items = []) {
  const by = { 10: 0, 8: 0, 0: 0 };
  const lines = items.filter((i) => i && (i.name || i.price)).map((i) => {
    const qty = +i.qty || 0; const price = Math.round(+i.price || 0); const rate = [10, 8, 0].includes(+i.rate) ? +i.rate : 10;
    const amount = Math.round(qty * price);
    by[rate] += amount;
    return { ...i, qty, price, rate, amount };
  });
  const tax10 = Math.floor((by[10] * 10) / 100); const tax8 = Math.floor((by[8] * 8) / 100);
  const subtotal = by[10] + by[8] + by[0];
  return { lines, base10: by[10], base8: by[8], base0: by[0], tax10, tax8, subtotal, tax: tax10 + tax8, total: subtotal + tax10 + tax8 };
}

// 次の請求書番号（例: 2026-0007）
export function nextInvoiceNo(ledger = [], today = new Date()) {
  const y = today.getFullYear();
  const nums = ledger.filter((l) => l.invoice && l.invoice.no && l.invoice.no.startsWith(`${y}-`)).map((l) => +l.invoice.no.slice(5) || 0);
  return `${y}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, '0')}`;
}

// 期日を過ぎても入金のない請求
export function overdueInvoices(ledger = [], todayISO) {
  return ledger.filter((l) => l.type === 'income' && l.debit === '売掛金' && l.invoice && l.invoice.due && l.invoice.due < todayISO && !ledger.some((x) => x.ref === l.id));
}
