"""見た目（色・文字・余白）。色はここだけで決め、画面側では名前で使う。"""
from __future__ import annotations

import sys

from PySide6.QtGui import QColor, QFont, QFontDatabase

# 色（落ち着いた紺を基調に、金額の状態だけ色で知らせる）
C = {
    "bg": "#F3F5F8",
    "surface": "#FFFFFF",
    "border": "#E1E5EB",
    "border_strong": "#C9D0DA",
    "text": "#1C2533",
    "muted": "#667085",
    "faint": "#98A2B3",
    "nav": "#17212F",
    "nav_hover": "#223044",
    "nav_active": "#2B3B52",
    "nav_text": "#AEB9C9",
    "accent": "#2563EB",
    "accent_hover": "#1D4FD8",
    "accent_soft": "#E8EFFD",
    "ok": "#16835A",
    "ok_soft": "#E5F4EC",
    "warn": "#B4690E",
    "warn_soft": "#FDF3E3",
    "bad": "#C2362F",
    "bad_soft": "#FCEBEA",
    "row_alt": "#F8FAFC",
    "level0": "#EEF2F7",
    "level1": "#F6F8FB",
}


def color(name: str) -> QColor:
    return QColor(C[name])


def light_palette():
    """Windows がダークモードでも、いつも明るい色で表示する（ダイアログの文字が見えなくならないように）。"""
    from PySide6.QtGui import QPalette
    p = QPalette()
    roles = {
        QPalette.Window: C["bg"], QPalette.WindowText: C["text"], QPalette.Base: C["surface"],
        QPalette.AlternateBase: C["row_alt"], QPalette.Text: C["text"], QPalette.Button: C["surface"],
        QPalette.ButtonText: C["text"], QPalette.ToolTipBase: C["surface"], QPalette.ToolTipText: C["text"],
        QPalette.Highlight: C["accent"], QPalette.HighlightedText: "#FFFFFF", QPalette.PlaceholderText: C["faint"],
        QPalette.Link: C["accent"], QPalette.BrightText: C["bad"],
    }
    for role, col in roles.items():
        p.setColor(role, QColor(col))
    for role in (QPalette.WindowText, QPalette.Text, QPalette.ButtonText):
        p.setColor(QPalette.Disabled, role, QColor(C["faint"]))
    return p


def base_font() -> QFont:
    """Windowsでは Yu Gothic UI → Meiryo UI の順に使う。"""
    families = set(QFontDatabase.families())
    for fam in ("Yu Gothic UI", "Meiryo UI", "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans"):
        if fam in families:
            f = QFont(fam)
            break
    else:
        f = QFont()
    f.setPointSizeF(9.5 if sys.platform.startswith("win") else 10)
    f.setHintingPreference(QFont.PreferNoHinting)
    return f


