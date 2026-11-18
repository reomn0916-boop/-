"""画面の部品：カード、金額の要約、取り込み口、入札額のものさし、明細表のモデル。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import (
    QComboBox, QCompleter, QFileDialog, QFrame, QHBoxLayout, QLabel, QLineEdit, QSizePolicy,
    QStyledItemDelegate, QVBoxLayout, QWidget,
)

from . import calc
from .importer import CATEGORIES
from .theme import C, color


def yen(v: float | int | None) -> str:
    return "" if v is None else f"{v:,.0f}"


# ------------------------------------------------------------------ 箱もの
class Card(QFrame):
    def __init__(self, title: str = "", hint: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Card")
        self.lay = QVBoxLayout(self)
        self.lay.setContentsMargins(18, 16, 18, 16)
        self.lay.setSpacing(10)
        if title:
            head = QHBoxLayout()
            t = QLabel(title)
            t.setObjectName("CardTitle")
            head.addWidget(t)
            head.addStretch(1)
            self.head = head
            self.lay.addLayout(head)
        if hint:
            h = QLabel(hint)
            h.setObjectName("Muted")
            h.setWordWrap(True)
            self.lay.addWidget(h)


class Kpi(QFrame):
    """金額の要約カード（見出し・大きな数字・補足）"""

    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Kpi")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 12, 16, 12)
        lay.setSpacing(2)
        self.title = QLabel(title)
        self.title.setObjectName("KpiTitle")
        self.value = QLabel("—")
        self.value.setObjectName("KpiValue")
        self.sub = QLabel(" ")
        self.sub.setObjectName("KpiSub")
        for w in (self.title, self.value, self.sub):
            lay.addWidget(w)
        self._accent = ""

    def set(self, value: str, sub: str = " ", tone: str = "") -> None:
        self.value.setText(value)
        self.sub.setText(sub or " ")
        col = {"bad": C["bad"], "ok": C["ok"], "warn": C["warn"]}.get(tone, C["text"])
        self.value.setStyleSheet(f"color: {col};")
        bar = {"bad": C["bad"], "ok": C["ok"], "warn": C["warn"]}.get(tone, C["border"])
        self.setStyleSheet(f"#Kpi {{ border-top: 3px solid {bar}; }}")


class Pill(QLabel):
    TONES = {
        "ok": (C["ok_soft"], C["ok"]), "warn": (C["warn_soft"], C["warn"]), "bad": (C["bad_soft"], C["bad"]),
        "info": (C["accent_soft"], C["accent"]), "": (C["bg"], C["muted"]),
    }

    def __init__(self, text: str = "", tone: str = "", parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self.setObjectName("Pill")
        self.set_tone(tone)

    def set_tone(self, tone: str) -> None:
        bg, fg = self.TONES.get(tone, self.TONES[""])
        self.setStyleSheet(f"background: {bg}; color: {fg};")


class Banner(QLabel):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Banner")
        self.setWordWrap(True)
        self.hide()

    def show_msg(self, text: str, tone: str = "info") -> None:
        bg, fg = Pill.TONES.get(tone, Pill.TONES["info"])
        self.setStyleSheet(f"background: {bg}; color: {fg}; border: 1px solid {fg}33;")
        self.setText(text)
        self.setVisible(bool(text))


def path_row(edit: QLineEdit, pick) -> QWidget:
    from PySide6.QtWidgets import QPushButton
    w = QWidget()
    h = QHBoxLayout(w)
    h.setContentsMargins(0, 0, 0, 0)
    h.setSpacing(6)
    b = QPushButton("参照…")
    b.clicked.connect(pick)
    h.addWidget(edit, 1)
    h.addWidget(b)
    return w


# ------------------------------------------------------------------ 取り込み口
class DropZone(QFrame):
    """設計書CSVをドラッグして落とす場所。クリックでも選べる。"""
    fileChosen = Signal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("Drop")
        self.setAcceptDrops(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(150)
        lay = QVBoxLayout(self)
        lay.setAlignment(Qt.AlignCenter)
        self.icon = QLabel("⇩")
        self.icon.setAlignment(Qt.AlignCenter)
        self.icon.setStyleSheet(f"font-size: 26pt; color: {C['faint']};")
        self.title = QLabel("設計書データ（CSV）をここにドラッグ")
        self.title.setObjectName("DropTitle")
        self.title.setAlignment(Qt.AlignCenter)
        self.sub = QLabel("またはクリックしてファイルを選ぶ")
        self.sub.setObjectName("Muted")
        self.sub.setAlignment(Qt.AlignCenter)
        for w in (self.icon, self.title, self.sub):
            lay.addWidget(w)
        self.path = ""

    def _restyle(self) -> None:
        self.style().unpolish(self)
        self.style().polish(self)

    def set_file(self, path: str) -> None:
        self.path = path
        p = Path(path)
        self.icon.setText("✓")
        self.icon.setStyleSheet(f"font-size: 22pt; color: {C['ok']};")
        self.title.setText(p.name)
        self.sub.setText(f"{p.parent}　—　クリックで選び直す")
        self.setProperty("filled", "true")
        self._restyle()
        self.fileChosen.emit(path)

    def mousePressEvent(self, e) -> None:  # noqa: N802
        p, _ = QFileDialog.getOpenFileName(self, "設計書データ", "", "CSV (*.csv);;すべて (*.*)")
        if p:
            self.set_file(p)

    def dragEnterEvent(self, e) -> None:  # noqa: N802
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
            self.setProperty("hover", "true")
            self._restyle()

    def dragLeaveEvent(self, e) -> None:  # noqa: N802
        self.setProperty("hover", "false")
        self._restyle()

    def dropEvent(self, e) -> None:  # noqa: N802
        self.setProperty("hover", "false")
        urls = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        if urls:
            self.set_file(urls[0])


# ------------------------------------------------------------------ 入札額のものさし
class BidGauge(QWidget):
    """予定価格・基準価格・実行原価の位置関係を1本の帯に描き、入札額をクリック・ドラッグで動かせる。"""
    bidChanged = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(118)
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.planned = self.threshold = self.cost = self.bid = 0
        self.step = 1000

    def set_values(self, planned: int, threshold: int, cost: int, bid: int) -> None:
        self.planned, self.threshold, self.cost, self.bid = planned, threshold, cost, bid
        self.update()

    def _range(self) -> tuple[float, float]:
        vals = [v for v in (self.planned, self.threshold, self.cost, self.bid) if v]
        if not vals:
            return 0.0, 1.0
        lo = min(min(vals), self.planned * 0.7) * 0.97
        hi = max(max(vals), self.planned) * 1.04
        return lo, hi

    def _x(self, v: float) -> float:
        lo, hi = self._range()
        left, right = 24, self.width() - 24
        return left + (v - lo) / (hi - lo or 1) * (right - left)

    def _v(self, x: float) -> int:
        lo, hi = self._range()
        left, right = 24, self.width() - 24
        v = lo + (x - left) / (right - left or 1) * (hi - lo)
        return int(round(v / self.step) * self.step)

    def mousePressEvent(self, e) -> None:  # noqa: N802
        if self.planned:
            self.bid = self._v(e.position().x())
            self.update()
            self.bidChanged.emit(self.bid)

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        if e.buttons() & Qt.LeftButton:
            self.mousePressEvent(e)

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        if not self.planned:
            p.setPen(color("faint"))
            p.drawText(self.rect(), Qt.AlignCenter, "工事を選ぶと表示されます")
            return
        lo, hi = self._range()
        y = 36
        h = 14
        left, right = self._x(lo), self._x(hi)

        def band(a: float, b: float, col: str) -> None:
            r = QRectF(self._x(a), y, self._x(b) - self._x(a), h)
            p.fillRect(r, QColor(col))

        # 帯：基準未満（赤）・基準〜予定価格（緑）・予定価格超（灰）
        path = QPainterPath()
        path.addRoundedRect(QRectF(left, y, right - left, h), 7, 7)
        p.setClipPath(path)
        band(lo, self.threshold, C["bad_soft"])
        band(self.threshold, self.planned, C["ok_soft"])
        band(self.planned, hi, C["bg"])
        p.setClipping(False)
        p.setPen(QPen(color("border_strong"), 1))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)

        small = QFont(self.font())
        small.setPointSizeF(self.font().pointSizeF() * 0.85)
        bold = QFont(self.font())
        bold.setBold(True)

        def marker(v: int, label: str, col: str, above: bool, dashed: bool = False) -> None:
            x = self._x(v)
            pen = QPen(QColor(col), 2, Qt.DashLine if dashed else Qt.SolidLine)
            p.setPen(pen)
            p.drawLine(QPointF(x, y - 8), QPointF(x, y + h + 8))
            p.setFont(small)
            fm = p.fontMetrics()
            text = f"{label}  {yen(v)}"
            w = fm.horizontalAdvance(text)
            tx = min(max(x - w / 2, 4), self.width() - w - 4)
            p.setPen(QColor(col))
            p.drawText(QPointF(tx, y - 14 if above else y + h + 24), text)

        marker(self.cost, "実行原価", C["muted"], above=False, dashed=True)
        marker(self.threshold, "基準価格", C["bad"], above=True)
        marker(self.planned, "予定価格", C["text"], above=True)

        if self.bid:
            x = self._x(self.bid)
            tone = "bad" if self.bid < self.threshold or self.bid > self.planned else "ok"
            if self.bid < self.cost and tone == "ok":
                tone = "warn"
            col = QColor(C[tone])
            p.setPen(Qt.NoPen)
            p.setBrush(col)
            p.drawPolygon(QPolygonF([QPointF(x, y + h / 2), QPointF(x - 8, y + h + 14), QPointF(x + 8, y + h + 14)]))
            p.drawEllipse(QPointF(x, y + h / 2), 6, 6)
            p.setFont(bold)
            pct = self.bid / self.planned * 100
            text = f"入札額 {yen(self.bid)}（{pct:.2f}%）"
            fm = p.fontMetrics()
            w = fm.horizontalAdvance(text)
            tx = min(max(x - w / 2, 4), self.width() - w - 4)
            p.setPen(col)
            p.drawText(QPointF(tx, y + h + 46), text)


# ------------------------------------------------------------------ 明細表
COLS = ["No", "区分", "工種", "種別", "細別", "名称", "規格", "単位", "数量", "単価", "金額", "当てはめ", "コード",
        "補正", "積算根拠メモ"]
CAT, QTY, PRICE, AMOUNT, HOW, CODE, COND, NOTE = 1, 8, 9, 10, 11, 12, 13, 14
NUMERIC = {0, QTY, PRICE, AMOUNT}
EDITABLE = {CAT, QTY, CODE, COND, NOTE}
HOW_TONE = {"歩掛": "ok", "パッケージ": "info", "単価": "ok", "見積": "info", "対応表": "info", "未設定": "bad",
            "物価資料待ち": "warn"}


class ItemModel(QAbstractTableModel):
    edited = Signal(int, int, str)  # 明細ID, 列, 値

    def __init__(self) -> None:
        super().__init__()
        self.items: list[calc.ItemResult] = []

    def set_items(self, items: list[calc.ItemResult]) -> None:
        self.beginResetModel()
        self.items = items
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()) -> int:  # noqa: N802
        return 0 if parent.isValid() else len(self.items)

    def columnCount(self, parent=QModelIndex()) -> int:  # noqa: N802
        return len(COLS)

    def headerData(self, s, orient, role=Qt.DisplayRole):  # noqa: N802
        if orient == Qt.Horizontal and role == Qt.DisplayRole:
            return COLS[s]
        if orient == Qt.Horizontal and role == Qt.TextAlignmentRole:
            return int((Qt.AlignRight if s in NUMERIC else Qt.AlignLeft) | Qt.AlignVCenter)
        return None

    def value(self, it: calc.ItemResult, c: int):
        return [it.seq, it.category, it.level1, it.level2, it.level3, it.name, it.spec, it.unit, it.qty,
                it.unit_price, it.amount, it.how, it.code, it.conditions, it.note][c]

    def data(self, idx: QModelIndex, role=Qt.DisplayRole):
        it = self.items[idx.row()]
        c = idx.column()
        v = self.value(it, c)
        if role == Qt.DisplayRole:
            if c == 8:
                return f"{v:,.3f}".rstrip("0").rstrip(".")
            if c in (PRICE, AMOUNT):
                return "—" if it.missing else yen(v)
            if c == HOW:
                return f"● {v}"
            return str(v)
        if role == Qt.EditRole:
            return f"{v:g}" if c == QTY else str(v)
        if role == Qt.TextAlignmentRole:
            return int((Qt.AlignRight if c in NUMERIC else Qt.AlignLeft) | Qt.AlignVCenter)
        if role == Qt.ForegroundRole:
            if c == HOW:
                return QBrush(QColor(C[{"ok": "ok", "info": "accent", "bad": "bad", "warn": "warn"}[HOW_TONE.get(it.how, "ok")]]))
            if c == CAT and it.category != "直接":
                return QBrush(color("warn"))
            if c == COND:
                return QBrush(color("accent"))
            if c in (0, 2, 3, 4):
                return QBrush(color("muted"))
            if c == NOTE:
                return QBrush(color("muted"))
        if role == Qt.BackgroundRole and it.how == "未設定":
            return QBrush(QColor(C["bad_soft"]))
        if role == Qt.BackgroundRole and it.how == "物価資料待ち":
            return QBrush(QColor(C["warn_soft"]))
        if role == Qt.FontRole and c == AMOUNT:
            f = QFont()
            f.setBold(True)
            return f
        if role == Qt.ToolTipRole:
            if c == CODE:
                return "歩掛・施工パッケージ・単価・見積のコードを入力（名称の一部でも候補が出ます）"
            if c == COND:
                return "この行だけに効かせる補正のコード（読点区切り）。工事全体の補正は「工事の設定」で。"
            if c == QTY:
                return "数量（設計変更のときなどに直せます。変更前の値は履歴に残ります）"
            if c == NOTE and it.note:
                return it.note
        return None

    def flags(self, idx: QModelIndex):
        f = super().flags(idx)
        return f | Qt.ItemIsEditable if idx.column() in EDITABLE else f

    def setData(self, idx: QModelIndex, value, role=Qt.EditRole) -> bool:  # noqa: N802
        if role != Qt.EditRole:
            return False
        it = self.items[idx.row()]
        if str(value).strip() == self.data(idx, Qt.EditRole):
            return False
        self.edited.emit(it.item_id, idx.column(), str(value).strip())
        return True


class CodeDelegate(QStyledItemDelegate):
    """コード欄：候補（コード＋名称）から選べる。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.candidates: list[str] = []

    def createEditor(self, parent, option, index):  # noqa: N802
        e = QLineEdit(parent)
        comp = QCompleter(self.candidates, e)
        comp.setFilterMode(Qt.MatchContains)
        comp.setCaseSensitivity(Qt.CaseInsensitive)
        comp.setMaxVisibleItems(12)
        comp.popup().setMinimumWidth(420)
        e.setCompleter(comp)
        return e

    def setModelData(self, editor, model, index):  # noqa: N802
        text = editor.text().strip()
        model.setData(index, text.split("　")[0].split(" ")[0] if text else "", Qt.EditRole)


