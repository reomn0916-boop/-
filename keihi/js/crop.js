// 写真の中からレシート（明るい紙）の範囲を見つける。机などの背景が写り込んだときに切り抜く。
// 画面に依存しない関数（Node でもテストできる）。gray は 0〜255 の明るさ、w × h。

function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0; let wB = 0; let best = 0; let t = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = v; }
  }
  return t;
}

// 見つからないとき・切り抜く必要がないときは null
export function findPaper(gray, w, h) {
  const n = w * h;
  if (n < 400) return null;
  const t = otsu(gray);
  let sb = 0; let nb = 0; let sd = 0; let nd = 0;
  for (let i = 0; i < n; i++) { if (gray[i] > t) { sb += gray[i]; nb++; } else { sd += gray[i]; nd++; } }
  if (!nb || !nd || sb / nb - sd / nd < 45) return null; // 紙と背景の差が小さい
  // 明るい部分のうち、いちばん大きいかたまり
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = gray[i] > t ? 1 : 0;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let bestArea = 0; let box = null; let id = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s]) continue;
    id++;
    let top = 0; stack[top++] = s; label[s] = id;
    let area = 0; let x0 = w; let y0 = h; let x1 = 0; let y1 = 0;
    while (top) {
      const p = stack[--top]; area++;
      const x = p % w; const y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[top++] = p + w; }
    }
    if (area > bestArea) { bestArea = area; box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }
  }
  if (!box || bestArea < n * 0.06) return null; // 紙が小さすぎる（見つけまちがい）
  const edges = (box.x <= 1) + (box.y <= 1) + (box.x + box.w >= w - 1) + (box.y + box.h >= h - 1);
  if (edges >= 3) return null; // 紙が画面いっぱい
  // 少し余白をつける（端の文字を切らないように）
  const mx = Math.round(w * 0.03); const my = Math.round(h * 0.03);
  const x = Math.max(0, box.x - mx); const y = Math.max(0, box.y - my);
  const r = { x, y, w: Math.min(w, box.x + box.w + mx) - x, h: Math.min(h, box.y + box.h + my) - y };
  if (r.w * r.h > n * 0.85) return null; // ほとんど切れないなら元のまま
  return r;
}
