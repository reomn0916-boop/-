"""出力：積算結果（入札額検討用）・工事費内訳書・単価表・実行予算 を Excel に書き出す。

電子入札で提出する内訳書の様式は発注者ごとに違うため、見本が届いたら合わせる。
"""
from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .calc import Result

THIN = Side(style="thin", color="999999")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="DDE7F0")
WARN_FILL = PatternFill("solid", fgColor="FCE4D6")
YEN = "#,##0"
NUM = "#,##0.###"


def _table(ws, start_row: int, headers: list[str], rows: list[list], formats: dict[int, str] | None = None,
           widths: list[int] | None = None, warn_col: int | None = None) -> int:
    for c, h in enumerate(headers, 1):
        cell = ws.cell(start_row, c, h)
        cell.font = Font(bold=True)
        cell.fill = HEAD_FILL
        cell.border = BORDER
        cell.alignment = Alignment(horizontal="center")
    r = start_row
    for row in rows:
        r += 1
        for c, v in enumerate(row, 1):
            cell = ws.cell(r, c, v)
            cell.border = BORDER
            if formats and c in formats and isinstance(v, (int, float)):
                cell.number_format = formats[c]
        if warn_col is not None and row[warn_col - 1] == "未設定":
            for c in range(1, len(headers) + 1):
                ws.cell(r, c).fill = WARN_FILL
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    return r


def _summary_sheet(ws, title: str, project: dict, res: Result) -> None:
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=14)
    ws["A3"], ws["B3"] = "工事名", project["name"]
    ws["A4"], ws["B4"] = "年度", project["fy"]
    ws["A5"], ws["B5"] = "工種区分", project["work_type"]
    ws["A6"], ws["B6"] = "地区", project["region"]
    rows = [[n, (f"{r:.2f}%" if r is not None else ""), a] for n, r, a in res.summary.as_rows()]
    _table(ws, 8, ["費目", "率", "金額（円）"], rows, {3: YEN}, [18, 12, 18])
    if res.warnings:
        r = 8 + len(rows) + 2
        ws.cell(r, 1, "確認が必要な点").font = Font(bold=True, color="C00000")
        for w in res.warnings:
            r += 1
            ws.cell(r, 1, w)


def _items_rows(res: Result) -> list[list]:
    return [
        [i.seq, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, i.qty, i.unit_price, i.amount, i.code, i.how]
        for i in res.items
    ]


ITEM_HEADERS = ["No", "工種", "種別", "細別", "名称", "規格", "単位", "数量", "単価", "金額", "コード", "当てはめ"]
ITEM_WIDTHS = [5, 14, 14, 14, 22, 22, 6, 10, 12, 14, 12, 9]


def _unit_price_sheet(ws, res: Result) -> None:
    ws["A1"] = "単価表（歩掛の内訳）"
    ws["A1"].font = Font(bold=True, size=14)
    r = 2
    seen = set()
    for i in res.items:
        d = i.detail
        if not d or d.code in seen:
            continue
        seen.add(d.code)
        r += 2
        ws.cell(r, 1, f"{d.code}  {d.name}（{d.per_qty:g}{d.unit}あたり）").font = Font(bold=True)
        rows = [[l.kind, l.code, l.name, l.unit, l.qty, l.price, l.amount, l.source] for l in d.lines]
        if d.misc_rate:
            rows.append(["諸雑費", "", f"{d.misc_rate:g}%", "", "", "", sum(l.amount for l in d.lines) * d.misc_rate / 100, ""])
        rows.append(["計", "", "", "", "", "", d.subtotal, ""])
        rows.append([f"1{d.unit}あたり単価", "", "", "", "", "", d.price, ""])
        r = _table(ws, r + 1, ["種類", "コード", "名称", "単位", "数量", "単価", "金額", "出どころ"], rows,
                   {5: NUM, 6: YEN, 7: YEN}, [14, 12, 24, 6, 10, 12, 14, 8])


def export_estimate(path: str | Path, project: dict, res: Result) -> Path:
    """積算結果：内訳書・明細・単価表を1冊にまとめる。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "工事費内訳書"
    _summary_sheet(ws, "工事費内訳書", project, res)
    ws2 = wb.create_sheet("明細")
    _table(ws2, 1, ITEM_HEADERS, _items_rows(res), {8: NUM, 9: YEN, 10: YEN}, ITEM_WIDTHS, warn_col=12)
    _unit_price_sheet(wb.create_sheet("単価表"), res)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def export_budget(path: str | Path, project: dict, design: Result, company: Result) -> Path:
    """実行予算：設計（発注者単価）と実行（自社単価）を並べ、差を出す。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "実行予算"
    ws["A1"] = "実行予算"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A3"], ws["B3"] = "工事名", project["name"]
    ws["A4"], ws["B4"] = "設計 工事価格", design.summary.price
    ws["A5"], ws["B5"] = "実行 直接工事費", company.summary.direct
    ws["A6"], ws["B6"] = "設計 直接工事費", design.summary.direct
    for c in ("B4", "B5", "B6"):
        ws[c].number_format = YEN
    rows = []
    for d, c in zip(design.items, company.items):
        rows.append([d.seq, d.name, d.spec, d.unit, d.qty, d.unit_price, d.amount, c.unit_price, c.amount,
                     d.amount - c.amount, c.how])
    _table(ws, 8, ["No", "名称", "規格", "単位", "数量", "設計単価", "設計金額", "実行単価", "実行金額", "差額", "当てはめ"],
           rows, {5: NUM, 6: YEN, 7: YEN, 8: YEN, 9: YEN, 10: YEN}, [5, 22, 22, 6, 10, 12, 14, 12, 14, 14, 9],
           warn_col=11)
    _unit_price_sheet(wb.create_sheet("実行単価表"), company)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
