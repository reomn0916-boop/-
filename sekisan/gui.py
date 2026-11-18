"""画面（Windows用）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QFormLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow,
    QMessageBox, QPlainTextEdit, QPushButton, QTableWidget, QTableWidgetItem, QTabWidget, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QWidget,
)

from . import calc, db, importer, pipeline, settings
from .export import breakdown_rows

ITEM_COLS = ["No", "区分", "工種", "種別", "細別", "名称", "規格", "単位", "数量", "コード", "当てはめ", "単価", "金額",
             "積算根拠メモ"]
CAT_COL, CODE_COL, NOTE_COL = 1, 9, 13
EDITABLE = {CAT_COL, CODE_COL, NOTE_COL}


def _open_folder(path: Path) -> None:
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]


def _file_row(edit: QLineEdit, pick) -> QWidget:
    w = QWidget()
    h = QHBoxLayout(w)
    h.setContentsMargins(0, 0, 0, 0)
    b = QPushButton("選ぶ…")
    b.clicked.connect(pick)
    h.addWidget(edit)
    h.addWidget(b)
    return w


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("公共工事 積算アプリ")
        self.resize(1200, 760)
        self.conn = db.connect(settings.db_path())
        tabs = QTabWidget()
        tabs.addTab(self._tab_run(), "一括処理")
        tabs.addTab(self._tab_items(), "工事・明細")
        tabs.addTab(self._tab_tree(), "内訳書")
        tabs.addTab(self._tab_bid(), "入札検討")
        tabs.addTab(self._tab_master(), "マスタ")
        tabs.addTab(self._tab_verify(), "答え合わせ")
        tabs.addTab(self._tab_settings(), "設定")
        tabs.currentChanged.connect(lambda _: self._refresh_lists())
        self.setCentralWidget(tabs)
        self._refresh_lists()

    # ------------------------------------------------------------ 一括処理
    def _tab_run(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        f = QFormLayout()
        self.run_csv = QLineEdit()
        self.run_name = QLineEdit()
        self.run_fy = QComboBox(editable=True)
        self.run_work = QComboBox(editable=True)
        self.run_region = QLineEdit()
        self.run_out = QLineEdit(str(Path.home() / "Documents" / "積算出力"))
        f.addRow("設計書データ（CSV）", _file_row(self.run_csv, self._pick_run_csv))
        f.addRow("工事名", self.run_name)
        f.addRow("年度", self.run_fy)
        f.addRow("工種区分", self.run_work)
        f.addRow("地区", self.run_region)
        f.addRow("出力先", _file_row(self.run_out, lambda: self._pick_dir(self.run_out)))
        v.addLayout(f)
        b = QPushButton("取り込み → 計算 → 内訳書・実行予算を出力")
        b.setMinimumHeight(40)
        b.clicked.connect(self._do_run)
        v.addWidget(b)
        self.run_log = QPlainTextEdit(readOnly=True)
        v.addWidget(self.run_log)
        return w

    def _pick_run_csv(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "設計書データ", "", "CSV (*.csv);;すべて (*.*)")
        if p:
            self.run_csv.setText(p)
            if not self.run_name.text():
                self.run_name.setText(Path(p).stem)

    def _pick_dir(self, edit: QLineEdit) -> None:
        p = QFileDialog.getExistingDirectory(self, "フォルダを選ぶ", edit.text())
        if p:
            edit.setText(p)

    def _do_run(self) -> None:
        if not self.run_csv.text() or not self.run_fy.currentText():
            QMessageBox.warning(self, "入力不足", "設計書データと年度を入れてください")
            return
        try:
            res = pipeline.import_and_run(
                self.conn, self.run_csv.text(), self.run_name.text() or "無題", self.run_fy.currentText(),
                self.run_work.currentText(), self.run_out.text(), self.run_region.text(),
            )
        except Exception as e:  # 利用者に原因を見せる
            QMessageBox.critical(self, "エラー", str(e))
            return
        s = res["design"].summary
        lines = [f"■ {self.run_name.text()}"]
        lines += [f"  {n}: {a:,} 円" + (f"（{r:.2f}%）" if r is not None else "") for n, r, a in s.as_rows()]
        lines += [f"  出力: {p}" for p in res["files"]]
        unresolved = res["design"].unresolved
        if unresolved:
            lines.append(f"  ※ 歩掛・単価が当たっていない明細が {len(unresolved)} 件あります。「工事・明細」で当ててください。")
        lines += [f"  要確認: {x}" for x in res["design"].warnings]
        self.run_log.appendPlainText("\n".join(lines) + "\n")
        self._refresh_lists()
        _open_folder(Path(self.run_out.text()))

    # ------------------------------------------------------------ 工事・明細
    def _tab_items(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        h = QHBoxLayout()
        self.proj = QComboBox()
        self.proj.currentIndexChanged.connect(self._load_items)
        h.addWidget(QLabel("工事"))
        h.addWidget(self.proj, 1)
        b1 = QPushButton("再計算")
        b1.clicked.connect(self._load_items)
        b2 = QPushButton("Excelに出力")
        b2.clicked.connect(self._export_current)
        h.addWidget(b1)
        h.addWidget(b2)
        v.addLayout(h)
        v.addWidget(QLabel("「コード」に歩掛・施工パッケージ・単価のコードを入れると、次の工事から同じ名称・規格・単位に自動で当たります。"
                           "「積算根拠メモ」も次の工事に引き継がれます。「区分」は 直接／共通仮設／現場管理（積上げ分）。"))
        self.items = QTableWidget(0, len(ITEM_COLS))
        self.items.setHorizontalHeaderLabels(ITEM_COLS)
        self.items.itemChanged.connect(self._code_edited)
        v.addWidget(self.items, 1)
        self.items_sum = QLabel()
        self.items_sum.setTextInteractionFlags(Qt.TextSelectableByMouse)
        v.addWidget(self.items_sum)
        return w

    def _current_pid(self) -> int | None:
        return self.proj.currentData()

    def _load_items(self) -> None:
        pid = self._current_pid()
        self.items.blockSignals(True)
        self.items.setRowCount(0)
        if pid is None:
            self.items.blockSignals(False)
            self._load_tree(None)
            return
        res = calc.calculate(self.conn, pid)
        self._load_tree(res)
        self.items.setRowCount(len(res.items))
        for r, i in enumerate(res.items):
            vals = [i.seq, i.category, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, f"{i.qty:g}", i.code,
                    i.how, f"{i.unit_price:,.0f}", f"{i.amount:,}", i.note]
            for c, val in enumerate(vals):
                cell = QTableWidgetItem(str(val))
                if c not in EDITABLE:
                    cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
                cell.setData(Qt.UserRole, i.item_id)
                if i.how == "未設定":
                    cell.setBackground(Qt.yellow)
                self.items.setItem(r, c, cell)
        self.items.resizeColumnsToContents()
        self.items.blockSignals(False)
        s = res.summary
        self.items_sum.setText(
            f"直接工事費 {s.direct:,} 円　工事価格 {s.price:,} 円　工事費計 {s.total:,} 円　"
            f"未設定 {len(res.unresolved)} 件　調査基準価格の試算 {s.threshold:,} 円"
        )
        self.bid_in.clear()
        self._load_bid()

    def _code_edited(self, cell: QTableWidgetItem) -> None:
        item_id, text = cell.data(Qt.UserRole), cell.text().strip()
        if cell.column() == CODE_COL:
            calc.assign_code(self.conn, item_id, text, remember=True)
        elif cell.column() == NOTE_COL:
            calc.set_note(self.conn, item_id, text, remember=True)
        elif cell.column() == CAT_COL:
            calc.set_category(self.conn, item_id, importer.normalize_category(text))
        else:
            return
        self._load_items()

    def _export_current(self) -> None:
        pid = self._current_pid()
        if pid is None:
            return
        d = QFileDialog.getExistingDirectory(self, "出力先", self.run_out.text())
        if d:
            res = pipeline.run(self.conn, pid, d)
            QMessageBox.information(self, "出力しました", "\n".join(str(p) for p in res["files"]))

    # ------------------------------------------------------------ 内訳書（階層）
    def _tab_tree(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.addWidget(QLabel("「工事・明細」で選んだ工事の内訳書を、工種 → 種別 → 細別 の階層で表示します。"))
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["費目・工種・種別・細別", "規格", "単位", "数量", "単価", "金額", "摘要"])
        v.addWidget(self.tree, 1)
        return w

    def _load_tree(self, res: calc.Result | None) -> None:
        self.tree.clear()
        if res is None:
            return
        parents: dict[int, QTreeWidgetItem] = {}
        for depth, name, spec, unit, qty, price, amount, note in breakdown_rows(res):
            vals = [name, spec, unit, "" if qty is None else f"{qty:g}",
                    "" if price is None else f"{price:,.0f}", f"{amount:,}", note]
            node = QTreeWidgetItem(vals)
            for c in (3, 4, 5):
                node.setTextAlignment(c, Qt.AlignRight | Qt.AlignVCenter)
            parent = parents.get(depth - 1) if depth > 0 else None
            (parent.addChild(node) if parent else self.tree.addTopLevelItem(node))
            parents[depth] = node
            if depth == 0:
                f = node.font(0)
                f.setBold(True)
                for c in range(7):
                    node.setFont(c, f)
        self.tree.expandAll()
        for c in range(7):
            self.tree.resizeColumnToContents(c)

    # ------------------------------------------------------------ 入札検討
    def _tab_bid(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        h = QHBoxLayout()
        h.addWidget(QLabel("入札額（税抜・円）"))
        self.bid_in = QLineEdit()
        self.bid_in.setPlaceholderText("例: 1350000")
        h.addWidget(self.bid_in)
        b = QPushButton("検討する")
        b.clicked.connect(self._do_bid)
        h.addWidget(b)
        b2 = QPushButton("基準価格ちょうどにする")
        b2.clicked.connect(self._bid_at_threshold)
        h.addWidget(b2)
        v.addLayout(h)
        self.bid_out = QTableWidget(0, 3)
        self.bid_out.setHorizontalHeaderLabels(["項目", "金額（円）", "対予定価格"])
        v.addWidget(self.bid_out, 1)
        self.bid_note = QLabel("基準価格の式は年度のルール表（ルール.csv）で発注者ごとに変えられます。試算なので、必ず発注者の公表内容と照らしてください。")
        self.bid_note.setWordWrap(True)
        v.addWidget(self.bid_note)
        return w

    def _bid_at_threshold(self) -> None:
        pid = self._current_pid()
        if pid is not None:
            self.bid_in.setText(str(calc.calculate(self.conn, pid).summary.threshold))
            self._do_bid()

    def _do_bid(self) -> None:
        pid = self._current_pid()
        if pid is None:
            return
        try:
            bid = int(float(self.bid_in.text().replace(",", "") or 0))
        except ValueError:
            QMessageBox.warning(self, "入力", "入札額は数字で入れてください")
            return
        calc.set_bid(self.conn, pid, bid)
        self._load_bid()

    def _load_bid(self) -> None:
        pid = self._current_pid()
        self.bid_out.setRowCount(0)
        if pid is None:
            return
        p = self.conn.execute("SELECT bid_price FROM project WHERE id=?", (pid,)).fetchone()
        d = calc.calculate(self.conn, pid)
        c = calc.calculate(self.conn, pid, calc.COMPANY)
        bid = int(p["bid_price"] or 0)
        if bid and not self.bid_in.text():
            self.bid_in.setText(str(bid))
        b = calc.bid_check(d, c, bid)
        price = d.summary.price or 1
        rows = [("予定価格の見込み（工事価格）", b.planned), ("調査基準価格・最低制限価格の試算", b.threshold),
                ("実行原価の見込み", b.cost)]
        if bid:
            rows += [("入札額", bid), ("粗利の見込み（入札額 − 実行原価）", b.margin)]
        self.bid_out.setRowCount(len(rows))
        for r, (name, amt) in enumerate(rows):
            for col, val in enumerate([name, f"{amt:,}", f"{amt / price * 100:.2f}%"]):
                cell = QTableWidgetItem(val)
                if name == "入札額" and (b.below_threshold or b.over_planned):
                    cell.setBackground(Qt.yellow)
                self.bid_out.setItem(r, col, cell)
        self.bid_out.resizeColumnsToContents()
        if bid and b.below_threshold:
            self.bid_note.setText("⚠ 入札額が基準価格の試算を下回っています（失格・調査の対象になるおそれ）。")
        elif bid and b.over_planned:
            self.bid_note.setText("⚠ 入札額が予定価格の見込みを上回っています。")
        elif bid and b.margin < 0:
            self.bid_note.setText("⚠ 実行原価の見込みを下回る入札額です（赤字の見込み）。")
        else:
            self.bid_note.setText("基準価格の式は年度のルール表（ルール.csv）で発注者ごとに変えられます。試算なので、必ず発注者の公表内容と照らしてください。")

    # ------------------------------------------------------------ マスタ
    def _tab_master(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        f = QFormLayout()
        self.m_fy = QLineEdit("R8")
        self.m_dir = QLineEdit()
        f.addRow("年度", self.m_fy)
        f.addRow("マスタのフォルダ", _file_row(self.m_dir, lambda: self._pick_dir(self.m_dir)))
        v.addLayout(f)
        b = QPushButton("年度マスタを取り込む（同じ年度は入れ替え）")
        b.clicked.connect(self._do_master)
        v.addWidget(b)
        b2 = QPushButton("自社単価CSVを取り込む…")
        b2.clicked.connect(self._do_company)
        v.addWidget(b2)
        self.m_log = QPlainTextEdit(readOnly=True)
        v.addWidget(self.m_log, 1)
        return w

    def _do_master(self) -> None:
        try:
            counts = importer.import_master_folder(self.conn, self.m_fy.text().strip(), self.m_dir.text())
        except Exception as e:
            QMessageBox.critical(self, "エラー", str(e))
            return
        self.m_log.appendPlainText(f"{self.m_fy.text()}年度: {counts}")
        self._refresh_lists()

    def _do_company(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "自社単価", "", "CSV (*.csv)")
        if p:
            try:
                n = importer.import_company_prices(self.conn, p)
            except Exception as e:
                QMessageBox.critical(self, "エラー", str(e))
                return
            self.m_log.appendPlainText(f"自社単価 {n} 件を取り込みました")

    # ------------------------------------------------------------ 答え合わせ
    def _tab_verify(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        h = QHBoxLayout()
        self.v_proj = QComboBox()
        self.v_proj.currentIndexChanged.connect(self._load_checks)
        h.addWidget(QLabel("工事"))
        h.addWidget(self.v_proj, 1)
        b = QPushButton("過去の積算結果CSVを取り込む…")
        b.clicked.connect(self._do_reference)
        h.addWidget(b)
        v.addLayout(h)
        self.checks = QTableWidget(0, 4)
        self.checks.setHorizontalHeaderLabels(["項目", "今回の計算", "過去の結果", "差"])
        v.addWidget(self.checks, 1)
        self.v_label = QLabel()
        v.addWidget(self.v_label)
        return w

    def _do_reference(self) -> None:
        pid = self.v_proj.currentData()
        if pid is None:
            return
        p, _ = QFileDialog.getOpenFileName(self, "過去の積算結果", "", "CSV (*.csv)")
        if p:
            importer.import_reference(self.conn, pid, p)
            self._load_checks()

    def _load_checks(self) -> None:
        pid = self.v_proj.currentData()
        self.checks.setRowCount(0)
        if pid is None:
            return
        cs = pipeline.verify(self.conn, pid)
        self.checks.setRowCount(len(cs))
        for r, ch in enumerate(cs):
            for c, val in enumerate([ch.key, f"{ch.ours:,.0f}", f"{ch.reference:,.0f}", f"{ch.diff:,.0f}"]):
                cell = QTableWidgetItem(val)
                if not ch.ok:
                    cell.setBackground(Qt.yellow)
                self.checks.setItem(r, c, cell)
        ok = sum(ch.ok for ch in cs)
        self.v_label.setText(f"{ok}/{len(cs)} 一致" if cs else "過去の結果がまだありません")

    # ------------------------------------------------------------ 設定
    def _tab_settings(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        f = QFormLayout()
        self.s_db = QLineEdit(str(settings.db_path()))
        f.addRow("データファイル（社内の共有フォルダに置く）", _file_row(self.s_db, self._pick_db))
        v.addLayout(f)
        b = QPushButton("保存して開き直す")
        b.clicked.connect(self._save_settings)
        v.addWidget(b)
        v.addWidget(QLabel("全員が同じデータファイルを指すと、単価・対応表・過去の工事を共有できます。"))
        v.addStretch(1)
        return w

    def _pick_db(self) -> None:
        p, _ = QFileDialog.getSaveFileName(self, "データファイル", self.s_db.text(), "データ (*.sqlite)",
                                           options=QFileDialog.DontConfirmOverwrite)
        if p:
            self.s_db.setText(p)

    def _save_settings(self) -> None:
        s = settings.load()
        s["db_path"] = self.s_db.text()
        settings.save(s)
        self.conn.close()
        self.conn = db.connect(self.s_db.text())
        self._refresh_lists()
        QMessageBox.information(self, "保存しました", f"データファイル: {self.s_db.text()}")

    # ------------------------------------------------------------ 共通
    def _refresh_lists(self) -> None:
        fys = [r[0] for r in self.conn.execute("SELECT DISTINCT fy FROM master_price UNION SELECT DISTINCT fy FROM bukake ORDER BY 1 DESC")]
        works = [r[0] for r in self.conn.execute("SELECT DISTINCT work_type FROM overhead_param ORDER BY 1")]
        for combo, vals in ((self.run_fy, fys), (self.run_work, works)):
            cur = combo.currentText()
            combo.clear()
            combo.addItems(vals)
            if cur:
                combo.setCurrentText(cur)
        projects = list(self.conn.execute("SELECT id, name, fy, created_at FROM project ORDER BY id DESC"))
        for combo in (self.proj, self.v_proj):
            cur = combo.currentData()
            combo.blockSignals(True)
            combo.clear()
            for p in projects:
                combo.addItem(f"{p['name']}（{p['fy']}・{p['created_at'][:10]}）", p["id"])
            if cur is not None:
                idx = combo.findData(cur)
                if idx >= 0:
                    combo.setCurrentIndex(idx)
            combo.blockSignals(False)
        self._load_items()
        self._load_checks()


def run_gui() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
