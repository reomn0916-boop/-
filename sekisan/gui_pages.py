"""追加した画面：工事の設定・設計変更・照合・変更履歴・見積単価・落札実績。
MainWindow に混ぜて使う（self.conn / self.pid / self.design などは MainWindow 側にある）。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QDate, Qt
from PySide6.QtGui import QBrush, QFont
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDateEdit, QDialog, QDialogButtonBox, QDoubleSpinBox, QFileDialog, QFormLayout,
    QGridLayout, QHBoxLayout, QHeaderView, QInputDialog, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMessageBox, QPushButton, QSplitter, QTableWidget, QVBoxLayout, QWidget,
)

from . import audit, awards, calc, change, export, pdfcheck, quotes
from .theme import C, color
from .widgets import Banner, Card, Kpi, Pill, RegionBox, path_row, yen

STATUS_TONE = {"作成中": "", "確認済": "ok", "提出済": "info"}
CHANGE_TONE = {"増": "warn", "減": "info", "新規": "ok", "削除": "bad", "単価": "warn", "同じ": ""}


def _page(margins: int = 24) -> tuple[QWidget, QVBoxLayout]:
    w = QWidget()
    v = QVBoxLayout(w)
    v.setContentsMargins(margins, 20, margins, 20)
    v.setSpacing(14)
    return w, v


def _table(headers: list[str], stretch: int | None = None) -> QTableWidget:
    from .gui import _style_table
    t = QTableWidget(0, len(headers))
    t.setHorizontalHeaderLabels(headers)
    _style_table(t)
    t.setEditTriggers(QTableWidget.NoEditTriggers)
    if stretch is not None:
        t.horizontalHeader().setSectionResizeMode(stretch, QHeaderView.Stretch)
    return t


def _set_row(t: QTableWidget, r: int, vals: list, right: set[int] = frozenset(), tone: str = "",
             tone_col: int | None = None) -> None:
    from .gui import _ro_item
    for c, v in enumerate(vals):
        cell = _ro_item("" if v is None else str(v), c in right)
        if tone and tone_col is not None and c == tone_col:
            cell.setForeground(QBrush(color({"ok": "ok", "bad": "bad", "warn": "warn", "info": "accent"}[tone])))
            f = QFont()
            f.setBold(True)
            cell.setFont(f)
        if tone == "bad":
            cell.setBackground(QBrush(color("bad_soft")))
        t.setItem(r, c, cell)


def _date(s: str) -> QDate:
    d = QDate.fromString(s, "yyyy-MM-dd")
    return d if d.isValid() else QDate.currentDate()


class AddItemDialog(QDialog):
    def __init__(self, parent, candidates: list[str]) -> None:
        super().__init__(parent)
        self.setWindowTitle("行を追加")
        self.setMinimumWidth(460)
        f = QFormLayout(self)
        self.f = {k: QLineEdit() for k in ("level1", "level2", "level3", "name", "spec", "unit", "qty", "code")}
        from PySide6.QtWidgets import QCompleter
        comp = QCompleter(candidates, self)
        comp.setFilterMode(Qt.MatchContains)
        self.f["code"].setCompleter(comp)
        self.cat = QComboBox()
        self.cat.addItems(list(calc.CATEGORIES))
        for k, label in (("level1", "工種"), ("level2", "種別"), ("level3", "細別"), ("name", "名称"), ("spec", "規格"),
                         ("unit", "単位"), ("qty", "数量"), ("code", "コード")):
            f.addRow(label, self.f[k])
        f.addRow("区分", self.cat)
        bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        bb.button(QDialogButtonBox.Ok).setText("追加")
        bb.button(QDialogButtonBox.Cancel).setText("やめる")
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        f.addRow(bb)

    def values(self) -> dict:
        v = {k: e.text().strip() for k, e in self.f.items()}
        v["qty"] = float(v["qty"].replace(",", "") or 0)
        v["code"] = v["code"].split("　")[0]
        v["category"] = self.cat.currentText()
        return v


class PagesMixin:
    # ================================================================ 共通
    def guard(self, fn, *args, **kw):
        """ロック中・権限なしなどを画面に出す。"""
        try:
            r = fn(*args, **kw)
            return True if r is None else r
        except (audit.Locked, PermissionError, ValueError) as e:
            QMessageBox.warning(self, "できませんでした", str(e))
            return None

    # ================================================================ 工事の設定
    def _page_project(self) -> QWidget:
        w, v = _page()
        row = QHBoxLayout()
        row.setSpacing(16)

        info = Card("工事の情報")
        f = QFormLayout()
        f.setVerticalSpacing(10)
        self.ps_name = QLineEdit()
        self.ps_fy = QComboBox()
        self.ps_fy.setEditable(True)
        self.ps_work = QComboBox()
        self.ps_work.setEditable(True)
        self.ps_region = RegionBox()
        self.ps_orderer = QComboBox()
        self.ps_orderer.setEditable(True)
        self.ps_use_date = QCheckBox("単価の適用日を指定する（単価改定を反映）")
        self.ps_date = QDateEdit()
        self.ps_date.setCalendarPopup(True)
        self.ps_date.setDisplayFormat("yyyy-MM-dd")
        self.ps_use_date.toggled.connect(self.ps_date.setEnabled)
        f.addRow("工事名", self.ps_name)
        f.addRow("年度", self.ps_fy)
        f.addRow("工種区分", self.ps_work)
        f.addRow("地区", self.ps_region)
        f.addRow("発注者", self.ps_orderer)
        f.addRow("", self.ps_use_date)
        f.addRow("単価の適用日", self.ps_date)
        info.lay.addLayout(f)
        b = QPushButton("保存")
        b.setObjectName("Primary")
        b.clicked.connect(self._save_project_info)
        info.lay.addWidget(b, 0, Qt.AlignRight)
        row.addWidget(info, 3)

        cond = Card("補正・割増（工事全体）", "チェックした条件が、歩掛の労務・機械・材料や諸経費率に掛かります。"
                    "1行だけに効かせたいときは「明細」の「補正」欄に書きます。")
        self.ps_conds = QListWidget()
        self.ps_conds.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 6px 2px; }")
        cond.lay.addWidget(self.ps_conds, 1)
        b2 = QPushButton("補正を保存")
        b2.setObjectName("Primary")
        b2.clicked.connect(self._save_conditions)
        cond.lay.addWidget(b2, 0, Qt.AlignRight)
        row.addWidget(cond, 3)
        v.addLayout(row)

        row2 = QHBoxLayout()
        row2.setSpacing(16)
        chk = Card("確認と提出", "作った人とは別の人が「確認済」にし、提出したらロックします。"
                   "確認済のあとに中身を変えると、確認はやり直しになります。")
        self.ps_status = Pill()
        self.ps_people = QLabel()
        self.ps_people.setObjectName("Muted")
        sh = QHBoxLayout()
        sh.addWidget(self.ps_status)
        sh.addWidget(self.ps_people, 1)
        chk.lay.addLayout(sh)
        bh = QHBoxLayout()
        self.ps_check = QPushButton("確認済にする")
        self.ps_check.setObjectName("Primary")
        self.ps_check.clicked.connect(lambda: self._status_action("check"))
        self.ps_submit = QPushButton("提出済にする（ロック）")
        self.ps_submit.clicked.connect(lambda: self._status_action("submit"))
        self.ps_unlock = QPushButton("ロックを解除…")
        self.ps_unlock.clicked.connect(lambda: self._status_action("unlock"))
        for x in (self.ps_check, self.ps_submit, self.ps_unlock):
            bh.addWidget(x)
        bh.addStretch(1)
        chk.lay.addLayout(bh)
        row2.addWidget(chk, 3)

        chg = Card("設計変更", "この工事を元に「第n回変更」を作ります。当初との対比は「設計変更」で見られます。")
        ch = QHBoxLayout()
        c1 = QPushButton("この工事を複製して変更を作る")
        c1.setObjectName("Primary")
        c1.clicked.connect(lambda: self._make_change(False))
        c2 = QPushButton("変更設計書CSVから作る…")
        c2.clicked.connect(lambda: self._make_change(True))
        ch.addWidget(c1)
        ch.addWidget(c2)
        ch.addStretch(1)
        chg.lay.addLayout(ch)
        row2.addWidget(chg, 3)
        v.addLayout(row2)
        v.addStretch(1)
        return w

    def _refresh_project_page(self) -> None:
        p = self._project_row()
        for wdg in (self.ps_name, self.ps_region):
            wdg.setEnabled(p is not None)
        if not p:
            self.ps_conds.clear()
            return
        fys = [r[0] for r in self.conn.execute(
            "SELECT DISTINCT fy FROM master_price UNION SELECT DISTINCT fy FROM bukake ORDER BY 1 DESC")]
        works = [r[0] for r in self.conn.execute("SELECT DISTINCT work_type FROM overhead_param ORDER BY 1")]
        orderers = self._orderers()
        for combo, vals, cur in ((self.ps_fy, fys, p["fy"]), (self.ps_work, works, p["work_type"]),
                                 (self.ps_orderer, orderers, p["orderer"])):
            combo.clear()
            combo.addItems(vals)
            combo.setCurrentText(cur)
        self.ps_name.setText(p["name"])
        self.ps_region.setText(p["region"])
        self.ps_use_date.setChecked(bool(p["price_date"]))
        self.ps_date.setEnabled(bool(p["price_date"]))
        self.ps_date.setDate(_date(p["price_date"]))
        # 補正の一覧（年度の補正表から）
        self.ps_conds.clear()
        current = set(calc.project_conditions(self.conn, self.pid))
        adj: dict[str, list] = {}
        for a in self.conn.execute("SELECT * FROM adjustment WHERE fy=? ORDER BY code", (p["fy"],)):
            adj.setdefault(a["code"], []).append(a)
        for code, rows in adj.items():
            desc = "、".join(f"{a['target']}×{a['factor']:g}" + (f"（{a['bukake_code']}のみ）" if a["bukake_code"] else "")
                            for a in rows)
            it = QListWidgetItem(f"{rows[0]['name']}　—　{desc}")
            it.setData(Qt.UserRole, code)
            it.setFlags(it.flags() | Qt.ItemIsUserCheckable)
            it.setCheckState(Qt.Checked if code in current else Qt.Unchecked)
            self.ps_conds.addItem(it)
        if not adj:
            it = QListWidgetItem("この年度の補正表（補正.csv）がまだ取り込まれていません")
            it.setFlags(Qt.NoItemFlags)
            self.ps_conds.addItem(it)
        st = p["status"] or "作成中"
        self.ps_status.setText(st)
        self.ps_status.set_tone(STATUS_TONE.get(st, ""))
        people = f"作成: {p['created_by'] or '—'}"
        if p["checked_by"]:
            people += f"　確認: {p['checked_by']}（{p['checked_at'][:16]}）"
        people += f"　いまの担当者: {audit.current_user()}"
        self.ps_people.setText(people)
        self.ps_check.setEnabled(st == "作成中")
        self.ps_submit.setEnabled(st == "確認済")
        self.ps_unlock.setEnabled(st == "提出済")

    def _orderers(self) -> list[str]:
        return [r[0] for r in self.conn.execute(
            "SELECT orderer FROM orderer_rule UNION SELECT orderer FROM award WHERE orderer<>'' "
            "UNION SELECT orderer FROM project WHERE orderer<>'' ORDER BY 1")]

    def _save_project_info(self) -> None:
        if self.pid is None:
            return
        ok = self.guard(calc.set_project_fields, self.conn, self.pid,
                        name=self.ps_name.text().strip() or "無題", fy=self.ps_fy.currentText().strip(),
                        work_type=self.ps_work.currentText().strip(), region=self.ps_region.text().strip(),
                        orderer=self.ps_orderer.currentText().strip(),
                        price_date=self.ps_date.date().toString("yyyy-MM-dd") if self.ps_use_date.isChecked() else "")
        if ok is None and self._project_row()["status"] == "提出済":
            return
        self._load_projects(select=self.pid)
        self.status.showMessage("工事の情報を保存しました", 3000)

    def _save_conditions(self) -> None:
        if self.pid is None:
            return
        codes = [self.ps_conds.item(i).data(Qt.UserRole) for i in range(self.ps_conds.count())
                 if self.ps_conds.item(i).data(Qt.UserRole) and self.ps_conds.item(i).checkState() == Qt.Checked]
        if self.guard(calc.set_project_conditions, self.conn, self.pid, codes) is None and \
                self._project_row()["status"] == "提出済":
            return
        self.recalc()
        self.status.showMessage("補正を保存しました", 3000)

    def _status_action(self, what: str) -> None:
        if self.pid is None:
            return
        if what == "check":
            self.guard(audit.mark_checked, self.conn, self.pid)
        elif what == "submit":
            if QMessageBox.question(self, "提出済にする", "提出済にすると、この工事は変更できなくなります。よろしいですか？") \
                    == QMessageBox.Yes:
                self.guard(audit.submit, self.conn, self.pid)
        else:
            reason, ok = QInputDialog.getText(self, "ロックを解除", "解除する理由（履歴に残ります）")
            if ok:
                self.guard(audit.unlock, self.conn, self.pid, reason)
        self.recalc()

    def _make_change(self, from_csv: bool) -> None:
        if self.pid is None:
            return
        path = None
        if from_csv:
            path, _ = QFileDialog.getOpenFileName(self, "変更設計書", "", "CSV (*.csv)")
            if not path:
                return
        new_id = self.guard(change.create_change, self.conn, self.pid, path)
        if new_id:
            self._load_projects(select=new_id)
            self.go("change")

    # ================================================================ 設計変更・スライド
    def _page_change(self) -> QWidget:
        w, v = _page()
        self.ch_banner = Banner()
        v.addWidget(self.ch_banner)
        krow = QHBoxLayout()
        krow.setSpacing(12)
        self.ch_k0 = Kpi("変更前の工事価格")
        self.ch_k1 = Kpi("変更後の工事価格")
        self.ch_kd = Kpi("増減")
        self.ch_kn = Kpi("変わった行")
        for k in (self.ch_k0, self.ch_k1, self.ch_kd, self.ch_kn):
            krow.addWidget(k)
        v.addLayout(krow)
        bar = QHBoxLayout()
        self.ch_only = QCheckBox("変わった行だけ表示")
        self.ch_only.setChecked(True)
        self.ch_only.toggled.connect(self._refresh_change)
        bar.addWidget(self.ch_only)
        bar.addStretch(1)
        mk = QPushButton("この工事から次の変更を作る")
        mk.clicked.connect(lambda: self._make_change(False))
        ex = QPushButton("変更対比表をExcelに出力")
        ex.setObjectName("Primary")
        ex.clicked.connect(self._export_change)
        bar.addWidget(mk)
        bar.addWidget(ex)
        v.addLayout(bar)
        self.ch_table = _table(["区分", "工種", "名称", "規格", "単位", "変更前", "変更後", "増減", "変更前の金額",
                                "変更後の金額", "増減額"], 2)
        v.addWidget(self.ch_table, 1)

        sl = Card("スライド（物価変動）の目安", "残工事の直接工事費を、2つの時点の単価（単価改定.csv）で積算し直して比べます。"
                  "受注者の負担（既定は1.5%）を超えた分がスライド額の目安です。")
        g = QHBoxLayout()
        g.setSpacing(10)
        self.sl_from = QDateEdit(QDate.currentDate().addMonths(-6))
        self.sl_to = QDateEdit(QDate.currentDate())
        for d in (self.sl_from, self.sl_to):
            d.setCalendarPopup(True)
            d.setDisplayFormat("yyyy-MM-dd")
        self.sl_rem = QDoubleSpinBox()
        self.sl_rem.setRange(0, 100)
        self.sl_rem.setValue(100)
        self.sl_rem.setSuffix(" %")
        for label, wdg in (("変動前の時点", self.sl_from), ("変動後の時点", self.sl_to), ("残工事の割合", self.sl_rem)):
            lab = QLabel(label)
            lab.setObjectName("Muted")
            g.addWidget(lab)
            g.addWidget(wdg)
        b = QPushButton("計算する")
        b.setObjectName("Primary")
        b.clicked.connect(self._do_slide)
        g.addWidget(b)
        g.addStretch(1)
        sl.lay.addLayout(g)
        sk = QHBoxLayout()
        self.sl_k1 = Kpi("変動前の残工事費")
        self.sl_k2 = Kpi("変動後の残工事費")
        self.sl_kc = Kpi("変動額")
        self.sl_ks = Kpi("スライド額の目安")
        for k in (self.sl_k1, self.sl_k2, self.sl_kc, self.sl_ks):
            sk.addWidget(k)
        sl.lay.addLayout(sk)
        v.addWidget(sl)
        return w

    def _refresh_change(self) -> None:
        self.ch_table.setRowCount(0)
        comp = change.compare(self.conn, self.pid) if self.pid is not None else None
        if not comp:
            self.ch_banner.show_msg("この工事は当初の工事です。「この工事から次の変更を作る」を押すと、複製して第1回変更を作ります。"
                                    "変更の工事を選ぶと、元の工事との対比が出ます。", "info")
            for k in (self.ch_k0, self.ch_k1, self.ch_kd, self.ch_kn):
                k.set("—")
            return
        before = self.conn.execute("SELECT name FROM project WHERE id=?", (comp.before_id,)).fetchone()["name"]
        self.ch_banner.show_msg(f"「{before}」と比べています。", "info")
        b, a = comp.before.price, comp.after.price
        self.ch_k0.set(f"¥{yen(b)}")
        self.ch_k1.set(f"¥{yen(a)}")
        d = a - b
        self.ch_kd.set(f"{'+' if d >= 0 else '−'}¥{yen(abs(d))}", f"{d / b * 100:+.2f}%" if b else "",
                       "warn" if d else "")
        changed = [r for r in comp.rows if r.status != "同じ"]
        self.ch_kn.set(f"{len(changed)} 行", f"全 {len(comp.rows)} 行")
        rows = changed if self.ch_only.isChecked() else comp.rows
        self.ch_table.setRowCount(len(rows))
        for i, r in enumerate(rows):
            dq = None if r.qty0 is None or r.qty1 is None else r.qty1 - r.qty0
            _set_row(self.ch_table, i, [
                r.status, r.level1, r.name, r.spec, r.unit,
                "" if r.qty0 is None else f"{r.qty0:g}", "" if r.qty1 is None else f"{r.qty1:g}",
                "" if dq is None else f"{dq:+g}", yen(r.amount0), yen(r.amount1),
                ("+" if r.diff > 0 else "") + yen(r.diff),
            ], right={5, 6, 7, 8, 9, 10}, tone=CHANGE_TONE.get(r.status, ""), tone_col=0)
        for c, wd in enumerate([60, 110, 160, 160, 50, 80, 80, 80, 110, 110, 110]):
            self.ch_table.setColumnWidth(c, wd)

    def _export_change(self) -> None:
        comp = change.compare(self.conn, self.pid) if self.pid is not None else None
        if not comp:
            return
        path, _ = QFileDialog.getSaveFileName(self, "変更対比表", str(Path(self.n_out.text()) / "変更対比表.xlsx"),
                                              "Excel (*.xlsx)")
        if path:
            export.export_change(path, dict(self._project_row()), comp)
            self.status.showMessage(f"出力しました: {path}", 5000)

    def _do_slide(self) -> None:
        if self.pid is None:
            return
        r = change.slide(self.conn, self.pid, self.sl_from.date().toString("yyyy-MM-dd"),
                         self.sl_to.date().toString("yyyy-MM-dd"), self.sl_rem.value() / 100)
        self.sl_k1.set(f"¥{yen(r.p1)}", r.date_from)
        self.sl_k2.set(f"¥{yen(r.p2)}", r.date_to)
        pct = r.change / r.p1 * 100 if r.p1 else 0
        self.sl_kc.set(f"{'+' if r.change >= 0 else '−'}¥{yen(abs(r.change))}", f"{pct:+.2f}%（負担 ¥{yen(r.burden)}）")
        self.sl_ks.set(f"¥{yen(r.slide)}", "負担を超えた分" if r.slide else "負担の範囲内（請求なし）",
                       "ok" if r.slide else "")

    # ================================================================ 照合（PDF）
    def _pdf_card(self) -> Card:
        c = Card("金抜き設計書PDFと照合", "PDFの文字から各明細の名称と数量を探し、取り込んだCSVと食い違いがないか確かめます。"
                 "（スキャンした画像のPDFは読めません）")
        h = QHBoxLayout()
        b = QPushButton("PDFを選ぶ…")
        b.setObjectName("Primary")
        b.clicked.connect(self._do_pdf)
        q = QPushButton("食い違いを質疑書へ")
        q.clicked.connect(self._inquiry_from_pdf)
        h.addWidget(b)
        h.addWidget(q)
        h.addStretch(1)
        c.lay.addLayout(h)
        return c

    def _pdf_table(self) -> QTableWidget:
        self.pdf_table = _table(["No", "名称", "規格", "単位", "CSVの数量", "PDFの数量", "判定", "PDFの行"], 7)
        return self.pdf_table

    def _do_pdf(self) -> None:
        if not self.design:
            return
        p, _ = QFileDialog.getOpenFileName(self, "金抜き設計書PDF", "", "PDF (*.pdf)")
        if not p:
            return
        try:
            res = pdfcheck.check_pdf(self.design.items, p)
        except Exception as e:
            QMessageBox.warning(self, "照合できませんでした", str(e))
            return
        self.show_pdf_result(res)

    def show_pdf_result(self, res: list[pdfcheck.PdfCheck]) -> None:
        self.last_pdf = res
        tone = {"一致": "ok", "数量違い": "bad", "見つからない": "warn"}
        self.pdf_table.setRowCount(len(res))
        for i, r in enumerate(res):
            _set_row(self.pdf_table, i, [r.seq, r.name, r.spec, r.unit, f"{r.qty:g}",
                                         "" if r.pdf_qty is None else f"{r.pdf_qty:g}", r.status, r.line],
                     right={0, 4, 5}, tone=tone[r.status], tone_col=6)
        for c, wd in enumerate([40, 130, 140, 50, 80, 80, 90]):
            self.pdf_table.setColumnWidth(c, wd)
        bad = sum(r.status != "一致" for r in res)
        self.v_pdf.set(f"{len(res) - bad} / {len(res)}", "すべて一致" if not bad else f"{bad} 行を確認してください",
                       "ok" if not bad else "bad")

    # ================================================================ 変更履歴
    def _page_history(self) -> QWidget:
        w, v = _page()
        bar = QHBoxLayout()
        self.h_all = QCheckBox("すべての工事・マスタの履歴を表示")
        self.h_all.toggled.connect(self._refresh_history)
        bar.addWidget(self.h_all)
        bar.addStretch(1)
        v.addLayout(bar)
        self.h_table = _table(["日時", "担当者", "工事", "操作", "内容"], 4)
        v.addWidget(self.h_table, 1)
        return w

    def _refresh_history(self) -> None:
        rows = audit.history(self.conn, None if self.h_all.isChecked() else self.pid)
        names = {r["id"]: r["name"] for r in self.conn.execute("SELECT id, name FROM project")}
        self.h_table.setRowCount(len(rows))
        for i, r in enumerate(rows):
            tone = "warn" if r["action"] in ("ロックを解除", "行を削除") else ""
            _set_row(self.h_table, i, [r["ts"], r["user"], names.get(r["project_id"], "—"), r["action"], r["detail"]],
                     tone=tone, tone_col=3)
        for c, wd in enumerate([140, 100, 200, 140]):
            self.h_table.setColumnWidth(c, wd)

    # ================================================================ 見積単価
    def _page_quotes(self) -> QWidget:
        w, v = _page()
        split = QSplitter(Qt.Horizontal)
        left = Card("見積単価の一覧", "単価表にない資材・工種。明細や歩掛のコードに使えます。")
        self.q_table = _table(["コード", "名称", "規格", "単位", "決め方", "採用単価", "見積"], 1)
        self.q_table.currentCellChanged.connect(lambda *_: self._show_quote())
        left.lay.addWidget(self.q_table, 1)
        lb = QHBoxLayout()
        nb = QPushButton("新しい見積単価")
        nb.clicked.connect(self._new_quote)
        db_ = QPushButton("削除")
        db_.clicked.connect(self._delete_quote)
        lb.addWidget(nb)
        lb.addWidget(db_)
        lb.addStretch(1)
        left.lay.addLayout(lb)
        split.addWidget(left)

        right = Card("見積の比較")
        f = QGridLayout()
        f.setHorizontalSpacing(10)
        f.setVerticalSpacing(8)
        self.q_code, self.q_name, self.q_spec, self.q_unit = QLineEdit(), QLineEdit(), QLineEdit(), QLineEdit()
        self.q_rule = QComboBox()
        self.q_rule.addItems(list(quotes.RULES))
        self.q_fixed = QLineEdit()
        self.q_fixed.setPlaceholderText("決め方が「指定」のとき")
        self.q_note = QLineEdit()
        for i, (lab, wdg) in enumerate((("コード", self.q_code), ("名称", self.q_name), ("規格", self.q_spec),
                                        ("単位", self.q_unit), ("決め方", self.q_rule), ("指定単価", self.q_fixed))):
            ll = QLabel(lab)
            ll.setObjectName("Muted")
            f.addWidget(ll, i // 2, (i % 2) * 2)
            f.addWidget(wdg, i // 2, (i % 2) * 2 + 1)
        ll = QLabel("備考")
        ll.setObjectName("Muted")
        f.addWidget(ll, 3, 0)
        f.addWidget(self.q_note, 3, 1, 1, 3)
        right.lay.addLayout(f)
        sb = QPushButton("保存")
        sb.setObjectName("Primary")
        sb.clicked.connect(self._save_quote)
        right.lay.addWidget(sb, 0, Qt.AlignRight)
        self.q_adopted = QLabel()
        self.q_adopted.setObjectName("Big")
        right.lay.addWidget(self.q_adopted)
        self.q_offers = _table(["業者", "単価", "日付", "見積書"], 3)
        self.q_offers.cellDoubleClicked.connect(self._open_offer_file)
        right.lay.addWidget(self.q_offers, 1)
        oh = QHBoxLayout()
        self.o_vendor, self.o_price = QLineEdit(), QLineEdit()
        self.o_vendor.setPlaceholderText("業者名")
        self.o_price.setPlaceholderText("単価")
        self.o_date = QDateEdit(QDate.currentDate())
        self.o_date.setCalendarPopup(True)
        self.o_date.setDisplayFormat("yyyy-MM-dd")
        self.o_file = QLineEdit()
        self.o_file.setPlaceholderText("見積書ファイル（任意）")
        ab = QPushButton("見積を追加")
        ab.clicked.connect(self._add_offer)
        rb = QPushButton("選んだ見積を削除")
        rb.clicked.connect(self._delete_offer)
        oh.addWidget(self.o_vendor, 2)
        oh.addWidget(self.o_price, 1)
        oh.addWidget(self.o_date)
        right.lay.addLayout(oh)
        oh2 = QHBoxLayout()
        oh2.addWidget(path_row(self.o_file, self._pick_offer_file), 1)
        oh2.addWidget(ab)
        oh2.addWidget(rb)
        right.lay.addLayout(oh2)
        split.addWidget(right)
        split.setSizes([620, 620])
        v.addWidget(split, 1)
        return w

    def _refresh_quotes(self, select: str | None = None) -> None:
        qs = quotes.all_quotes(self.conn)
        cur = select or (self.q_code.text().strip() if hasattr(self, "q_code") else "")
        self.q_table.blockSignals(True)
        self.q_table.setRowCount(len(qs))
        sel_row = -1
        for i, q in enumerate(qs):
            _set_row(self.q_table, i, [q.code, q.name, q.spec, q.unit, q.rule,
                                       "—" if q.adopted is None else yen(q.adopted), len(q.offers)], right={5, 6})
            if q.code == cur:
                sel_row = i
        self.q_table.blockSignals(False)
        for c, wd in enumerate([70, 170, 90, 50, 60, 80, 50]):
            self.q_table.setColumnWidth(c, wd)
        if sel_row >= 0:
            self.q_table.selectRow(sel_row)
        self._show_quote()

    def _show_quote(self) -> None:
        r = self.q_table.currentRow()
        code = self.q_table.item(r, 0).text() if r >= 0 and self.q_table.item(r, 0) else ""
        q = quotes.get(self.conn, code) if code else None
        self.q_offers.setRowCount(0)
        if not q:
            self.q_adopted.setText("")
            return
        self.q_code.setText(q.code)
        self.q_name.setText(q.name)
        self.q_spec.setText(q.spec)
        self.q_unit.setText(q.unit)
        self.q_rule.setCurrentText(q.rule)
        self.q_fixed.setText(f"{q.fixed_price:g}" if q.fixed_price else "")
        self.q_note.setText(q.note)
        self.q_adopted.setText("採用単価 —" if q.adopted is None else f"採用単価 ¥{yen(q.adopted)} / {q.unit}")
        self.q_offers.setRowCount(len(q.offers))
        low = min((o["price"] for o in q.offers), default=None)
        for i, o in enumerate(q.offers):
            _set_row(self.q_offers, i, [o["vendor"], yen(o["price"]), o["date"], Path(o["file"]).name if o["file"] else ""],
                     right={1}, tone="ok" if o["price"] == low else "", tone_col=1)
            self.q_offers.item(i, 0).setData(Qt.UserRole, o["id"])
            self.q_offers.item(i, 3).setData(Qt.UserRole, o["file"])
        for c, wd in enumerate([160, 100, 100]):
            self.q_offers.setColumnWidth(c, wd)

    def _new_quote(self) -> None:
        for e in (self.q_code, self.q_name, self.q_spec, self.q_unit, self.q_fixed, self.q_note):
            e.clear()
        self.q_rule.setCurrentIndex(0)
        self.q_table.clearSelection()
        self.q_offers.setRowCount(0)
        self.q_adopted.setText("")
        self.q_code.setFocus()

    def _save_quote(self) -> None:
        code = self.q_code.text().strip()
        if not code or not self.q_name.text().strip():
            QMessageBox.warning(self, "入力", "コードと名称を入れてください")
            return
        try:
            fixed = float(self.q_fixed.text().replace(",", "") or 0)
        except ValueError:
            fixed = 0
        self.guard(quotes.save, self.conn, code, self.q_name.text().strip(), self.q_spec.text().strip(),
                   self.q_unit.text().strip(), self.q_rule.currentText(), fixed, self.q_note.text().strip())
        self._refresh_quotes(code)
        self.recalc()

    def _delete_quote(self) -> None:
        code = self.q_code.text().strip()
        if code and QMessageBox.question(self, "削除", f"見積単価 {code} を削除しますか？") == QMessageBox.Yes:
            quotes.delete(self.conn, code)
            self._new_quote()
            self._refresh_quotes()
            self.recalc()

    def _pick_offer_file(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "見積書", "", "PDF・画像・Excel (*.pdf *.png *.jpg *.xlsx *.xls);;すべて (*.*)")
        if p:
            self.o_file.setText(p)

    def _add_offer(self) -> None:
        code = self.q_code.text().strip()
        if not quotes.get(self.conn, code):
            QMessageBox.warning(self, "入力", "先に見積単価を保存してください")
            return
        try:
            price = float(self.o_price.text().replace(",", ""))
        except ValueError:
            QMessageBox.warning(self, "入力", "単価は数字で入れてください")
            return
        quotes.add_offer(self.conn, code, self.o_vendor.text().strip() or "（業者名なし）", price,
                         self.o_date.date().toString("yyyy-MM-dd"), self.o_file.text().strip())
        self.o_vendor.clear()
        self.o_price.clear()
        self.o_file.clear()
        self._refresh_quotes(code)
        self.recalc()

    def _delete_offer(self) -> None:
        r = self.q_offers.currentRow()
        if r >= 0:
            quotes.delete_offer(self.conn, self.q_offers.item(r, 0).data(Qt.UserRole))
            self._refresh_quotes(self.q_code.text().strip())
            self.recalc()

    def _open_offer_file(self, r: int, _c: int) -> None:
        from .gui import open_path
        f = self.q_offers.item(r, 3).data(Qt.UserRole)
        if f:
            open_path(Path(f))

    # ================================================================ 落札実績
    def _page_awards(self) -> QWidget:
        w, v = _page()
        krow = QHBoxLayout()
        krow.setSpacing(12)
        self.a_kc = Kpi("件数")
        self.a_kr = Kpi("平均の落札率")
        self.a_kt = Kpi("基準価格 ÷ 予定価格（平均）")
        self.a_ka = Kpi("自社積算 ÷ 予定価格（精度）")
        self.a_kw = Kpi("自社の受注")
        for k in (self.a_kc, self.a_kr, self.a_kt, self.a_ka, self.a_kw):
            krow.addWidget(k)
        v.addLayout(krow)
        bar = QHBoxLayout()
        self.a_orderer = QComboBox()
        self.a_work = QComboBox()
        for lab, cb in (("発注者", self.a_orderer), ("工種区分", self.a_work)):
            ll = QLabel(lab)
            ll.setObjectName("Muted")
            bar.addWidget(ll)
            cb.setMinimumWidth(180)
            cb.currentIndexChanged.connect(self._refresh_awards_table)
            bar.addWidget(cb)
        bar.addStretch(1)
        ib = QPushButton("CSVから取り込む…")
        ib.clicked.connect(self._import_awards)
        db_ = QPushButton("選んだ行を削除")
        db_.clicked.connect(self._delete_award)
        bar.addWidget(ib)
        bar.addWidget(db_)
        v.addLayout(bar)
        self.a_table = _table(["日付", "発注者", "工事名", "工種区分", "予定価格", "基準価格", "落札額", "落札率", "落札者",
                               "自社入札", "自社積算", "精度"], 2)
        v.addWidget(self.a_table, 1)

        add = Card("落札結果を登録")
        g = QGridLayout()
        g.setHorizontalSpacing(8)
        self.a_in = {}
        fields = [("date", "日付"), ("orderer", "発注者"), ("name", "工事名"), ("work_type", "工種区分"),
                  ("planned", "予定価格"), ("threshold", "基準価格"), ("award_price", "落札額"), ("winner", "落札者"),
                  ("our_bid", "自社入札額"), ("our_estimate", "自社積算額")]
        for i, (k, lab) in enumerate(fields):
            e = QLineEdit()
            e.setPlaceholderText(lab)
            if k == "date":
                e.setText(QDate.currentDate().toString("yyyy-MM-dd"))
            self.a_in[k] = e
            g.addWidget(e, i // 5, i % 5)
        add.lay.addLayout(g)
        ab = QPushButton("登録")
        ab.setObjectName("Primary")
        ab.clicked.connect(self._add_award)
        add.lay.addWidget(ab, 0, Qt.AlignRight)
        v.addWidget(add)
        return w

    def _refresh_awards(self) -> None:
        for cb, sql in ((self.a_orderer, "SELECT DISTINCT orderer FROM award WHERE orderer<>'' ORDER BY 1"),
                        (self.a_work, "SELECT DISTINCT work_type FROM award WHERE work_type<>'' ORDER BY 1")):
            cur = cb.currentText()
            cb.blockSignals(True)
            cb.clear()
            cb.addItem("すべて")
            cb.addItems([r[0] for r in self.conn.execute(sql)])
            cb.setCurrentText(cur or "すべて")
            cb.blockSignals(False)
        self._refresh_awards_table()

    def _award_filter(self) -> tuple[str, str]:
        o = self.a_orderer.currentText()
        wk = self.a_work.currentText()
        return ("" if o == "すべて" else o), ("" if wk == "すべて" else wk)

    def _refresh_awards_table(self) -> None:
        o, wk = self._award_filter()
        rs = awards.rows(self.conn, o, wk)
        self.a_table.setRowCount(len(rs))
        for i, r in enumerate(rs):
            ratio = f"{r['award_price'] / r['planned'] * 100:.2f}%" if r["planned"] and r["award_price"] else ""
            acc = f"{r['our_estimate'] / r['planned'] * 100:.1f}%" if r["planned"] and r["our_estimate"] else ""
            _set_row(self.a_table, i, [r["date"], r["orderer"], r["name"], r["work_type"], yen(r["planned"]),
                                       yen(r["threshold"]), yen(r["award_price"]), ratio, r["winner"],
                                       yen(r["our_bid"]), yen(r["our_estimate"]), acc],
                     right={4, 5, 6, 7, 9, 10, 11}, tone="ok" if r["winner"] == "自社" else "", tone_col=8)
            self.a_table.item(i, 0).setData(Qt.UserRole, r["id"])
        for c, wd in enumerate([90, 120, 200, 110, 100, 100, 100, 70, 90, 100, 100, 60]):
            self.a_table.setColumnWidth(c, wd)
        st = awards.stats(self.conn, o, wk)
        self.a_kc.set(f"{st.count} 件")
        self.a_kr.set("—" if st.award_ratio is None else f"{st.award_ratio * 100:.2f}%")
        self.a_kt.set("—" if st.threshold_ratio is None else f"{st.threshold_ratio * 100:.2f}%")
        if st.accuracy is None:
            self.a_ka.set("—", "自社積算額の入った結果が必要です")
        else:
            sd = f"ばらつき ±{st.accuracy_sd * 100:.1f}%" if st.accuracy_sd is not None else ""
            self.a_ka.set(f"{st.accuracy * 100:.1f}%", ("自社が低めに見ている " if st.accuracy < 1 else "自社が高めに見ている ")
                          + sd, "warn" if abs(st.accuracy - 1) > 0.03 else "ok")
        self.a_kw.set(f"{st.win_count} 件", f"{st.win_count / st.count * 100:.0f}%" if st.count else "")

    def _add_award(self) -> None:
        kw = {}
        for k, e in self.a_in.items():
            t = e.text().strip()
            if k in awards.NUMS:
                try:
                    kw[k] = float(t.replace(",", "") or 0)
                except ValueError:
                    QMessageBox.warning(self, "入力", f"{e.placeholderText()}は数字で入れてください")
                    return
            else:
                kw[k] = t
        if self.guard(awards.add, self.conn, **kw) is None:
            return
        for k, e in self.a_in.items():
            if k != "date":
                e.clear()
        self._refresh_awards()

    def _import_awards(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "落札結果", "", "CSV (*.csv)")
        if p:
            n = self.guard(awards.import_csv, self.conn, p)
            if n:
                self.status.showMessage(f"落札結果を {n} 件取り込みました", 4000)
            self._refresh_awards()

    def _delete_award(self) -> None:
        r = self.a_table.currentRow()
        if r >= 0 and QMessageBox.question(self, "削除", "選んだ落札結果を削除しますか？") == QMessageBox.Yes:
            awards.delete(self.conn, self.a_table.item(r, 0).data(Qt.UserRole))
            self._refresh_awards()

    # ================================================================ 発注者ごとの設定（マスタ画面の中）
    def _orderer_card(self) -> Card:
        c = Card("発注者ごとの設定", "最低制限価格の式・内訳書の階層の深さ・電子入札CSVの文字コードなどを、"
                 "発注者ごとに年度のルールより優先して使います。")
        self.or_table = _table(["発注者", "項目", "値"], 2)
        self.or_table.setMinimumHeight(140)
        c.lay.addWidget(self.or_table, 1)
        h = QHBoxLayout()
        self.or_name = QComboBox()
        self.or_name.setEditable(True)
        self.or_name.setMinimumWidth(160)
        self.or_key = QComboBox()
        self.or_key.addItems(list(calc.DEFAULT_RULES))
        self.or_val = QLineEdit()
        self.or_val.setPlaceholderText("値")
        self.or_val.setMaximumWidth(120)
        b = QPushButton("追加・上書き")
        b.clicked.connect(self._add_orderer_rule)
        d = QPushButton("選んだ行を削除")
        d.clicked.connect(self._delete_orderer_rule)
        ib = QPushButton("CSVから取り込む…")
        ib.clicked.connect(self._import_orderer_rules)
        for x in (self.or_name, self.or_key, self.or_val, b, d):
            h.addWidget(x)
        h.addStretch(1)
        h.addWidget(ib)
        c.lay.addLayout(h)
        return c

    def _refresh_orderer_rules(self) -> None:
        rs = list(self.conn.execute("SELECT * FROM orderer_rule ORDER BY orderer, key"))
        self.or_table.setRowCount(len(rs))
        for i, r in enumerate(rs):
            default = calc.DEFAULT_RULES.get(r["key"], "")
            _set_row(self.or_table, i, [r["orderer"], r["key"], r["value"] + (f"（既定 {default}）" if default else "")])
        for col, wd in enumerate([180, 220]):
            self.or_table.setColumnWidth(col, wd)
        cur = self.or_name.currentText()
        self.or_name.clear()
        self.or_name.addItems(self._orderers())
        self.or_name.setCurrentText(cur)

    def _add_orderer_rule(self) -> None:
        o, k, val = self.or_name.currentText().strip(), self.or_key.currentText(), self.or_val.text().strip()
        if not o or not val:
            QMessageBox.warning(self, "入力", "発注者と値を入れてください")
            return
        with self.conn:
            self.conn.execute("INSERT OR REPLACE INTO orderer_rule(orderer, key, value) VALUES (?,?,?)", (o, k, val))
            audit.log(self.conn, None, "発注者ごとの設定", f"{o} {k}={val}")
        self.or_val.clear()
        self._refresh_orderer_rules()
        self.recalc()

    def _delete_orderer_rule(self) -> None:
        r = self.or_table.currentRow()
        if r < 0:
            return
        o, k = self.or_table.item(r, 0).text(), self.or_table.item(r, 1).text()
        with self.conn:
            self.conn.execute("DELETE FROM orderer_rule WHERE orderer=? AND key=?", (o, k))
            audit.log(self.conn, None, "発注者ごとの設定を削除", f"{o} {k}")
        self._refresh_orderer_rules()
        self.recalc()

    def _import_orderer_rules(self) -> None:
        from . import importer
        p, _ = QFileDialog.getOpenFileName(self, "発注者ごとの設定", "", "CSV (*.csv)")
        if p:
            self.guard(importer.import_orderer_rules, self.conn, p)
            self._refresh_orderer_rules()
            self.recalc()