class CategoryDelegate(QStyledItemDelegate):
    def createEditor(self, parent, option, index):  # noqa: N802
        cb = QComboBox(parent)
        cb.addItems(list(CATEGORIES))
        return cb

    def setEditorData(self, editor, index):  # noqa: N802
        editor.setCurrentText(index.data(Qt.EditRole))

    def setModelData(self, editor, model, index):  # noqa: N802
        model.setData(index, editor.currentText(), Qt.EditRole)


class RegionBox(QComboBox):
    """地区の選択。奈良県の地区別資材単価の 1〜11地区 を、市町村名つきで選べる。text()/setText() は「5地区」の形。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        from .publicprice import NARA_AREAS
        self.addItem("（地区を指定しない：県下同一の単価だけ使う）", "")
        for k, cities in NARA_AREAS.items():
            self.addItem(f"{k}　{cities}", k)
            self.setItemData(self.count() - 1, cities, Qt.ToolTipRole)
        self.setMaxVisibleItems(13)
        self.view().setMinimumWidth(560)
        # 長い市町村名で画面の幅が広がらないようにする（一覧を開くと全部見える）
        self.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
        self.setMinimumContentsLength(18)

    def text(self) -> str:
        return self.currentData() if self.currentData() is not None else self.currentText()

    def setText(self, value: str) -> None:  # noqa: N802
        i = self.findData(value or "")
        if i < 0:  # 以前に手で入れた地区名も残す
            self.addItem(value, value)
            i = self.count() - 1
        self.setCurrentIndex(i)

    def setPlaceholderText(self, _t: str) -> None:  # noqa: N802 （QLineEdit と同じ呼び方を受ける）
        pass
