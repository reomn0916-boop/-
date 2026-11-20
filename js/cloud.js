// 現場CAD: Google ドライブ（マイドライブ/現場CAD/）にプロジェクトを 1 つずつ .gcad で置き、差分で同期する（スマホ版・パソコン版で共通）
import * as gd from '../lib/gdrive.js';
import { packProject, unpackProject, mergeProjects, ensureIds, EXT } from './sync.js';

export { gd };
const SEEN = 'genbacad.cloudSeen';
const seenGet = () => { try { return JSON.parse(localStorage.getItem(SEEN) || '{}'); } catch (_) { return {}; } };
const seenSet = (o) => { try { localStorage.setItem(SEEN, JSON.stringify(o)); } catch (_) { /* 容量 */ } };
const fileName = (doc) => `${String(doc.name || '無題').replace(/[\\/:*?"<>|]/g, '_')}${EXT}`;
const root = () => gd.folder('現場CAD', { key: 'genbacad' });

export const cloudState = { busy: false, last: 0, error: '' };

// 今のプロジェクトを同期: ドライブの方が新しければ差分で取り込み、そのあと今の内容を書く
// 戻り値: { ok, merged: mergeProjects の結果 | null, created }
export async function syncProject(doc, app) {
  if (!gd.connected()) return { ok: false, auth: true, error: gd.needsReconnect() ? 'Google ドライブとのつながりが切れました' : 'Google ドライブにつないでいません' };
  if (cloudState.busy) return { ok: false, busy: true };
  cloudState.busy = true; cloudState.error = '';
  try {
    ensureIds(doc);
    const dir = await root();
    const found = await gd.list(dir, { extra: `appProperties has { key='pid' and value='${doc.pid}' }` });
    const f = found.sort((a, b) => b.modifiedTime - a.modifiedTime)[0];
    const seen = seenGet();
    let merged = null;
    if (f && (!seen[doc.pid] || f.modifiedTime > seen[doc.pid])) {
      const remote = unpackProject(await gd.readText(f.id)).doc;
      merged = mergeProjects(doc, remote);
    }
    const w = await gd.write({ id: f ? f.id : null, name: fileName(doc), parent: dir, data: JSON.stringify(packProject(doc, app)), mime: 'application/octet-stream', appProperties: { pid: doc.pid } });
    seen[doc.pid] = Date.parse(w.modifiedTime) || Date.now(); seenSet(seen);
    cloudState.last = Date.now();
    return { ok: true, merged, created: !f };
  } catch (e) {
    cloudState.error = e.message || String(e);
    return { ok: false, auth: e instanceof gd.DriveAuthError, error: cloudState.error };
  } finally { cloudState.busy = false; }
}

// ドライブにあるプロジェクトの一覧（新しい順）
export async function listProjects() {
  const dir = await root();
  return (await gd.list(dir)).filter((f) => f.name.endsWith(EXT)).sort((a, b) => b.modifiedTime - a.modifiedTime);
}
export async function openProjectFile(f) {
  const r = unpackProject(await gd.readText(f.id));
  const seen = seenGet(); seen[r.doc.pid] = f.modifiedTime; seenSet(seen);
  return r.doc;
}

// 自動同期: 保存のたびに少し待って / 5 分ごと / アプリに戻ったとき
export function autoSync({ getDoc, app, onDone, delay = 15000 }) {
  let t = null;
  const run = async () => { if (!gd.connected() || !getDoc().entities.length) return; const r = await syncProject(getDoc(), app); onDone(r); };
  setInterval(run, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - cloudState.last > 60000) run(); });
  return { changed() { if (!gd.connected()) return; clearTimeout(t); t = setTimeout(run, delay); }, run };
}
