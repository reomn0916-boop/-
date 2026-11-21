"""基準・ルールの画面：諸経費率・施工地域の補正・一般管理費等率の補正・最低制限価格の式・計算ルールを、ソフトの中で直す。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox, QFileDialog, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QTableWidget,
    QTableWidgetItem,
)

from . import calc, overhead_std, standards
from .gui_pages import _page
from .widgets import Banner, Card

OH_COLS = ["工種区分", "費目", "式", "A", "b", "対象額の下限", "上限", "出どころ", "例：5,000万円の率"]
AREA_COLS = ["施工地域区分", "共通仮設費率×", "現場管理費率×", "優先", "対象の工種区分（、区切り・空＝すべて）", "対象外の工種区分"]
TH_LABELS = {"基準価格_直接工事費": "直接工事費の係数", "基準価格_共通仮設費": "共通仮設費の係数", "基準価格_現場管理費": "現場管理費の係数",
             "基準価格_一般管理費等": "一般管理費等の係数", "基準価格_下限": "予定価格に対する下限", "基準価格_上限": "予定価格に対する上限",
             "基準価格の端数単位": "切り捨てる単位（円）"}


def _cell(text, editable=True, right=False) -> QTableWidgetItem:
    it = QTableWidgetItem("" if text is None else str(text))
    if not editable:
        it.setFlags(it.flags() & ~Qt.ItemIsEditable)
    if right:
        it.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
    return it


def _num(t: str) -> float:
    return float((t or "").replace(",", "").strip())


class StandardsPageMixin:
    def _page_standards(self):
        from .gui import _style_table
        w, v = _page()
        self.st_banner = Banner()
        v.addWidget(self.st_banner)
        top = QHBoxLayout()
        top.addWidget(QLabel("年度"))
        self.st_fy = QComboBox()
        self.st_fy.setEditable(True)
        self.st_fy.currentTextChanged.connect(lambda *_: self._refresh_standards())
        top.addWidget(self.st_fy)
        hint = QLabel("国や発注者の基準が変わったら、ここで直すか、新しい資料を読み込みます。入れた値はデータファイル（全員で共通）に"
                      "残り、ソフトに入っている値（既定）より優先されます。変更は「変更履歴」に残ります。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        top.addWidget(hint, 1)
        v.addLayout(top)

        # 諸経費率
        c1 = Card("諸経費率（共通仮設費・現場管理費・一般管理費等）",
                  "率＝A×対象額^b（power）、一般管理費等は A×log10(工事原価)＋b（log）。下限未満・上限超は境目の率。"
                  "国交省の「土木工事工事費積算要領及び基準の運用」（毎年2〜3月）のPDFを読み込むと、表の率で確かめてから入れ替えます。")
        self.st_oh = QTableWidget(0, len(OH_COLS))
        self.st_oh.setHorizontalHeaderLabels(OH_COLS)
        _style_table(self.st_oh)
        self.st_oh.setMinimumHeight(320)
        c1.lay.addWidget(self.st_oh)
        h1 = QHBoxLayout()
        for text, fn, primary in (("国交省の積算要領PDFを読み込む…", self._st_import_unyou, False),
                                  ("表のとおり保存", self._st_save_oh, True), ("この年度を既定に戻す", self._st_reset_oh, False)):
            b = QPushButton(text)
            if primary:
                b.setObjectName("Primary")
            b.clicked.connect(fn)
            h1.addWidget(b)
        h1.addStretch(1)
        c1.lay.addLayout(h1)
        v.addWidget(c1)

        # 施工地域の補正
        c2 = Card("施工地域の補正（共通仮設費率・現場管理費率に掛ける係数）",
                  "同じ区分に当てはまる行が複数あれば、優先の数字が小さい行を使います。行を足すときは表の下に書き足してください。")
        self.st_area = QTableWidget(0, len(AREA_COLS))
        self.st_area.setHorizontalHeaderLabels(AREA_COLS)
        _style_table(self.st_area)
        self.st_area.setMinimumHeight(260)
        c2.lay.addWidget(self.st_area)
        h2 = QHBoxLayout()
        for text, fn, primary in (("行を足す", lambda: self.st_area.insertRow(self.st_area.rowCount()), False),
                                  ("表のとおり保存", self._st_save_area, True), ("既定に戻す", self._st_reset_area, False)):
            b = QPushButton(text)
            if primary:
                b.setObjectName("Primary")
            b.clicked.connect(fn)
            h2.addWidget(b)
        h2.addStretch(1)
        c2.lay.addLayout(h2)
        v.addWidget(c2)

        # 一般管理費等率の補正
        c3 = Card("一般管理費等率の補正", "前払金支出割合（係数を掛ける）と契約保証（％を足す）。条件は金抜き設計書の表紙の書き方に含まれる言葉です。")
        self.st_gen = QTableWidget(0, 3)
        self.st_gen.setHorizontalHeaderLabels(["種類", "条件（表紙の言葉）", "値"])
        _style_table(self.st_gen)
        self.st_gen.setMinimumHeight(200)
        c3.lay.addWidget(self.st_gen)
        h3 = QHBoxLayout()
        for text, fn, primary in (("表のとおり保存", self._st_save_gen, True), ("既定に戻す", self._st_reset_gen, False)):
            b = QPushButton(text)
            if primary:
                b.setObjectName("Primary")
            b.clicked.connect(fn)
            h3.addWidget(b)
        h3.addStretch(1)
        c3.lay.addLayout(h3)
        v.addWidget(c3)

        # 最低制限価格
        c4 = Card("最低制限価格・調査基準価格の式（発注者ごと）",
                  "（直接工事費×係数＋共通仮設費×係数＋現場管理費×係数＋一般管理費等×係数）を予定価格（税抜）の下限〜上限に収め、"
                  "単位未満を切り捨てます。要綱・算定方法のPDFや文章を読み込むと、係数を読み取って入れます（保存する前に確かめてください）。")
        g = QGridLayout()
        g.addWidget(QLabel("発注者"), 0, 0)
        self.st_orderer = QComboBox()
        self.st_orderer.setEditable(True)
        self.st_orderer.currentTextChanged.connect(lambda *_: self._st_show_threshold())
        g.addWidget(self.st_orderer, 0, 1)
        self.st_th: dict[str, tuple[QLineEdit, QLabel]] = {}
        for i, k in enumerate(standards.THRESHOLD_KEYS, 1):
            e = QLineEdit()
            e.setMaximumWidth(140)
            src = QLabel()
            src.setObjectName("Muted")
            g.addWidget(QLabel(TH_LABELS[k]), i, 0)
            g.addWidget(e, i, 1)
            g.addWidget(src, i, 2)
            self.st_th[k] = (e, src)
        c4.lay.addLayout(g)
        h4 = QHBoxLayout()
        for text, fn, primary in (("要綱・資料を読み込む（PDF・テキスト）…", self._st_read_threshold, False),
                                  ("保存", self._st_save_threshold, True), ("既定に戻す", self._st_reset_threshold, False)):
            b = QPushButton(text)
            if primary:
                b.setObjectName("Primary")
            b.clicked.connect(fn)
            h4.addWidget(b)
        h4.addStretch(1)
        c4.lay.addLayout(h4)
        v.addWidget(c4)

        # 計算ルール
        c5 = Card("計算ルール（年度ごと）", "端数処理・消費税率など。値を変えて保存すると、その年度の工事に使います。")
        self.st_rules = QTableWidget(0, 4)
        self.st_rules.setHorizontalHeaderLabels(["項目", "値", "出どころ", "説明"])
        _style_table(self.st_rules)
        self.st_rules.setMinimumHeight(300)
        c5.lay.addWidget(self.st_rules)
        b5 = QPushButton("ルールを保存")
        b5.setObjectName("Primary")
        b5.clicked.connect(self._st_save_rules)
        h5 = QHBoxLayout()
        h5.addWidget(b5)
        h5.addStretch(1)
        c5.lay.addLayout(h5)
        v.addWidget(c5)
        v.addStretch(1)
        return w

    # ------------------------------------------------------------ 表示
    def _st_fy(self) -> str:
        return self.st_fy.currentText().strip() or "R8"

    def _refresh_standards(self) -> None:
        if not hasattr(self, "st_oh"):
            return
        fys = sorted({r[0] for r in self.conn.execute("SELECT DISTINCT fy FROM master_price UNION SELECT DISTINCT fy FROM "
                                                      "overhead_param UNION SELECT fy FROM project")} | set(overhead_std.STANDARD),
                     reverse=True)
        cur = self.st_fy.currentText() or (self._project_row()["fy"] if self._project_row() else fys[0])
        self.st_fy.blockSignals(True)
        self.st_fy.clear()
        self.st_fy.addItems(fys)
        self.st_fy.setCurrentText(cur)
        self.st_fy.blockSignals(False)
        fy = self._st_fy()
        rows = standards.overheads(self.conn, fy)
        self.st_oh.setRowCount(len(rows))
        for i, o in enumerate(rows):
            vals = [o.work_type, o.item, o.formula, f"{o.a:g}", f"{o.b:g}", f"{o.p_min:,.0f}", f"{o.p_max:,.0f}", o.source,
                    f"{o.rate(5e7):.2f}%"]
            for c, val in enumerate(vals):
                self.st_oh.setItem(i, c, _cell(val, editable=c not in (7, 8), right=c >= 3 and c != 7))
        self.st_oh.resizeColumnsToContents()
        area = standards.area_table(self.conn)
        self.st_area.setRowCount(len(area))
        for i, (lab, ct, sm, pr, only, excl) in enumerate(area):
            for c, val in enumerate([lab, f"{ct:g}", f"{sm:g}", str(pr), "、".join(sorted(only)) if only else "",
                                     "、".join(sorted(excl)) if excl else ""]):
                self.st_area.setItem(i, c, _cell(val, right=c in (1, 2, 3)))
        self.st_area.resizeColumnsToContents()
        adv, gua = standards.general_adjust_tables(self.conn)
        rows_g = [("前払金支出割合（係数）", k, v) for k, v in adv] + [("契約保証（％を加算）", k, v) for k, v in gua]
        self.st_gen.setRowCount(len(rows_g))
        for i, (kind, k, val) in enumerate(rows_g):
            self.st_gen.setItem(i, 0, _cell(kind, editable=False))
            self.st_gen.setItem(i, 1, _cell(k))
            self.st_gen.setItem(i, 2, _cell(f"{val:g}", right=True))
        self.st_gen.resizeColumnsToContents()
        cur_o = self.st_orderer.currentText()
        self.st_orderer.blockSignals(True)
        self.st_orderer.clear()
        self.st_orderer.addItems(self._orderers())
        self.st_orderer.setCurrentText(cur_o or "奈良県")
        self.st_orderer.blockSignals(False)
        self._st_show_threshold()
        rules = standards.year_rules(self.conn, fy)
        self.st_rules.setRowCount(len(rules))
        for i, (k, val, src, help_) in enumerate(rules):
            self.st_rules.setItem(i, 0, _cell(k, editable=False))
            self.st_rules.setItem(i, 1, _cell(val))
            self.st_rules.setItem(i, 2, _cell(src, editable=False))
            self.st_rules.setItem(i, 3, _cell(help_, editable=False))
        self.st_rules.resizeColumnsToContents()
        n_master = sum(o.source == "マスタ" for o in rows)
        self.st_banner.show_msg(f"{fy}年度：諸経費率 {len(rows)} 行（うちデータファイルで直したもの {n_master} 行）。"
                                "既定はソフトに入っている国交省・発注者の値です。", "info")

    def _st_show_threshold(self) -> None:
        o = self.st_orderer.currentText().strip()
        if not o:
            return
        for k, (val, src) in standards.threshold_rules(self.conn, o).items():
            e, lab = self.st_th[k]
            e.setText(val)
            lab.setText(src)

    # ------------------------------------------------------------ 諸経費率
    def _st_rows_oh(self) -> list:
        out = []
        for i in range(self.st_oh.rowCount()):
            t = [self.st_oh.item(i, c).text() if self.st_oh.item(i, c) else "" for c in range(7)]
            if not t[0].strip():
                continue
            out.append(standards.Overhead(t[0].strip(), t[1].strip(), t[2].strip(), _num(t[3]), _num(t[4]), _num(t[5]),
                                          _num(t[6]), "マスタ"))
        return out

    def _st_save_oh(self) -> None:
        try:
            rows = self._st_rows_oh()
        except ValueError:
            QMessageBox.warning(self, "諸経費率", "A・b・下限・上限は数字で入れてください。")
            return
        if self.guard(standards.save_overheads, self.conn, self._st_fy(), rows, "画面で直した") is not None:
            self._st_done("諸経費率を保存しました。")

    def _st_reset_oh(self) -> None:
        if QMessageBox.question(self, "諸経費率", f"{self._st_fy()}年度の諸経費率を、ソフトに入っている国交省の値に戻しますか？"
                                "（年度マスタで入れた諸経費.csv の分も消えます）") == QMessageBox.Yes:
            if self.guard(standards.reset_overheads, self.conn, self._st_fy()) is not None:
                self._st_done("諸経費率を既定に戻しました。")

    def _st_import_unyou(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "国交省「土木工事工事費積算要領及び基準の運用」", "", "PDF (*.pdf)")
        if not path:
            return
        try:
            u = standards.parse_unyou(path)
        except Exception as e:   # noqa: BLE001
            QMessageBox.warning(self, "諸経費率", f"読めませんでした：{e}")
            return
        n_rows = len([o for o in u.overheads if o.item != "一般管理費等"])
        if not n_rows:
            QMessageBox.warning(self, "諸経費率", "共通仮設費率・現場管理費率の表が見つかりませんでした。\n" + "\n".join(u.problems[:5]))
            return
        fy = u.fy or self._st_fy()
        msg = (f"{fy}年度として、{len({o.work_type for o in u.overheads})} 工種区分の諸経費率（{len(u.overheads)} 行）を読み取りました。"
               "表に載っている下限・上限の率と、式の計算が合うことを確かめてあります。")
        if u.problems:
            msg += "\n\n読めなかったもの・合わなかったもの（入れません）：\n" + "\n".join(f"・{p}" for p in u.problems[:8])
        if u.advance or u.guarantee:
            msg += "\n\n一般管理費等率の補正（前払金・契約保証）も入れ替えます。"
        if QMessageBox.question(self, "諸経費率", msg + "\n\n入れ替えますか？") != QMessageBox.Yes:
            return
        if self.guard(standards.apply_unyou, self.conn, fy, u, Path(path).name) is not None:
            self.st_fy.setCurrentText(fy)
            self._st_done(f"{fy}年度の諸経費率を入れ替えました。")

    # ------------------------------------------------------------ 施工地域・一般管理費
    def _st_save_area(self) -> None:
        rows = []
        try:
            for i in range(self.st_area.rowCount()):
                t = [self.st_area.item(i, c).text().strip() if self.st_area.item(i, c) else "" for c in range(6)]
                if not t[0]:
                    continue
                split = (lambda s: {x.strip() for x in s.replace(",", "、").split("、") if x.strip()} or None)
                rows.append((t[0], _num(t[1]), _num(t[2]), int(_num(t[3] or "9")), split(t[4]), split(t[5])))
        except ValueError:
            QMessageBox.warning(self, "施工地域の補正", "係数と優先は数字で入れてください。")
            return
        if self.guard(standards.set_area_table, self.conn, rows) is not None:
            self._st_done("施工地域の補正を保存しました。")

    def _st_reset_area(self) -> None:
        if self.guard(standards.set_area_table, self.conn, None) is not None:
            self._st_done("施工地域の補正を既定に戻しました。")

    def _st_save_gen(self) -> None:
        adv, gua = [], []
        try:
            for i in range(self.st_gen.rowCount()):
                kind = self.st_gen.item(i, 0).text()
                k = self.st_gen.item(i, 1).text().strip()
                val = _num(self.st_gen.item(i, 2).text())
                (adv if kind.startswith("前払") else gua).append((k, val))
        except (ValueError, AttributeError):
            QMessageBox.warning(self, "一般管理費等率の補正", "値は数字で入れてください。")
            return
        if self.guard(standards.set_general_adjust_tables, self.conn, adv, gua) is not None:
            self._st_done("一般管理費等率の補正を保存しました。")

    def _st_reset_gen(self) -> None:
        if self.guard(standards.set_general_adjust_tables, self.conn, None, None) is not None:
            self._st_done("一般管理費等率の補正を既定に戻しました。")

    # ------------------------------------------------------------ 最低制限価格
    def _st_read_threshold(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "最低制限価格の要綱・算定方法", "", "PDF・テキスト・HTML (*.pdf *.txt *.htm *.html)")
        if not path:
            return
        try:
            found = standards.parse_threshold_text(standards.read_text(path))
        except Exception as e:   # noqa: BLE001
            QMessageBox.warning(self, "最低制限価格", f"読めませんでした：{e}")
            return
        if not found:
            QMessageBox.warning(self, "最低制限価格", "係数が見つかりませんでした。数字を直接入れてください。")
            return
        for k, val in found.items():
            e, lab = self.st_th[k]
            e.setText(val)
            lab.setText(f"読み取り（{Path(path).name}）")
        self._st_threshold_source = Path(path).name
        missing = [TH_LABELS[k] for k in standards.THRESHOLD_KEYS if k not in found]
        QMessageBox.information(self, "最低制限価格", "読み取った値を入れました。確かめて「保存」を押してください。"
                                + (f"\n\n見つからなかったもの（今の値のまま）：{'、'.join(missing)}" if missing else ""))

    def _st_save_threshold(self) -> None:
        o = self.st_orderer.currentText().strip()
        if not o:
            QMessageBox.warning(self, "最低制限価格", "発注者を入れてください。")
            return
        values = {k: e.text().strip() for k, (e, _l) in self.st_th.items() if e.text().strip()}
        try:
            lo, hi = float(values["基準価格_下限"]), float(values["基準価格_上限"])
            if not 0 < lo <= hi <= 1:
                raise ValueError
        except (KeyError, ValueError):
            QMessageBox.warning(self, "最低制限価格", "下限・上限は 0〜1（例：0.75・0.92）で入れてください。")
            return
        if self.guard(standards.save_threshold_rules, self.conn, o, values,
                      getattr(self, "_st_threshold_source", "")) is not None:
            self._st_threshold_source = ""
            self._st_done(f"{o}の最低制限価格の式を保存しました。")

    def _st_reset_threshold(self) -> None:
        o = self.st_orderer.currentText().strip()
        if o and self.guard(standards.reset_threshold_rules, self.conn, o) is not None:
            self._st_done(f"{o}の最低制限価格の式を既定に戻しました。")

    # ------------------------------------------------------------ 計算ルール
    def _st_save_rules(self) -> None:
        values = {self.st_rules.item(i, 0).text(): self.st_rules.item(i, 1).text().strip()
                  for i in range(self.st_rules.rowCount())}
        if self.guard(standards.save_year_rules, self.conn, self._st_fy(), values) is not None:
            self._st_done("計算ルールを保存しました。")

    def _st_done(self, msg: str) -> None:
        self._refresh_standards()
        self.recalc()
        self.status.showMessage(msg + "（開いている工事を計算し直しました）", 8000)
