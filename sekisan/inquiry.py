"""⑥ 質疑書。照合で見つかった食い違いや、当てはめできない明細を、発注者への質問にまとめる。"""
from __future__ import annotations

import sqlite3

from . import audit
from .pdfcheck import PdfCheck


def rows(conn: sqlite3.Connection, project_id: int) -> list[sqlite3.Row]:
    return list(conn.execute("SELECT * FROM inquiry WHERE project_id=? ORDER BY id", (project_id,)))


def add(conn: sqlite3.Connection, project_id: int, question: str, place: str = "") -> int:
    audit.require_editable(conn, project_id)
    if not question.strip():
        raise ValueError("質問の内容を入れてください")
    with conn:
        cur = conn.execute("INSERT INTO inquiry(project_id, place, question) VALUES (?,?,?)",
                           (project_id, place, question.strip()))
        audit.log(conn, project_id, "質疑を追加", f"{place} {question[:40]}")
    return cur.lastrowid


def update(conn: sqlite3.Connection, inquiry_id: int, question: str | None = None, answer: str | None = None,
           place: str | None = None) -> None:
    r = conn.execute("SELECT * FROM inquiry WHERE id=?", (inquiry_id,)).fetchone()
    audit.require_editable(conn, r["project_id"])
    with conn:
        conn.execute("UPDATE inquiry SET question=?, answer=?, place=? WHERE id=?",
                     (r["question"] if question is None else question, r["answer"] if answer is None else answer,
                      r["place"] if place is None else place, inquiry_id))
        if answer is not None and answer != r["answer"]:
            audit.log(conn, r["project_id"], "質疑の回答", answer[:60])


def delete(conn: sqlite3.Connection, inquiry_id: int) -> None:
    r = conn.execute("SELECT project_id FROM inquiry WHERE id=?", (inquiry_id,)).fetchone()
    audit.require_editable(conn, r["project_id"] if r else None)
    with conn:
        conn.execute("DELETE FROM inquiry WHERE id=?", (inquiry_id,))


def from_pdf_check(conn: sqlite3.Connection, project_id: int, checks: list[PdfCheck]) -> int:
    """PDF照合で「数量違い」「見つからない」だった行を質問の下書きにする（同じ質問は重ねない）。"""
    have = {r["question"] for r in rows(conn, project_id)}
    n = 0
    for c in checks:
        if c.status == "数量違い":
            q = (f"「{c.name} {c.spec}」の数量について、設計書データでは {c.qty:g}{c.unit}、"
                 f"金抜き設計書では {c.pdf_qty:g}{c.unit} となっています。どちらが正しいかご教示ください。")
        elif c.status == "見つからない":
            q = f"「{c.name} {c.spec}」（{c.qty:g}{c.unit}）が金抜き設計書に見当たりません。計上の有無をご教示ください。"
        else:
            continue
        if q not in have:
            add(conn, project_id, q, f"明細{c.seq}")
            n += 1
    return n


def from_unresolved(conn: sqlite3.Connection, project_id: int, items) -> int:
    """歩掛・単価が当たらない明細について、施工条件や規格を確かめる質問の下書きを作る。"""
    have = {r["question"] for r in rows(conn, project_id)}
    n = 0
    for it in items:
        q = f"「{it.name} {it.spec}」（{it.qty:g}{it.unit}）の施工条件・規格の詳細（適用する歩掛など）をご教示ください。"
        if q not in have:
            add(conn, project_id, q, f"明細{it.seq}")
            n += 1
    return n
