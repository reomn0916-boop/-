"""⑧ 受注後：単価合意（請負比率で設計単価を割り戻す）と出来高（部分払い）の計算。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from . import audit, calc


def set_contract_price(conn: sqlite3.Connection, project_id: int, price: float) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("UPDATE project SET contract_price=? WHERE id=?", (price, project_id))
        audit.log(conn, project_id, "契約額", f"{price:,.0f}")


@dataclass
class AgreedItem:
    item_id: int
    seq: int
    name: str
    spec: str
    unit: str
    qty: float
    design_price: float
    agreed_price: float
    agreed_amount: int


@dataclass
class Agreement:
    contract_price: int
    planned: int           # 工事価格（設計）
    ratio: float           # 請負比率 = 契約額 ÷ 工事価格
    items: list[AgreedItem]


def agreement(conn: sqlite3.Connection, project_id: int) -> Agreement:
    """単価合意の目安：合意単価 = 設計単価 × 請負比率（単価は有効桁数のルールで切り捨て）。"""
    p = conn.execute("SELECT contract_price FROM project WHERE id=?", (project_id,)).fetchone()
    res = calc.calculate(conn, project_id)
    planned = res.summary.price
    cp = int(p["contract_price"] or 0)
    ratio = cp / planned if planned and cp else 0.0
    digits = int(res.rules.get("単価の有効桁数", "4"))
    mode = res.rules.get("単価の端数処理", "切捨て")
    items = []
    for i in res.items:
        ap = calc.round_sig(i.unit_price * ratio, digits, mode) if ratio else 0.0
        items.append(AgreedItem(i.item_id, i.seq, i.name, i.spec, i.unit, i.qty, i.unit_price, ap,
                                calc.floor_yen(ap * i.qty)))
    return Agreement(cp, planned, ratio, items)


def periods(conn: sqlite3.Connection, project_id: int) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT period FROM progress WHERE project_id=? GROUP BY period ORDER BY MIN(rowid)", (project_id,))]


def set_progress(conn: sqlite3.Connection, project_id: int, period: str, item_id: int, qty: float) -> None:
    audit.require(conn, "edit")
    if not period.strip():
        raise ValueError("回（例: 第1回）を入れてください")
    with conn:
        conn.execute("INSERT OR REPLACE INTO progress(project_id, period, item_id, qty) VALUES (?,?,?,?)",
                     (project_id, period, item_id, qty))


@dataclass
class ProgressRow:
    seq: int
    name: str
    unit: str
    qty: float
    agreed_price: float
    done_qty: float        # その回までの累計
    done_amount: int
    rate: float            # 出来高率（数量ベース）


@dataclass
class Progress:
    period: str
    rows: list[ProgressRow]
    done_total: int        # 出来高金額（直接工事費ベースの合計）
    done_ratio: float      # 出来高 ÷ 合意後の直接工事費
    contract_done: int     # 契約額 × 出来高率
    payable: int           # 部分払いの限度額 = 契約額×出来高率×割合 − 前回までの支払
    paid_before: int


def progress(conn: sqlite3.Connection, project_id: int, period: str, pay_rate: float | None = None) -> Progress:
    ag = agreement(conn, project_id)
    res = calc.calculate(conn, project_id)
    pay_rate = float(res.rules.get("部分払_割合", "0.9")) if pay_rate is None else pay_rate
    ps = periods(conn, project_id)
    q = {r["item_id"]: r["qty"] for r in conn.execute(
        "SELECT item_id, qty FROM progress WHERE project_id=? AND period=?", (project_id, period))}
    rows = []
    for a in ag.items:
        dq = q.get(a.item_id, 0.0)
        rows.append(ProgressRow(a.seq, a.name, a.unit, a.qty, a.agreed_price, dq, calc.floor_yen(a.agreed_price * dq),
                                dq / a.qty if a.qty else 0.0))
    done = sum(r.done_amount for r in rows)
    base = sum(a.agreed_amount for a in ag.items)
    ratio = done / base if base else 0.0
    contract_done = calc.floor_yen(ag.contract_price * ratio)
    paid_before = 0
    if period in ps and ps.index(period) > 0:
        prev = progress(conn, project_id, ps[ps.index(period) - 1], pay_rate)
        paid_before = prev.paid_before + prev.payable
    payable = max(0, calc.floor_yen(contract_done * pay_rate) - paid_before)
    return Progress(period, rows, done, ratio, contract_done, payable, paid_before)
