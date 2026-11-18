"""出力：積算結果（入札額検討用）・工事費内訳書・単価表・実行予算 を Excel に書き出す。

電子入札で提出する内訳書の様式は発注者ごとに違うため、見本が届いたら合わせる。
"""
from __future__ import annotations

from pathlib import Path
import csv

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .calc import BidCheck, ItemResult, Result, is_direct

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
        if warn_col is not None and warn_col <= len(row) and row[warn_col - 1] == "未設定":
            for c in range(1, len(headers) + 1):
                ws.cell(r, c).fill = WARN_FILL
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    return r


def _summary_sheet(ws, title: str, project: dict, res: Result, bid: BidCheck | None = None) -> None:
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=14)
    ws["A3"], ws["B3"] = "工事名", project["name"]
    ws["A4"], ws["B4"] = "年度", project["fy"]
    ws["A5"], ws["B5"] = "工種区分", project["work_type"]
    ws["A6"], ws["B6"] = "地区", project["region"]
    ws["D3"], ws["E3"] = "発注者", project.get("orderer", "")
    ws["D4"], ws["E4"] = "補正", "、".join(res.conditions) or "なし"
    ws["D5"], ws["E5"] = "単価の適用日", project.get("price_date", "") or "年度の単価"
    ws["D6"], ws["E6"] = "状態", f"{project.get('status', '')} {project.get('checked_by', '')}".strip()
    rows = [[n, (f"{r:.2f}%" if r is not None else ""), a] for n, r, a in res.summary.as_rows()]
    r = _table(ws, 8, ["費目", "率", "金額（円）"], rows, {3: YEN}, [18, 12, 18])
    r += 2
    ws.cell(r, 1, "入札の検討（試算）").font = Font(bold=True)
    brows = [["予定価格の見込み（工事価格）", "", res.summary.price],
             ["調査基準価格・最低制限価格の試算", "", res.summary.threshold]]
    if bid and bid.bid:
        brows += [["入札額", f"{bid.ratio * 100:.2f}%", bid.bid],
                  ["実行原価の見込み", "", bid.cost],
                  ["粗利の見込み（入札額 − 実行原価）", "", bid.margin]]
    r = _table(ws, r + 1, ["項目", "対予定価格", "金額（円）"], brows, {3: YEN})
    ws.column_dimensions["A"].width = 34
    r += 1
    ws.cell(r, 1, "※ 基準価格の式は年度のルール表のもの。発注者の公表内容と合っているか確認すること。")
    if bid and bid.below_threshold:
        r += 1
        ws.cell(r, 1, "※ 入札額が基準価格の試算を下回っています").font = Font(bold=True, color="C00000")
    if res.warnings:
        r += 2
        ws.cell(r, 1, "確認が必要な点").font = Font(bold=True, color="C00000")
        for w in res.warnings:
            r += 1
            ws.cell(r, 1, w)


def _items_rows(res: Result) -> list[list]:
    return [
        [i.seq, i.category, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, i.qty, i.unit_price, i.amount,
         i.code, i.how, i.note]
        for i in res.items
    ]


ITEM_HEADERS = ["No", "区分", "工種", "種別", "細別", "名称", "規格", "単位", "数量", "単価", "金額", "コード", "当てはめ",
                "積算根拠メモ"]
ITEM_WIDTHS = [5, 8, 14, 14, 14, 22, 22, 6, 10, 12, 14, 12, 9, 30]


def breakdown_rows(res: Result, max_depth: int = 4) -> list[tuple[int, str, str, str, float | None, float | None, int, str]]:
    """階層つき内訳書の行: (字下げ, 名称, 規格, 単位, 数量, 単価, 金額, 摘要)。
    工種 → 種別 → 細別 → 明細 の順に並べ、上の階層には合計を「1式」で出す。
    max_depth（発注者の様式に合わせる）より深い行は出さない。"""
    out: list = []

    def tree(items: list[ItemResult], level: int, depth: int | None = None) -> None:
        depth = level if depth is None else depth  # 字下げ（空欄の階層は詰める）
        if level > 3:
            for i in items:
                out.append((depth, i.name, i.spec, i.unit, i.qty, i.unit_price, i.amount, i.code))
            return
        key = ("level1", "level2", "level3")[level - 1]
        groups: list[tuple[str, list[ItemResult]]] = []
        for i in items:
            k = getattr(i, key)
            if groups and groups[-1][0] == k:
                groups[-1][1].append(i)
            else:
                groups.append((k, [i]))
        for k, g in groups:
            if k:
                out.append((depth, k, "", "式", 1, None, sum(x.amount for x in g), ""))
                tree(g, level + 1, depth + 1)
            else:
                tree(g, level + 1, depth)  # 空欄の階層は飛ばす

    s = res.summary
    out.append((0, "直接工事費", "", "式", 1, None, s.direct, ""))
    tree([i for i in res.items if is_direct(i.category)], 1)
    out.append((0, "共通仮設費", "", "式", 1, None, s.common_temp, f"率 {s.common_temp_rate:.2f}%"))
    tree([i for i in res.items if i.category == "共通仮設"], 1)
    out.append((0, "純工事費", "", "式", 1, None, s.net, ""))
    out.append((0, "現場管理費", "", "式", 1, None, s.site_mgmt, f"率 {s.site_mgmt_rate:.2f}%"))
    tree([i for i in res.items if i.category == "現場管理"], 1)
    out.append((0, "工事原価", "", "式", 1, None, s.cost, ""))
    out.append((0, "一般管理費等", "", "式", 1, None, s.general, f"率 {s.general_rate:.2f}%"))
    out.append((0, "工事価格", "", "式", 1, None, s.price, ""))
    out.append((0, "消費税相当額", "", "式", 1, None, s.tax, ""))
    out.append((0, "工事費計", "", "式", 1, None, s.total, ""))
    return [r for r in out if r[0] <= max_depth]


