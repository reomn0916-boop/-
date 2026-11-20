// 端末内の保存（IndexedDB）。経費・領収書の画像・精算書の履歴
const DB_NAME = 'rakukeihi';
const DB_VER = 3;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('expenses')) db.createObjectStore('expenses', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('ledger')) db.createObjectStore('ledger', { keyPath: 'id' }); // 売上・収入・振替伝票
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' }); // 同期フォルダなど
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id' }); // 訂正・削除の履歴（電子帳簿保存法）
      if (!db.objectStoreNames.contains('approvals')) db.createObjectStore('approvals', { keyPath: 'id' }); // 届いた精算の承認
    };
    req.onsuccess = () => { const d = req.result; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); }; // 新しい版を開いたタブに道をゆずる
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存できませんでした'));
  }));
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  put: (store, obj) => tx(store, 'readwrite', (s) => s.put(obj)),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  putMany: (store, list) => tx(store, 'readwrite', (s) => { list.forEach((o) => s.put(o)); }),
};

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// 消されにくくする（ブラウザに保存領域の保持を頼む）
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (_) { /* 使えない環境 */ }
}

export async function usage() {
  try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (_) { /* 使えない環境 */ }
  return null;
}
