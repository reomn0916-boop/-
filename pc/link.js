// パソコン版: スマホ版との連携
// - 現場へ送る: .gcad（プロジェクト一式）を保存・共有・連携フォルダへ
// - 現場データ取込: スマホから戻ってきた .gcad を差分で取り込む
// - 連携フォルダ: Google ドライブ・OneDrive などの同期フォルダを見張って新着を知らせる
import { unpackProject, mergeProjects, mergeSummary, EXT } from '../js/sync.js';
import { decodeText } from '../js/io.js';

export function initLink(K) {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = K.esc;
  let dir = null;           // 連携フォルダ
  let timer = null;
  const SEEN_KEY = 'genbacad.pc.link.seen';
  const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } };
  const setSeen = (m) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch { /* */ } };
  const safe = () => (K.doc.name || 'genbacad').replace(/[\\/:*?"<>|]/g, '_');

  async function perm(h, ask) {
    if (!h?.queryPermission) return false;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    if (!ask) return false;
    return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  // ------------------------------------------------------------
  async function send() {
    const blob = K.projectBlob();
    const name = `${safe()}${EXT}`;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'application/octet-stream' })] }));
    const r = await K.dialog({
      title: '現場（スマホ）へ送る',
      body: `<div class="form"><p>図面・点・路線・計算書をまとめた <b>${esc(name)}</b> を作ります（${K.doc.entities.length} 図形）。</p>
        <ol class="small" style="line-height:1.8"><li>保存したファイルを、LINE・メール・Google ドライブ・OneDrive などでスマホに送ります。</li>
        <li>スマホ版のメニュー［パソコン連携］→［パソコンから受け取る］で開きます。</li>
        <li>前に送った図面がスマホにあるときは「取り込む」を選ぶと、現場で作った点を残したまま更新できます。</li></ol>
        ${dir ? `<p class="ok">連携フォルダ「${esc(dir.name)}」に保存すると、同期されたスマホからすぐ開けます。</p>` : '<p class="small">［連携フォルダ設定］で同期フォルダを指定すると、そこへ直接保存できます。</p>'}</div>`,
      buttons: [{ label: 'キャンセル', value: 'cancel' }, ...(canShare ? [{ label: '共有…', value: 'share' }] : []), ...(dir ? [{ label: '連携フォルダに保存', value: 'folder', primary: true }] : []), { label: 'ファイルに保存', value: 'save', primary: !dir }],
    });
    if (r === 'save') { const h = await K.saveBlob(name, blob, [{ description: '現場CAD プロジェクト', accept: { 'application/octet-stream': [EXT] } }]); if (h) K.toast('保存しました。スマホへ送ってください'); }
    else if (r === 'share') { try { await navigator.share({ files: [new File([blob], name, { type: 'application/octet-stream' })], title: name }); } catch { /* 取り消し */ } }
    else if (r === 'folder') {
      try {
        if (!(await perm(dir, true))) throw new Error('フォルダへの書き込みが許可されていません');
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(blob); await w.close();
        const f = await fh.getFile();
        const m = seen(); m[name] = f.lastModified; setSeen(m); // 自分で書いたものは新着にしない
        K.toast(`連携フォルダに保存しました（${name}）`);
      } catch (err) { K.toast('保存できませんでした: ' + err.message, 4000); }
    }
  }

  // ------------------------------------------------------------
  async function receive() {
    if ('showOpenFilePicker' in window) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: '現場CAD プロジェクト', accept: { 'application/octet-stream': [EXT, '.json'] } }] });
        await mergeFile(await h.getFile());
      } catch (err) { if (err.name !== 'AbortError') K.toast(err.message); }
      return;
    }
    const inp = document.getElementById('fileMerge');
    inp.onchange = async () => { const f = inp.files[0]; inp.value = ''; if (f) await mergeFile(f); };
    inp.click();
  }

  async function mergeFile(f) {
    let inc;
    try { inc = unpackProject(decodeText(await f.arrayBuffer())); } catch (err) { K.toast('読み込めませんでした: ' + err.message, 4000); return; }
    const d = inc.doc;
    const same = d.pid && d.pid === K.doc.pid;
    const when = inc.savedAt ? new Date(inc.savedAt).toLocaleString('ja-JP') : '';
    const from = inc.app === 'mobile' ? 'スマホ版' : inc.app === 'pc' ? 'パソコン版' : '';
    const pts = d.entities.filter((e) => e.type === 'point');
    const r = await K.dialog({
      title: `現場データの取り込み（${f.name}）`,
      body: `<div class="form"><p>${from ? `${from}で` : ''}${when ? `${esc(when)} に` : ''}保存されたデータです。図形 ${d.entities.length}（点 ${pts.length}）。</p>
        ${same ? '<p class="ok">今開いている図面と同じプロジェクトです。現場で増えた点・変えた図形だけを取り込みます。</p>'
        : '<p class="err">今開いている図面とは別のプロジェクトです。取り込むと図形を追加します（同じ点名で位置が違う点は名前を変えます）。</p>'}</div>`,
      buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '開く（今の図面と置き換え）', value: 'open' }, { label: '取り込む（差分）', value: 'merge', primary: true }],
    });
    if (r === 'open') { K.replaceDoc(d, f.name); K.zoomAll(); K.toast(`「${f.name}」を開きました`); return; }
    if (r !== 'merge') return;
    K.begin();
    const res = mergeProjects(K.doc, d);
    K.commit();
    K.renderAll();
    await K.dialog({ title: '取り込み結果', body: `<p><b>${esc(mergeSummary(res))}</b></p><p class="small">元に戻すときは Ctrl+Z。</p>` });
  }

  // ------------------------------------------------------------
  async function setupFolder() {
    if (!('showDirectoryPicker' in window)) {
      await K.dialog({ title: '連携フォルダ', body: '<p>このブラウザはフォルダの指定に対応していません。Chrome か Edge でお使いください。<br>代わりに［現場データ取込］でファイルを選んで取り込めます。</p>' });
      return;
    }
    const r = await K.dialog({
      title: '連携フォルダの設定',
      body: `<div class="form"><p>Google ドライブ・OneDrive・Dropbox などの<b>パソコンと同期しているフォルダ</b>を指定すると、</p>
        <ul class="small" style="line-height:1.8"><li>［現場へ送る］でそのフォルダに直接保存できます。</li><li>スマホ版から同じフォルダ（クラウド）に保存した .gcad・SIMA・DXF を見つけて「新しいデータがあります」と知らせます。</li></ul>
        <p>今の設定: ${dir ? `<b>${esc(dir.name)}</b>` : '未設定'}</p></div>`,
      buttons: [{ label: '閉じる', value: 'cancel' }, ...(dir ? [{ label: '解除', value: 'off' }] : []), { label: 'フォルダを選ぶ', value: 'pick', primary: true }],
    });
    if (r === 'off') { dir = null; await K.idb.set('linkDir', null); stopWatch(); K.toast('連携フォルダを解除しました'); return; }
    if (r !== 'pick') return;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      await K.idb.set('linkDir', dir);
      // いまあるファイルは既読にする
      const m = seen();
      for await (const [name, h] of dir.entries()) if (h.kind === 'file' && isData(name)) m[name] = (await h.getFile()).lastModified;
      setSeen(m);
      startWatch();
      K.toast(`連携フォルダを「${dir.name}」にしました`);
    } catch (err) { if (err.name !== 'AbortError') K.toast(err.message); }
  }
  const isData = (n) => /\.(gcad|json|sim|dxf|csv)$/i.test(n);

  async function listFiles() {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !isData(name)) continue;
      const f = await h.getFile();
      out.push({ name, h, f, time: f.lastModified });
    }
    return out.sort((a, b) => b.time - a.time);
  }
  async function check(manual) {
    if (!dir) { if (manual) await setupFolder(); return; }
    if (!(await perm(dir, manual))) { if (manual) K.toast('フォルダを見る許可がありません'); return; }
    let files;
    try { files = await listFiles(); } catch (err) { if (manual) K.toast(err.message); return; }
    const m = seen();
    const fresh = files.filter((x) => !m[x.name] || m[x.name] < x.time);
    $('#linkBadge').hidden = !fresh.length;
    if (!manual) return;
    const r = await K.dialog({
      title: `連携フォルダ「${dir.name}」`, wide: true,
      body: `<div class="files">${files.slice(0, 60).map((x, i) => `<div class="${fresh.includes(x) ? 'new' : ''}"><span>${fresh.includes(x) ? '🆕 ' : ''}${esc(x.name)}</span><span class="small">${new Date(x.time).toLocaleString('ja-JP')}</span><button type="button" class="btn" data-f="${i}">取り込む</button></div>`).join('') || '<div class="small">データがありません</div>'}</div>
        <p class="small">.gcad は差分で取り込み、SIMA は点を、DXF は図形を追加します。</p>`,
      buttons: [{ label: 'すべて既読にする', value: 'read' }, { label: '閉じる', value: 'cancel' }],
      onOpen(root) {
        root.addEventListener('click', async (ev) => {
          const b = ev.target.closest('[data-f]'); if (!b) return;
          const x = files[Number(b.dataset.f)];
          document.getElementById('dlg').close();
          const mm = seen(); mm[x.name] = x.time; setSeen(mm);
          await importFile(x.f);
          check(false);
        });
      },
    });
    if (r === 'read') { for (const x of files) m[x.name] = x.time; setSeen(m); $('#linkBadge').hidden = true; }
  }
  async function importFile(f) {
    if (/\.(gcad|json)$/i.test(f.name)) return mergeFile(f);
    const text = decodeText(await f.arrayBuffer());
    if (/\.dxf$/i.test(f.name)) K.importDxfText(text, f.name); else K.importPointsText(text, f.name);
    K.zoomAll();
  }
  function startWatch() { stopWatch(); timer = setInterval(() => { if (document.visibilityState === 'visible') check(false); }, 15000); check(false); }
  function stopWatch() { clearInterval(timer); timer = null; $('#linkBadge').hidden = true; }

  // ------------------------------------------------------------
  async function phoneInfo() {
    const url = new URL('../', location.href).href;
    const body = document.createElement('div');
    body.className = 'form';
    body.innerHTML = `<div class="cols"><div><p>スマホでこのアドレスを開き、［ホーム画面に追加］するとスマホ版（現場用）が使えます。</p>
      <p><input readonly value="${esc(url)}" style="width:100%" onclick="this.select()"></p>
      <p class="small">スマホ版でできること: GPS で現在地の座標・図面の位置合わせ・位置出しと逃げ杭・SIMA 出力・現場での施工図。</p>
      <p class="small">データのやりとりはファイル（.gcad）で行います。インターネット上のサーバーには送りません。</p></div>
      <div id="qrBox" style="display:flex;align-items:center;justify-content:center;min-height:200px"><span class="small">QR コードを作成中…</span></div></div>`;
    K.dialog({ title: 'スマホ版の開き方', body, wide: true });
    try {
      if (!window.qrcode) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      }
      const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
      body.querySelector('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
    } catch { body.querySelector('#qrBox').innerHTML = '<span class="small">（オフラインのため QR コードを表示できません）</span>'; }
  }

  async function init() {
    document.getElementById('linkBadge').addEventListener('click', () => check(true));
    try { dir = (await K.idb.get('linkDir')) || null; } catch { dir = null; }
    if (dir) { if (await perm(dir, false)) startWatch(); }
  }

  return { init, send, receive, mergeFile, setupFolder, check, phoneInfo };
}
