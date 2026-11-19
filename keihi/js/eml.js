// メール（.eml）の読み取り: 件名・差出人・本文・添付ファイル（電子レシート用。画面に依存しない）

function bytesOfBinary(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; }
function b64(s) { const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); return bytesOfBinary(bin); }
function qp(s) {
  const t = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}
function decode(u8, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^(x-)?sjis$/, 'shift_jis').replace('cp932', 'shift_jis').replace('windows-31j', 'shift_jis');
  try { return new TextDecoder(cs).decode(u8); } catch (_) { return new TextDecoder('utf-8').decode(u8); }
}
// =?ISO-2022-JP?B?...?= のような見出しの文字
export function decodeWords(s) {
  let t = String(s || '');
  if (/[\x80-\xff]/.test(t)) t = decode(bytesOfBinary(t), 'utf-8'); // 8bit のままの見出し
  return t.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    const u = enc.toUpperCase() === 'B' ? b64(data) : qp(data.replace(/_/g, ' '));
    return decode(u, cs);
  });
}
function headers(block) {
  const h = {};
  const lines = block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  for (const l of lines) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  return h;
}
const param = (v, name) => { const m = String(v || '').match(new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i')); return m ? (m[1] ?? m[2]) : ''; };

function walk(raw, out) {
  const sep = raw.search(/\r?\n\r?\n/);
  const head = headers(sep >= 0 ? raw.slice(0, sep) : raw);
  const body = sep >= 0 ? raw.slice(sep).replace(/^\r?\n\r?\n/, '') : '';
  const ct = head['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const bnd = param(ct, 'boundary');
    if (!bnd) return head;
    const parts = body.split(new RegExp(`\\r?\\n?--${bnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*\\r?\\n`)).slice(1);
    for (const p of parts) if (p.trim() && !/^--/.test(p.trim())) walk(p, out);
    return head;
  }
  const te = (head['content-transfer-encoding'] || '').toLowerCase();
  const bytes = te === 'base64' ? b64(body) : te === 'quoted-printable' ? qp(body) : bytesOfBinary(body);
  const disp = head['content-disposition'] || '';
  const name = decodeWords(param(disp, 'filename') || param(ct, 'name'));
  if (/attachment/i.test(disp) || name || /^(image|application)\//.test(type)) {
    out.attachments.push({ name: name || `添付.${type.split('/')[1] || 'bin'}`, type, bytes });
  } else if (type === 'text/plain') out.text.push(decode(bytes, param(ct, 'charset')));
  else if (type === 'text/html') out.html.push(decode(bytes, param(ct, 'charset')));
  return head;
}

export function htmlToText(h) {
  return String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&yen;|&#165;/g, '¥').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// raw は .eml の中身（バイト列をそのまま 1 文字 1 バイトにした文字列でもよい）
export function parseEml(raw) {
  const out = { text: [], html: [], attachments: [] };
  const top = walk(String(raw), out);
  const text = out.text.length ? out.text.join('\n') : out.html.map(htmlToText).join('\n');
  return {
    subject: decodeWords(top.subject || ''),
    from: decodeWords(top.from || ''),
    date: top.date ? new Date(top.date) : null,
    text,
    attachments: out.attachments,
  };
}
