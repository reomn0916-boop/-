"""単価表の画面：金抜き設計書から作った単価表（歩掛）と施工パッケージの、伏せてある数量・資源・率を入れる。"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QFont
from PySide6.QtWidgets import (
    QCheckBox, QCompleter, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPushButton,
    QSplitter, QStyledItemDelegate, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from . import calc, kinnuki
from .gui_pages import _page, _set_row
from .theme import C, color
from .widgets import Banner, Card, Pill, yen

COLS = ["行", "設計書の記載", "種類", "資源コード", "当てた資源", "数量", "単価", "金額", "注意"]
PKG_COLS = ["行", "設計書の記載", "種類", "資源コード", "当てた資源", "構成比", "東京の基準単価", "当地の単価", "注意"]
RES_COL, QTY_COL, BASE_COL = 3, 5, 6


class _CodeDelegate(QStyledItemDelegate):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.candidates: list[str] = []

    def createEditor(self, parent, option, index):  # noqa: N802
        e = QLineEdit(parent)
        comp = QCompleter(self.candidates, e)
        comp.setFilterMode(Qt.MatchContains)
        comp.setCaseSensitivity(Qt.CaseInsensitive)
        comp.setMaxVisibleItems(14)
        comp.popup().setMinimumWidth(520)
        e.setCompleter(comp)
        return e

    def setModelData(self, editor, model, index):  # noqa: N802
        t = editor.text().strip()
        model.setData(index, t.split("　")[0] if t else "", Qt.EditRole)


class TablesPageMixin:
    def _page_tables(self) -> QWidget:
        w, v = _page()
        self.tb_banner = Banner()
        v.addWidget(self.tb_banner)
        split = QSplitter(Qt.Horizontal)
        left = Card("単価表の一覧", "金抜き設計書から作った単価表です。数字は残りの「入れるもの」の数。")
        self.tb_only = QCheckBox("残りがあるものだけ")
        self.tb_only.toggled.connect(self._refresh_tables)
        left.lay.addWidget(self.tb_only)
        self.tb_list = QListWidget()
        self.tb_list.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 6px 4px; "
                                   f"border-bottom: 1px solid {C['border']}; }}"
                                   f"QListWidget::item:selected {{ background: {C['accent_soft']}; color: {C['text']}; }}")
        self.tb_list.currentItemChanged.connect(lambda *_: self._show_table())
        left.lay.addWidget(self.tb_list, 1)
        left.setMinimumWidth(320)
        split.addWidget(left)

        right = Card("")
        hh = QHBoxLayout()
        self.tb_title = QLabel("単価表を選んでください")
        self.tb_title.setObjectName("CardTitle")
        self.tb_title.setWordWrap(True)
        self.tb_state = Pill()
        hh.addWidget(self.tb_title, 1)
        hh.addWidget(self.tb_state, 0, Qt.AlignTop)
        right.lay.addLayout(hh)
        self.tb_sub = QLabel()
        self.tb_sub.setObjectName("Muted")
        self.tb_sub.setWordWrap(True)
        right.lay.addWidget(self.tb_sub)
        fh = QHBoxLayout()
        self.tb_per_lab = QLabel("割戻数量")
        self.tb_per = QLineEdit()
        self.tb_per.setMaximumWidth(90)
        self.tb_misc_lab = QLabel("諸雑費率（%）")
        self.tb_misc = QLineEdit()
        self.tb_misc.setMaximumWidth(90)
        self.tb_std_lab = QLabel("標準単価（東京）")
        self.tb_std = QLineEdit()
        self.tb_std.setMaximumWidth(120)
        sb = QPushButton("保存")
        sb.clicked.connect(self._save_table_head)
        for x in (self.tb_per_lab, self.tb_per, self.tb_misc_lab, self.tb_misc, self.tb_std_lab, self.tb_std):
            if isinstance(x, QLabel):
                x.setObjectName("Muted")
            fh.addWidget(x)
        fh.addWidget(sb)
        fh.addStretch(1)
        self.tb_price = QLabel()
        self.tb_price.setObjectName("Big")
        fh.addWidget(self.tb_price)
        right.lay.addLayout(fh)
        self.tb_table = QTableWidget(0, len(COLS))
        from .gui import _style_table
        _style_table(self.tb_table)
        self.tb_table.setWordWrap(True)
        self.tb_delegate = _CodeDelegate(self.tb_table)
        self.tb_table.setItemDelegateForColumn(RES_COL, self.tb_delegate)
        self.tb_table.itemChanged.connect(self._table_cell_changed)
        right.lay.addWidget(self.tb_table, 1)
        self.tb_note = QLabel()
        self.tb_note.setObjectName("Muted")
        self.tb_note.setWordWrap(True)
        right.lay.addWidget(self.tb_note)
        hint = QLabel("「数量」と「資源コード」はダブルクリックで直せます。入れた数量と資源は覚えておき、"
                      "次に同じ単価表が出てくる金抜き設計書を取り込んだとき自動で入ります（「前回の値」）。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        right.lay.addWidget(hint)
        split.addWidget(right)
        split.setSizes([340, 960])
        v.addWidget(split, 1)
        return w

    # ------------------------------------------------------------ 一覧
    def _refresh_tables(self) -> None:
        cur = self.tb_list.currentItem().data(Qt.UserRole) if self.tb_list.currentItem() else None
        self.tb_list.blockSignals(True)
        self.tb_list.clear()
        sts = kinnuki.tables_of(self.conn, self.pid) if self.pid is not None else []
        left = sum(s.todo for s in sts)
        for s in sts:
            if self.tb_only.isChecked() and not s.todo:
                continue
            mark = f"あと {s.todo}" if s.todo else "済"
            li = QListWidgetItem(f"{s.name}　{s.spec}\n{'施工パッケージ' if s.is_package else '単価表'}・{s.unit}　［{mark}］")
            li.setData(Qt.UserRole, (s.code, s.is_package))
            li.setForeground(QBrush(color("warn" if s.todo else "ok")))
            self.tb_list.addItem(li)
        self.tb_list.blockSignals(False)
        if not sts:
            self.tb_banner.show_msg("この工事には、金抜き設計書から作った単価表がありません。"
                                    "「新規積算」に金抜き設計書のPDFを落とすと、単価表もいっしょに作ります。", "info")
        elif left:
            self.tb_banner.show_msg(f"単価表 {len(sts)} 個のうち、入れるものが残り {left} 件あります"
                                    "（金抜きで伏せてある数量・単価が当たらない資源・諸雑費率）。", "warn")
        else:
            self.tb_banner.show_msg(f"単価表 {len(sts)} 個は、すべて入っています。", "ok")
        for i in range(self.tb_list.count()):
            if self.tb_list.item(i).data(Qt.UserRole) == cur:
                self.tb_list.setCurrentRow(i)
                break
        else:
            if self.tb_list.count():
                self.tb_list.setCurrentRow(0)
        self._show_table()

    def _calc(self) -> calc.Calculator | None:
        p = self._project_row()
        if not p:
            return None
        return calc.Calculator(self.conn, p["fy"], p["region"], calc.DESIGN, calc.project_conditions(self.conn, self.pid),
                               p["orderer"], p["price_date"], self.pid)

    def _resource_candidates(self) -> list[str]:
        p = self._project_row()
        if not p:
            return []
        out = []
        for r in self.conn.execute("SELECT DISTINCT kind, code, name, spec, unit FROM master_price WHERE fy=? ORDER BY kind, code",
                                   (p["fy"],)):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[{r['kind']}・{r['unit']}]")
        have = {x.split("　")[0] for x in out}
        for r in self.conn.execute("SELECT DISTINCT kind, code, name, spec, unit, source FROM public_item WHERE fy=? AND price IS NULL",
                                   (p["fy"],)):
            if r["code"] not in have:
                out.append(f"{r['code']}　{r['name']}　{r['spec']}　[{r['kind']}・{r['unit']}・{r['source']}]")
        for r in self.conn.execute("SELECT code, name, spec, unit FROM quote"):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[見積・{r['unit']}]")
        from . import disposal
        return out + disposal.candidates(self.conn)

    # ------------------------------------------------------------ 1つの単価表
    def _show_table(self) -> None:
        li = self.tb_list.currentItem()
        self.tb_table.blockSignals(True)
        self.tb_table.setRowCount(0)
        p = self._project_row()
        if not li or not p:
            self.tb_title.setText("単価表を選んでください")
            self.tb_sub.setText("")
            self.tb_price.setText("")
            self.tb_note.setText("")
            self.tb_table.blockSignals(False)
            return
        code, is_pkg = li.data(Qt.UserRole)
        fy = p["fy"]
        cl = self._calc()
        self.tb_delegate.candidates = getattr(self, "_res_cands", None) or self._resource_candidates()
        self._res_cands = self.tb_delegate.candidates
        for wdg in (self.tb_per_lab, self.tb_per, self.tb_misc_lab, self.tb_misc):
            wdg.setVisible(not is_pkg)
        for wdg in (self.tb_std_lab, self.tb_std):
            wdg.setVisible(is_pkg)
        names = {}
        if is_pkg:
            k = self.conn.execute("SELECT * FROM package WHERE fy=? AND code=?", (fy, code)).fetchone()
            up = cl.package_price(code)
            self.tb_title.setText(f"{k['name']}　{k['spec']}（施工パッケージ）")
            self.tb_sub.setText(f"コード {code.split('/')[-1]}　単位 {k['unit']}　"
                                "積算単価 = 標準単価 × { Σ 構成比 ×（当地の単価 ÷ 東京の基準単価）+ 補正しない分 }")
            self.tb_std.setText(f"{k['std_price']:g}" if k["std_price"] else "")
            rows = list(self.conn.execute("SELECT * FROM package_component WHERE fy=? AND package_code=? ORDER BY seq",
                                          (fy, code)))
            self.tb_table.setColumnCount(len(PKG_COLS))
            self.tb_table.setHorizontalHeaderLabels(PKG_COLS)
            self.tb_table.setRowCount(len(rows))
            todo = (k["std_price"] == 0)
            for i, r in enumerate(rows):
                local, nm, unit, _src = cl.resource_price(r["kind"], r["res_code"]) if r["res_code"] else (0, "", "", "")
                warn = []
                if not r["res_code"]:
                    warn.append("単価を当てる")
                if not r["base_price"]:
                    warn.append("東京の基準単価を入れる")
                todo += bool(warn)
                vals = [r["seq"], r["src"], r["kind"], r["res_code"], nm, f"{r['ratio'] * 100:.2f}%",
                        f"{r['base_price']:g}" if r["base_price"] else "", yen(local) if r["res_code"] else "", "・".join(warn)]
                self._put_row(i, vals, editable={RES_COL, BASE_COL}, warn=bool(warn), key=r["seq"])
            self.tb_state.setText("済" if not todo else f"あと {todo}")
            self.tb_state.set_tone("ok" if not todo else "warn")
            self.tb_note.setText("")
        else:
            b = self.conn.execute("SELECT * FROM bukake WHERE fy=? AND code=?", (fy, code)).fetchone()
            up = cl.unit_price(code)
            self.tb_title.setText(f"{b['name']}　{b['spec']}")
            self.tb_sub.setText(f"単位 {b['unit']}　{b['per_qty']:g}{b['unit']}あたりの数量で書きます")
            self.tb_per.setText(f"{b['per_qty']:g}")
            self.tb_misc.setText(f"{b['misc_rate']:g}")
            rows = list(self.conn.execute("SELECT * FROM bukake_component WHERE fy=? AND bukake_code=? ORDER BY seq",
                                          (fy, code)))
            lines = up.lines if up else []
            self.tb_table.setColumnCount(len(COLS))
            self.tb_table.setHorizontalHeaderLabels(COLS)
            self.tb_table.setRowCount(len(rows))
            todo = 0
            for i, r in enumerate(rows):
                ln = lines[i] if i < len(lines) else None
                note = r["note"] or ""
                warn = any(x in note for x in (kinnuki.NEED_QTY, kinnuki.NEED_RES))
                todo += warn
                res_name = ln.name if ln and r["res_code"] else ""
                if r["kind"] == "歩掛" and r["res_code"]:
                    res_name = f"→ {res_name}"
                vals = [r["seq"], r["src"], r["kind"], r["res_code"].split("/")[-1] if "/" in r["res_code"] else r["res_code"],
                        res_name, f"{r['qty']:g}", yen(ln.price) if ln else "", yen(ln.amount) if ln else "", note]
                editable = {QTY_COL} | ({RES_COL} if r["kind"] not in ("歩掛", "パッケージ") else set())
                self._put_row(i, vals, editable=editable, warn=warn, key=r["seq"], note=note)
            misc_todo = kinnuki.NEED_MISC in (b["note"] or "")
            todo += misc_todo
            self.tb_state.setText("済" if not todo else f"あと {todo}")
            self.tb_state.set_tone("ok" if not todo else "warn")
            self.tb_misc.setStyleSheet(f"background: {C['warn_soft']};" if misc_todo else "")
            self.tb_note.setText(b["note"] or "")
        self.tb_price.setText(f"¥{yen(up.price)} / {up.unit}" if up else "")
        for c_, wd in enumerate([36, 300, 70, 110, 220, 70, 90, 90]):
            self.tb_table.setColumnWidth(c_, wd)
        self.tb_table.horizontalHeader().setStretchLastSection(True)
        self.tb_table.resizeRowsToContents()
        self.tb_table.blockSignals(False)

    def _put_row(self, i: int, vals: list, editable: set[int], warn: bool, key: int, note: str = "") -> None:
        for c_, val in enumerate(vals):
            cell = QTableWidgetItem("" if val is None else str(val))
            cell.setData(Qt.UserRole, key)
            if c_ not in editable:
                cell.setFlags(cell.flags() & ~Qt.ItemIsEditable)
            else:
                cell.setToolTip("ダブルクリックで直せます")
            if c_ in (0, 5, 6, 7):
                cell.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if warn:
                cell.setBackground(QBrush(color("warn_soft")))
            if c_ == 8 and val:
                cell.setForeground(QBrush(color("warn" if "前回の値" not in str(val) or warn else "accent")))
                f = QFont()
                f.setBold(True)
                cell.setFont(f)
            if c_ in editable and c_ == QTY_COL and kinnuki.NEED_QTY in note:
                cell.setForeground(QBrush(color("bad")))
            self.tb_table.setItem(i, c_, cell)

    def _table_cell_changed(self, cell: QTableWidgetItem) -> None:
        li = self.tb_list.currentItem()
        p = self._project_row()
        if not li or not p:
            return
        code, is_pkg = li.data(Qt.UserRole)
        seq = cell.data(Qt.UserRole)
        text = cell.text().strip()
        col = cell.column()
        kind = None
        if col == RES_COL and text:
            r = self.conn.execute("SELECT kind FROM master_price WHERE fy=? AND code=? LIMIT 1", (p["fy"], text)).fetchone() \
                or self.conn.execute("SELECT kind FROM public_item WHERE fy=? AND code=? LIMIT 1", (p["fy"], text)).fetchone()
            kind = r["kind"] if r else None
            if not r and not self.conn.execute("SELECT 1 FROM quote WHERE code=?", (text,)).fetchone():
                QMessageBox.warning(self, "資源コード", f"{text} は年度の単価・県の品目・見積単価にありません")
                self._show_table()
                return
        try:
            num = float(text.replace(",", "")) if col in (QTY_COL, BASE_COL) else None
        except ValueError:
            QMessageBox.warning(self, "入力", "数字で入れてください")
            self._show_table()
            return
        if is_pkg:
            if col == BASE_COL:
                self.guard(kinnuki.set_package_component, self.conn, p["fy"], code, seq, base_price=num)
            elif col == RES_COL:
                self.guard(kinnuki.set_package_component, self.conn, p["fy"], code, seq, res_code=text, kind=kind)
        else:
            if col == QTY_COL:
                self.guard(kinnuki.set_component, self.conn, p["fy"], code, seq, qty=num)
            elif col == RES_COL:
                self.guard(kinnuki.set_component, self.conn, p["fy"], code, seq, res_code=text, kind=kind)
        self.recalc()

    def _save_table_head(self) -> None:
        li = self.tb_list.currentItem()
        p = self._project_row()
        if not li or not p:
            return
        code, is_pkg = li.data(Qt.UserRole)
        try:
            if is_pkg:
                self.guard(kinnuki.set_table, self.conn, p["fy"], code,
                           std_price=float(self.tb_std.text().replace(",", "") or 0))
            else:
                self.guard(kinnuki.set_table, self.conn, p["fy"], code,
                           misc_rate=float(self.tb_misc.text() or 0), per_qty=float(self.tb_per.text() or 1))
        except ValueError:
            QMessageBox.warning(self, "入力", "数字で入れてください")
            return
        self.recalc()


# ====================================================================== 公表単価の自動収集（マスタ画面のカード）
from PySide6.QtCore import QThread, Signal  # noqa: E402


class _CheckWorker(QThread):
    done = Signal(object, object)

    def __init__(self, db_path: str, pages: list[str], probe: bool) -> None:
        super().__init__()
        self.db_path, self.pages, self.probe = db_path, pages, probe

    def run(self) -> None:  # 通信は別のスレッドで（画面を止めない）。接続も別に開く
        from . import autofetch, db
        try:
            conn = db.connect(self.db_path)
            found, errors = autofetch.check(conn, self.pages, self.probe)
            conn.close()
            self.done.emit(found, errors)
        except Exception as e:
            self.done.emit([], [str(e)])


class AutoFetchMixin:
    def _autofetch_card(self) -> Card:
        from . import settings
        c = Card("公表単価の自動収集（奈良県のサイト）",
                 "県のサイトで新しい「土木工事設計単価資料」（資材単価・労務単価・再生資材・土砂受入）を探し、"
                 "ダウンロードして取り込みます。取り込むと年度の単価を最新にし、その月の単価を適用日つきでも残します"
                 "（単価の適用日を入れた工事は、その時点の単価で計算されます）。")
        s = settings.load()
        self.af_pages = QLineEdit(s.get("price_pages", ""))
        self.af_pages.setPlaceholderText("ほかに見る一覧ページのアドレス（任意・複数は空白で区切る）")
        from . import autofetch as _af
        dl = QLabel("いつも見るページ：" + "　".join(_af.DEFAULT_PAGES))
        dl.setObjectName("Muted")
        dl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        c.lay.addWidget(dl)
        c.lay.addWidget(self.af_pages)
        oh = QHBoxLayout()
        self.af_probe = QCheckBox("一覧ページが読めないときは、県のファイル名の決まりから最近12か月を確かめる")
        self.af_probe.setChecked(s.get("price_probe", True))
        self.af_auto = QCheckBox("起動したとき週1回確かめる")
        self.af_auto.setChecked(s.get("price_auto_check", True))
        self.af_import = QCheckBox("見つかったら自動で取り込む（管理者）")
        self.af_import.setChecked(s.get("price_auto_import", False))
        for x in (self.af_probe, self.af_auto, self.af_import):
            oh.addWidget(x)
        oh.addStretch(1)
        c.lay.addLayout(oh)
        bh = QHBoxLayout()
        self.af_btn = QPushButton("今すぐ確かめる")
        self.af_btn.setObjectName("Primary")
        self.af_btn.clicked.connect(lambda: self._autofetch_check(interactive=True))
        imp = QPushButton("選んだ資料を取り込む")
        imp.clicked.connect(self._autofetch_import_selected)
        alln = QPushButton("新しい資料をすべて取り込む")
        alln.clicked.connect(lambda: self._autofetch_import(new_only=True))
        self.af_last = QLabel()
        self.af_last.setObjectName("Muted")
        bh.addWidget(self.af_btn)
        bh.addWidget(imp)
        bh.addWidget(alln)
        bh.addStretch(1)
        bh.addWidget(self.af_last)
        c.lay.addLayout(bh)
        from .gui_pages import _table
        self.af_table = _table(["種類", "適用（年月）", "ファイル", "状態", "取り込み先", "結果"], 5)
        self.af_table.setMinimumHeight(150)
        c.lay.addWidget(self.af_table, 1)
        return c

    def _autofetch_save_settings(self) -> None:
        from . import settings
        s = settings.load()
        s.update({"price_pages": self.af_pages.text().strip(), "price_probe": self.af_probe.isChecked(),
                  "price_auto_check": self.af_auto.isChecked(), "price_auto_import": self.af_import.isChecked()})
        settings.save(s)

    def _refresh_autofetch(self) -> None:
        from . import autofetch
        rows = autofetch.list_found(self.conn)
        info = {r["url"]: r for r in self.conn.execute("SELECT url, fy, result FROM fetched_doc")}
        self.af_table.setRowCount(len(rows))
        tone = {"新しい": "warn", "ダウンロード済み": "info", "取り込み済み": "ok"}
        for i, f in enumerate(rows):
            r = info.get(f.url)
            _set_row(self.af_table, i, [f.kind, f.label, f.url.rsplit("/", 1)[-1], f.status,
                                        (r["fy"] if r and r["fy"] else autofetch.target_fy("", f.yymm)),
                                        r["result"] if r else ""], tone=tone.get(f.status, ""), tone_col=3)
            self.af_table.item(i, 0).setData(Qt.UserRole, f.url)
        for col, wd in enumerate([100, 110, 230, 110, 80]):
            self.af_table.setColumnWidth(col, wd)
        last = autofetch.last_checked(self.conn)
        new = sum(f.status == "新しい" for f in rows)
        self.af_last.setText((f"最終確認 {last}" if last else "まだ確かめていません") + (f"・新しい資料 {new}件" if new else ""))
        btn = self.nav_buttons.get("master")
        if btn:
            btn.setText(f"マスタ（新着{new}）" if new else "マスタ")

    def _autofetch_check(self, interactive: bool = False) -> None:
        from . import settings
        if getattr(self, "_af_worker", None) and self._af_worker.isRunning():
            return
        self._autofetch_save_settings()
        self.af_btn.setEnabled(False)
        self.af_btn.setText("確かめています…")
        self._af_interactive = interactive
        self._af_worker = _CheckWorker(str(settings.db_path()), self.af_pages.text().split(), self.af_probe.isChecked())
        self._af_worker.done.connect(self._autofetch_done)
        self._af_worker.start()

    def _autofetch_done(self, found, errors) -> None:
        from . import audit
        self.af_btn.setEnabled(True)
        self.af_btn.setText("今すぐ確かめる")
        self._refresh_autofetch()
        new = [f for f in found if f.status == "新しい"]
        msg = f"公表単価を確かめました：新しい資料 {len(new)}件"
        if errors:
            msg += "（うまくいかなかったもの：" + " / ".join(errors[:2]) + "）"
        self.status.showMessage(msg, 15000)
        if new and self.af_import.isChecked() and audit.can(self.conn, "master"):
            self._autofetch_import(new_only=True, quiet=not getattr(self, "_af_interactive", False))
        elif getattr(self, "_af_interactive", False) and not found and errors:
            QMessageBox.warning(self, "県のサイトに接続できませんでした", "\n".join(errors[:5]))

    def _autofetch_import_selected(self) -> None:
        rows = sorted({i.row() for i in self.af_table.selectedItems()})
        urls = [self.af_table.item(r, 0).data(Qt.UserRole) for r in rows]
        if urls:
            self._autofetch_import(urls=urls)

    def _autofetch_import(self, new_only: bool = False, urls: list[str] | None = None, quiet: bool = False) -> None:
        from pathlib import Path

        from PySide6.QtWidgets import QApplication, QProgressDialog

        from . import autofetch, settings
        targets = [f for f in autofetch.list_found(self.conn)
                   if (urls and f.url in urls) or (new_only and f.status == "新しい")]
        if not targets:
            return
        dest = Path(settings.db_path()).parent / "公表単価"
        prog = QProgressDialog("県の単価資料を取り込んでいます…", None, 0, len(targets), self)
        prog.setWindowTitle("公表単価の取り込み")
        prog.setWindowModality(Qt.WindowModal)
        prog.setMinimumDuration(0)
        done, failed = [], []
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            # 古い月から順に取り込む（年度の単価が最後に最新の月になる）
            for k, f in enumerate(sorted(targets, key=lambda x: x.yymm)):
                prog.setLabelText(f"{f.kind} {f.label} を取り込んでいます…（{k + 1}/{len(targets)}）")
                prog.setValue(k)
                QApplication.processEvents()
                try:
                    path = (Path(f.file) if f.file and Path(f.file).exists()
                            else autofetch.download(self.conn, f.url, dest, tick=QApplication.processEvents))
                    r = autofetch.import_file(self.conn, path, f.url, progress=lambda *_: QApplication.processEvents())
                    done.append(f"{f.kind} {f.label} → {r['fy']}：{r['result']}")
                except autofetch.SiteBusy as e:
                    # 断られたら続けて取りに行かない（残りは「新しい」のまま、次に押したときに取り込む）
                    rest = len(targets) - k
                    failed.append(f"{e}\n（残り {rest} 件はまだ取り込んでいません）")
                    break
                except Exception as e:
                    failed.append(f"{f.kind} {f.label}：{e}")
        finally:
            QApplication.restoreOverrideCursor()
            prog.close()
        self._refresh_autofetch()
        self._load_master_overview()
        self._res_cands = None
        self.recalc()
        text = "\n".join(done + failed)
        if quiet:
            self.status.showMessage(f"公表単価を自動で取り込みました：{len(done)}件" + (f"（失敗 {len(failed)}件）" if failed else ""),
                                    20000)
        else:
            (QMessageBox.warning if failed else QMessageBox.information)(self, "公表単価の取り込み", text or "取り込むものはありません")

    def _autofetch_on_start(self) -> None:
        """起動したとき：週1回、県のサイトを確かめる（設定でオフにできる）。"""
        from datetime import datetime, timedelta

        from . import autofetch, settings
        s = settings.load()
        if not s.get("price_auto_check", True):
            return
        last = autofetch.last_checked(self.conn)
        try:
            if last and datetime.now() - datetime.strptime(last, "%Y-%m-%d %H:%M") < timedelta(days=7):
                return
        except ValueError:
            pass
        self._autofetch_check(interactive=False)
