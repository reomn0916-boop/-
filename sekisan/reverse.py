"""公表された金額（予定価格・最低制限価格）から、直接工事費と内訳を逆算する。

諸経費の率の式と基準価格の式は、積算に使っているもの（年度マスタ・発注者ごとの設定）と同じ。
直接工事費だけを動かして、公表額になる範囲を二分法で探す（共通仮設・現場管理の積上げ分と率対象外は自社積算のまま）。
自社積算の直接工事費との差は「単価が不明な分・数量の違い」の見込みになる。
予定価格から逆算した場合は、その内訳から最低制限価格（調査基準価格）も見込める。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from . import audit, calc

BASES = ("予定価格（税抜）", "予定価格（税込）", "最低制限価格（税抜）")


@dataclass
class Reverse:
    basis: str
    target: int
    ours: calc.Summary            # 自社積算
    implied: calc.Summary         # 逆算した内訳（直接工事費は範囲の中ほど）
    direct_low: int               # 公表額になる直接工事費の範囲
    direct_high: int
    exact: bool                   # 公表額ちょうどになる直接工事費があったか

    @property
    def gap(self) -> int:
        """逆算した直接工事費 − 自社積算の直接工事費（＋なら自社積算が足りない）"""
        return self.implied.direct - self.ours.direct

    @property
    def gap_rate(self) -> float:
        return self.gap / self.implied.direct * 100 if self.implied.direct else 0.0


def _value(s: calc.Summary, basis: str) -> int:
    return {"予定価格（税抜）": s.price, "予定価格（税込）": s.total, "最低制限価格（税抜）": s.threshold}[basis]


def solve(conn: sqlite3.Connection, project_id: int, target: int, basis: str = BASES[0]) -> Reverse:
    if basis not in BASES:
        raise ValueError(f"逆算のもとにできるのは {'・'.join(BASES)} です")
    if target <= 0:
        raise ValueError("公表された金額を入れてください")
    res = calc.calculate(conn, project_id)
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    cl = calc.Calculator(conn, p["fy"], p["region"], calc.DESIGN, res.conditions, p["orderer"], p["price_date"],
                         project_id)
    s0 = res.summary
    ct = s0.common_temp_stacked
    sm = s0.site_mgmt_stacked
    ex = s0.direct_excluded

    def at(direct: int) -> calc.Summary:
        return cl.summary(max(direct, ex), p["work_type"], ct, sm, ex)

    def f(direct: int) -> int:
        return _value(at(direct), basis)

    # 公表額以上になる最小の直接工事費と、公表額を超える最小の直接工事費を探す（金額は直接工事費に対して増える）
    hi = max(target * 2, s0.direct * 2, 1000)
    while f(hi) <= target:
        hi *= 2

    def first(pred) -> int:
        lo_, hi_ = ex, hi
        while lo_ < hi_:
            mid = (lo_ + hi_) // 2
            if pred(f(mid)):
                hi_ = mid
            else:
                lo_ = mid + 1
        return lo_

    low = first(lambda v: v >= target)
    high = first(lambda v: v > target) - 1
    exact = f(low) == target
    if not exact:        # ちょうどにならない（端数の決まりが違うなど）：いちばん近いところ
        high = low
    mid = (low + high) // 2
    return Reverse(basis, target, s0, at(mid), low, high, exact)


def save(conn: sqlite3.Connection, project_id: int, basis: str, amount: int) -> None:
    """公表額を工事に控える（次に開いたときも逆算が出るように）"""
    audit.require_editable(conn, project_id)
    with conn:
        conn.execute("UPDATE project SET published_basis=?, published_amount=? WHERE id=?", (basis, amount, project_id))
        audit.log(conn, project_id, "公表額", f"{basis} {amount:,}")
