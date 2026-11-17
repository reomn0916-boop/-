// app/index.html（Claude 版）から、Firebase で動く単独のウェブアプリを dist/ に作る
//   node build.mjs              … 本番用（firebase-config.js を使う）
//   node build.mjs --emulator   … 手元の試験用（エミュレーターにつなぐ）
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const emulator = process.argv.includes("--emulator");
const app = readFileSync(join(here, "..", "app", "index.html"), "utf8");
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "vendor"), { recursive: true });
for (const f of ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js", "firebase-storage-compat.js"])
  copyFileSync(join(here, "node_modules", "firebase", f), join(dist, "vendor", f));
copyFileSync(join(here, "adapter.js"), join(dist, "adapter.js"));
if (emulator) writeFileSync(join(dist, "firebase-config.js"),
  'window.FIREBASE_CONFIG={apiKey:"demo-key",authDomain:"demo-anken.firebaseapp.com",projectId:"demo-anken",storageBucket:"demo-anken.appspot.com",appId:"demo"};window.FIREBASE_EMULATOR=true;\n');
else {
  const cfg = readFileSync(join(here, "firebase-config.js"), "utf8");
  if (cfg.includes("ここに貼る")) { console.error("firebase-config.js がまだ設定されていません。"); process.exit(1); }
  copyFileSync(join(here, "firebase-config.js"), join(dist, "firebase-config.js"));
}
// Artifact の公開時に付く最低限のリセットと同じものを付ける
const reset = ":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.5 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}";
const head = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="theme-color" content="#C24E1C">',
  "<style>" + reset + "</style>",
  ...["app", "auth", "firestore", "storage"].map(m => `<script src="vendor/firebase-${m}-compat.js"></script>`),
  '<script src="firebase-config.js"></script>',
  '<script src="adapter.js"></script>',
].join("\n");
writeFileSync(join(dist, "index.html"), `<!doctype html>\n<html lang="ja">\n<head>\n${head}\n</head>\n<body>\n${app}\n</body>\n</html>\n`);
console.log("dist/ を作りました" + (emulator ? "（エミュレーター用）" : ""));
