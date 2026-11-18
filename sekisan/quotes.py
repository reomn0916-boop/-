"""⑤ 見積単価：単価表にない資材・工種について業者見積を比べ、採用単価を決める。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from . import audit

RULES = ("最低", "平均", "指定")


@dataclass
class Quote:
    code: str
    name: str
    spec: str
    unit: str
    rule: str
    fixed_price: float
    note: str
    offers: list[sqlite3.Row]
    adopted: float | None  # 採用単価（見積がなければ None）


def adopted_price(conn: sqlite3.Connection, code: str) -> tuple[float, sqlite3.Row] | None:
    q = conn.execute("SELECT * FROM quote WHERE code=?", (code,)).fetchone()
    if not q:
        return None
    if q["rule"] == "指定":
        return (q["fixed_price"], q) if q["fixed_price"] else None
    prices = [r["price"] for r in conn.execute("SELECT price FROM quote_offer WHERE code=?", (code,))]
    if not prices:
        return None
    if q["rule"] == "平均":
        return sum(prices) / len(prices), q
    return min(prices), q


def get(conn: sqlite3.Connection, code: str) -> Quote | None:
    q = conn.execute("SELECT * FROM quote WHERE code=?", (code,)).fetchone()
    if not q:
        return None
    offers = list(conn.execute("SELECT * FROM quote_offer WHERE code=? ORDER BY price", (code,)))
    ap = adopted_price(conn, code)
    return Quote(q["code"], q["name"], q["spec"], q["unit"], q["rule"], q["fixed_price"], q["note"], offers,
                 ap[0] if ap else None)


def all_quotes(conn: sqlite3.Connection) -> list[Quote]:
    return [get(conn, r["code"]) for r in conn.execute("SELECT code FROM quote ORDER BY code")]


def save(conn: sqlite3.Connection, code: str, name: str, spec: str = "", unit: str = "", rule: str = "最低",
         fixed_price: float = 0, note: str = "") -> None:
    if rule not in RULES:
        raise ValueError(f"採用の決め方は {RULES} のどれかです")
    audit.require(conn, "edit")
    with conn:
        conn.execute(
            "INSERT INTO quote(code, name, spec, unit, rule, fixed_price, note) VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(code) DO UPDATE SET name=excluded.name, spec=excluded.spec, unit=excluded.unit,"
            " rule=excluded.rule, fixed_price=excluded.fixed_price, note=excluded.note",
            (code, name, spec, unit, rule, fixed_price, note),
        )


def add_offer(conn: sqlite3.Connection, code: str, vendor: str, price: float, date: str = "", file: str = "") -> int:
    audit.require(conn, "edit")
    with conn:
        cur = conn.execute("INSERT INTO quote_offer(code, vendor, price, date, file) VALUES (?,?,?,?,?)",
                           (code, vendor, price, date, file))
    return cur.lastrowid


def delete_offer(conn: sqlite3.Connection, offer_id: int) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("DELETE FROM quote_offer WHERE id=?", (offer_id,))


def delete(conn: sqlite3.Connection, code: str) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("DELETE FROM quote_offer WHERE code=?", (code,))
        conn.execute("DELETE FROM quote WHERE code=?", (code,))