def _depth(res: Result) -> int:
    try:
        return int(res.rules.get("内訳書_階層の深さ", "4"))
    except ValueError:
        return 4


def _breakdown_sheet(ws, project: dict, res: Result) -> None:
    ws["A1"] = f"工事費内訳書　{project['name']}"
    ws["A1"].font = Font(bold=True, size=14)
    rows = []
    brows = breakdown_rows(res, _depth(res))
    for depth, name, spec, unit, qty, price, amount, note in brows:
        rows.append(["　" * max(depth, 0) + name, spec, unit, qty, price, amount, note])
    r0 = 3
    _table(ws, r0, ["費目・工種・種別・細別", "規格", "単位", "数量", "単価", "金額", "摘要"], rows,
           {4: NUM, 5: YEN, 6: YEN}, [40, 24, 6, 10, 12, 16, 16])
    for k, (depth, *_rest) in enumerate(brows):
        if depth == 0:
            for c in range(1, 8):
                ws.cell(r0 + 1 + k, c).font = Font(bold=True)
                ws.cell(r0 + 1 + k, c).fill = HEAD_FILL


def _unit_price_sheet(ws, res: Result) -> None:
    ws["A1"] = "単価表（歩掛の内訳）"
    ws["A1"].font = Font(bold=True, size=14)
    r = 2
    seen = set()
    for i in res.items:
        d = i.detail
        if not d or (d.code, d.conditions) in seen:
            continue
        seen.add((d.code, d.conditions))
        r += 2
        cond = f"　補正: {'、'.join(d.conditions)}" if d.conditions else ""
        ws.cell(r, 1, f"{d.code}  {d.name}（{d.per_qty:g}{d.unit}あたり）{cond}").font = Font(bold=True)
        rows = [[l.kind, l.code, l.name, l.unit, l.qty, l.price, l.amount,
                 l.source + (f" ×{l.factor:g}" if l.factor != 1 else "")] for l in d.lines]
        if d.misc_rate:
            rows.append(["諸雑費", "", f"{d.misc_rate:g}%", "", "", "", sum(l.amount for l in d.lines) * d.misc_rate / 100, ""])
        rows.append(["計", "", "", "", "", "", d.subtotal, ""])
        rows.append([f"1{d.unit}あたり単価", "", "", "", "", "", d.price, ""])
        r = _table(ws, r + 1, ["種類", "コード", "名称", "単位", "数量", "単価", "金額", "出どころ"], rows,
                   {5: NUM, 6: YEN, 7: YEN}, [14, 12, 24, 6, 10, 12, 14, 14])


def export_estimate(path: str | Path, project: dict, res: Result, bid: BidCheck | None = None) -> Path:
    """積算結果：総括・内訳書・明細・単価表を1冊にまとめる。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "総括"
    _summary_sheet(ws, "積算結果 総括", project, res, bid)
    _breakdown_sheet(wb.create_sheet("工事費内訳書"), project, res)
    ws2 = wb.create_sheet("明細")
    _table(ws2, 1, ITEM_HEADERS, _items_rows(res), {9: NUM, 10: YEN, 11: YEN}, ITEM_WIDTHS, warn_col=13)
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


def export_ebid_csv(path: str | Path, project: dict, res: Result) -> Path:
    """⑧ 電子入札で出す内訳書のCSV（文字コードと階層の深さは発注者ごとの設定に従う）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    enc = res.rules.get("電子入札_文字コード", "cp932")
    with open(path, "w", encoding=enc, errors="replace", newline="") as f:
        w = csv.writer(f)
        w.writerow(["階層", "名称", "規格", "単位", "数量", "単価", "金額", "摘要"])
        for depth, name, spec, unit, qty, price, amount, note in breakdown_rows(res, _depth(res)):
            w.writerow([depth, name, spec, unit, "" if qty is None else f"{qty:g}",
                        "" if price is None else f"{price:.0f}", amount, note])
    return path


def export_change(path: str | Path, project: dict, comp) -> Path:
    """① 設計変更の対比表（当初・変更・増減）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "変更対比表"
    ws["A1"] = f"変更対比表　{project['name']}"
    ws["A1"].font = Font(bold=True, size=14)
    rows = [[r.level1, r.level2, r.name, r.spec, r.unit, r.qty0, r.qty1,
             None if r.qty0 is None or r.qty1 is None else r.qty1 - r.qty0,
             r.price0 or None, r.price1 or None, r.amount0, r.amount1, r.diff, r.status] for r in comp.rows]
    r = _table(ws, 3, ["工種", "種別", "名称", "規格", "単位", "当初数量", "変更数量", "増減", "当初単価", "変更単価",
                       "当初金額", "変更金額", "増減額", "区分"], rows,
               {6: NUM, 7: NUM, 8: NUM, 9: YEN, 10: YEN, 11: YEN, 12: YEN, 13: YEN},
               [12, 12, 18, 18, 6, 10, 10, 10, 11, 11, 13, 13, 13, 7])
    r += 2
    srows = []
    for (n, _, a), (_, _, b) in zip(comp.before.as_rows(), comp.after.as_rows()):
        srows.append([n, a, b, b - a])
    _table(ws, r, ["費目", "当初", "変更", "増減"], srows, {2: YEN, 3: YEN, 4: YEN})
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
