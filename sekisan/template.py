"""⑨ 自社の書式で出力：Excelのひな形に {{工事名}} などの差し込み記号を書いておくと、値を入れて保存する。

使える記号
  {{工事名}} {{発注者}} {{年度}} {{工種区分}} {{地区}} {{日付}} {{担当者}}
  {{直接工事費}} {{共通仮設費}} {{純工事費}} {{現場管理費}} {{工事原価}} {{一般管理費等}}
  {{工事価格}} {{消費税相当額}} {{工事費計}} {{基準価格}} {{入札額}}
  明細の行：ある行に {{明細.名称}} {{明細.規格}} {{明細.単位}} {{明細.数量}} {{明細.単価}} {{明細.金額}}
            {{明細.No}} {{明細.工種}} {{明細.種別}} {{明細.細別}} {{明細.コード}} {{明細.メモ}} を書くと、
            その行を明細の数だけ増やして埋める
"""
from __future__ import annotations

import re
from copy import copy
from datetime import date
from pathlib import Path

from openpyxl import load_workbook

from . import audit
from .calc import Result

TOKEN = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")


def _values(project: dict, res: Result) -> dict[str, object]:
    s = res.summary
    v: dict[str, object] = {
        "工事名": project.get("name", ""), "発注者": project.get("orderer", ""), "年度": project.get("fy", ""),
        "工種区分": project.get("work_type", ""), "地区": project.get("region", ""),
        "日付": date.today().isoformat(), "担当者": audit.current_user(),
        "基準価格": s.threshold, "入札額": int(project.get("bid_price") or 0),
    }
    for n, _r, a in s.as_rows():
        v[n.strip("　")] = a
    return v


def _item_values(i) -> dict[str, object]:
    return {"明細.No": i.seq, "明細.工種": i.level1, "明細.種別": i.level2, "明細.細別": i.level3,
            "明細.名称": i.name, "明細.規格": i.spec, "明細.単位": i.unit, "明細.数量": i.qty,
            "明細.単価": i.unit_price, "明細.金額": i.amount, "明細.コード": i.code, "明細.メモ": i.note}


def _fill(text: str, vals: dict[str, object]):
    m = TOKEN.fullmatch(text.strip())
    if m and m.group(1) in vals:
        return vals[m.group(1)]  # 記号だけのセルは数字のまま入れる
    return TOKEN.sub(lambda mm: str(vals.get(mm.group(1), mm.group(0))), text)


def fill(template_path: str | Path, out_path: str | Path, project: dict, res: Result) -> Path:
    wb = load_workbook(template_path)
    vals = _values(project, res)
    for ws in wb.worksheets:
        item_row = None
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and "{{明細." in c.value:
                    item_row = c.row
                    break
            if item_row:
                break
        if item_row:
            n = len(res.items)
            tmpl = [(c.column, c.value, copy(c._style)) for c in ws[item_row]]
            if n > 1:
                ws.insert_rows(item_row + 1, n - 1)
            for k, it in enumerate(res.items):
                iv = _item_values(it)
                for col, val, style in tmpl:
                    cell = ws.cell(item_row + k, col)
                    cell._style = copy(style)
                    cell.value = _fill(val, iv) if isinstance(val, str) else val
            if n == 0:
                for col, _v, _s in tmpl:
                    ws.cell(item_row, col).value = None
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and "{{" in c.value:
                    c.value = _fill(c.value, vals)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out
