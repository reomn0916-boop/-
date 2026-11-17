/*
 * Firebase の設定（Firebase コンソール → プロジェクトの設定 → マイアプリ → ウェブアプリ の「構成」）
 * この値は公開されても問題ない種類のものです（アクセスは firestore.rules / storage.rules で守ります）。
 * 下の「ここに貼る」の部分を、自分のプロジェクトの値に置き換えてください。
 */
window.FIREBASE_CONFIG = {
  apiKey: "ここに貼る",
  authDomain: "ここに貼る.firebaseapp.com",
  projectId: "ここに貼る",
  storageBucket: "ここに貼る",
  messagingSenderId: "ここに貼る",
  appId: "ここに貼る",
};
