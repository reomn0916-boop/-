// レシートの切り抜き（crop.js）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPaper } from '../js/crop.js';

function img(w, h, bg, rect, paper = 245) {
  const g = new Uint8Array(w * h).fill(bg);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) g[y * w + x] = paper;
    // 文字（暗い線）を少し入れる
    for (let y = rect.y + 10; y < rect.y + rect.h - 10; y += 12) for (let x = rect.x + 8; x < rect.x + rect.w - 8; x++) g[y * w + x] = 30;
  }
  return g;
}

test('机の上のレシートを切り抜く', () => {
  const r = findPaper(img(200, 260, 95, { x: 60, y: 50, w: 80, h: 150 }), 200, 260);
  assert.ok(r);
  assert.ok(r.x <= 60 && r.x >= 50, `x=${r.x}`);
  assert.ok(r.y <= 50 && r.y >= 40, `y=${r.y}`);
  assert.ok(r.x + r.w >= 140 && r.x + r.w <= 150);
  assert.ok(r.y + r.h >= 200 && r.y + r.h <= 210);
});

test('紙が画面いっぱいなら切り抜かない', () => {
  assert.equal(findPaper(img(200, 260, 245, null), 200, 260), null);
  assert.equal(findPaper(img(200, 260, 95, { x: 0, y: 0, w: 200, h: 250 }), 200, 260), null);
});

test('紙と背景の差が小さいときは切り抜かない', () => {
  assert.equal(findPaper(img(200, 260, 215, { x: 60, y: 50, w: 80, h: 150 }, 240), 200, 260), null);
});

test('小さすぎる明るい部分は紙とみなさない', () => {
  assert.equal(findPaper(img(200, 260, 90, { x: 90, y: 100, w: 20, h: 30 }), 200, 260), null);
});
