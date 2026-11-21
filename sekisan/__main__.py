"""起動口。引数なしなら画面を開く。

  積算アプリ                                  画面を開く
  積算アプリ master R8 マスタ/R8              年度マスタを取り込む
  積算アプリ company 自社単価.csv             自社単価を取り込む
  積算アプリ run 設計書.csv --name 工事名 --fy R8 --work-type 道路改良 --out 出力
"""
from __future__ import annotations

import argparse
import sys

from . import db, importer, pipeline, settings


def main(argv: list[str] | None = None) -> int:
    args0 = list(sys.argv[1:] if argv is None else argv)
    if args0[:1] == ["--finish-update"]:   # 自動更新：新しい版が古いフォルダを置き換える
        from . import updater
        return updater.finish(args0[1], int(args0[2]), restart="--no-restart" not in args0)
    if args0[:1] == ["--selftest"]:        # ビルドの確かめ：画面を作って閉じる
        return selftest()
    ap = argparse.ArgumentParser(prog="積算アプリ")
    ap.add_argument("--db", help="データファイルの場所（省略時は設定の場所）")
    sub = ap.add_subparsers(dest="cmd")
    m = sub.add_parser("master", help="年度マスタを取り込む")
    m.add_argument("fy")
    m.add_argument("folder")
    c = sub.add_parser("company", help="自社単価を取り込む")
    c.add_argument("csv")
    r = sub.add_parser("run", help="設計書CSVから積算結果・実行予算まで一括で出す")
    r.add_argument("csv")
    r.add_argument("--name", required=True)
    r.add_argument("--fy", required=True)
    r.add_argument("--work-type", required=True)
    r.add_argument("--region", default="")
    r.add_argument("--orderer", default="", help="発注者（発注者ごとの設定を使う）")
    r.add_argument("--out", default="出力")
    r.add_argument("--mapping", help="列の対応表（JSON）")
    r.add_argument("--reference", help="答え合わせ用CSV（項目,金額）")
    args = ap.parse_args(argv)

    if not args.cmd:
        from .gui import run_gui
        return run_gui()

    conn = db.connect(args.db or settings.db_path())
    if args.cmd == "master":
        print(importer.import_master_folder(conn, args.fy, args.folder))
    elif args.cmd == "company":
        print(f"{importer.import_company_prices(conn, args.csv)}件 取り込みました")
    elif args.cmd == "run":
        res = pipeline.import_and_run(conn, args.csv, args.name, args.fy, args.work_type, args.out,
                                      args.region, args.mapping, args.orderer)
        if args.reference:
            importer.import_reference(conn, res["project_id"], args.reference)
            res["checks"] = pipeline.verify(conn, res["project_id"], res["design"])
        s = res["design"].summary
        print(f"直接工事費 {s.direct:,} 円 / 工事価格 {s.price:,} 円 / 工事費計 {s.total:,} 円")
        for f in res["files"]:
            print(f"出力: {f}")
        for w in res["design"].warnings:
            print(f"要確認: {w}")
        bad = [ch for ch in res["checks"] if not ch.ok]
        if res["checks"]:
            print(f"答え合わせ: {len(res['checks']) - len(bad)}/{len(res['checks'])} 一致")
            for ch in bad:
                print(f"  ズレ {ch.key}: 計算 {ch.ours:,.0f} / 過去 {ch.reference:,.0f}（差 {ch.diff:,.0f}）")
    return 0


def selftest() -> int:
    """ビルドしたソフトが起動できるか（画面を作れるか）を確かめる。結果は終了コードで返す。"""
    import os
    import tempfile
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    tmp = tempfile.mkdtemp()
    os.environ["APPDATA"] = tmp
    try:
        s = settings.load()
        s.update({"db_path": os.path.join(tmp, "test.sqlite"), "update_check": False, "price_auto_check": False})
        settings.save(s)
        from PySide6.QtWidgets import QApplication

        from . import gui
        app = QApplication.instance() or QApplication([])
        w = gui.MainWindow()
        w.show()
        app.processEvents()
        for key, *_ in gui.PAGES:
            w.go(key)
            app.processEvents()
        w.close()
        with open(os.path.join(os.path.dirname(sys.executable), "selftest.txt"), "w", encoding="utf-8") as f:
            f.write("ok")
        return 0
    except Exception as e:   # noqa: BLE001
        with open(os.path.join(os.path.dirname(sys.executable), "selftest.txt"), "w", encoding="utf-8") as f:
            f.write(f"NG {type(e).__name__}: {e}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
