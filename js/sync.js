// スマホ版とパソコン版で共通のプロジェクトファイル（.gcad）と差分取り込み
//
// 各図形には uid（端末をまたいで同じ図形を指す ID）と t（最後に変更した時刻 ms）を持たせる。
// 削除した図形は doc.tomb に {uid, t} で残し、取り込み先でも消せるようにする。

export const FORMAT = 'genbacad';
export const FILE_VER = 2;
export const EXT = '.gcad';

export const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

/** 図形の中身（id・uid・t を除く）の文字列。変更検出に使う */
export function sig(e) {
  const { id, t, uid, ...rest } = e;
  return JSON.stringify(rest);
}

/** プロジェクト ID と各図形の uid を用意する */
export function ensureIds(doc) {
  if (!doc.pid) doc.pid = newUid();
  if (!Array.isArray(doc.tomb)) doc.tomb = [];
  const seen = new Set();
  for (const e of doc.entities) {
    if (!e.uid || seen.has(e.uid)) e.uid = newUid();
    seen.add(e.uid);
  }
  return doc;
}

/**
 * 変更の追跡。保存のたびに track(doc) を呼ぶと、前回から変わった図形の t を更新し、
 * 消えた図形を doc.tomb に記録する。
 */
export function makeTracker() {
  let last = new Map();
  return {
    reset(doc) {
      ensureIds(doc);
      last = new Map(doc.entities.map((e) => [e.uid, sig(e)]));
    },
    track(doc) {
      if (!doc.pid) doc.pid = newUid();
      if (!Array.isArray(doc.tomb)) doc.tomb = [];
      const now = Date.now();
      const cur = new Map();
      for (const e of doc.entities) {
        if (!e.uid || cur.has(e.uid)) e.uid = newUid(); // 複製した図形は別の図形として扱う
        const s = sig(e);
        cur.set(e.uid, s);
        if (last.get(e.uid) !== s) e.t = now;
      }
      for (const u of last.keys()) if (!cur.has(u)) doc.tomb.push({ uid: u, t: now });
      if (doc.tomb.length > 5000) doc.tomb.splice(0, doc.tomb.length - 5000);
      last = cur;
    },
  };
}

const FIELDS = ['name', 'pid', 'zone', 'entities', 'seq', 'nextId', 'hiddenLayers', 'reports', 'gpsCal', 'sheet', 'layers', 'tomb'];

