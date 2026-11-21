"""画面（Windows用）。左にメニュー、上に工事の要約、中央に各画面。"""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QSortFilterProxyModel, Qt, QTimer, QUrl
from PySide6.QtGui import QBrush, QDesktopServices, QFont, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView, QApplication, QButtonGroup, QCheckBox, QComboBox, QFileDialog, QFormLayout, QFrame,
    QGridLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow,
    QMessageBox, QPlainTextEdit, QPushButton, QSplitter, QStackedWidget, QTableView, QTableWidget,
    QSizePolicy, QTableWidgetItem, QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

from . import audit, awards, calc, db, importer, pipeline, settings, theme
from .gui_pages import AddItemDialog, PagesMixin
from .gui_pages2 import BookPageMixin, PagesMixin2
from .gui_pages3 import AutoFetchMixin, TablesPageMixin
from .gui_pages5 import StandardsPageMixin, UpdateMixin
from .gui_pages4 import DisposalPageMixin, KoukokuMixin, ReversePanelMixin, SekopkgMixin, SubmissionPageMixin
from . import kinnuki
from . import backup
from .export import breakdown_rows
from .importer import normalize_category
from .theme import C, color
from .widgets import (
    AMOUNT, CAT, CODE, COND, NOTE, QTY, Banner, RegionBox, BidGauge, Card, CategoryDelegate, CodeDelegate, DropZone, ItemModel, Kpi,
    Pill, path_row, yen,
)

PAGES = [
    # (キー, メニュー名, 見出し, 説明, 区切り)
    ("new", "新規積算", "新規積算", "設計書データを取り込み、計算から内訳書・実行予算の出力までを一度に行います。", "積算"),
    ("items", "明細", "明細", "歩掛・単価の当てはめを確認・修正します。直したコードとメモは次の工事にも引き継がれます。", None),
    ("tables", "単価表", "単価表", "金抜き設計書から作った単価表（歩掛）です。伏せてある数量・当たらない資源・諸雑費率を入れます。", None),
    ("tree", "内訳書", "工事費内訳書", "直接工事費 → 工種 → 種別 → 細別 の階層で金額を確認します。", None),
    ("bid", "入札検討", "入札検討", "予定価格・基準価格・実行原価の位置関係を見ながら入札額を決めます。", None),
    ("submit", "提出書類", "提出書類", "入札額に合わせた工事費内訳書（Excel・PDF）・入札書・委任状を作り、出す前のチェックをします。", None),
    ("project", "工事の設定", "工事の設定", "発注者・単価の適用日・補正（割増）・確認と提出を設定します。", "工事"),
    ("schedule", "スケジュール", "入札スケジュール", "公告から開札・工期までの日程と、提出物のチェックリストです。", None),
    ("change", "設計変更", "設計変更", "変更前と変更後を並べて、数量・金額の増減を確認します。スライドの目安も出せます。", None),
    ("after", "受注後", "受注後（単価合意・出来高）", "契約額から合意単価を出し、出来高と部分払いの限度額を計算します。", None),
    ("verify", "照合・答え合わせ", "照合・答え合わせ", "金抜き設計書PDFや、外注していた頃の積算結果と比べてズレを見つけます。", "確認"),
    ("inquiry", "質疑書", "質疑書", "設計書の食い違い・不明な点を、発注者への質問にまとめます。", None),
    ("history", "変更履歴", "変更履歴", "誰が・いつ・何を変えたかの記録です。", None),
    ("quotes", "見積単価", "見積単価", "単価表にない資材・工種の業者見積を比べ、採用単価を決めます。", "データ"),
    ("disposal", "処分場", "処分場（受入価格）", "県の受入価格から、品目ごとに処分場を選びます。安い順・現場からの距離つきで比べられます。", None),
    ("book", "不明な単価", "単価が不明な資源", "単価が「不明」の資源を原因ごとにまとめ、物価資料・損料表・見積で調べた単価を入れます。", None),
    ("awards", "落札実績", "落札実績", "過去の落札結果から、落札率や自社積算の精度を見ます。入札検討の予定価格の見込みにも使います。", None),
    ("master", "マスタ", "マスタ管理", "年度ごとの単価・歩掛・諸経費率・補正・機械損料・公表単価、発注者ごとの設定を取り込みます。", None),
    ("standards", "基準・ルール", "基準・ルール", "諸経費率・施工地域の補正・最低制限価格の式・端数処理を、基準が変わったときにソフトの中で直します。", None),
    ("settings", "設定", "設定", "データファイル・担当者名・利用者と権限・バックアップの設定です。", None),
]
PROJECT_PAGES = {"items", "tables", "tree", "bid", "submit", "project", "schedule", "change", "after", "verify", "inquiry", "history", "book",
                 "disposal"}


def open_path(path: Path) -> None:
    QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))


def _page(margins: int = 24) -> tuple[QWidget, QVBoxLayout]:
    w = QWidget()
    v = QVBoxLayout(w)
    v.setContentsMargins(margins, 20, margins, 20)
    v.setSpacing(14)
    return w, v


def _ro_item(text: str, align_right: bool = False) -> QTableWidgetItem:
    it = QTableWidgetItem(text)
    it.setFlags(it.flags() & ~Qt.ItemIsEditable)
    if align_right:
        it.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
    return it


def _style_table(t) -> None:
    t.setAlternatingRowColors(True)
    t.setShowGrid(False) if hasattr(t, "setShowGrid") else None
    t.verticalHeader().setVisible(False) if hasattr(t, "verticalHeader") else None
    if hasattr(t, "verticalHeader"):
        t.verticalHeader().setDefaultSectionSize(30)
    t.setSelectionBehavior(QAbstractItemView.SelectRows)
    t.horizontalHeader().setHighlightSections(False) if hasattr(t, "horizontalHeader") else None


class ItemFilter(QSortFilterProxyModel):
    def __init__(self) -> None:
        super().__init__()
        self.text = ""
        self.only_unresolved = False

    def filterAcceptsRow(self, row, parent) -> bool:  # noqa: N802
        it = self.sourceModel().items[row]
        if self.only_unresolved and not it.missing:
            return False
        if self.text:
            hay = " ".join([it.name, it.spec, it.code, it.level1, it.level2, it.level3, it.note]).lower()
            return self.text.lower() in hay
        return True


