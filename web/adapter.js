/*
 * 案件ボード：Firebase 版のつなぎ
 *
 * アプリ本体（app/index.html）は Claude の Artifact の仕組み（window.claude.use）で
 * データ・ログイン・写真を扱う。この file はその同じ窓口を Firebase で用意し、
 * 本体を書き換えずに Claude の外で動かす。
 *
 *   db        → Cloud Firestore
 *   user      → Firebase Authentication（Google ログイン）＋ users コレクション
 *   assets    → Cloud Storage（写真・レシート）
 *   downloads → ブラウザの通常のダウンロード
 *   sample（AI）→ なし（null）。AI の画面は本体側で自動的に隠れる
 */
(function () {
  "use strict";
  const CFG = window.FIREBASE_CONFIG;
  if (!CFG || !window.firebase) { document.addEventListener("DOMContentLoaded", () => gate("error", "設定ファイル（firebase-config.js）が読み込めません。")); return; }

  firebase.initializeApp(CFG);
  const auth = firebase.auth(), fs = firebase.firestore(), st = firebase.storage();
  fs.settings({ ignoreUndefinedProperties: true, merge: true });
  if (window.FIREBASE_EMULATOR) {
    auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
    fs.useEmulator("127.0.0.1", 8080);
    st.useEmulator("127.0.0.1", 9199);
  } else {
    fs.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  }

  const ROLES = { owner: "オーナー", admin: "編集者", staff: "社員", partner: "協力会社", pending: "承認待ち" };
  const ACTIVE = ["owner", "admin", "staff", "partner"];
  let me = null, role = null, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  /* ---------- 共通 ---------- */
  const CODE = { "permission-denied": "invalid_argument", "not-found": "invalid_argument", "invalid-argument": "invalid_argument",
    "failed-precondition": "invalid_argument", "unavailable": "unavailable", "resource-exhausted": "resource_exhausted", "unauthenticated": "revoked" };
  const err = e => ({ code: CODE[e && e.code] || "unavailable", message: (e && e.message) || String(e) });
  const P = p => p.catch(e => { throw err(e); });

  /* ---------- db ---------- */
  const meta = m => ({ fromCache: !!m.fromCache, hasPendingWrites: !!m.hasPendingWrites });
  const dsnap = s => ({ id: s.id, exists: s.exists, data: () => (s.exists ? s.data() : undefined), metadata: meta(s.metadata) });
  const qsnap = q => ({ docs: q.docs.map(dsnap), size: q.size, empty: q.empty, metadata: meta(q.metadata),
    docChanges: () => q.docChanges().map(c => ({ type: c.type, doc: dsnap(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex })) });
  function docRef(ref) {
    return {
      id: ref.id, path: ref.path,
      get: () => P(ref.get()).then(dsnap),
      set: d => P(ref.set(d)),
      update: d => P(ref.update(d)),
      delete: () => P(ref.delete()),
      onSnapshot: (next, onErr) => ref.onSnapshot(s => next(dsnap(s)), e => onErr && onErr(err(e))),
      collection: c => colRef(ref.collection(c)),
      acquire: async () => ({ acquired: true }),
    };
  }
  function query(q) {
    return {
      where: (f, op, v) => query(q.where(f, op, v)),
      orderBy: (f, d) => query(q.orderBy(f, d || "asc")),
      limit: n => query(q.limit(n)),
      get: () => P(q.get()).then(qsnap),
      onSnapshot: (next, onErr) => q.onSnapshot(s => next(qsnap(s)), e => onErr && onErr(err(e))),
    };
  }
  function colRef(c) {
    return Object.assign(query(c), { path: c.path, doc: id => docRef(id ? c.doc(id) : c.doc()), add: d => P(c.add(d)).then(docRef) });
  }
  const DB = { doc: p => docRef(fs.doc(p)), collection: p => colRef(fs.collection(p)) };

  /* ---------- user ---------- */
  const cache = {};
  const prof = (id, d) => ({ id, name: (d && d.name) || "", avatarUrl: (d && d.photo) || "", color: "#7a847e",
    email: (d && d.email) || null, isMe: !!me && id === me.uid, guest: !!d && d.role === "partner" });
  async function profiles(ids) {
    const list = [...new Set([].concat(ids || []).filter(Boolean))];
    await Promise.all(list.filter(id => !(id in cache)).map(async id => {
      try { const s = await fs.doc("users/" + id).get(); cache[id] = prof(id, s.exists ? s.data() : null); } catch (e) { cache[id] = prof(id, null); }
    }));
    const out = {}; for (const id of list) out[id] = cache[id]; return out;
  }
  const isAdmin = () => role === "owner" || role === "admin";
  const USER = {
    id: async () => me.uid,
    me: async () => ({ id: me.uid, name: me.name, avatarUrl: me.photo || "", color: "#7a847e", email: me.email, isOwner: role === "owner", canEdit: isAdmin() }),
    name: async () => me.name,
    email: async () => me.email,
    avatarUrl: async () => me.photo || null,
    isOwner: async () => role === "owner",
    canEdit: async () => isAdmin(),
    can: async n => n === "data.write" ? true : n === "assets.write" ? isAdmin() : n === "files.write" ? isAdmin() : n === "view.limited" ? role === "partner" : false,
    profiles,
    search: async q => {
      const s = await fs.collection("users").get().catch(() => null);
      if (!s) return [];
      q = (q || "").trim();
      return s.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(u => ACTIVE.includes(u.role) && (!q || (u.name || "").includes(q) || (u.email || "").includes(q)))
        .slice(0, 8).map(u => { cache[u.id] = prof(u.id, u); return { ...cache[u.id], name: u.name || u.email || "メンバー" }; });
    },
  };

  /* ---------- assets ---------- */
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "text/csv": "csv", "text/plain": "txt" };
  const ASSETS = {
    upload: async (blob, opts) => {
      const type = (opts && opts.type) || blob.type || "image/jpeg";
      const ref = st.ref("uploads/" + me.uid + "/" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "." + (EXT[type] || "bin"));
      try {
        await ref.put(blob, { contentType: type });
        const url = await ref.getDownloadURL();
        return { id: url, url, sizeBytes: blob.size, contentType: type };
      } catch (e) {
        const c = e && e.code;
        throw { code: c === "storage/unauthorized" ? "not_granted" : c === "storage/quota-exceeded" ? "quota_or_state" : "upstream_error", message: (e && e.message) || "" };
      }
    },
    delete: async id => { try { await st.refFromURL(id).delete(); return { deleted: true }; } catch (e) { return { deleted: false }; } },
    list: async () => ({ assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }),
  };

  /* ---------- downloads ---------- */
  const DOWNLOADS = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/.test(filename) ? "text/csv" : /\.html?$/.test(filename) ? "text/html" : "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    },
  };

  window.claude = {
    use: async name => {
      await ready;
      return { db: DB, user: USER, assets: ASSETS, downloads: DOWNLOADS }[name] || null;
    },
  };

  /* ---------- ログイン画面・承認待ち ---------- */
  const css = `
  .fb-gate{position:fixed;inset:0;z-index:100;background:var(--bg,#ECEFEA);display:flex;align-items:center;justify-content:center;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px))}
  .fb-card{background:var(--surface,#fff);color:var(--ink,#1B211E);border:1px solid var(--line,#D1D7D0);border-radius:14px;padding:28px 24px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px;text-align:center}
  .fb-card h1{font-family:var(--f-head,sans-serif);font-size:24px;margin:0;letter-spacing:.04em}
  .fb-card p{margin:0;font-size:14px;line-height:1.7;color:var(--muted,#5C6660)}
  .fb-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;border-radius:10px;border:1px solid var(--line,#D1D7D0);background:var(--surface,#fff);color:var(--ink,#1B211E);font-size:16px;font-weight:500;cursor:pointer;padding:0 16px}
  .fb-btn.primary{background:var(--accent,#C24E1C);border-color:var(--accent,#C24E1C);color:var(--accent-ink,#fff)}
  .fb-email{font-family:var(--f-mono,monospace);font-size:13px;background:var(--bg,#ECEFEA);border-radius:8px;padding:8px;word-break:break-all;color:var(--ink,#1B211E)}
  .fb-tools{display:flex;gap:12px;align-items:center;margin-left:8px;white-space:nowrap}
  .brand{flex-wrap:wrap;row-gap:2px}
  .brand h1{white-space:nowrap}
  @media (max-width:560px){.fb-tools{flex-basis:100%;margin-left:0}}
  .fb-link{border:0;background:transparent;color:var(--muted,#5C6660);text-decoration:underline;font-size:12px;cursor:pointer;padding:0}
  .fb-modal{position:fixed;inset:0;z-index:90;background:rgba(10,14,12,.45);display:flex;align-items:center;justify-content:center;padding:16px}
  .fb-panel{background:var(--surface,#fff);color:var(--ink,#1B211E);border-radius:12px;width:min(720px,100%);max-height:86vh;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
  .fb-panel h2{font-family:var(--f-head,sans-serif);font-size:18px;margin:0}
  .fb-panel table{width:100%;border-collapse:collapse;font-size:13px}
  .fb-panel th,.fb-panel td{border-bottom:1px solid var(--line,#D1D7D0);padding:7px 6px;text-align:left;vertical-align:middle}
  .fb-panel select{border:1px solid var(--line,#D1D7D0);border-radius:7px;padding:4px 6px;background:var(--surface,#fff);color:var(--ink,#1B211E)}
  .fb-note{font-size:12.5px;color:var(--muted,#5C6660);margin:0}`;
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v); }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }
  function gate(mode, extra) {
    if (!document.getElementById("fb-style")) document.head.append(el("style", { id: "fb-style" }, css));
    let g = document.getElementById("fb-gate");
    if (!g) { g = el("div", { class: "fb-gate", id: "fb-gate" }); document.body.append(g); }
    const card = el("div", { class: "fb-card", role: "dialog", "aria-label": "ログイン" }, el("h1", { text: "案件ボード" }));
    if (mode === "login") {
      card.append(el("p", { text: "会社の Google アカウントか、個人の Google アカウントでログインしてください。初めての方は、ログイン後に会社の担当者の承認が必要です。" }),
        el("button", { class: "fb-btn primary", type: "button", onclick: login }, "Google でログイン"),
        extra ? el("p", { style: "color:var(--danger,#B3261E)", text: extra }) : null);
    } else if (mode === "pending") {
      card.append(el("p", { text: "ログインできました。会社の担当者があなたを承認すると使えるようになります。下のメールアドレスを担当者に伝えてください。" }),
        el("div", { class: "fb-email", text: (me && me.email) || "" }),
        el("p", { text: "承認されると、この画面は自動で切り替わります。" }),
        el("button", { class: "fb-btn", type: "button", onclick: () => auth.signOut() }, "別のアカウントでログインし直す"));
    } else if (mode === "loading") {
      card.append(el("p", { text: "読み込み中…" }));
    } else {
      card.append(el("p", { style: "color:var(--danger,#B3261E)", text: extra || "エラーが起きました。" }));
    }
    g.replaceChildren(card);
    g.hidden = false;
  }
  async function login() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try { await auth.signInWithPopup(provider); }
    catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) return auth.signInWithRedirect(provider);
      if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") gate("login", "ログインできませんでした（" + (e.code || "") + "）。もう一度お試しください。");
    }
  }
  if (window.FIREBASE_EMULATOR) {
    window.__testLogin = (email, name) => auth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, name, email_verified: true })));
  }

  /* ---------- メンバー管理（オーナー・編集者） ---------- */
  function memberPanel() {
    const wrap = el("div", { class: "fb-modal", role: "dialog", "aria-label": "メンバー管理", onclick: e => { if (e.target === wrap) wrap.remove(); } });
    const body = el("div", { class: "fb-panel" });
    wrap.append(body); document.body.append(wrap);
    const draw = async () => {
      const s = await fs.collection("users").get();
      const users = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || (a.name || "").localeCompare(b.name || "", "ja"));
      body.replaceChildren(
        el("div", { style: "display:flex;align-items:center;gap:8px" }, el("h2", { text: "メンバー管理" }), el("button", { class: "fb-link", type: "button", style: "margin-left:auto", onclick: () => wrap.remove() }, "閉じる")),
        el("p", { class: "fb-note", text: "初めてログインした人は「承認待ち」になります。役割を選ぶと使えるようになります。協力会社は「今日・現場・日報」だけが見え、経費・連絡・予算は見えません。" }),
        el("table", null,
          el("thead", null, el("tr", null, el("th", { text: "名前" }), el("th", { text: "メール" }), el("th", { text: "役割" }), el("th", { text: "" }))),
          el("tbody", null, users.map(u => {
            const self = u.id === me.uid, fixed = u.role === "owner" || self;
            const sel = el("select", { "aria-label": (u.name || "") + "の役割", disabled: fixed },
              Object.entries(ROLES).filter(([k]) => k !== "owner" || u.role === "owner").filter(([k]) => role === "owner" || k !== "admin" || u.role === "admin").map(([k, v]) => el("option", { value: k }, v)));
            sel.value = u.role || "pending";
            sel.addEventListener("change", async () => { try { await fs.doc("users/" + u.id).update({ role: sel.value, roleBy: me.uid, roleAt: new Date().toISOString() }); draw(); } catch (e) { alertRow("役割を変更できませんでした。"); } });
            const del = fixed ? null : el("button", { class: "fb-link", type: "button", onclick: async () => { if (del.dataset.c) { await fs.doc("users/" + u.id).delete().catch(() => {}); draw(); } else { del.dataset.c = "1"; del.textContent = "本当に外す"; } } }, "外す");
            return el("tr", null, el("td", { text: (u.name || "（名前なし）") + (self ? "（自分）" : "") }), el("td", { text: u.email || "" }), el("td", null, sel), el("td", null, del));
          }))),
        role === "owner" ? importBox() : null);
    };
    const alertRow = t => body.prepend(el("p", { class: "fb-note", style: "color:var(--danger,#B3261E)", text: t }));
    draw();
  }
  /* データ取り込み（Claude 版からの移行用。オーナーのみ） */
  function importBox() {
    const input = el("input", { type: "file", accept: ".json,application/json" });
    const out = el("p", { class: "fb-note" });
    const box = el("div", { style: "border-top:1px solid var(--line,#D1D7D0);padding-top:12px;display:flex;flex-direction:column;gap:8px" },
      el("h2", { text: "データの取り込み" }),
      el("p", { class: "fb-note", text: "Claude 版の案件ボードから書き出した JSON ファイルを選ぶと、同じ ID のデータを上書きして取り込みます。写真は Claude 版に残るため、取り込み後は表示されないことがあります。" }),
      input, out);
    input.addEventListener("change", async () => {
      const f = input.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        let n = 0, batch = fs.batch(), inBatch = 0;
        for (const [path, doc] of Object.entries(data)) {
          if (typeof doc !== "object" || !doc || path.split("/").length % 2) continue;
          batch.set(fs.doc(path), doc); n++; inBatch++;
          if (inBatch >= 400) { await batch.commit(); batch = fs.batch(); inBatch = 0; out.textContent = n + " 件を取り込み中…"; }
        }
        if (inBatch) await batch.commit();
        out.textContent = n + " 件を取り込みました。";
      } catch (e) { out.textContent = "取り込めませんでした：" + ((e && e.message) || e); }
    });
    return box;
  }
  function addHeaderTools() {
    const brand = document.querySelector(".brand");
    if (!brand || document.getElementById("fb-tools")) return;
    brand.append(el("span", { class: "fb-tools", id: "fb-tools" },
      el("span", { class: "fb-note", text: ROLES[role] || "" }),
      isAdmin() ? el("button", { class: "fb-link", type: "button", onclick: memberPanel }, "メンバー管理") : null,
      el("button", { class: "fb-link", type: "button", onclick: () => auth.signOut().then(() => location.reload()) }, "ログアウト")));
  }

  /* ---------- 起動 ---------- */
  let unsubRole = null;
  document.addEventListener("DOMContentLoaded", () => gate("loading"));
  auth.getRedirectResult().catch(() => {});
  auth.onAuthStateChanged(async u => {
    if (unsubRole) { unsubRole(); unsubRole = null; }
    if (!u) { me = null; role = null; gate("login"); return; }
    me = { uid: u.uid, name: u.displayName || (u.email || "").split("@")[0], email: u.email || "", photo: u.photoURL || "" };
    try {
      const ref = fs.doc("users/" + u.uid);
      let snap = await ref.get();
      if (!snap.exists) {
        const owner = await fs.doc("meta/owner").get();
        const base = { name: me.name, email: me.email, photo: me.photo, createdAt: new Date().toISOString() };
        if (!owner.exists) {
          // 最初にログインした人をオーナーにする
          const b = fs.batch();
          b.set(fs.doc("meta/owner"), { uid: u.uid, at: base.createdAt });
          b.set(ref, { ...base, role: "owner" });
          await b.commit().catch(() => ref.set({ ...base, role: "pending" }));
        } else await ref.set({ ...base, role: "pending" });
        snap = await ref.get();
      } else {
        const d = snap.data();
        if (d.name !== me.name || d.photo !== me.photo) ref.update({ name: me.name, photo: me.photo }).catch(() => {});
      }
      role = snap.data().role;
      unsubRole = ref.onSnapshot(s => { if (s.metadata.hasPendingWrites) return; const r = s.exists ? s.data().role : null; if (r !== role) location.reload(); }, () => {});
      if (!ACTIVE.includes(role)) { gate("pending"); return; }
      const g = document.getElementById("fb-gate"); if (g) g.hidden = true;
      readyResolve();
      const tick = () => { addHeaderTools(); if (!document.getElementById("fb-tools")) setTimeout(tick, 200); };
      tick();
    } catch (e) {
      gate("error", "データに接続できませんでした。通信状態を確認して、開き直してください。");
      console.warn(e);
    }
  });
})();
