// 平面直角座標系 (JGD2011 / GRS80) と緯度経度の相互変換
// 国土地理院「平面直角座標への換算」(河瀬 2011 の式) に基づく

const a = 6378137.0;
const F = 298.257222101;
const m0 = 0.9999;
const n = 1 / (2 * F - 1);

const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;

const A = [
  1 + n2 / 4 + n4 / 64,
  -1.5 * (n - n3 / 8 - n5 / 64),
  (15 / 16) * (n2 - n4 / 4),
  -(35 / 48) * (n3 - (5 / 16) * n5),
  (315 / 512) * n4,
  -(693 / 1280) * n5,
];

const alpha = [
  0,
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5,
  (49561 / 161280) * n4 - (179 / 168) * n5,
  (34729 / 80640) * n5,
];

const beta = [
  0,
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5,
  (4397 / 161280) * n4 - (11 / 504) * n5,
  (4583 / 161280) * n5,
];

const delta = [
  0,
  2 * n - (2 / 3) * n2 - 2 * n3 + (116 / 45) * n4 + (26 / 45) * n5 - (2854 / 675) * n6,
  (7 / 3) * n2 - (8 / 5) * n3 - (227 / 45) * n4 + (2704 / 315) * n5 + (2323 / 945) * n6,
  (56 / 15) * n3 - (136 / 35) * n4 - (1262 / 105) * n5 + (73814 / 2835) * n6,
  (4279 / 630) * n4 - (332 / 35) * n5 - (399572 / 14175) * n6,
  (4174 / 315) * n5 - (144838 / 6237) * n6,
  (601676 / 22275) * n6,
];

const Abar = (m0 * a) / (1 + n) * A[0];

// 系番号 → 原点 [緯度(度), 経度(度)]
const dm = (d, m) => d + m / 60;
export const ZONES = {
  1: [33, dm(129, 30)], 2: [33, 131], 3: [36, dm(132, 10)], 4: [33, dm(133, 30)],
  5: [36, dm(134, 20)], 6: [36, 136], 7: [36, dm(137, 10)], 8: [36, dm(138, 30)],
  9: [36, dm(139, 50)], 10: [40, dm(140, 50)], 11: [44, dm(140, 15)], 12: [44, dm(142, 15)],
  13: [44, dm(144, 15)], 14: [26, 142], 15: [26, dm(127, 30)], 16: [26, 124],
  17: [26, 131], 18: [20, 136], 19: [26, 154],
};

export const ZONE_AREAS = {
  1: '長崎県・鹿児島県の一部', 2: '福岡・佐賀・熊本・大分・宮崎・鹿児島', 3: '山口・島根・広島',
  4: '香川・愛媛・徳島・高知', 5: '兵庫・鳥取・岡山', 6: '京都・大阪・福井・滋賀・三重・奈良・和歌山',
  7: '石川・富山・岐阜・愛知', 8: '新潟・長野・山梨・静岡', 9: '東京・福島・栃木・茨城・埼玉・千葉・群馬・神奈川',
  10: '青森・秋田・山形・岩手・宮城', 11: '北海道（小樽・函館など）', 12: '北海道（札幌・旭川など）',
  13: '北海道（北見・釧路など）', 14: '東京都（小笠原の一部）', 15: '沖縄県（沖縄本島など）',
  16: '沖縄県（石垣・宮古など）', 17: '沖縄県（大東島など）', 18: '東京都（沖ノ鳥島）', 19: '東京都（南鳥島）',
};

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function Sbar(phi0) {
  let s = A[0] * phi0;
  for (let j = 1; j <= 5; j++) s += A[j] * Math.sin(2 * j * phi0);
  return (m0 * a) / (1 + n) * s;
}

/** 緯度経度(度) → 平面直角座標 {x: 北(m), y: 東(m)} */
export function llToXY(latDeg, lonDeg, zone) {
  const [lat0, lon0] = ZONES[zone];
  const phi = rad(latDeg), lam = rad(lonDeg);
  const phi0 = rad(lat0), lam0 = rad(lon0);
  const k = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - k * Math.atanh(k * Math.sin(phi)));
  const tb = Math.sqrt(1 + t * t);
  const lc = Math.cos(lam - lam0), ls = Math.sin(lam - lam0);
  const xi = Math.atan(t / lc);
  const eta = Math.atanh(ls / tb);
  let x = xi, y = eta;
  for (let j = 1; j <= 5; j++) {
    x += alpha[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += alpha[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { x: Abar * x - Sbar(phi0), y: Abar * y };
}

/** 平面直角座標 (x:北, y:東) → 緯度経度(度) */
export function xyToLL(x, y, zone) {
  const [lat0, lon0] = ZONES[zone];
  const phi0 = rad(lat0), lam0 = rad(lon0);
  const xi = (x + Sbar(phi0)) / Abar;
  const eta = y / Abar;
  let xi2 = xi, eta2 = eta;
  for (let j = 1; j <= 5; j++) {
    xi2 -= beta[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta2 -= beta[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  let phi = chi;
  for (let j = 1; j <= 6; j++) phi += delta[j] * Math.sin(2 * j * chi);
  const lam = lam0 + Math.atan(Math.sinh(eta2) / Math.cos(xi2));
  return { lat: deg(phi), lon: deg(lam) };
}

/** 緯度経度から最寄りの系を推定（経度・緯度による目安。県境付近は手動で確認） */
export function guessZone(lat, lon) {
  let best = 9, bestD = Infinity;
  for (const [z, [la, lo]] of Object.entries(ZONES)) {
    const zn = Number(z);
    if (zn >= 14) continue; // 離島系は自動推定しない
    const dLon = (lon - lo) * Math.cos(rad(lat));
    const d = dLon * dLon + ((lat - la) * 0.15) ** 2;
    if (d < bestD) { bestD = d; best = zn; }
  }
  if (lat < 27.5 && lon > 122 && lon < 129) return lon < 125.5 ? 16 : 15;
  if (lat > 41.4 && lon > 139.3) return lon < 141.2 ? 11 : lon < 143.3 ? 12 : 13; // 北海道（目安）
  if (lat >= 37.9 && lon >= 139.4 && lon < 142.5) return 10; // 東北（目安）
  return best;
}

/** 度 → "度°分′秒″" */
export function toDMS(d, digits = 1) {
  const sign = d < 0 ? '-' : '';
  let v = Math.abs(d);
  let dd = Math.floor(v);
  let mm = Math.floor((v - dd) * 60);
  let ss = (v - dd - mm / 60) * 3600;
  if (Number(ss.toFixed(digits)) >= 60) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; dd += 1; }
  return `${sign}${dd}°${String(mm).padStart(2, '0')}′${ss.toFixed(digits).padStart(digits ? 3 + digits : 2, "0")}″`;
}

/** "45-30-15" / "45°30'15\"" / "45.5" → 度 */
export function parseAngle(s) {
  s = String(s).trim();
  const m = s.match(/^(-?)(\d+(?:\.\d+)?)[-°d\s]+(\d+(?:\.\d+)?)(?:[-′'m\s]+(\d+(?:\.\d+)?))?[″"s]?$/);
  if (m) {
    const v = Number(m[2]) + Number(m[3]) / 60 + (m[4] ? Number(m[4]) / 3600 : 0);
    return m[1] ? -v : v;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/** 方向角（X軸=北から時計回り, 度 0-360） */
export function azimuth(p, q) {
  let t = deg(Math.atan2(q.y - p.y, q.x - p.x));
  if (t < 0) t += 360;
  return t;
}