class MainWindow(PagesMixin, PagesMixin2, BookPageMixin, TablesPageMixin, AutoFetchMixin, DisposalPageMixin, ReversePanelMixin,
                 SubmissionPageMixin, SekopkgMixin, KoukokuMixin, StandardsPageMixin, UpdateMixin,
                 QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("公共工事 積算アプリ")
        self.resize(1360, 840)
        self.setMinimumSize(1100, 680)
        self.conn = db.connect(settings.db_path())
        try:  # ⑩ 前回から1日たっていれば自動でバックアップ
            self.auto_backup = backup.auto(settings.db_path(), settings.load().get("backup_dir") or None)
        except Exception:  # バックアップ先に書けなくても起動は止めない
            self.auto_backup = None
        self.pid: int | None = None
        self.design: calc.Result | None = None
        self.company: calc.Result | None = None

        root = QWidget()
        h = QHBoxLayout(root)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(0)
        h.addWidget(self._sidebar())

        content = QWidget()
        content.setObjectName("Content")
        cv = QVBoxLayout(content)
        cv.setContentsMargins(0, 0, 0, 0)
        cv.setSpacing(0)
        cv.addWidget(self._header())
        self.stack = QStackedWidget()
        self.pages: dict[str, int] = {}
        builders = {"new": self._page_new, "items": self._page_items, "tree": self._page_tree,
                    "bid": self._page_bid, "verify": self._page_verify, "master": self._page_master,
                    "settings": self._page_settings, "project": self._page_project, "change": self._page_change,
                    "history": self._page_history, "quotes": self._page_quotes, "awards": self._page_awards,
                    "schedule": self._page_schedule, "after": self._page_after, "inquiry": self._page_inquiry,
                    "book": self._page_book, "tables": self._page_tables, "disposal": self._page_disposal,
                    "submit": self._page_submit, "standards": self._page_standards}
        for key, *_ in PAGES:
            page = builders[key]()
            if key in ("master", "settings", "bid", "submit", "standards"):  # 中身が多い画面はスクロールできるようにする
                from PySide6.QtWidgets import QScrollArea
                sc = QScrollArea()
                sc.setWidgetResizable(True)
                sc.setFrameShape(QFrame.NoFrame)
                sc.setStyleSheet("QScrollArea { background: transparent; } QScrollArea > QWidget > QWidget { background: transparent; }")
                page.setMinimumHeight(1180 if key == "master" else 860)
                sc.setWidget(page)
                page = sc
            self.pages[key] = self.stack.addWidget(page)
        cv.addWidget(self.stack, 1)
        h.addWidget(content, 1)
        self.setCentralWidget(root)

        self.status = self.statusBar()
        self._update_status()
        QShortcut(QKeySequence("Ctrl+F"), self, activated=lambda: (self.go("items"), self.search.setFocus()))
        QShortcut(QKeySequence("F5"), self, activated=self.recalc)

        self._load_projects()
        self.go("items" if self.pid is not None else "new")
        self._refresh_autofetch()
        QTimer.singleShot(1500, self._autofetch_on_start)  # 画面が出てから、週1回だけ県のサイトを確かめる
        QTimer.singleShot(3000, self._update_on_start)     # 新しい版があるか確かめる

    # ================================================================ 骨組み
    def _sidebar(self) -> QWidget:
        side = QFrame()
        side.setObjectName("Sidebar")
        side.setFixedWidth(208)
        v = QVBoxLayout(side)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        b = QLabel("積算アプリ")
        b.setObjectName("Brand")
        s = QLabel("公共工事（奈良県・県内市町村）")
        s.setObjectName("BrandSub")
        v.addWidget(b)
        v.addWidget(s)
        self.nav = QButtonGroup(self)
        self.nav.setExclusive(True)
        self.nav_buttons: dict[str, QPushButton] = {}
        for key, label, _t, _h, section in PAGES:
            if section:
                sec = QLabel(section)
                sec.setObjectName("NavSection")
                v.addWidget(sec)
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setCursor(Qt.PointingHandCursor)
            btn.clicked.connect(lambda _=False, k=key: self.go(k))
            self.nav.addButton(btn)
            self.nav_buttons[key] = btn
            v.addWidget(btn)
        v.addStretch(1)
        self.side_role = QLabel()
        self.side_role.setObjectName("SidebarFoot")
        self.side_role.setStyleSheet("color: #C9D3E0; font-weight: 700; padding-bottom: 0;")
        v.addWidget(self.side_role)
        self.side_foot = QLabel()
        self.side_foot.setObjectName("SidebarFoot")
        self.side_foot.setWordWrap(True)
        v.addWidget(self.side_foot)
        return side

    def _header(self) -> QWidget:
        hd = QFrame()
        hd.setObjectName("Header")
        hd.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        v = QVBoxLayout(hd)
        v.setContentsMargins(24, 16, 24, 16)
        v.setSpacing(12)
        top = QHBoxLayout()
        tl = QVBoxLayout()
        tl.setSpacing(2)
        self.page_title = QLabel()
        self.page_title.setObjectName("PageTitle")
        self.page_hint = QLabel()
        self.page_hint.setObjectName("PageHint")
        tl.addWidget(self.page_title)
        tl.addWidget(self.page_hint)
        top.addLayout(tl, 1)
        self.proj_box = QWidget()
        pb = QHBoxLayout(self.proj_box)
        pb.setContentsMargins(0, 0, 0, 0)
        pb.setSpacing(8)
        lab = QLabel("工事")
        lab.setObjectName("Muted")
        self.proj = QComboBox()
        self.proj.setObjectName("HeaderProject")
        self.proj.currentIndexChanged.connect(self._project_changed)
        self.fy_pill = Pill("", "info")
        self.status_pill = Pill("")
        pb.addWidget(lab)
        pb.addWidget(self.proj)
        pb.addWidget(self.fy_pill)
        pb.addWidget(self.status_pill)
        top.addWidget(self.proj_box, 0, Qt.AlignTop)
        v.addLayout(top)

        self.kpi_row = QWidget()
        kr = QHBoxLayout(self.kpi_row)
        kr.setContentsMargins(0, 0, 0, 0)
        kr.setSpacing(12)
        self.k_direct = Kpi("直接工事費")
        self.k_price = Kpi("工事価格（予定価格の見込み）")
        self.k_threshold = Kpi("調査基準価格・最低制限価格（試算）")
        self.k_cost = Kpi("実行原価の見込み")
        self.k_unres = Kpi("歩掛・単価が未設定の明細")
        for k in (self.k_direct, self.k_price, self.k_threshold, self.k_cost, self.k_unres):
            kr.addWidget(k)
        v.addWidget(self.kpi_row)
        v.addStretch(1)
        self.header_frame = hd
        return hd

    def go(self, key: str) -> None:
        self.stack.setCurrentIndex(self.pages[key])
        self.nav_buttons[key].setChecked(True)
        _k, _l, title, hint, _s = next(p for p in PAGES if p[0] == key)
        self.page_title.setText(title)
        self.page_hint.setText(hint)
        on_project = key in PROJECT_PAGES
        self.kpi_row.setVisible(on_project)
        self.proj_box.setVisible(on_project)
        self.header_frame.layout().activate()
        self.header_frame.setFixedHeight(self.header_frame.sizeHint().height())
        if key == "master":
            self._load_master_overview()
            self._refresh_autofetch()
            self._refresh_sekop()
            self._refresh_orderer_rules()
        if key == "new":
            self._load_recent()
            self._fill_master_choices()
        if key == "quotes":
            self._refresh_quotes()
        if key == "awards":
            self._refresh_awards()
        if key == "history":
            self._refresh_history()
        if key == "standards":
            self._refresh_standards()
        if key == "settings":
            self._refresh_users()
            self._refresh_backups()

    def _update_status(self) -> None:
        p = settings.db_path()
        msg = f"データファイル: {p}"
        if getattr(self, "auto_backup", None):
            msg += f"　／　自動バックアップしました: {self.auto_backup.name}"
        self.status.showMessage(msg)
        self.side_foot.setText(f"データ: {p.name}\n{p.parent}")

    # ================================================================ 工事の切り替え・再計算
    def _load_projects(self, select: int | None = None) -> None:
        rows = list(self.conn.execute("SELECT id, name, fy, created_at FROM project ORDER BY id DESC"))
        cur = select if select is not None else self.pid
        self.proj.blockSignals(True)
        self.proj.clear()
        for r in rows:
            self.proj.addItem(f"{r['name']}", r["id"])
        idx = self.proj.findData(cur) if cur is not None else (0 if rows else -1)
        self.proj.setCurrentIndex(max(idx, 0) if rows else -1)
        self.proj.blockSignals(False)
        self._project_changed()
        self._load_recent()

    def _project_changed(self) -> None:
        self.pid = self.proj.currentData()
        self._res_cands = None
        self.bid_edit.clear()
        self.recalc()

    def recalc(self) -> None:
        if self.pid is None:
            self.design = self.company = None
        else:
            self.design = calc.calculate(self.conn, self.pid, calc.DESIGN)
            self.company = calc.calculate(self.conn, self.pid, calc.COMPANY)
        self._refresh_kpis()
        self._refresh_items()
        self._refresh_tree()
        self._refresh_bid()
        self._refresh_verify()
        self._refresh_project_page()
        self._refresh_change()
        self._refresh_history()
        self._refresh_schedule()
        self._refresh_inquiry()
        self._refresh_after()
        self._refresh_users()
        self._refresh_book()
        self._refresh_tables()
        self._refresh_disposal()
        self._refresh_submit()

    def _project_row(self):
        return self.conn.execute("SELECT * FROM project WHERE id=?", (self.pid,)).fetchone() if self.pid else None

    def _refresh_kpis(self) -> None:
        d, c = self.design, self.company
        p = self._project_row()
        self.fy_pill.setText(f"{p['fy']}年度・{p['work_type'] or '工種区分なし'}"
                             + (f"・{p['region']}" if p["region"] else "")
                             + (f"・{p['orderer']}" if p["orderer"] else "") if p else "")
        st = (p["status"] or "作成中") if p else ""
        self.status_pill.setText(st + ("（ロック中）" if st == "提出済" else ""))
        self.status_pill.set_tone({"確認済": "ok", "提出済": "info"}.get(st, ""))
        self.status_pill.setVisible(bool(p))
        if not d:
            for k in (self.k_direct, self.k_price, self.k_threshold, self.k_cost, self.k_unres):
                k.set("—")
            return
        s = d.summary
        self.k_direct.set(f"¥{yen(s.direct)}", f"明細 {len(d.items)} 行")
        self.k_price.set(f"¥{yen(s.price)}", f"税込 ¥{yen(s.total)}")
        pct = s.threshold / s.price * 100 if s.price else 0
        ast = awards.stats(self.conn, p["orderer"] if p else "")
        past = f"・過去のずれ 平均±{yen(ast.th_mae)}円" if ast.th_n else ""
        self.k_threshold.set(f"¥{yen(s.threshold)}", f"予定価格の {pct:.2f}%{past}")
        cost = c.summary.direct + s.common_temp + s.site_mgmt
        self.k_cost.set(f"¥{yen(cost)}", "自社単価＋設計の間接費",
                        "bad" if cost > s.threshold else "")
        n = len(d.unresolved)
        self.k_unres.set(f"{n} 件", "すべて当たっています" if n == 0 else "明細で黄色の行を直してください",
                         "ok" if n == 0 else "bad")

    # ================================================================ 新規積算
    def _page_new(self) -> QWidget:
        w, v = _page()
        row = QHBoxLayout()
        row.setSpacing(16)

        left = QVBoxLayout()
        left.setSpacing(14)
        self.drop = DropZone()
        self.drop.fileChosen.connect(self._file_chosen)
        left.addWidget(self.drop)

        form_card = Card("工事の情報")
        f = QFormLayout()
        f.setHorizontalSpacing(16)
        f.setVerticalSpacing(10)
        f.setLabelAlignment(Qt.AlignRight)
        self.n_name = QLineEdit()
        self.n_name.setPlaceholderText("例: 県道〇〇線 道路改良工事")
        self.n_fy = QComboBox()
        self.n_fy.setEditable(True)
        self.n_work = QComboBox()
        self.n_work.setEditable(True)
        self.n_region = RegionBox()
        self.n_region.setPlaceholderText("空欄なら全地区共通の単価")
        self.n_orderer = QComboBox()
        self.n_orderer.setEditable(True)
        self.n_out = QLineEdit(str(Path.home() / "Documents" / "積算出力"))
        f.addRow("工事名", self.n_name)
        f.addRow("年度", self.n_fy)
        f.addRow("工種区分", self.n_work)
        f.addRow("地区", self.n_region)
        f.addRow("発注者", self.n_orderer)
        f.addRow("出力先", path_row(self.n_out, lambda: self._pick_dir(self.n_out)))
        form_card.lay.addLayout(f)
        btns = QHBoxLayout()
        btns.addStretch(1)
        self.run_btn = QPushButton("積算を実行")
        self.run_btn.setObjectName("Primary")
        self.run_btn.setMinimumWidth(180)
        self.run_btn.setMinimumHeight(36)
        self.run_btn.clicked.connect(self._do_run)
        btns.addWidget(self.run_btn)
        form_card.lay.addLayout(btns)
        left.addWidget(form_card)

        self.run_banner = Banner()
        left.addWidget(self.run_banner)
        self.run_actions = QWidget()
        ra = QHBoxLayout(self.run_actions)
        ra.setContentsMargins(0, 0, 0, 0)
        b1 = QPushButton("明細を開く")
        b1.setObjectName("Primary")
        b1.clicked.connect(lambda: self.go("items"))
        b3 = QPushButton("単価表を開く")
        b3.clicked.connect(lambda: self.go("tables"))
        ra_tables = b3
        b2 = QPushButton("出力フォルダを開く")
        b2.clicked.connect(lambda: open_path(Path(self.n_out.text())))
        ra.addWidget(b1)
        ra.addWidget(ra_tables)
        ra.addWidget(b2)
        ra.addStretch(1)
        self.run_actions.hide()
        left.addWidget(self.run_actions)
        left.addStretch(1)

        right = Card("最近の工事", "ダブルクリックで開きます。")
        right.setFixedWidth(360)
        self.recent = QListWidget()
        self.recent.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 8px 4px; "
                                  f"border-bottom: 1px solid {C['border']}; }} "
                                  f"QListWidget::item:selected {{ background: {C['accent_soft']}; color: {C['text']}; }}")
        self.recent.itemDoubleClicked.connect(self._open_recent)
        right.lay.addWidget(self.recent, 1)

        rcol = QVBoxLayout()
        rcol.setSpacing(14)
        rcol.addWidget(right, 3)
        dl = self._deadline_card()
        dl.setFixedWidth(360)
        rcol.addWidget(dl, 2)
        row.addLayout(left, 1)
        row.addLayout(rcol)
        v.addLayout(row, 1)
        self._fill_master_choices()
        return w

    def _fill_master_choices(self) -> None:
        fys = [r[0] for r in self.conn.execute(
            "SELECT DISTINCT fy FROM master_price UNION SELECT DISTINCT fy FROM bukake ORDER BY 1 DESC")]
        works = [r[0] for r in self.conn.execute("SELECT DISTINCT work_type FROM overhead_param ORDER BY 1")]
        for combo, vals in ((self.n_fy, fys), (self.n_work, works), (self.n_orderer, self._orderers())):
            cur = combo.currentText()
            combo.clear()
            combo.addItems(vals)
            if cur or combo is self.n_orderer:
                combo.setCurrentText(cur)  # 発注者は空欄から始める

    def _load_recent(self) -> None:
        if not hasattr(self, "recent"):
            return
        self.recent.clear()
        for r in self.conn.execute("SELECT id, name, fy, work_type, created_at FROM project ORDER BY id DESC LIMIT 30"):
            it = QListWidgetItem(f"{r['name']}\n{r['fy']}年度・{r['work_type'] or '—'}・{r['created_at'][:16]}")
            it.setData(Qt.UserRole, r["id"])
            self.recent.addItem(it)
        if self.recent.count() == 0:
            it = QListWidgetItem("まだ工事がありません")
            it.setFlags(Qt.NoItemFlags)
            self.recent.addItem(it)
        self._refresh_deadlines()

    def _open_recent(self, it: QListWidgetItem) -> None:
        pid = it.data(Qt.UserRole)
        if pid is not None:
            self._load_projects(select=pid)
            self.go("items")

    def _file_chosen(self, path: str) -> None:
        self.kin_doc = None
        if path.lower().endswith(".pdf"):
            QApplication.setOverrideCursor(Qt.WaitCursor)
            try:
                ok = kinnuki.is_kinnuki(path)
                doc = kinnuki.parse(path) if ok else None
            except Exception as e:
                ok, doc = False, None
                self.run_banner.show_msg(f"PDFを読めませんでした：{e}", "bad")
            finally:
                QApplication.restoreOverrideCursor()
            if not ok or not doc:
                self.run_banner.show_msg("このPDFは金抜き設計書（実施設計書）の形ではないようです。", "warn")
                return
            self.kin_doc = doc
            self.kin_priced = doc.priced
            m = doc.meta
            self.n_name.setText(m.get("工事名", Path(path).stem))
            if doc.fy:
                self.n_fy.setCurrentText(doc.fy)
            self.n_work.setCurrentText(m.get("適用工種", ""))
            import unicodedata
            self.n_region.setText(unicodedata.normalize("NFKC", m.get("単価地区", "")).replace(" ", ""))
            self.n_orderer.setCurrentText("奈良県")
            pkg = sum(k.startswith("施") for k in doc.tables)
            hidden = sum(1 for t in doc.tables.values() for l in t.lines
                         if l.qty is None and not l.name.startswith("諸雑費") and not t.ref.startswith("施"))
            self.run_banner.show_msg(
                f"<b>金抜き設計書です。</b>　{m.get('工事番号', '')}　{m.get('工事箇所', '')}<br>"
                f"明細 {len(doc.items)} 行・単価表 {len(doc.tables) - pkg} 個・施工パッケージ {pkg} 個を読み取りました"
                f"（単価適用 {doc.price_date[:7]}・{m.get('単価地区', '')}・{m.get('適用工種', '')}）。<br>"
                + (f"<b>金入り（答えつき）です。</b>工事価格 ¥{yen(doc.totals.get('工事価格', 0))}。"
                   "積算を実行すると、数量・諸雑費率・物価資料の単価を覚え、答え合わせまで行います。" if doc.priced else
                   f"伏せてある歩掛の数量が {hidden} か所あります。取り込んだあと「単価表」で入れます。"), "info")
            return
        if not self.n_name.text():
            self.n_name.setText(Path(path).stem)

    def _pick_dir(self, edit: QLineEdit) -> None:
        p = QFileDialog.getExistingDirectory(self, "フォルダを選ぶ", edit.text())
        if p:
            edit.setText(p)

    def _do_run(self) -> None:
        if not self.drop.path:
            self.run_banner.show_msg("設計書データ（CSV）を選んでください。", "warn")
            return
        if not self.n_fy.currentText():
            self.run_banner.show_msg("年度を選んでください。先に「マスタ」で年度マスタを取り込む必要があります。", "warn")
            return
        QApplication.setOverrideCursor(Qt.WaitCursor)
        kin = None
        try:
            if getattr(self, "kin_doc", None) and getattr(self, "kin_priced", False) \
                    and self.drop.path.lower().endswith(".pdf"):
                pr = kinnuki.import_priced(self.conn, self.drop.path, work_type=self.n_work.currentText().strip() or None,
                                           orderer=self.n_orderer.currentText().strip() or "奈良県")
                kin = pr["import"] or {"単価表": 0, "施工パッケージ": 0, "数量を入れる": 0, "単価を当てる": 0,
                                       "諸雑費率を入れる": 0, "前回の値": 0, "project_id": pr["project_id"]}
                kin["priced"] = pr
                res = pipeline.run(self.conn, pr["project_id"], self.n_out.text())
                res["project_id"] = pr["project_id"]
            elif getattr(self, "kin_doc", None) and self.drop.path.lower().endswith(".pdf"):
                kin = kinnuki.import_doc(self.conn, self.drop.path, work_type=self.n_work.currentText().strip() or None,
                                         orderer=self.n_orderer.currentText().strip() or "奈良県")
                calc.set_project_fields(self.conn, kin["project_id"], name=self.n_name.text().strip() or "無題",
                                        region=self.n_region.text())
                res = pipeline.run(self.conn, kin["project_id"], self.n_out.text())
                res["project_id"] = kin["project_id"]
            else:
                res = pipeline.import_and_run(
                    self.conn, self.drop.path, self.n_name.text() or "無題", self.n_fy.currentText(),
                    self.n_work.currentText(), self.n_out.text(), self.n_region.text(),
                    orderer=self.n_orderer.currentText().strip(),
                )
        except Exception as e:  # 利用者に原因を見せる
            self.run_banner.show_msg(f"取り込めませんでした：{e}", "bad")
            return
        finally:
            QApplication.restoreOverrideCursor()
        d = res["design"]
        n = len(d.unresolved)
        msg = (f"<b>積算が終わりました。</b>　工事価格 ¥{yen(d.summary.price)}（税込 ¥{yen(d.summary.total)}）"
               f"<br>積算結果・実行予算・電子入札用内訳書を {self.n_out.text()} に出力しました。")
        if kin and kin.get("priced"):
            msg += "<br>" + self._priced_message(kin["priced"]) + "。「照合・答え合わせ」で項目ごとに見られます。"
        elif kin:
            msg += (f"<br>金抜き設計書から単価表 {kin['単価表']} 個・施工パッケージ {kin['施工パッケージ']} 個を作りました。"
                    f"入れるもの：伏せてある数量 <b>{kin['数量を入れる']}</b>・単価が当たらない資源 <b>{kin['単価を当てる']}</b>"
                    f"・諸雑費率 <b>{kin['諸雑費率を入れる']}</b>"
                    + (f"（前回の値で {kin['前回の値']} か所を入れました）" if kin["前回の値"] else "")
                    + "。「単価表」で入れてください。")
        elif n:
            msg += f"<br>歩掛・単価が当たっていない明細が <b>{n} 件</b> あります。「明細」で直してください。"
        self.run_banner.show_msg(msg, "warn" if (n or kin) else "ok")
        self.run_actions.show()
        self._load_projects(select=res["project_id"])
        if kin:
            self._res_cands = None

    # ================================================================ 明細
    def _page_items(self) -> QWidget:
        w, v = _page()
        bar = QHBoxLayout()
        bar.setSpacing(10)
        self.search = QLineEdit()
        self.search.setPlaceholderText("名称・規格・コード・メモで絞り込み（Ctrl+F）")
        self.search.setClearButtonEnabled(True)
        self.search.setMinimumWidth(280)
        self.search.textChanged.connect(self._filter_changed)
        self.only_unres = QCheckBox("未設定だけ表示")
        self.only_unres.toggled.connect(self._filter_changed)
        self.count_pill = Pill()
        bar.addWidget(self.search)
        bar.addWidget(self.only_unres)
        bar.addWidget(self.count_pill)
        bar.addStretch(1)
        au = QPushButton("候補で一括当てはめ")
        au.setToolTip("未設定の明細に、点数が高く迷いのない候補だけを当てます")
        au.clicked.connect(self._auto_assign)
        bar.addWidget(au)
        from PySide6.QtWidgets import QMenu
        more = QPushButton("その他の操作 ▾")
        menu = QMenu(more)
        menu.addAction("行を追加…", self._add_row)
        menu.addAction("選んだ行を削除", self._delete_row)
        menu.addSeparator()
        menu.addAction("数量計算書…", self._open_qty)
        menu.addAction("再計算（F5）", self.recalc)
        menu.addSeparator()
        menu.addAction("自社の書式で出力…", self._export_template)
        menu.addAction("自社書式のひな形を選び直す…", self._choose_template)
        more.setMenu(menu)
        bar.addWidget(more)
        xb = QPushButton("Excelに出力")
        xb.setObjectName("Primary")
        xb.clicked.connect(self._export_current)
        bar.addWidget(xb)
        v.addLayout(bar)

        split = QSplitter(Qt.Horizontal)
        self.model = ItemModel()
        self.model.edited.connect(self._item_edited)
        self.proxy = ItemFilter()
        self.proxy.setSourceModel(self.model)
        self.table = QTableView()
        self.table.setModel(self.proxy)
        _style_table(self.table)
        self.table.setEditTriggers(QAbstractItemView.DoubleClicked | QAbstractItemView.EditKeyPressed
                                   | QAbstractItemView.AnyKeyPressed)
        self.code_delegate = CodeDelegate(self.table)
        self.table.setItemDelegateForColumn(CODE, self.code_delegate)
        self.table.setItemDelegateForColumn(CAT, CategoryDelegate(self.table))
        hh = self.table.horizontalHeader()
        hh.setStretchLastSection(True)
        self.table.selectionModel().currentRowChanged.connect(lambda *_: self._show_detail())
        split.addWidget(self.table)

        detail = Card("単価の内訳")
        detail.setMinimumWidth(330)
        self.d_name = QLabel("明細を選ぶと表示されます")
        self.d_name.setWordWrap(True)
        self.d_name.setStyleSheet("font-weight: 700;")
        self.d_how = Pill()
        dh = QHBoxLayout()
        dh.addWidget(self.d_name, 1)
        dh.addWidget(self.d_how, 0, Qt.AlignTop)
        detail.lay.addLayout(dh)
        self.d_price = QLabel()
        self.d_price.setObjectName("Big")
        detail.lay.addWidget(self.d_price)
        self.d_sub = QLabel()
        self.d_sub.setObjectName("Muted")
        self.d_sub.setWordWrap(True)
        detail.lay.addWidget(self.d_sub)
        self.d_lines = QTableWidget(0, 5)
        self.d_lines.setMinimumHeight(110)
        self.d_lines.setHorizontalHeaderLabels(["名称", "数量", "単価", "金額", "出どころ"])
        _style_table(self.d_lines)
        self.d_lines.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        detail.lay.addWidget(self.d_lines, 1)
        detail.lay.addWidget(self._candidates_box())
        ml = QLabel("積算根拠メモ（次の工事にも表示されます）")
        ml.setObjectName("Muted")
        detail.lay.addWidget(ml)
        self.d_note = QPlainTextEdit()
        self.d_note.setPlaceholderText("例: 土質は砂質土で見込む。残土は場内流用。")
        self.d_note.setMaximumHeight(90)
        detail.lay.addWidget(self.d_note)
        nb = QHBoxLayout()
        nb.addStretch(1)
        self.d_save = QPushButton("メモを保存")
        self.d_save.clicked.connect(self._save_note)
        nb.addWidget(self.d_save)
        detail.lay.addLayout(nb)
        split.addWidget(detail)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 1)
        split.setSizes([960, 340])
        v.addWidget(split, 1)
        return w

    def _code_candidates(self) -> list[str]:
        p = self._project_row()
        if not p:
            return []
        fy = p["fy"]
        out = []
        for r in self.conn.execute("SELECT code, name, spec, unit FROM bukake WHERE fy=? ORDER BY code", (fy,)):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[歩掛・{r['unit']}]")
        for r in self.conn.execute("SELECT code, name, spec, unit FROM package WHERE fy=? ORDER BY code", (fy,)):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[施工パッケージ・{r['unit']}]")
        for r in self.conn.execute(
                "SELECT DISTINCT kind, code, name, spec, unit FROM master_price WHERE fy=? ORDER BY kind, code", (fy,)):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[{r['kind']}・{r['unit']}]")
        for r in self.conn.execute("SELECT code, name, spec, unit FROM quote ORDER BY code"):
            out.append(f"{r['code']}　{r['name']}　{r['spec']}　[見積・{r['unit']}]")
        return out

    def _refresh_items(self) -> None:
        sel = self._selected_item_id()
        self.model.set_items(self.design.items if self.design else [])
        self.code_delegate.candidates = self._code_candidates()
        widths = [38, 60, 80, 72, 64, 112, 124, 40, 60, 76, 96, 88, 60]
        for i, wd in enumerate(widths):
            self.table.setColumnWidth(i, wd)
        # 中身が空の階層（工種・種別・細別）の列は隠して、金額まで見えるようにする
        items = self.model.items
        for col, attr in ((2, "level1"), (3, "level2"), (4, "level3")):
            self.table.setColumnHidden(col, bool(items) and not any(getattr(i, attr) for i in items))
        self._update_count()
        if sel is not None:
            for r in range(self.proxy.rowCount()):
                if self.model.items[self.proxy.mapToSource(self.proxy.index(r, 0)).row()].item_id == sel:
                    self.table.selectRow(r)
                    break
        self._show_detail()

    def _update_count(self) -> None:
        if not self.design:
            self.count_pill.setText("")
            return
        n = len(self.design.unresolved)
        shown = self.proxy.rowCount()
        self.count_pill.setText(f"{shown} / {len(self.design.items)} 行　未設定 {n}")
        self.count_pill.set_tone("bad" if n else "ok")

    def _filter_changed(self) -> None:
        self.proxy.text = self.search.text().strip()
        self.proxy.only_unresolved = self.only_unres.isChecked()
        self.proxy.invalidateFilter()
        self._update_count()

    def _selected(self) -> calc.ItemResult | None:
        idx = self.table.currentIndex()
        if not idx.isValid():
            return None
        return self.model.items[self.proxy.mapToSource(idx).row()]

    def _selected_item_id(self) -> int | None:
        it = self._selected() if hasattr(self, "table") else None
        return it.item_id if it else None

    def _show_detail(self) -> None:
        it = self._selected()
        self._show_candidates(it)
        self.d_lines.setRowCount(0)
        self.d_note.setEnabled(it is not None)
        self.d_save.setEnabled(it is not None)
        if not it:
            self.d_name.setText("明細を選ぶと表示されます")
            self.d_how.setText("")
            self.d_price.setText("")
            self.d_sub.setText("")
            self.d_note.setPlainText("")
            self.d_lines.setVisible(False)
            return
        self.d_name.setText(f"{it.name}　{it.spec}")
        self.d_how.setText(it.how)
        self.d_how.set_tone({"未設定": "bad", "物価資料待ち": "warn", "単価表待ち": "warn", "パッケージ": "info",
                             "対応表": "info"}.get(it.how, "ok"))
        self.d_note.setPlainText(it.note)
        self.d_lines.setVisible(not it.missing or it.how == "単価表待ち")
        if it.how == "物価資料待ち":
            self.d_price.setText("—")
            self.d_sub.setText(f"コード {it.code} は県の単価資料で「○（物価資料の単価を使う）」です。"
                               "積算資料・建設物価で調べて、「不明な単価」の画面で単価を入れてください。")
            return
        if it.how == "未設定":
            self.d_price.setText("—")
            self.d_sub.setText("表の「コード」欄をダブルクリックして、歩掛・施工パッケージ・単価のコードを入れてください。"
                               "名称の一部を打つと候補が出ます。")
            return
        self.d_price.setText(f"¥{yen(it.unit_price)} / {it.unit}")
        conds = "、".join(d.conditions) if (d := it.detail) and d.conditions else ""
        self.d_sub.setText(f"数量 {it.qty:g} {it.unit} → 金額 ¥{yen(it.amount)}　（コード {it.code}）"
                           + (f"\n補正: {conds}" if conds else ""))
        if it.how == "単価表待ち":
            self.d_price.setText(f"¥{yen(it.unit_price)} / {it.unit}（途中）")
            self.d_sub.setText("この明細の単価表には、まだ入れていない数量・資源・率があります。"
                               "「単価表」の画面で入れてください（いまの単価は入っている分だけの途中の値です）。")
        d = it.detail
        if not d:
            return
        lines = list(d.lines)
        self.d_lines.setRowCount(len(lines) + 1)
        for r, ln in enumerate(lines):
            vals = [f"{ln.name}", f"{ln.qty:g}", yen(ln.price), yen(ln.amount),
                    ln.source + (f" ×{ln.factor:g}" if ln.factor != 1 else "")]
            for c, val in enumerate(vals):
                cell = _ro_item(val, c in (1, 2, 3))
                if ln.source == "不明":
                    cell.setForeground(QBrush(color("bad")))
                elif ln.source == "自社":
                    cell.setForeground(QBrush(color("ok")))
                self.d_lines.setItem(r, c, cell)
        r = len(lines)
        per = f"計 {d.per_qty:g}{d.unit}あたり" + (f"（諸雑費{d.misc_rate:g}%込）" if d.misc_rate else "")
        for c, val in enumerate([per, "", "", yen(d.subtotal), ""]):
            cell = _ro_item(val, c == 3)
            f = QFont()
            f.setBold(True)
            cell.setFont(f)
            self.d_lines.setItem(r, c, cell)
        self.d_lines.resizeColumnsToContents()
        self.d_lines.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)

    def _item_edited(self, item_id: int, col: int, value: str) -> None:
        if col == CODE:
            self.guard(calc.assign_code, self.conn, item_id, value, remember=True)
        elif col == NOTE:
            self.guard(calc.set_note, self.conn, item_id, value, remember=True)
        elif col == CAT:
            self.guard(calc.set_category, self.conn, item_id, normalize_category(value))
        elif col == COND:
            self.guard(calc.set_item_conditions, self.conn, item_id, value)
        elif col == QTY:
            try:
                q = float(value.replace(",", ""))
            except ValueError:
                QMessageBox.warning(self, "入力", "数量は数字で入れてください")
                return
            self.guard(calc.set_qty, self.conn, item_id, q)
        QTimer.singleShot(0, self.recalc)

    def _add_row(self) -> None:
        if self.pid is None:
            return
        dlg = AddItemDialog(self, self._code_candidates())
        if dlg.exec():
            v = dlg.values()
            if not v["name"]:
                return
            self.guard(calc.add_item, self.conn, self.pid, **v)
            self.recalc()

    def _delete_row(self) -> None:
        it = self._selected()
        if it and QMessageBox.question(self, "行を削除", f"明細{it.seq}「{it.name}」を削除しますか？（履歴に残ります）") \
                == QMessageBox.Yes:
            self.guard(calc.delete_item, self.conn, it.item_id)
            self.recalc()

    def _save_note(self) -> None:
        it = self._selected()
        if it:
            if self.guard(calc.set_note, self.conn, it.item_id, self.d_note.toPlainText().strip(), remember=True) \
                    is None and self._project_row()["status"] == "提出済":
                return
            self.recalc()
            self.status.showMessage("メモを保存しました", 3000)

    def _export_current(self) -> None:
        if self.pid is None:
            return
        d = QFileDialog.getExistingDirectory(self, "出力先", self.n_out.text())
        if d:
            res = pipeline.run(self.conn, self.pid, d)
            box = QMessageBox(self)
            box.setWindowTitle("出力しました")
            box.setText("積算結果と実行予算を出力しました。")
            box.setInformativeText("\n".join(Path(p).name for p in res["files"]))
            open_btn = box.addButton("フォルダを開く", QMessageBox.AcceptRole)
            box.addButton("閉じる", QMessageBox.RejectRole)
            box.exec()
            if box.clickedButton() is open_btn:
                open_path(Path(d))

    # ================================================================ 内訳書
    def _page_tree(self) -> QWidget:
        w, v = _page()
        bar = QHBoxLayout()
        e1 = QPushButton("すべて開く")
        e1.clicked.connect(lambda: self.tree.expandAll())
        e2 = QPushButton("工種まで")
        e2.clicked.connect(lambda: self.tree.expandToDepth(0))
        bar.addWidget(e1)
        bar.addWidget(e2)
        bar.addStretch(1)
        v.addLayout(bar)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["費目・工種・種別・細別", "規格", "単位", "数量", "単価", "金額", "摘要"])
        self.tree.setAlternatingRowColors(False)
        self.tree.setIndentation(22)
        self.tree.setUniformRowHeights(True)
        self.tree.setStyleSheet("QTreeWidget::item { padding: 5px 2px; }")
        v.addWidget(self.tree, 1)
        return w

    def _refresh_tree(self) -> None:
        self.tree.clear()
        if not self.design:
            return
        parents: dict[int, QTreeWidgetItem] = {}
        bold = QFont()
        bold.setBold(True)
        for depth, name, spec, unit, qty, price, amount, note in breakdown_rows(self.design):
            node = QTreeWidgetItem([name, spec, unit, "" if qty is None else f"{qty:g}",
                                    "" if price is None else yen(price), yen(amount), note])
            for c in (3, 4, 5):
                node.setTextAlignment(c, Qt.AlignRight | Qt.AlignVCenter)
            parent = parents.get(depth - 1) if depth > 0 else None
            (parent.addChild(node) if parent else self.tree.addTopLevelItem(node))
            parents[depth] = node
            if depth == 0:
                for c in range(7):
                    node.setFont(c, bold)
                    node.setBackground(c, QBrush(color("level0")))
                if name in ("工事価格", "工事費計"):
                    for c in range(7):
                        node.setForeground(c, QBrush(color("accent")))
            elif depth == 1:
                node.setFont(0, bold)
                node.setFont(5, bold)
            if price is not None and price == 0:
                for c in range(7):
                    node.setForeground(c, QBrush(color("bad")))
            if note.startswith("率"):
                node.setForeground(6, QBrush(color("muted")))
        self.tree.expandAll()
        for c, wd in enumerate([300, 200, 50, 80, 100, 130, 120]):
            self.tree.setColumnWidth(c, wd)

    # ================================================================ 入札検討
    def _page_bid(self) -> QWidget:
        w, v = _page()
        g = Card("入札額のものさし", "帯をクリック・ドラッグすると入札額が動きます（千円単位）。"
                 "赤い範囲は基準価格を下回る範囲、緑は基準価格から予定価格までの範囲です。")
        self.gauge = BidGauge()
        self.gauge.bidChanged.connect(self._gauge_moved)
        g.lay.addWidget(self.gauge)
        row = QHBoxLayout()
        row.setSpacing(8)
        lab = QLabel("入札額（税抜）")
        lab.setObjectName("Muted")
        self.bid_edit = QLineEdit()
        self.bid_edit.setPlaceholderText("例: 1,950,000")
        self.bid_edit.setMaximumWidth(220)
        self.bid_edit.setAlignment(Qt.AlignRight)
        self.bid_edit.returnPressed.connect(self._bid_entered)
        row.addWidget(lab)
        row.addWidget(self.bid_edit)
        for text, fn in (("決定", self._bid_entered),
                         ("基準価格ちょうど", lambda: self._set_bid(self._cur_threshold())),
                         ("基準価格＋0.5%", lambda: self._set_bid(
                             (int(self._cur_threshold() + self._cur_planned() * 0.005) + 999) // 1000 * 1000))):
            b = QPushButton(text)
            if text == "決定":
                b.setObjectName("Primary")
            b.clicked.connect(lambda _=False, f=fn: self.design and f())
            row.addWidget(b)
        row.addStretch(1)
        lb = QPushButton("低入札調査の資料を出力…")
        lb.clicked.connect(self._export_lowbid)
        row.addWidget(lb)
        g.lay.addLayout(row)
        v.addWidget(g)

        self.bid_banner = Banner()
        v.addWidget(self.bid_banner)

        grid = QGridLayout()
        grid.setSpacing(12)
        self.b_ratio = Kpi("入札額 ÷ 予定価格")
        self.b_margin = Kpi("粗利の見込み（入札額 − 実行原価）")
        self.b_gap = Kpi("基準価格との差")
        self.b_cost = Kpi("実行原価 ÷ 予定価格")
        self.b_pred = Kpi("落札実績から見た予定価格の見込み")
        for i, k in enumerate((self.b_ratio, self.b_margin, self.b_gap, self.b_cost, self.b_pred)):
            grid.addWidget(k, 0, i)
        v.addLayout(grid)

        v.addWidget(self._reverse_card())

        note = QLabel("※ 基準価格の式は「マスタ」の発注者ごとの設定（なければ年度のルール.csv）に従います。"
                      "予定価格は工事価格と同じとみなした試算です。必ず発注者の公表内容と照らしてください。")
        note.setObjectName("Muted")
        note.setWordWrap(True)
        v.addWidget(note)
        v.addStretch(1)
        return w

    def _gauge_moved(self, bid: int) -> None:
        self._set_bid(bid)

    def _bid_entered(self) -> None:
        try:
            bid = int(float(self.bid_edit.text().replace(",", "").replace("¥", "") or 0))
        except ValueError:
            self.bid_banner.show_msg("入札額は数字で入れてください。", "warn")
            return
        self._set_bid(bid)

    def _set_bid(self, bid: int) -> None:
        if self.pid is None:
            return
        calc.set_bid(self.conn, self.pid, bid)
        self._refresh_bid()

    def _refresh_bid(self) -> None:
        d, c = self.design, self.company
        if not d:
            self.gauge.set_values(0, 0, 0, 0)
            return
        p = self._project_row()
        bid = int(p["bid_price"] or 0)
        self._refresh_reverse()
        rv = self._rv_result   # 公表額があれば、予定価格・最低制限価格はそちら（逆算）を使う
        b = calc.bid_check(d, c, bid, rv.implied.price if rv else None,
                           (rv.target if rv.basis == "最低制限価格（税抜）" else rv.implied.threshold) if rv else None)
        self.gauge.set_values(b.planned, b.threshold, b.cost, bid)
        if not self.bid_edit.hasFocus():
            self.bid_edit.setText(yen(bid) if bid else "")
        price = b.planned or 1
        st = awards.stats(self.conn, p["orderer"], p["work_type"])
        if st.count == 0 or st.accuracy is None:
            st = awards.stats(self.conn, p["orderer"])
        pred = st.predict_planned(b.planned)
        if pred:
            self.b_pred.set(f"¥{yen(pred)}", f"過去{st.count}件で自社積算は予定価格の{st.accuracy * 100:.1f}%",
                            "warn" if abs(pred - b.planned) / b.planned > 0.03 else "")
        else:
            self.b_pred.set("—", "落札実績（自社積算額入り）がまだありません")
        self.b_cost.set(f"{b.cost / price * 100:.2f}%", f"¥{yen(b.cost)}", "bad" if b.cost > b.threshold else "")
        if not bid:
            self.b_ratio.set("—", "入札額を入れてください")
            self.b_margin.set("—")
            self.b_gap.set("—")
            self.bid_banner.hide()
            return
        self.b_ratio.set(f"{b.ratio * 100:.2f}%", f"¥{yen(bid)}",
                         "bad" if b.below_threshold or b.over_planned else "ok")
        self.b_margin.set(f"¥{yen(b.margin)}", f"入札額の {b.margin / bid * 100:.1f}%",
                          "bad" if b.margin < 0 else "ok")
        gap = bid - b.threshold
        self.b_gap.set(f"{'+' if gap >= 0 else '−'}¥{yen(abs(gap))}", "上回っています" if gap >= 0 else "下回っています",
                       "bad" if gap < 0 else "ok")
        if b.below_threshold:
            self.bid_banner.show_msg("入札額が基準価格の試算を下回っています。失格や低入札調査の対象になるおそれがあります。", "bad")
        elif b.over_planned:
            self.bid_banner.show_msg("入札額が予定価格の見込みを上回っています。", "bad")
        elif b.margin < 0:
            self.bid_banner.show_msg("実行原価の見込みを下回る入札額です（赤字の見込み）。", "warn")
        else:
            self.bid_banner.show_msg("基準価格と予定価格の間にあり、実行原価も上回っています。", "ok")

    # ================================================================ 答え合わせ
    def _page_verify(self) -> QWidget:
        w, v = _page()
        top = QHBoxLayout()
        top.setSpacing(12)
        self.v_rate = Kpi("過去の結果と一致")
        self.v_diff = Kpi("工事価格の差")
        top.addWidget(self.v_rate)
        top.addWidget(self.v_diff)
        imp = Card("答え（金入り設計書・過去の積算結果）", "金入り設計書のPDFなら、答えを覚えて答え合わせまで行います。"
                   "CSV（項目,金額）も使えます。")
        bh = QHBoxLayout()
        b0 = QPushButton("金入り設計書…")
        b0.setObjectName("Primary")
        b0.clicked.connect(self._do_priced)
        b = QPushButton("CSV…")
        b.clicked.connect(self._do_reference)
        bh.addWidget(b0)
        bh.addWidget(b)
        bh.addStretch(1)
        imp.lay.addLayout(bh)
        top.addWidget(imp, 2)
        self.v_pdf = Kpi("PDFと一致した明細")
        self.v_pdf.set("—", "PDFを選ぶと照合します")
        top.addWidget(self.v_pdf)
        top.addWidget(self._pdf_card(), 2)
        v.addLayout(top)
        split = QSplitter(Qt.Vertical)
        a = Card("過去の積算結果との比較")
        self.checks = QTableWidget(0, 5)
        self.checks.setHorizontalHeaderLabels(["項目", "今回の計算", "過去の結果", "差", "判定"])
        _style_table(self.checks)
        self.checks.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        a.lay.addWidget(self.checks, 1)
        b2 = Card("金抜き設計書PDFとの照合")
        b2.lay.addWidget(self._pdf_table(), 1)
        split.addWidget(a)
        split.addWidget(b2)
        v.addWidget(split, 1)
        return w

    def _do_priced(self, path: str = "") -> None:
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "金入り設計書", "", "PDF (*.pdf)")
        if not path:
            return
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            r = self.guard(kinnuki.import_priced, self.conn, path)
        finally:
            QApplication.restoreOverrideCursor()
        if not r or r is True:
            return
        self._load_projects(select=r["project_id"])
        self.go("verify")
        self.status.showMessage(self._priced_message(r), 15000)

    def _priced_message(self, r: dict) -> str:
        lr = r["learned"]
        cs = pipeline.verify(self.conn, r["project_id"])
        ok = sum(c.ok for c in cs)
        price = next((c for c in cs if c.key == "工事価格"), None)
        msg = (f"金入り設計書から覚えました：数量 {lr['数量']}・諸雑費率 {lr['諸雑費率']}・設計書の単価 {lr['単価（設計書実績）']}・"
               f"単価表の単価 {lr['単価表の単価']}。答え合わせ {ok}/{len(cs)} 一致")
        if price:
            msg += f"（工事価格の差 {price.diff:+,.0f}円）"
        return msg

    def _do_reference(self) -> None:
        if self.pid is None:
            return
        p, _ = QFileDialog.getOpenFileName(self, "過去の積算結果", "", "CSV (*.csv)")
        if p:
            try:
                importer.import_reference(self.conn, self.pid, p)
            except Exception as e:
                QMessageBox.critical(self, "取り込めませんでした", str(e))
                return
            self._refresh_verify()

    def _refresh_verify(self) -> None:
        self.checks.setRowCount(0)
        if self.pid is None:
            self.v_rate.set("—")
            self.v_diff.set("—")
            return
        cs = pipeline.verify(self.conn, self.pid, self.design)
        names = {str(i.seq): f"{i.seq}. {i.name} {i.spec}" for i in (self.design.items if self.design else [])}
        p = self._project_row()
        if p:  # 単価表（単1・施1 …）は名称を添えて出す
            for t in self.conn.execute("SELECT code, name, spec FROM bukake WHERE fy=? AND project_id=? "
                                       "UNION ALL SELECT code, name, spec FROM package WHERE fy=? AND project_id=?",
                                       (p["fy"], self.pid, p["fy"], self.pid)):
                ref = t["code"].split("/")[-1]
                names[ref] = f"単価表 {ref}号 {t['name'].split('（')[0]} {t['spec']}（1単位あたり）"
        self.checks.setRowCount(len(cs))
        for r, ch in enumerate(cs):
            vals = [names.get(ch.key, ch.key), yen(ch.ours), yen(ch.reference),
                    ("+" if ch.diff > 0 else "") + yen(ch.diff), "一致" if ch.ok else "ズレ"]
            for c, val in enumerate(vals):
                cell = _ro_item(val, c in (1, 2, 3))
                if c == 4:
                    cell.setForeground(QBrush(color("ok" if ch.ok else "bad")))
                    f = QFont()
                    f.setBold(True)
                    cell.setFont(f)
                if not ch.ok:
                    cell.setBackground(QBrush(color("bad_soft")))
                self.checks.setItem(r, c, cell)
        if cs:
            ok = sum(ch.ok for ch in cs)
            self.v_rate.set(f"{ok} / {len(cs)}", f"{ok / len(cs) * 100:.0f}%", "ok" if ok == len(cs) else "bad")
        else:
            self.v_rate.set("—", "過去の結果がまだありません")
        price = next((ch for ch in cs if ch.key == "工事価格"), None)
        if price:
            self.v_diff.set(f"{'+' if price.diff >= 0 else '−'}¥{yen(abs(price.diff))}",
                            f"{price.diff / price.reference * 100:+.2f}%" if price.reference else "",
                            "ok" if price.ok else "bad")
        else:
            self.v_diff.set("—", "工事価格の行がありません")

    # ================================================================ マスタ
    def _page_master(self) -> QWidget:
        w, v = _page()
        row = QHBoxLayout()
        row.setSpacing(16)
        c1 = Card("年度マスタを取り込む", "年度フォルダ（単価・歩掛・歩掛構成・諸経費・ルール・施工パッケージ・"
                  "施工パッケージ構成・補正・機械損料・単価改定 の各CSV）を選びます。同じ年度の古い内容は入れ替わります。")
        f = QFormLayout()
        self.m_fy = QLineEdit("R8")
        self.m_fy.setMaximumWidth(120)
        self.m_dir = QLineEdit()
        f.addRow("年度", self.m_fy)
        f.addRow("フォルダ", path_row(self.m_dir, lambda: self._pick_dir(self.m_dir)))
        c1.lay.addLayout(f)
        b = QPushButton("取り込む")
        b.setObjectName("Primary")
        b.clicked.connect(self._do_master)
        c1.lay.addWidget(b, 0, Qt.AlignRight)
        row.addWidget(c1, 3)
        c2 = Card("自社単価", "作業員の日当・保有重機・よく頼む下請けの単価。実行予算で優先して使います。")
        self.m_company = QLabel()
        self.m_company.setObjectName("Big")
        c2.lay.addWidget(self.m_company)
        b2 = QPushButton("自社単価CSVを取り込む…")
        b2.clicked.connect(self._do_company)
        c2.lay.addWidget(b2, 0, Qt.AlignLeft)
        c2.lay.addStretch(1)
        row.addWidget(c2, 2)
        v.addLayout(row)
        v.addWidget(self._autofetch_card())
        v.addWidget(self._sekop_card())
        v.addWidget(self._public_price_card())
        self.m_banner = Banner()
        v.addWidget(self.m_banner)
        ov = Card("登録済みの年度")
        self.m_table = QTableWidget(0, 10)
        self.m_table.setHorizontalHeaderLabels(["年度", "単価", "歩掛", "施工パッケージ", "諸経費の式", "ルール", "補正",
                                                "機械損料", "単価改定", "工種区分"])
        _style_table(self.m_table)
        self.m_table.horizontalHeader().setSectionResizeMode(9, QHeaderView.Stretch)
        self.m_table.setMinimumHeight(110)
        ov.lay.addWidget(self.m_table)
        v.addWidget(ov, 2)
        v.addWidget(self._orderer_card(), 3)
        return w

    def _load_master_overview(self) -> None:
        fys = [r[0] for r in self.conn.execute(
            "SELECT fy FROM master_price UNION SELECT fy FROM bukake UNION SELECT fy FROM package "
            "UNION SELECT fy FROM overhead_param UNION SELECT fy FROM adjustment ORDER BY 1 DESC")]
        self.m_table.setRowCount(len(fys))
        for r, fy in enumerate(fys):
            def cnt(table: str) -> str:
                return f"{self.conn.execute(f'SELECT COUNT(*) FROM {table} WHERE fy=?', (fy,)).fetchone()[0]:,}"
            works = "、".join(x[0] for x in self.conn.execute(
                "SELECT DISTINCT work_type FROM overhead_param WHERE fy=?", (fy,)))
            for c, val in enumerate([fy, cnt("master_price"), cnt("bukake"), cnt("package"), cnt("overhead_param"),
                                     cnt("rule"), cnt("adjustment"), cnt("machine_cost"), cnt("price_revision"), works]):
                self.m_table.setItem(r, c, _ro_item(val, 1 <= c <= 8))
        n = self.conn.execute("SELECT COUNT(*) FROM company_price").fetchone()[0]
        self.m_company.setText(f"{n:,} 件")

    def _do_master(self) -> None:
        try:
            counts = importer.import_master_folder(self.conn, self.m_fy.text().strip(), self.m_dir.text())
        except Exception as e:
            self.m_banner.show_msg(f"取り込めませんでした：{e}", "bad")
            return
        if not counts:
            self.m_banner.show_msg("フォルダにマスタのCSVが見つかりませんでした。", "warn")
            return
        self.m_banner.show_msg(f"{self.m_fy.text()}年度を取り込みました：" + "、".join(f"{k} {v:,}件" for k, v in counts.items()),
                               "ok")
        self._load_master_overview()
        self._fill_master_choices()
        self.recalc()

    def _do_company(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "自社単価", "", "CSV (*.csv)")
        if p:
            try:
                n = importer.import_company_prices(self.conn, p)
            except Exception as e:
                self.m_banner.show_msg(f"取り込めませんでした：{e}", "bad")
                return
            self.m_banner.show_msg(f"自社単価 {n} 件を取り込みました。", "ok")
            self._load_master_overview()
            self.recalc()

    # ================================================================ 設定
    def _page_settings(self) -> QWidget:
        w, v = _page()
        c = Card("データファイル", "社内の共有フォルダ（NASなど）に置き、全員が同じファイルを指すと、"
                 "単価・コードの対応表・積算根拠メモ・過去の工事を共有できます。")
        self.s_db = QLineEdit(str(settings.db_path()))
        c.lay.addWidget(path_row(self.s_db, self._pick_db))
        b = QPushButton("保存して開き直す")
        b.setObjectName("Primary")
        b.clicked.connect(self._save_settings)
        c.lay.addWidget(b, 0, Qt.AlignRight)
        v.addWidget(c)
        u = Card("担当者名", "変更履歴とダブルチェック（作成者と確認者は別の人）に使います。空欄ならWindowsのユーザー名。")
        uh = QHBoxLayout()
        self.s_user = QLineEdit(settings.load().get("user_name", ""))
        self.s_user.setPlaceholderText(audit.current_user())
        self.s_user.setMaximumWidth(260)
        ub = QPushButton("保存")
        ub.clicked.connect(self._save_user)
        uh.addWidget(self.s_user)
        uh.addWidget(ub)
        uh.addStretch(1)
        u.lay.addLayout(uh)
        row2 = QHBoxLayout()
        row2.setSpacing(16)
        row2.addWidget(u, 1)
        v.addWidget(self._update_card())
        k = Card("ショートカット")
        k.lay.addWidget(QLabel("Ctrl+F　明細を絞り込む　／　F5　再計算\n明細の「コード」欄をダブルクリック　候補から選んで当てる"))
        row2.addWidget(k, 1)
        v.addLayout(row2)
        self.s_banner = Banner()
        v.addWidget(self.s_banner)
        row3 = QHBoxLayout()
        row3.setSpacing(16)
        row3.addWidget(self._users_card(), 1)
        row3.addWidget(self._backup_card(), 1)
        v.addLayout(row3)
        v.addStretch(1)
        return w

    def _save_user(self) -> None:
        s = settings.load()
        s["user_name"] = self.s_user.text().strip()
        settings.save(s)
        self.s_banner.show_msg(f"担当者名を「{audit.current_user()}」にしました。", "ok")
        self._refresh_project_page()
        self._refresh_users()

    def _pick_db(self) -> None:
        p, _ = QFileDialog.getSaveFileName(self, "データファイル", self.s_db.text(), "データ (*.sqlite)",
                                           options=QFileDialog.DontConfirmOverwrite)
        if p:
            self.s_db.setText(p)

    def _save_settings(self) -> None:
        try:
            conn = db.connect(self.s_db.text())
        except Exception as e:
            self.s_banner.show_msg(f"開けませんでした：{e}", "bad")
            return
        s = settings.load()
        s["db_path"] = self.s_db.text()
        settings.save(s)
        self.conn.close()
        self.conn = conn
        self.pid = None
        self._update_status()
        self._fill_master_choices()
        self._load_projects()
        self.s_banner.show_msg(f"データファイルを切り替えました：{self.s_db.text()}", "ok")


def run_gui() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setFont(theme.base_font())
    app.setStyleSheet(theme.QSS)
    win = MainWindow()
    win.show()
    return app.exec()
