"""⑤ 数量計算書。計算式（10.5×2.0×0.3 など）で数量を拾い、明細の数量に反映する。"""
from __future__ import annotations

import ast
import operator
import sqlite3
import unicodedata

from . import audit, calc

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.USub: operator.neg, ast.UAdd: operator.pos, ast.Pow: operator.pow}


def evaluate(expr: str) -> float:
    """四則演算と括弧だけを計算する（それ以外は受け付けない）。× ÷ や全角数字も使える。"""
    s = unicodedata.normalize("NFKC", expr).replace("×", "*").replace("÷", "/").replace("x", "*").replace("X", "*")
    s = s.replace("^", "**").replace(",", "")
    if not s.strip():
        raise ValueError("計算式が空です")
    try:
        tree = ast.parse(s, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"計算式が読めません: {expr}") from e

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            if isinstance(n.op, ast.Pow) and abs(ev(n.right)) > 10:
                raise ValueError("べき乗が大きすぎます")
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        raise ValueError(f"使えない書き方です: {expr}")

    try:
        return ev(tree)
    except ZeroDivisionError as e:
        raise ValueError("0で割っています") from e


def lines(conn: sqlite3.Connection, item_id: int) -> list[sqlite3.Row]:
    return list(conn.execute("SELECT * FROM qty_calc WHERE item_id=? ORDER BY seq, id", (item_id,)))


def add_line(conn: sqlite3.Connection, item_id: int, expr: str, label: str = "") -> float:
    audit.require_editable(conn, audit.project_of_item(conn, item_id))
    v = evaluate(expr)
    with conn:
        seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM qty_calc WHERE item_id=?", (item_id,)).fetchone()[0]
        conn.execute("INSERT INTO qty_calc(item_id, seq, label, expr, value) VALUES (?,?,?,?,?)",
                     (item_id, seq, label, expr, v))
    return v


def delete_line(conn: sqlite3.Connection, line_id: int) -> None:
    r = conn.execute("SELECT item_id FROM qty_calc WHERE id=?", (line_id,)).fetchone()
    if r:
        audit.require_editable(conn, audit.project_of_item(conn, r["item_id"]))
    with conn:
        conn.execute("DELETE FROM qty_calc WHERE id=?", (line_id,))


def total(conn: sqlite3.Connection, item_id: int) -> float:
    return sum(r["value"] for r in lines(conn, item_id))


def apply_total(conn: sqlite3.Connection, item_id: int, places: int = 2) -> float:
    """数量計算書の合計（小数 places 桁で四捨五入）を明細の数量にする。"""
    t = calc.round_dec(total(conn, item_id), places)
    calc.set_qty(conn, item_id, t)
    return t


def sheet_rows(conn: sqlite3.Connection, project_id: int) -> list[tuple]:
    """出力用: (明細No, 名称, 規格, 単位, 場所, 計算式, 値, 明細の数量)"""
    out = []
    for it in conn.execute("SELECT * FROM project_item WHERE project_id=? ORDER BY seq", (project_id,)):
        ls = lines(conn, it["id"])
        for l in ls:
            out.append((it["seq"], it["name"], it["spec"], it["unit"], l["label"], l["expr"], l["value"], None))
        if ls:
            out.append((it["seq"], f"{it['name']} 計", "", it["unit"], "", "", sum(l["value"] for l in ls), it["qty"]))
    return out
