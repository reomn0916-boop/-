"""処分場の画面：県の受入価格から、工事ごとに品目の処分場を選ぶ（安い順・現場からの距離つき）。"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QTableWidget, QVBoxLayout,
)

from . import disposal
from .gui_pages import _page, _set_row
from .widgets import Banner, Card

SITE_COLS = ["管理番号", "処分場（会社）", "所在地", "区分", "受入価格", "単位", "距離（直線）", "電話", "備考"]
CHOSEN_COLS = ["種類", "品目", "時間帯", "処分場", "受入価格", "単価表・明細に入れるコード"]


class DisposalPageMixin:
    def _page_disposal(self):
        from .gui import _style_table
        w, v = _page()
        self.dp_banner = Banner()
        v.addWidget(self.dp_banner)

        top = Card("現場の位置", "地図アプリで現場を長押しして出る「34.6851, 135.8048」のような数字を貼り付けると、"
                   "処分場までの直線距離が出ます。運搬費は距離で変わるので、安さと距離の両方で選んでください。")
        h = QHBoxLayout()
        self.dp_site = QLineEdit()
        self.dp_site.setPlaceholderText("緯度, 経度（例：34.6851, 135.8048）")
        sb = QPushButton("位置を保存")
        sb.clicked.connect(self._save_dp_site)
        h.addWidget(self.dp_site, 1)
        h.addWidget(sb)
        top.lay.addLayout(h)
        v.addWidget(top)

        pick = Card("品目ごとの処分場", "県の「建設廃棄物等受入価格」「建設発生土受入価格」を取り込むと出ます"
                    "（マスタの自動収集、または公表単価の取り込み）。安い順に並び、同じ値段なら近い順です。")
        h2 = QHBoxLayout()
        self.dp_cat = QComboBox()
        self.dp_item = QComboBox()
        self.dp_time = QComboBox()
        self.dp_time.addItems(list(disposal.TIMEBANDS))
        self.dp_cat.currentTextChanged.connect(self._fill_dp_items)
        self.dp_item.currentTextChanged.connect(self._refresh_dp_sites)
        self.dp_time.currentTextChanged.connect(self._refresh_dp_sites)
        for lab, wd in (("種類", self.dp_cat), ("品目", self.dp_item), ("時間帯", self.dp_time)):
            h2.addWidget(QLabel(lab))
            h2.addWidget(wd, 1)
        cb = QPushButton("この処分場にする")
        cb.setObjectName("Primary")
        cb.clicked.connect(self._choose_dp)
        h2.addWidget(cb)
        pick.lay.addLayout(h2)
        self.dp_sites = QTableWidget(0, len(SITE_COLS))
        self.dp_sites.setHorizontalHeaderLabels(SITE_COLS)
        _style_table(self.dp_sites)
        self.dp_sites.setMinimumHeight(260)
        pick.lay.addWidget(self.dp_sites)
        v.addWidget(pick, 1)

        ch = Card("この工事で選んだ処分場", "単価表の「資源コード」（または明細のコード）に右の「処分:〜」を入れると、"
                  "選んだ処分場の受入価格が入ります（コードは候補にも出ます）。")
        self.dp_chosen = QTableWidget(0, len(CHOSEN_COLS))
        self.dp_chosen.setHorizontalHeaderLabels(CHOSEN_COLS)
        _style_table(self.dp_chosen)
        self.dp_chosen.setMinimumHeight(150)
        ch.lay.addWidget(self.dp_chosen)
        h3 = QHBoxLayout()
        h3.addStretch(1)
        ub = QPushButton("選んだ行の処分場を外す")
        ub.clicked.connect(self._unchoose_dp)
        h3.addWidget(ub)
        ch.lay.addLayout(h3)
        v.addWidget(ch)
        return w

    # ------------------------------------------------------------
    def _refresh_disposal(self) -> None:
        if not hasattr(self, "dp_cat"):
            return
        p = self._project_row()
        cats = disposal.categories(self.conn)
        cur = self.dp_cat.currentText()
        self.dp_cat.blockSignals(True)
        self.dp_cat.clear()
        self.dp_cat.addItems(cats)
        if cur in cats:
            self.dp_cat.setCurrentText(cur)
        self.dp_cat.blockSignals(False)
        lat = p["site_lat"] if p and "site_lat" in p.keys() else None
        lon = p["site_lon"] if p and "site_lon" in p.keys() else None
        self.dp_site.setText("" if lat is None else f"{lat:.6f}, {lon:.6f}")
        if not cats:
            self.dp_banner.show_msg("受入価格がまだありません。マスタの「県の単価資料を自動で集める」で「建設廃棄物受入価格」"
                                    "を取り込むか、県のPDFを「公表単価を取り込む」で読み込んでください。", "warn")
        elif not p:
            self.dp_banner.show_msg("工事を選ぶと、品目ごとに処分場を選べます。", "info")
        else:
            self.dp_banner.hide()
        self._fill_dp_items()
        self._refresh_dp_chosen()

    def _fill_dp_items(self, *_):
        cur = self.dp_item.currentText()
        its = [i for i, _u in disposal.items(self.conn, self.dp_cat.currentText())] if self.dp_cat.currentText() else []
        self.dp_item.blockSignals(True)
        self.dp_item.clear()
        self.dp_item.addItems(its)
        if cur in its:
            self.dp_item.setCurrentText(cur)
        self.dp_item.blockSignals(False)
        self._refresh_dp_sites()

    def _site_latlon(self):
        p = self._project_row()
        if not p or "site_lat" not in p.keys():
            return None, None
        return p["site_lat"], p["site_lon"]

    def _refresh_dp_sites(self, *_):
        cat, item = self.dp_cat.currentText(), self.dp_item.currentText()
        lat, lon = self._site_latlon()
        p = self._project_row()
        sites = disposal.search(self.conn, cat, item, self.dp_time.currentText(), lat, lon,
                                (p["price_date"] or "") if p else "") if cat and item else []
        chosen = {(c["category"], c["item"]): c["no"] for c in (disposal.chosen(self.conn, self.pid) if self.pid else [])}
        mine = chosen.get((cat, item))
        nearest = min((s.km for s in sites if s.km is not None), default=None)
        self.dp_sites.setRowCount(len(sites))
        for i, s in enumerate(sites):
            km = "" if s.km is None else f"{s.km:.1f} km" + ("（最寄り）" if s.km == nearest else "")
            note = " ".join(x for x in (s.note, f"換算 {s.factor:g} t/m3" if s.factor else "") if x)
            _set_row(self.dp_sites, i, [s.no, s.company + ("　← 選択中" if s.no == mine else ""), s.city, s.site_type,
                                        f"{s.price:,.0f}", s.unit, km, s.tel, note],
                     tone="ok" if s.no == mine else ("info" if i == 0 else ""), tone_col=1)
            self.dp_sites.item(i, 0).setData(Qt.UserRole, s.no)
        self.dp_sites.resizeColumnsToContents()

    def _refresh_dp_chosen(self):
        rows = disposal.chosen(self.conn, self.pid) if self.pid else []
        self.dp_chosen.setRowCount(len(rows))
        for i, c in enumerate(rows):
            s = c["site"]
            _set_row(self.dp_chosen, i, [c["category"], c["item"], c["timeband"],
                                         f"{s.company}（{s.city}）" if s else f"{c['no']}（今の資料にありません）",
                                         f"{s.price:,.0f} {s.unit}" if s else "", c["code"]],
                     tone="" if s else "bad", tone_col=3)
            self.dp_chosen.item(i, 0).setData(Qt.UserRole, (c["category"], c["item"]))
        self.dp_chosen.resizeColumnsToContents()

    # ------------------------------------------------------------
    def _save_dp_site(self):
        if self.pid is None:
            return
        t = self.dp_site.text().strip()
        lat, lon = disposal.parse_latlon(t) if t else (None, None)
        if t and lat is None:
            QMessageBox.warning(self, "位置", "緯度・経度が読めませんでした。「34.6851, 135.8048」の形で入れてください。")
            return
        if self.guard(disposal.set_site, self.conn, self.pid, lat, lon):
            self._refresh_disposal()

    def _choose_dp(self):
        if self.pid is None:
            QMessageBox.information(self, "処分場", "先に工事を選んでください。")
            return
        r = self.dp_sites.currentRow()
        if r < 0:
            QMessageBox.information(self, "処分場", "一覧から処分場を選んでください。")
            return
        no = self.dp_sites.item(r, 0).data(Qt.UserRole)
        if self.guard(disposal.choose, self.conn, self.pid, self.dp_cat.currentText(), self.dp_item.currentText(), no,
                      self.dp_time.currentText()):
            self._res_cands = None
            self.recalc()

    def _unchoose_dp(self):
        r = self.dp_chosen.currentRow()
        if r < 0 or self.pid is None:
            return
        cat, item = self.dp_chosen.item(r, 0).data(Qt.UserRole)
        if self.guard(disposal.unchoose, self.conn, self.pid, cat, item):
            self.recalc()


# ====================================================================== 公表額から逆算（入札検討の画面）
REV_ROWS = [("直接工事費", "direct"), ("共通仮設費", "common_temp"), ("現場管理費", "site_mgmt"),
            ("一般管理費等", "general"), ("工事価格（予定価格・税抜）", "price"), ("工事費計（税込）", "total"),
            ("最低制限価格・調査基準価格の見込み", "threshold")]


class ReversePanelMixin:
    def _reverse_card(self):
        from PySide6.QtWidgets import QTableWidget

        from . import reverse
        from .gui import _style_table
        c = Card("公表額から逆算", "発注者が公表した予定価格（または最低制限価格）を入れると、同じ諸経費の式で直接工事費と内訳を逆算します。"
                 "自社積算との差が、単価が不明な分・数量の違いの見込みです。予定価格から逆算すると、最低制限価格も見込めます。")
        h = QHBoxLayout()
        self.rv_basis = QComboBox()
        self.rv_basis.addItems(list(reverse.BASES))
        self.rv_amount = QLineEdit()
        self.rv_amount.setPlaceholderText("公表された金額（例: 12,340,000）")
        self.rv_amount.setAlignment(Qt.AlignRight)
        self.rv_amount.returnPressed.connect(self._do_reverse)
        go = QPushButton("逆算する")
        go.setObjectName("Primary")
        go.clicked.connect(self._do_reverse)
        self.rv_bid = QPushButton("見込みの最低制限価格を入札額にする")
        self.rv_bid.clicked.connect(self._reverse_to_bid)
        self.rv_bid.setEnabled(False)
        h.addWidget(self.rv_basis)
        h.addWidget(self.rv_amount, 1)
        h.addWidget(go)
        h.addWidget(self.rv_bid)
        c.lay.addLayout(h)
        self.rv_msg = Banner()
        c.lay.addWidget(self.rv_msg)
        self.rv_table = QTableWidget(len(REV_ROWS), 4)
        self.rv_table.setHorizontalHeaderLabels(["", "自社積算", "逆算した見込み", "差（見込み − 自社）"])
        _style_table(self.rv_table)
        self.rv_table.verticalHeader().setVisible(False)
        self.rv_table.setMinimumHeight(250)
        c.lay.addWidget(self.rv_table)
        self._rv_result = None
        return c

    def _do_reverse(self) -> None:
        from . import reverse
        if self.pid is None:
            return
        t = self.rv_amount.text().replace(",", "").replace("¥", "").replace("円", "").strip()
        try:
            amount = int(float(t))
        except ValueError:
            self.rv_msg.show_msg("公表された金額を数字で入れてください。", "warn")
            return
        if self.guard(reverse.save, self.conn, self.pid, self.rv_basis.currentText(), amount) is None:
            return
        self._refresh_bid()

    def _refresh_reverse(self) -> None:
        from . import reverse
        from .widgets import yen
        if not hasattr(self, "rv_table"):
            return
        p = self._project_row()
        self._rv_result = None
        self.rv_bid.setEnabled(False)
        basis = (p["published_basis"] if p and "published_basis" in p.keys() else "") or ""
        amount = (p["published_amount"] if p and "published_amount" in p.keys() else 0) or 0
        if basis in reverse.BASES:
            self.rv_basis.setCurrentText(basis)
        if not self.rv_amount.hasFocus():
            self.rv_amount.setText(yen(amount) if amount else "")
        if not p or not amount:
            self.rv_table.clearContents()
            self.rv_msg.show_msg("公表額を入れると、ここに内訳の見込みが出ます。", "info")
            return
        try:
            r = reverse.solve(self.conn, self.pid, amount, self.rv_basis.currentText())
        except ValueError as e:
            self.rv_msg.show_msg(str(e), "warn")
            return
        self._rv_result = r
        for i, (label, key) in enumerate(REV_ROWS):
            a, b = getattr(r.ours, key), getattr(r.implied, key)
            _set_row(self.rv_table, i, [label, yen(a), yen(b), f"{'+' if b - a >= 0 else '−'}{yen(abs(b - a))}"],
                     tone=("warn" if key == "direct" and abs(r.gap_rate) > 3 else ""), tone_col=3)
        self.rv_table.resizeColumnsToContents()
        rng = (f"¥{yen(r.direct_low)}〜¥{yen(r.direct_high)}" if r.direct_high > r.direct_low
               else f"¥{yen(r.direct_low)}")
        if not r.exact:
            self.rv_msg.show_msg(f"諸経費の式では公表額ちょうどになりませんでした（いちばん近い直接工事費 {rng}）。"
                                 "工種区分・諸経費の式・端数の決まりが発注者と合っているか確かめてください。", "warn")
        elif r.gap > 0:
            self.rv_msg.show_msg(f"公表額になる直接工事費は {rng}。自社積算より ¥{yen(r.gap)}（{r.gap_rate:.1f}%）多く、"
                                 "単価が不明な資源や数量の違いの分と見込まれます（「不明な単価」で埋めると近づきます）。", "warn")
        else:
            self.rv_msg.show_msg(f"公表額になる直接工事費は {rng}。自社積算より ¥{yen(-r.gap)}（{-r.gap_rate:.1f}%）少なく、"
                                 "自社積算が高めです（数量・単価・工種区分を確かめてください）。", "info" if r.gap > -1000 else "warn")
        self.rv_bid.setEnabled(True)

    def _cur_threshold(self) -> int:
        """今の基準価格：公表額があれば逆算した値、なければ自社積算からの試算"""
        r = getattr(self, "_rv_result", None)
        if r:
            return r.target if r.basis == "最低制限価格（税抜）" else r.implied.threshold
        return self.design.summary.threshold

    def _cur_planned(self) -> int:
        r = getattr(self, "_rv_result", None)
        return r.implied.price if r else self.design.summary.price

    def _reverse_to_bid(self) -> None:
        if self._rv_result and self.pid is not None:
            self._set_bid(self._cur_threshold())
