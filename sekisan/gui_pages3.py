"""単価表の画面：金抜き設計書から作った単価表（歩掛）と施工パッケージの、伏せてある数量・資源・率を入れる。"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QFont
from PySide6.QtWidgets import (
    QCheckBox, QCompleter, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMessageBox, QPushButton,
    QSplitter, QStyledItemDelegate, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from . import calc, kinnuki
from .gui_pages import _page
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
                               p["orderer"], p["price_date"])

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
        return out

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
