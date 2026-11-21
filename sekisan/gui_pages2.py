"""追加した画面（その2）：スケジュール・質疑書・受注後、当てはめ候補・数量計算・公表単価・利用者・バックアップ。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QDate, Qt
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDateEdit, QDialog, QDialogButtonBox, QFileDialog, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPushButton, QSplitter, QTableWidget, QTableWidgetItem,
    QVBoxLayout, QWidget,
)

from . import aftercontract, audit, backup, calc, export, inquiry, publicprice, qtycalc, quotes, schedule, settings
from . import suggest, template
from .gui_pages import _date, _page, _set_row, _table
from .theme import C
from .widgets import Banner, Card, Kpi, Pill, path_row, yen


# ====================================================================== 数量計算のダイアログ
class QtyDialog(QDialog):
    def __init__(self, win, item: calc.ItemResult) -> None:
        super().__init__(win)
        self.win, self.item = win, item
        self.setWindowTitle(f"数量計算書　明細{item.seq}「{item.name} {item.spec}」")
        self.resize(720, 460)
        v = QVBoxLayout(self)
        self.table = _table(["場所・測点", "計算式", "数量"], 1)
        v.addWidget(self.table, 1)
        h = QHBoxLayout()
        self.label = QLineEdit()
        self.label.setPlaceholderText("場所・測点（任意）")
        self.expr = QLineEdit()
        self.expr.setPlaceholderText("計算式　例: 10.5×2.0×0.3")
        self.expr.textChanged.connect(self._preview)
        self.expr.returnPressed.connect(self._add)
        self.prev = QLabel()
        self.prev.setObjectName("Muted")
        self.prev.setMinimumWidth(110)
        add = QPushButton("追加")
        add.clicked.connect(self._add)
        dele = QPushButton("選んだ行を削除")
        dele.clicked.connect(self._delete)
        h.addWidget(self.label, 1)
        h.addWidget(self.expr, 2)
        h.addWidget(self.prev)
        h.addWidget(add)
        h.addWidget(dele)
        v.addLayout(h)
        self.total = QLabel()
        self.total.setObjectName("Big")
        v.addWidget(self.total)
        bb = QDialogButtonBox()
        ap = bb.addButton("合計を明細の数量にする", QDialogButtonBox.AcceptRole)
        ap.setObjectName("Primary")
        bb.addButton("閉じる", QDialogButtonBox.RejectRole)
        bb.accepted.connect(self._apply)
        bb.rejected.connect(self.reject)
        v.addWidget(bb)
        self._load()

    def _load(self) -> None:
        ls = qtycalc.lines(self.win.conn, self.item.item_id)
        self.table.setRowCount(len(ls))
        for i, l in enumerate(ls):
            _set_row(self.table, i, [l["label"], l["expr"], f"{l['value']:,.3f}".rstrip("0").rstrip(".")], right={2})
            self.table.item(i, 0).setData(Qt.UserRole, l["id"])
        t = sum(l["value"] for l in ls)
        self.total.setText(f"合計 {t:,.3f}".rstrip("0").rstrip(".") + f" {self.item.unit}　（明細の数量 {self.item.qty:g}）")
        self.table.setColumnWidth(0, 180)

    def _preview(self) -> None:
        try:
            self.prev.setText(f"= {qtycalc.evaluate(self.expr.text()):,.3f}".rstrip("0").rstrip("."))
        except ValueError:
            self.prev.setText("（式を確認）" if self.expr.text().strip() else "")

    def _add(self) -> None:
        if self.win.guard(qtycalc.add_line, self.win.conn, self.item.item_id, self.expr.text(), self.label.text()) \
                is not None:
            self.expr.clear()
            self._load()

    def _delete(self) -> None:
        r = self.table.currentRow()
        if r >= 0:
            self.win.guard(qtycalc.delete_line, self.win.conn, self.table.item(r, 0).data(Qt.UserRole))
            self._load()

    def _apply(self) -> None:
        if not qtycalc.lines(self.win.conn, self.item.item_id):
            return
        if self.win.guard(qtycalc.apply_total, self.win.conn, self.item.item_id) is not None:
            self.accept()


# ====================================================================== 公表単価の確認ダイアログ
class PricePreviewDialog(QDialog):
    TONE = {"新規": "ok", "更新": "warn", "同じ": "", "物価資料": "info", "未設定": ""}

    def __init__(self, parent, rows: list[publicprice.PriceRow], fy: str = "", valid_from: str = "") -> None:
        super().__init__(parent)
        self.rows = rows
        self.setWindowTitle("公表単価の取り込み（確認）")
        self.resize(1000, 600)
        v = QVBoxLayout(self)
        cnt = {k: sum(r.status == k for r in rows) for k in self.TONE}
        head = f"{len(rows):,} 件を読み取りました。" + (f"（適用日 {valid_from}）" if valid_from else "")
        lab = QLabel(head + f"\n{fy}年度の単価に入れるもの：新規 {cnt['新規']:,} 件・単価が変わる {cnt['更新']:,} 件・"
                     f"変わらない {cnt['同じ']:,} 件\n単価がないもの：○（物価資料の単価を使う）{cnt['物価資料']:,} 件・"
                     f"空欄 {cnt['未設定']:,} 件 → 名称・規格だけ控えて、当てはめ候補と「物価資料の単価」に使います")
        lab.setStyleSheet("font-weight: 700;")
        lab.setWordWrap(True)
        v.addWidget(lab)
        fh = QHBoxLayout()
        fl = QLabel("表示")
        fl.setObjectName("Muted")
        self.filter = QComboBox()
        self.filter.addItems(["すべて"] + [k for k in self.TONE if cnt[k]])
        self.filter.currentIndexChanged.connect(self._fill)
        fh.addWidget(fl)
        fh.addWidget(self.filter)
        fh.addStretch(1)
        v.addLayout(fh)
        self.t = _table(["状態", "種類", "コード", "名称", "規格", "単位", "地区", "いまの単価", "新しい単価"], 3)
        v.addWidget(self.t, 1)
        self._fill()
        bb = QDialogButtonBox()
        ok = bb.addButton("取り込む", QDialogButtonBox.AcceptRole)
        self._bb = bb
        ok.setObjectName("Primary")
        bb.addButton("やめる", QDialogButtonBox.RejectRole)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        v.addWidget(bb)


def _fill_preview(self) -> None:
    f = self.filter.currentText()
    rows = [r for r in self.rows if f == "すべて" or r.status == f][:5000]
    self.t.setRowCount(len(rows))
    for i, r in enumerate(rows):
        _set_row(self.t, i, [r.status, r.kind, r.code, r.name, r.spec, r.unit, r.region,
                             "" if r.old_price is None else yen(r.old_price), "○" if r.price is None and r.status == "物価資料"
                             else ("" if r.price is None else yen(r.price))],
                 right={7, 8}, tone=self.TONE.get(r.status, ""), tone_col=0)
    for c, wd in enumerate([70, 60, 100, 260, 220, 50, 60, 90]):
        self.t.setColumnWidth(c, wd)


PricePreviewDialog._fill = _fill_preview


class PagesMixin2:
    # ================================================================ 明細：当てはめ候補・数量計算・自社書式
    def _candidates_box(self) -> QWidget:
        box = QWidget()
        v = QVBoxLayout(box)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(6)
        lab = QLabel("当てはめ候補")
        lab.setObjectName("Muted")
        v.addWidget(lab)
        self.cand = QListWidget()
        self.cand.setMinimumHeight(96)
        self.cand.setMaximumHeight(150)
        self.cand.setWordWrap(True)
        self.cand.setStyleSheet("QListWidget { border: 1px solid %s; border-radius: 6px; } "
                                "QListWidget::item { padding: 4px; }" % C["border"])
        self.cand.itemDoubleClicked.connect(lambda _: self._use_candidate())
        v.addWidget(self.cand)
        h = QHBoxLayout()
        b = QPushButton("この候補を当てる")
        b.clicked.connect(self._use_candidate)
        q = QPushButton("数量計算書…")
        q.clicked.connect(self._open_qty)
        h.addWidget(b)
        h.addWidget(q)
        h.addStretch(1)
        v.addLayout(h)
        return box

    def _show_candidates(self, it: calc.ItemResult | None) -> None:
        self.cand.clear()
        p = self._project_row()
        if not it or not p:
            return
        for c in suggest.candidates(self.conn, p["fy"], it.name, it.spec, it.unit, 5):
            mark = "★ " if c.code == it.code else ""
            li = QListWidgetItem(f"{mark}{c.score * 100:.0f}点　{c.code}　{c.name} {c.spec}（{c.unit}・{c.kind}）")
            li.setToolTip(c.reason)
            li.setData(Qt.UserRole, c.code)
            self.cand.addItem(li)
        if self.cand.count() == 0:
            li = QListWidgetItem("似ている候補が見つかりません")
            li.setFlags(Qt.NoItemFlags)
            self.cand.addItem(li)

    def _use_candidate(self) -> None:
        it = self._selected()
        li = self.cand.currentItem()
        if it and li and li.data(Qt.UserRole):
            self.guard(calc.assign_code, self.conn, it.item_id, li.data(Qt.UserRole), remember=True)
            self.recalc()

    def _auto_assign(self) -> None:
        if self.pid is None:
            return
        done = self.guard(suggest.auto_assign, self.conn, self.pid)
        if done is None:
            return
        self.recalc()
        left = len(self.design.unresolved) if self.design else 0
        msg = "\n".join(f"明細{seq} → {c.code} {c.name}（{c.score * 100:.0f}点）" for seq, c in done) or "当てられる候補はありませんでした。"
        QMessageBox.information(self, "候補で一括当てはめ",
                                f"{len(done)} 行に当てました（{suggest.AUTO_MIN_SCORE * 100:.0f}点以上で、迷いのないものだけ）。\n\n"
                                f"{msg}\n\n残りの未設定：{left} 行（右の候補から選んでください）")

    def _open_qty(self) -> None:
        it = self._selected()
        if it:
            QtyDialog(self, it).exec()
            self.recalc()

    def _choose_template(self) -> None:
        tp, _ = QFileDialog.getOpenFileName(self, "自社書式のひな形（Excel）", "", "Excel (*.xlsx)")
        if tp:
            s = settings.load()
            s["template_path"] = tp
            settings.save(s)
            self.status.showMessage(f"ひな形: {tp}", 4000)

    def _export_template(self) -> None:
        if self.pid is None or not self.design:
            return
        s = settings.load()
        tp = s.get("template_path", "")
        if not tp or not Path(tp).exists():
            tp, _ = QFileDialog.getOpenFileName(self, "自社書式のひな形（Excel）", "", "Excel (*.xlsx)")
            if not tp:
                return
            s["template_path"] = tp
            settings.save(s)
        p = dict(self._project_row())
        out, _ = QFileDialog.getSaveFileName(self, "保存先", str(Path(self.n_out.text()) / f"{p['name']}_{Path(tp).stem}.xlsx"),
                                             "Excel (*.xlsx)")
        if out:
            try:
                template.fill(tp, out, p, self.design)
            except Exception as e:
                QMessageBox.warning(self, "出力できませんでした", str(e))
                return
            self.status.showMessage(f"自社の書式で出力しました: {out}", 6000)

    # ================================================================ スケジュール
    def _page_schedule(self) -> QWidget:
        w, v = _page()
        row = QHBoxLayout()
        row.setSpacing(16)
        dc = Card("日程", "チェックを入れた日程だけを保存します。入札締切・開札日などは「新規積算」の画面にも出ます。")
        f = QFormLayout()
        f.setVerticalSpacing(8)
        self.sc_dates: dict[str, tuple[QCheckBox, QDateEdit]] = {}
        for k in schedule.KINDS:
            cb = QCheckBox()
            de = QDateEdit(QDate.currentDate())
            de.setCalendarPopup(True)
            de.setDisplayFormat("yyyy-MM-dd")
            de.setEnabled(False)
            cb.toggled.connect(de.setEnabled)
            hw = QWidget()
            hh = QHBoxLayout(hw)
            hh.setContentsMargins(0, 0, 0, 0)
            hh.addWidget(cb)
            hh.addWidget(de)
            hh.addStretch(1)
            f.addRow(k, hw)
            self.sc_dates[k] = (cb, de)
        dc.lay.addLayout(f)
        dc.lay.addStretch(1)
        sb = QPushButton("日程を保存")
        sb.setObjectName("Primary")
        sb.clicked.connect(self._save_schedule)
        dc.lay.addWidget(sb, 0, Qt.AlignRight)
        row.addWidget(dc, 2)

        cc = Card("提出物のチェックリスト", "チェックを付けると履歴に残ります。")
        self.sc_list = QListWidget()
        self.sc_list.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 6px 2px; }")
        self.sc_list.itemChanged.connect(self._check_changed)
        cc.lay.addWidget(self.sc_list, 1)
        ah = QHBoxLayout()
        self.sc_new = QLineEdit()
        self.sc_new.setPlaceholderText("提出物を追加")
        self.sc_new.returnPressed.connect(self._add_check)
        ab = QPushButton("追加")
        ab.clicked.connect(self._add_check)
        db_ = QPushButton("選んだものを削除")
        db_.clicked.connect(self._delete_check)
        ah.addWidget(self.sc_new, 1)
        ah.addWidget(ab)
        ah.addWidget(db_)
        cc.lay.addLayout(ah)
        row.addWidget(cc, 3)
        v.addLayout(row, 1)

        rc = Card("開札のあと", "開札結果を「落札実績」に登録すると、次の入札検討で予定価格の見込みに使われます。")
        rb = QPushButton("この工事の開札結果を落札実績に登録する…")
        rb.setObjectName("Primary")
        rb.clicked.connect(self._register_award)
        rc.lay.addWidget(rb, 0, Qt.AlignLeft)
        v.addWidget(rc)
        return w

    def _refresh_schedule(self) -> None:
        if self.pid is None:
            self.sc_list.clear()
            return
        dates = schedule.get(self.conn, self.pid)
        for k, (cb, de) in self.sc_dates.items():
            cb.setChecked(k in dates)
            de.setDate(_date(dates.get(k, "")))
        self.sc_list.blockSignals(True)
        self.sc_list.clear()
        for r in schedule.checklist(self.conn, self.pid, create=audit.can(self.conn, "edit")):
            li = QListWidgetItem(r["item"])
            li.setFlags(li.flags() | Qt.ItemIsUserCheckable)
            li.setCheckState(Qt.Checked if r["done"] else Qt.Unchecked)
            li.setData(Qt.UserRole, r["id"])
            self.sc_list.addItem(li)
        self.sc_list.blockSignals(False)

    def _save_schedule(self) -> None:
        if self.pid is None:
            return
        dates = {k: (de.date().toString("yyyy-MM-dd") if cb.isChecked() else "") for k, (cb, de) in self.sc_dates.items()}
        if self.guard(schedule.set_dates, self.conn, self.pid, dates) is not None:
            self.status.showMessage("日程を保存しました", 3000)
            self._load_recent()

    def _check_changed(self, li: QListWidgetItem) -> None:
        if self.guard(schedule.set_done, self.conn, li.data(Qt.UserRole), li.checkState() == Qt.Checked) is None \
                and not audit.can(self.conn, "edit"):
            self._refresh_schedule()

    def _add_check(self) -> None:
        if self.pid is not None and self.sc_new.text().strip():
            self.guard(schedule.add_check, self.conn, self.pid, self.sc_new.text().strip())
            self.sc_new.clear()
            self._refresh_schedule()

    def _delete_check(self) -> None:
        li = self.sc_list.currentItem()
        if li:
            self.guard(schedule.delete_check, self.conn, li.data(Qt.UserRole))
            self._refresh_schedule()

    def _register_award(self) -> None:
        p = self._project_row()
        if not p or not self.design:
            return
        dates = schedule.get(self.conn, self.pid)
        vals = {"date": dates.get("開札日", QDate.currentDate().toString("yyyy-MM-dd")), "orderer": p["orderer"],
                "name": p["name"], "work_type": p["work_type"], "our_bid": yen(p["bid_price"]) if p["bid_price"] else "",
                "our_estimate": str(self.design.summary.price), "our_threshold": str(self.design.summary.threshold),
                "publish": ""}
        self.go("awards")
        self.a_project_id = self.pid
        for k, e in self.a_in.items():
            e.setText(str(vals.get(k, "")).replace(",", "") if k in vals else "")
        self.a_in["planned"].setFocus()
        self.status.showMessage("工事の情報と自社の試算を入れました。公表された予定価格・最低制限価格・落札額・落札者・"
                                "同額の社数・くじの結果を入れて「登録」を押してください。", 10000)

    def _deadline_card(self) -> Card:
        c = Card("近い締切（30日以内）")
        self.deadlines = QListWidget()
        self.deadlines.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 6px 2px; "
                                     f"border-bottom: 1px solid {C['border']}; }}")
        self.deadlines.itemDoubleClicked.connect(self._open_deadline)
        c.lay.addWidget(self.deadlines, 1)
        return c

    def _refresh_deadlines(self) -> None:
        if not hasattr(self, "deadlines"):
            return
        self.deadlines.clear()
        for d in schedule.upcoming(self.conn):
            when = "今日" if d.days == 0 else (f"{d.days}日後" if d.days > 0 else f"{-d.days}日前（過ぎた）")
            li = QListWidgetItem(f"{d.date}（{when}）　{d.kind}\n{d.project}　未提出 {d.open_items}")
            li.setData(Qt.UserRole, d.project_id)
            if d.days <= 3:
                li.setForeground(Qt.red if d.days >= 0 else Qt.gray)
            self.deadlines.addItem(li)
        if self.deadlines.count() == 0:
            li = QListWidgetItem("近い締切はありません（日程は「スケジュール」で入れます）")
            li.setFlags(Qt.NoItemFlags)
            self.deadlines.addItem(li)

    def _open_deadline(self, li: QListWidgetItem) -> None:
        pid = li.data(Qt.UserRole)
        if pid is not None:
            self._load_projects(select=pid)
            self.go("schedule")

    # ================================================================ 質疑書
    def _page_inquiry(self) -> QWidget:
        w, v = _page()
        bar = QHBoxLayout()
        a = QPushButton("質問を追加")
        a.clicked.connect(self._add_inquiry)
        u = QPushButton("未設定の明細から下書き")
        u.clicked.connect(self._inquiry_from_unresolved)
        d = QPushButton("選んだ質問を削除")
        d.clicked.connect(self._delete_inquiry)
        x = QPushButton("質疑書をExcelに出力")
        x.setObjectName("Primary")
        x.clicked.connect(self._export_inquiry)
        for b in (a, u, d):
            bar.addWidget(b)
        bar.addStretch(1)
        bar.addWidget(x)
        v.addLayout(bar)
        hint = QLabel("「照合・答え合わせ」でPDFと照合したあと「食い違いを質疑書へ」を押すと、ここに下書きが入ります。"
                      "セルをダブルクリックすると、該当箇所・質問・回答を直せます。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        v.addWidget(hint)
        self.iq_table = QTableWidget(0, 4)
        self.iq_table.setHorizontalHeaderLabels(["No", "該当箇所", "質問事項", "回答"])
        from .gui import _style_table
        _style_table(self.iq_table)
        self.iq_table.setWordWrap(True)
        self.iq_table.itemChanged.connect(self._inquiry_edited)
        v.addWidget(self.iq_table, 1)
        return w

    def _refresh_inquiry(self) -> None:
        self.iq_table.blockSignals(True)
        rows = inquiry.rows(self.conn, self.pid) if self.pid is not None else []
        self.iq_table.setRowCount(len(rows))
        for i, r in enumerate(rows):
            for c, val in enumerate([str(i + 1), r["place"], r["question"], r["answer"]]):
                cell = QTableWidgetItem(val)
                cell.setData(Qt.UserRole, r["id"])
                if c == 0:
                    cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
                if c == 3 and not val:
                    cell.setBackground(Qt.transparent)
                self.iq_table.setItem(i, c, cell)
        for c, wd in enumerate([40, 100, 520]):
            self.iq_table.setColumnWidth(c, wd)
        self.iq_table.horizontalHeader().setStretchLastSection(True)
        self.iq_table.resizeRowsToContents()
        self.iq_table.blockSignals(False)

    def _inquiry_edited(self, cell: QTableWidgetItem) -> None:
        iid = cell.data(Qt.UserRole)
        field = {1: "place", 2: "question", 3: "answer"}.get(cell.column())
        if field:
            self.guard(inquiry.update, self.conn, iid, **{field: cell.text()})
            self._refresh_inquiry()

    def _add_inquiry(self) -> None:
        if self.pid is None:
            return
        it = self._selected() if hasattr(self, "table") else None
        place = f"明細{it.seq}" if it else ""
        self.guard(inquiry.add, self.conn, self.pid, "（質問を入力）", place)
        self._refresh_inquiry()

    def _inquiry_from_unresolved(self) -> None:
        if self.pid is None or not self.design:
            return
        n = self.guard(inquiry.from_unresolved, self.conn, self.pid, self.design.unresolved)
        self._refresh_inquiry()
        if n is not None:
            self.status.showMessage(f"質問の下書きを {n} 件作りました", 4000)

    def _inquiry_from_pdf(self) -> None:
        res = getattr(self, "last_pdf", None)
        if not res or self.pid is None:
            QMessageBox.information(self, "質疑書へ", "先にPDFと照合してください。")
            return
        n = self.guard(inquiry.from_pdf_check, self.conn, self.pid, res)
        if n is not None:
            self._refresh_inquiry()
            self.go("inquiry")
            self.status.showMessage(f"食い違い {n} 件を質疑書の下書きにしました", 5000)

    def _delete_inquiry(self) -> None:
        r = self.iq_table.currentRow()
        if r >= 0:
            self.guard(inquiry.delete, self.conn, self.iq_table.item(r, 0).data(Qt.UserRole))
            self._refresh_inquiry()

    def _export_inquiry(self) -> None:
        if self.pid is None:
            return
        p = dict(self._project_row())
        out, _ = QFileDialog.getSaveFileName(self, "質疑書", str(Path(self.n_out.text()) / f"{p['name']}_質疑書.xlsx"),
                                             "Excel (*.xlsx)")
        if out:
            export.export_inquiry(out, p, inquiry.rows(self.conn, self.pid))
            self.status.showMessage(f"出力しました: {out}", 5000)

    # ================================================================ 低入札調査の資料
    def _export_lowbid(self) -> None:
        if self.pid is None or not self.design:
            return
        p = dict(self._project_row())
        bid = int(p["bid_price"] or 0)
        if not bid:
            QMessageBox.information(self, "低入札調査の資料", "先に入札額を入れてください。")
            return
        out, _ = QFileDialog.getSaveFileName(self, "低入札調査の資料",
                                             str(Path(self.n_out.text()) / f"{p['name']}_低入札調査資料.xlsx"), "Excel (*.xlsx)")
        if out:
            used = {i.code for i in self.company.items} | {l.code for i in self.company.items if i.detail
                                                          for l in i.detail.lines}
            qs = [q for q in quotes.all_quotes(self.conn) if q.code in used]
            export.export_lowbid(out, p, self.design, self.company, bid, qs,
                                 list(self.conn.execute("SELECT * FROM company_price ORDER BY kind, code")))
            self.status.showMessage(f"出力しました: {out}", 5000)

    # ================================================================ 受注後（単価合意・出来高）
    def _page_after(self) -> QWidget:
        w, v = _page()
        top = QHBoxLayout()
        top.setSpacing(12)
        cc = Card("契約額")
        ch = QHBoxLayout()
        self.ac_price = QLineEdit()
        self.ac_price.setPlaceholderText("契約額（税抜）")
        self.ac_price.setAlignment(Qt.AlignRight)
        self.ac_price.returnPressed.connect(self._save_contract)
        sb = QPushButton("保存")
        sb.setObjectName("Primary")
        sb.clicked.connect(self._save_contract)
        ch.addWidget(self.ac_price)
        ch.addWidget(sb)
        cc.lay.addLayout(ch)
        top.addWidget(cc, 2)
        self.ac_ratio = Kpi("請負比率（契約額 ÷ 工事価格）")
        self.ac_done = Kpi("出来高金額")
        self.ac_rate = Kpi("出来高率")
        self.ac_pay = Kpi("今回の部分払い限度額")
        for k in (self.ac_ratio, self.ac_done, self.ac_rate, self.ac_pay):
            top.addWidget(k, 1)
        v.addLayout(top)
        bar = QHBoxLayout()
        lab = QLabel("出来高の回")
        lab.setObjectName("Muted")
        self.ac_period = QComboBox()
        self.ac_period.setMinimumWidth(180)
        self.ac_period.currentIndexChanged.connect(lambda _: self._refresh_after_table())
        nb = QPushButton("新しい回を作る…")
        nb.clicked.connect(self._new_period)
        xb = QPushButton("単価合意書・出来高内訳書をExcelに出力")
        xb.setObjectName("Primary")
        xb.clicked.connect(self._export_agreement)
        bar.addWidget(lab)
        bar.addWidget(self.ac_period)
        bar.addWidget(nb)
        bar.addStretch(1)
        bar.addWidget(xb)
        v.addLayout(bar)
        hint = QLabel("合意単価 = 設計単価 × 請負比率（目安）。「出来高数量（累計）」をダブルクリックして、その回までの累計数量を入れます。"
                      "部分払いの限度額は 契約額×出来高率×割合（既定 0.9）− 前回までの支払 です。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        v.addWidget(hint)
        self.ac_table = QTableWidget(0, 8)
        self.ac_table.setHorizontalHeaderLabels(["No", "名称", "単位", "契約数量", "設計単価", "合意単価", "出来高数量（累計）",
                                                 "出来高金額"])
        from .gui import _style_table
        _style_table(self.ac_table)
        self.ac_table.itemChanged.connect(self._progress_edited)
        v.addWidget(self.ac_table, 1)
        return w

    def _refresh_after(self) -> None:
        p = self._project_row()
        if not p:
            self.ac_table.setRowCount(0)
            return
        if not self.ac_price.hasFocus():
            self.ac_price.setText(yen(p["contract_price"]) if p["contract_price"] else "")
        cur = self.ac_period.currentText()
        self.ac_period.blockSignals(True)
        self.ac_period.clear()
        self.ac_period.addItems(aftercontract.periods(self.conn, self.pid))
        if cur:
            self.ac_period.setCurrentText(cur)
        self.ac_period.blockSignals(False)
        self._refresh_after_table()

    def _refresh_after_table(self) -> None:
        if self.pid is None:
            return
        ag = aftercontract.agreement(self.conn, self.pid)
        self.ac_ratio.set(f"{ag.ratio * 100:.2f}%" if ag.ratio else "—",
                          f"工事価格 ¥{yen(ag.planned)}" if ag.ratio else "契約額を入れてください")
        period = self.ac_period.currentText()
        prog = aftercontract.progress(self.conn, self.pid, period) if period else None
        done = {r.seq: r for r in prog.rows} if prog else {}
        self.ac_table.blockSignals(True)
        self.ac_table.setRowCount(len(ag.items))
        for i, a in enumerate(ag.items):
            d = done.get(a.seq)
            vals = [a.seq, a.name + (f" {a.spec}" if a.spec else ""), a.unit, f"{a.qty:g}", yen(a.design_price),
                    yen(a.agreed_price), "" if not d else f"{d.done_qty:g}", "" if not d else yen(d.done_amount)]
            for c, val in enumerate(vals):
                cell = QTableWidgetItem(str(val))
                cell.setData(Qt.UserRole, a.item_id)
                if c in (0, 3, 4, 5, 6, 7):
                    cell.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if c != 6 or not period:
                    cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
                self.ac_table.setItem(i, c, cell)
        for c, wd in enumerate([40, 260, 50, 90, 100, 100, 130]):
            self.ac_table.setColumnWidth(c, wd)
        self.ac_table.horizontalHeader().setStretchLastSection(True)
        self.ac_table.blockSignals(False)
        if prog:
            self.ac_done.set(f"¥{yen(prog.done_total)}", period)
            self.ac_rate.set(f"{prog.done_ratio * 100:.1f}%", f"契約額ベース ¥{yen(prog.contract_done)}")
            self.ac_pay.set(f"¥{yen(prog.payable)}", f"前回までの支払 ¥{yen(prog.paid_before)}", "ok" if prog.payable else "")
        else:
            for k in (self.ac_done, self.ac_rate, self.ac_pay):
                k.set("—", "出来高の回を作ってください")

    def _save_contract(self) -> None:
        if self.pid is None:
            return
        try:
            v = float(self.ac_price.text().replace(",", "").replace("¥", "") or 0)
        except ValueError:
            QMessageBox.warning(self, "入力", "契約額は数字で入れてください")
            return
        self.guard(aftercontract.set_contract_price, self.conn, self.pid, v)
        self.ac_price.clearFocus()
        self._refresh_after()

    def _new_period(self) -> None:
        if self.pid is None:
            return
        from PySide6.QtWidgets import QInputDialog
        n = len(aftercontract.periods(self.conn, self.pid)) + 1
        name, ok = QInputDialog.getText(self, "新しい回", "回の名前", text=f"第{n}回（{QDate.currentDate().toString('yyyy-MM')}）")
        if not ok or not name.strip():
            return
        ps = aftercontract.periods(self.conn, self.pid)
        prev = aftercontract.progress(self.conn, self.pid, ps[-1]) if ps else None
        items = aftercontract.agreement(self.conn, self.pid).items
        for a, r in zip(items, prev.rows if prev else [None] * len(items)):
            # 前回の累計を引き継いで始める
            if self.guard(aftercontract.set_progress, self.conn, self.pid, name.strip(), a.item_id,
                          r.done_qty if r else 0.0) is None and not audit.can(self.conn, "edit"):
                return
        self._refresh_after()
        self.ac_period.setCurrentText(name.strip())

    def _progress_edited(self, cell: QTableWidgetItem) -> None:
        if cell.column() != 6:
            return
        try:
            q = float(cell.text().replace(",", "") or 0)
        except ValueError:
            QMessageBox.warning(self, "入力", "数量は数字で入れてください")
            self._refresh_after_table()
            return
        self.guard(aftercontract.set_progress, self.conn, self.pid, self.ac_period.currentText(), cell.data(Qt.UserRole), q)
        self._refresh_after_table()

    def _export_agreement(self) -> None:
        if self.pid is None:
            return
        p = dict(self._project_row())
        ag = aftercontract.agreement(self.conn, self.pid)
        period = self.ac_period.currentText()
        prog = aftercontract.progress(self.conn, self.pid, period) if period else None
        out, _ = QFileDialog.getSaveFileName(self, "単価合意書・出来高内訳書",
                                             str(Path(self.n_out.text()) / f"{p['name']}_単価合意・出来高.xlsx"), "Excel (*.xlsx)")
        if out:
            export.export_agreement(out, p, ag, prog)
            self.status.showMessage(f"出力しました: {out}", 5000)

    # ================================================================ マスタ：公表単価
    def _public_price_card(self) -> Card:
        c = Card("公表単価を取り込む", "奈良県の「土木工事設計単価資料」（労務単価・資材単価）のPDFは、そのまま読めます"
                 "（種類と地区はPDFから自動で決まります）。ほかの Excel・CSV は下の「種類」を選んで読みます。"
                 "取り込む前に、新規・更新・○（物価資料）の件数を確認できます。")
        h = QHBoxLayout()
        self.pp_kind = QComboBox()
        self.pp_kind.addItems(["材料", "労務", "機械", "市場単価"])
        self.pp_pref = QLineEdit("奈良")
        self.pp_pref.setMaximumWidth(80)
        self.pp_pref.setToolTip("労務単価の表（職種が横・都道府県が縦）で使う都道府県")
        self.pp_region = QLineEdit()
        self.pp_region.setPlaceholderText("地区（空欄=共通）")
        self.pp_region.setMaximumWidth(140)
        b = QPushButton("ファイルを選んで確認…")
        b.setObjectName("Primary")
        b.clicked.connect(self._import_public_price)
        for lab, wdg in (("種類", self.pp_kind), ("都道府県", self.pp_pref), ("", self.pp_region)):
            if lab:
                ll = QLabel(lab)
                ll.setObjectName("Muted")
                h.addWidget(ll)
            h.addWidget(wdg)
        h.addStretch(1)
        h.addWidget(b)
        c.lay.addLayout(h)
        return c

    def _import_public_price(self) -> None:
        fy = self.m_fy.text().strip()
        if not fy:
            QMessageBox.warning(self, "入力", "年度を入れてください（上の「年度マスタを取り込む」の年度を使います）")
            return
        path, _ = QFileDialog.getOpenFileName(self, "公表単価のファイル", "", "Excel・CSV・PDF (*.xlsx *.xlsm *.csv *.pdf)")
        if not path:
            return
        from PySide6.QtWidgets import QApplication, QProgressDialog
        prog = QProgressDialog("PDFを読み取っています…（200ページほどで30秒ほどかかります）", None, 0, 100, self)
        prog.setWindowTitle("公表単価の取り込み")
        prog.setWindowModality(Qt.WindowModal)
        prog.setMinimumDuration(0)

        def step(n: int, total: int) -> None:
            prog.setMaximum(total)
            prog.setValue(n)
            QApplication.processEvents()

        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            rows = publicprice.parse(path, self.pp_kind.currentText(), self.pp_pref.text().strip() or "奈良", step)
            valid = publicprice.effective_date(path) if path.lower().endswith(".pdf") else ""
        except Exception as e:
            self.m_banner.show_msg(f"読めませんでした：{e}", "bad")
            return
        finally:
            QApplication.restoreOverrideCursor()
            prog.close()
        if not rows:
            self.m_banner.show_msg("単価の表が見つかりませんでした。見出しに「名称」と「単価」がある表か、"
                                   "職種が横に並ぶ労務単価の表に対応しています。", "warn")
            return
        rows = publicprice.preview(self.conn, fy, rows, self.pp_region.text().strip())
        if PricePreviewDialog(self, rows, fy, valid).exec():
            n = self.guard(publicprice.apply, self.conn, fy, rows, Path(path).name)
            if n:
                book = sum(r.price is None for r in rows)
                self.m_banner.show_msg(f"{fy}年度の単価に {n:,} 件を取り込みました。単価のない {book:,} 件は名称・規格を控えました"
                                       "（当てはめ候補と「物価資料の単価」に出ます）。", "ok")
                self._load_master_overview()
                self.recalc()

    # ================================================================ 設定：利用者・バックアップ
    def _users_card(self) -> Card:
        c = Card("利用者と権限", "1人も登録していないあいだは、全員が管理者として使えます。登録すると、登録していない人は閲覧だけになります。"
                 "管理者：すべて／確認：積算と確認・提出／積算：積算の変更／閲覧：見るだけ")
        self.u_me = QLabel()
        self.u_me.setStyleSheet("font-weight: 700;")
        c.lay.addWidget(self.u_me)
        self.u_table = _table(["名前", "役割"], 0)
        self.u_table.setMinimumHeight(120)
        c.lay.addWidget(self.u_table)
        h = QHBoxLayout()
        self.u_name = QLineEdit()
        self.u_name.setPlaceholderText("名前（担当者名と同じにする）")
        self.u_role = QComboBox()
        self.u_role.addItems(list(audit.ROLES))
        ab = QPushButton("追加・変更")
        ab.clicked.connect(self._save_user_role)
        db_ = QPushButton("選んだ人を削除")
        db_.clicked.connect(self._delete_user_role)
        h.addWidget(self.u_name, 1)
        h.addWidget(self.u_role)
        h.addWidget(ab)
        h.addWidget(db_)
        c.lay.addLayout(h)
        return c

    def _refresh_users(self) -> None:
        us = audit.users(self.conn)
        self.u_table.setRowCount(len(us))
        for i, u in enumerate(us):
            _set_row(self.u_table, i, [u["name"], u["role"]], tone="info" if u["role"] == "管理者" else "", tone_col=1)
        self.u_table.setColumnWidth(0, 240)
        me = audit.current_user()
        self.u_me.setText(f"いまの担当者：{me}（{audit.role(self.conn)}）"
                          + ("　※利用者が未登録なので全員が管理者です" if not us else ""))
        self.side_role.setText(f"{me}（{audit.role(self.conn)}）")

    def _save_user_role(self) -> None:
        self.guard(audit.set_user, self.conn, self.u_name.text().strip(), self.u_role.currentText())
        self.u_name.clear()
        self._refresh_users()

    def _delete_user_role(self) -> None:
        r = self.u_table.currentRow()
        if r >= 0:
            name = self.u_table.item(r, 0).text()
            if QMessageBox.question(self, "削除", f"{name} を利用者から外しますか？") == QMessageBox.Yes:
                self.guard(audit.delete_user, self.conn, name)
                self._refresh_users()

    def _backup_card(self) -> Card:
        c = Card("バックアップ", "起動したとき、前回から1日たっていれば自動でバックアップします（新しい30個を残す）。"
                 "共有フォルダとは別の場所（別のNASや外付けディスク）にすると、より安全です。")
        self.bk_dir = QLineEdit(settings.load().get("backup_dir", "") or str(backup.default_dir(settings.db_path())))
        c.lay.addWidget(path_row(self.bk_dir, lambda: self._pick_dir(self.bk_dir)))
        h = QHBoxLayout()
        b1 = QPushButton("今すぐバックアップ")
        b1.setObjectName("Primary")
        b1.clicked.connect(self._do_backup)
        b2 = QPushButton("データの点検")
        b2.clicked.connect(self._check_integrity)
        b3 = QPushButton("選んだバックアップに戻す…")
        b3.clicked.connect(self._do_restore)
        h.addWidget(b1)
        h.addWidget(b2)
        h.addStretch(1)
        h.addWidget(b3)
        c.lay.addLayout(h)
        self.bk_list = QListWidget()
        self.bk_list.setMaximumHeight(140)
        c.lay.addWidget(self.bk_list)
        return c

    def _backup_dest(self) -> Path:
        d = self.bk_dir.text().strip() if hasattr(self, "bk_dir") else settings.load().get("backup_dir", "")
        return Path(d) if d else backup.default_dir(settings.db_path())

    def _refresh_backups(self) -> None:
        self.bk_list.clear()
        for b in backup.list_backups(self._backup_dest()):
            li = QListWidgetItem(f"{b.name}　（{b.stat().st_size / 1024:,.0f} KB）")
            li.setData(Qt.UserRole, str(b))
            self.bk_list.addItem(li)

    def _do_backup(self) -> None:
        s = settings.load()
        s["backup_dir"] = self.bk_dir.text().strip()
        settings.save(s)
        try:
            out = backup.make(settings.db_path(), self._backup_dest())
        except Exception as e:
            self.s_banner.show_msg(f"バックアップできませんでした：{e}", "bad")
            return
        self.s_banner.show_msg(f"バックアップしました：{out}", "ok")
        self._refresh_backups()

    def _check_integrity(self) -> None:
        r = backup.integrity(settings.db_path())
        self.s_banner.show_msg("データファイルに異常はありません。" if r == "ok" else f"データファイルに異常があります：{r}"
                               "　バックアップから戻すことを検討してください。", "ok" if r == "ok" else "bad")

    def _do_restore(self) -> None:
        li = self.bk_list.currentItem()
        if not li:
            return
        if self.guard(audit.require, self.conn, "admin") is None and not audit.can(self.conn, "admin"):
            return
        if QMessageBox.question(self, "バックアップに戻す",
                                f"{Path(li.data(Qt.UserRole)).name} の状態に戻します。\n"
                                "いまの状態は「復元前_…」として残します。ほかの人がこのソフトを閉じていることを確かめてください。\n\n戻しますか？") \
                != QMessageBox.Yes:
            return
        self.conn.close()
        try:
            safety = backup.restore(li.data(Qt.UserRole), settings.db_path())
        except Exception as e:
            from . import db
            self.conn = db.connect(settings.db_path())
            self.s_banner.show_msg(f"戻せませんでした：{e}", "bad")
            return
        from . import db
        self.conn = db.connect(settings.db_path())
        self.pid = None
        self._load_projects()
        self.s_banner.show_msg(f"バックアップから戻しました。戻す前の状態は {safety.name} に残しています。", "ok")


class BookPageMixin:
    """物価資料（積算資料・建設物価）で調べる単価：県の資料で○の品目のうち、この工事で使うもの。"""

    def _page_book(self) -> QWidget:
        w, v = _page()
        self.bk_banner = Banner()
        v.addWidget(self.bk_banner)
        bar = QHBoxLayout()
        hint = QLabel("県の単価資料で「○（刊行物単価使用）」の品目は、県のPDFに金額がありません。"
                      "積算資料・建設物価で調べた単価を「単価」欄に入れて「保存」すると、年度の単価として使われます。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        bar.addWidget(hint, 1)
        xb = QPushButton("一覧をExcelに出力")
        xb.clicked.connect(self._export_book)
        sb = QPushButton("入れた単価を保存")
        sb.setObjectName("Primary")
        sb.clicked.connect(self._save_book)
        bar.addWidget(xb)
        bar.addWidget(sb)
        v.addLayout(bar)
        self.book_table = QTableWidget(0, 9)
        self.book_table.setHorizontalHeaderLabels(["種類", "単価コード", "名称", "規格", "単位", "地区", "刊行物の掲載元",
                                                   "使う明細", "単価（入力）"])
        from .gui import _style_table
        _style_table(self.book_table)
        v.addWidget(self.book_table, 1)
        return w

    def _refresh_book(self) -> None:
        items = publicprice.book_items_for(self.conn, self.pid) if self.pid is not None else []
        self.book_items = items
        self.book_table.setRowCount(len(items))
        for i, b in enumerate(items):
            for c, val in enumerate([b.kind, b.code, b.name, b.spec, b.unit, b.region or "共通", b.ref, b.used_in, ""]):
                cell = QTableWidgetItem(val)
                if c != 8:
                    cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
                else:
                    cell.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                    cell.setBackground(Qt.white)
                self.book_table.setItem(i, c, cell)
        for c, wd in enumerate([70, 110, 220, 200, 50, 60, 200, 140]):
            self.book_table.setColumnWidth(c, wd)
        self.book_table.horizontalHeader().setStretchLastSection(True)
        if self.pid is None:
            self.bk_banner.hide()
        elif items:
            self.bk_banner.show_msg(f"この工事で使う品目のうち {len(items)} 件は、物価資料の単価を入れる必要があります。", "warn")
        else:
            self.bk_banner.show_msg("物価資料で調べる必要のある品目はありません。", "ok")

    def _save_book(self) -> None:
        p = self._project_row()
        if not p:
            return
        n = 0
        for i, b in enumerate(getattr(self, "book_items", [])):
            t = (self.book_table.item(i, 8).text() or "").replace(",", "").replace("¥", "").strip()
            if not t:
                continue
            try:
                price = float(t)
            except ValueError:
                QMessageBox.warning(self, "入力", f"{b.name} {b.spec} の単価は数字で入れてください")
                return
            if self.guard(publicprice.set_book_price, self.conn, p["fy"], b.kind, b.code, price, b.region) is None:
                return
            n += 1
        self.recalc()
        self.status.showMessage(f"物価資料の単価を {n} 件保存しました", 5000)

    def _export_book(self) -> None:
        if self.pid is None:
            return
        p = dict(self._project_row())
        out, _ = QFileDialog.getSaveFileName(self, "物価資料で調べる単価", str(Path(self.n_out.text()) / f"{p['name']}_物価資料で調べる単価.xlsx"),
                                             "Excel (*.xlsx)")
        if out:
            export.export_book_list(out, p, publicprice.book_items_for(self.conn, self.pid))
            self.status.showMessage(f"出力しました: {out}", 5000)