/** 保存用のオブジェクト */
export function packProject(doc, app) {
  ensureIds(doc);
  const out = { format: FORMAT, ver: FILE_VER, app, savedAt: new Date().toISOString() };
  for (const k of FIELDS) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

/** 読み込んだ JSON（.gcad または以前の .json）を検査して、足りない項目を補う */
export function unpackProject(src) {
  const d = typeof src === 'string' ? JSON.parse(src) : src;
  if (!d || !Array.isArray(d.entities)) throw new Error('現場CAD のプロジェクトファイルではありません');
  const doc = {
    name: d.name || '無題', pid: d.pid || null, zone: d.zone || null,
    entities: d.entities.filter((e) => e && typeof e.type === 'string'),
    seq: d.seq || 1, nextId: d.nextId || 1,
    hiddenLayers: Array.isArray(d.hiddenLayers) ? d.hiddenLayers : [],
    reports: Array.isArray(d.reports) ? d.reports : [],
    gpsCal: d.gpsCal || { mode: 'rigid', pairs: [] },
    sheet: d.sheet || null,
    layers: Array.isArray(d.layers) ? d.layers : [],
    tomb: Array.isArray(d.tomb) ? d.tomb : [],
  };
  let next = 1;
  for (const e of doc.entities) if (Number.isFinite(e.id)) next = Math.max(next, e.id + 1);
  doc.nextId = Math.max(doc.nextId, next);
  for (const e of doc.entities) if (!Number.isFinite(e.id)) e.id = doc.nextId++;
  ensureIds(doc);
  return { doc, app: d.app || '', savedAt: d.savedAt || '' };
}

const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 5e-4;

/**
 * inc（取り込むプロジェクト）を local に差分で取り込む。local を直接書き換える。
 * - 同じ uid の図形は、新しい方（t が大きい方）を残す
 * - 相手側で削除された図形は、こちらでその後に変更していなければ消す
 * - 同じ名前で位置が違う点は、取り込む側の点名を変える
 * @returns {added, updated, removed, renamed:[[旧,新]], same}
 */
export function mergeProjects(local, inc) {
  ensureIds(local);
  const res = { added: 0, updated: 0, removed: 0, renamed: [], same: 0 };
  const byUid = new Map(local.entities.map((e) => [e.uid, e]));
  const localTomb = new Map();
  for (const t of local.tomb) localTomb.set(t.uid, Math.max(localTomb.get(t.uid) || 0, t.t));
  const incTomb = new Map();
  for (const t of inc.tomb || []) incTomb.set(t.uid, Math.max(incTomb.get(t.uid) || 0, t.t));
  const incUids = new Set(inc.entities.map((e) => e.uid));

  // 相手で削除された図形
  const drop = new Set();
  for (const [u, t] of incTomb) {
    const e = byUid.get(u);
    if (e && !incUids.has(u) && (e.t || 0) <= t) drop.add(e);
  }
  if (drop.size) { local.entities = local.entities.filter((e) => !drop.has(e)); res.removed = drop.size; }

  const pointNames = () => new Set(local.entities.filter((e) => e.type === 'point').map((e) => e.name));
  let names = pointNames();
  const unique = (n) => { if (!names.has(n)) return n; let i = 2; while (names.has(`${n}-${i}`)) i++; return `${n}-${i}`; };

  for (const src of inc.entities) {
    const ie = JSON.parse(JSON.stringify(src));
    const le = ie.uid ? byUid.get(ie.uid) : null;
    if (le && !drop.has(le)) {
      if ((ie.t || 0) > (le.t || 0) && sig(ie) !== sig(le)) {
        const id = le.id;
        for (const k of Object.keys(le)) delete le[k];
        Object.assign(le, ie, { id });
        res.updated++;
        names = pointNames();
      } else res.same++;
      continue;
    }
    const lt = ie.uid ? localTomb.get(ie.uid) : undefined;
    if (lt !== undefined && lt >= (ie.t || 0)) continue; // こちらで後から削除した
    if (ie.type === 'point' && ie.name && names.has(ie.name)) {
      const same = local.entities.find((e) => e.type === 'point' && e.name === ie.name);
      if (same && near(same.p, ie.p)) { res.same++; continue; }
      const nn = unique(ie.name);
      res.renamed.push([ie.name, nn]);
      ie.name = nn;
    }
    if (!ie.uid) ie.uid = newUid();
    ie.id = local.nextId++;
    local.entities.push(ie);
    byUid.set(ie.uid, ie);
    if (ie.type === 'point') names.add(ie.name);
    res.added++;
  }

  // その他の項目
  local.seq = Math.max(local.seq || 1, inc.seq || 1);
  if (!local.zone && inc.zone) local.zone = inc.zone;
  if (!local.sheet && inc.sheet) local.sheet = inc.sheet;
  if ((!local.gpsCal || !local.gpsCal.pairs?.length) && inc.gpsCal?.pairs?.length) local.gpsCal = inc.gpsCal;
  const rKey = (r) => `${r.title}|${r.time}`;
  const rs = new Set((local.reports || []).map(rKey));
  for (const r of inc.reports || []) if (!rs.has(rKey(r))) { (local.reports ||= []).push(r); rs.add(rKey(r)); }
  const ls = new Set((local.layers || []).map((l) => l.name));
  for (const l of inc.layers || []) if (!ls.has(l.name)) { (local.layers ||= []).push(l); ls.add(l.name); }
  const ts = new Set(local.tomb.map((t) => t.uid));
  for (const t of inc.tomb || []) if (!ts.has(t.uid)) { local.tomb.push(t); ts.add(t.uid); }
  if (!local.pid) local.pid = inc.pid;
  return res;
}

/** 取り込み結果の文章 */
export function mergeSummary(r) {
  const parts = [];
  if (r.added) parts.push(`追加 ${r.added}`);
  if (r.updated) parts.push(`更新 ${r.updated}`);
  if (r.removed) parts.push(`削除 ${r.removed}`);
  let s = parts.length ? parts.join('・') : '変更はありませんでした';
  if (r.renamed.length) s += `（点名が重なった ${r.renamed.length} 点は ${r.renamed.slice(0, 3).map(([a, b]) => `${a}→${b}`).join('、')}${r.renamed.length > 3 ? ' など' : ''} に変更）`;
  return s;
}