QSS = f"""
QMessageBox, QDialog, QInputDialog, QProgressDialog {{ background: {C['surface']}; color: {C['text']}; }}
QMessageBox QLabel, QDialog QLabel, QInputDialog QLabel, QProgressDialog QLabel {{ color: {C['text']}; background: transparent; }}

* {{ color: {C['text']}; }}
QMainWindow, #Content {{ background: {C['bg']}; }}
QToolTip {{ background: {C['nav']}; color: white; border: none; padding: 6px 8px; }}

/* ---- 左のメニュー ---- */
#Sidebar {{ background: {C['nav']}; }}
#Brand {{ color: white; font-size: 15pt; font-weight: 700; padding: 18px 18px 2px 18px; }}
#BrandSub {{ color: {C['nav_text']}; font-size: 8.5pt; padding: 0 18px 14px 18px; }}
#NavSection {{ color: #6B7A90; font-size: 8pt; font-weight: 700; padding: 14px 18px 4px 18px; }}
#Sidebar QPushButton {{
    color: {C['nav_text']}; background: transparent; border: none; text-align: left;
    padding: 9px 16px; margin: 1px 8px; border-radius: 6px; font-size: 10pt;
}}
#Sidebar QPushButton:hover {{ background: {C['nav_hover']}; color: white; }}
#Sidebar QPushButton:checked {{ background: {C['nav_active']}; color: white; font-weight: 700; }}
#SidebarFoot {{ color: #6B7A90; font-size: 8pt; padding: 12px 18px; }}

/* ---- 上の帯 ---- */
#Header {{ background: {C['surface']}; border-bottom: 1px solid {C['border']}; }}
#PageTitle {{ font-size: 15pt; font-weight: 700; }}
#PageHint {{ color: {C['muted']}; }}

/* ---- カード ---- */
#Card, #Kpi {{ background: {C['surface']}; border: 1px solid {C['border']}; border-radius: 10px; }}
#KpiTitle {{ color: {C['muted']}; font-size: 8.5pt; }}
#KpiValue {{ font-size: 16pt; font-weight: 700; }}
#KpiSub {{ color: {C['faint']}; font-size: 8.5pt; }}
#CardTitle {{ font-size: 11pt; font-weight: 700; }}
#Muted {{ color: {C['muted']}; }}
#Big {{ font-size: 20pt; font-weight: 700; }}

/* ---- ボタン ---- */
QPushButton {{
    background: {C['surface']}; border: 1px solid {C['border_strong']}; border-radius: 6px;
    padding: 6px 14px; min-height: 18px;
}}
QPushButton:hover {{ background: {C['bg']}; }}
QPushButton:disabled {{ color: {C['faint']}; }}
QPushButton#Primary {{ background: {C['accent']}; color: white; border: 1px solid {C['accent']}; font-weight: 700; }}
QPushButton#Primary:hover {{ background: {C['accent_hover']}; }}
QPushButton#Primary:disabled {{ background: #9DB6F2; border-color: #9DB6F2; }}
QPushButton#Danger {{ color: {C['bad']}; border: 1px solid {C['bad']}; background: {C['surface']}; }}
QPushButton#Danger:hover {{ background: {C['bad_soft']}; }}
QPushButton#Ghost {{ border: none; background: transparent; color: {C['accent']}; padding: 4px 6px; }}
QPushButton#Ghost:hover {{ text-decoration: underline; }}

/* ---- 入力 ---- */
QLineEdit, QComboBox, QPlainTextEdit, QTextEdit {{
    background: {C['surface']}; border: 1px solid {C['border_strong']}; border-radius: 6px; padding: 5px 8px;
    selection-background-color: {C['accent']};
}}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus {{ border: 1px solid {C['accent']}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox QAbstractItemView {{ border: 1px solid {C['border']}; selection-background-color: {C['accent_soft']};
    selection-color: {C['text']}; outline: none; }}
#HeaderProject {{ font-size: 10.5pt; font-weight: 700; min-width: 320px; }}
QCheckBox {{ spacing: 6px; }}

/* ---- 表 ---- */
QTableView, QTreeView, QTreeWidget, QTableWidget {{
    background: {C['surface']}; border: 1px solid {C['border']}; border-radius: 8px;
    gridline-color: {C['border']}; alternate-background-color: {C['row_alt']};
    selection-background-color: {C['accent_soft']}; selection-color: {C['text']};
}}
QHeaderView::section {{
    background: {C['bg']}; color: {C['muted']}; border: none; border-bottom: 1px solid {C['border']};
    border-right: 1px solid {C['border']}; padding: 6px 8px; font-weight: 700; font-size: 8.5pt;
}}
QTableCornerButton::section {{ background: {C['bg']}; border: none; }}
QSplitter::handle {{ background: transparent; width: 10px; }}

QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: {C['border_strong']}; border-radius: 4px; min-height: 30px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: {C['border_strong']}; border-radius: 4px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

QStatusBar {{ background: {C['surface']}; border-top: 1px solid {C['border']}; color: {C['muted']}; }}

/* ---- 取り込み口 ---- */
#Drop {{ background: {C['surface']}; border: 2px dashed {C['border_strong']}; border-radius: 12px; }}
#Drop[hover="true"] {{ border-color: {C['accent']}; background: {C['accent_soft']}; }}
#Drop[filled="true"] {{ border-style: solid; border-color: {C['ok']}; background: {C['ok_soft']}; }}
#DropTitle {{ font-size: 12pt; font-weight: 700; }}

/* ---- 状態の札 ---- */
#Pill {{ border-radius: 9px; padding: 2px 9px; font-size: 8.5pt; font-weight: 700; }}
#Banner {{ border-radius: 8px; padding: 10px 14px; }}
"""
