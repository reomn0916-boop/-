"""⑦ 落札結果のデータベースと、そこから見た傾向（落札率・自社積算の精度）。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, pstdev

from . import audit
from .importer import _to_float, read_csv_rows

FIELDS = ("date", "orderer", "name", "work_type", "planned", "threshold", "award_price", "winner", "our_bid",
          "our_estimate", "note")
CSV_COLS = {"日付": "date", "発注者": "orderer", "工事名": "name", "工種区分": "work_type", "予定価格": "planned",
            "基準価格": "threshold", "落札額": "award_price", "落札者": "winner", "自社入札額": "our_bid",
            "自社積算額": "our_estimate", "備考": "note"}
NUMS = {"planned", "threshold", "award_price", "our_bid", "our_estimate"}


def add(conn: sqlite3.Connection, **kw) -> int:
    data = {k: kw.get(k, 0 if k in NUMS else "") for k in FIELDS}
    audit.require(conn, "edit")
    if not data["name"]:
        raise ValueError("工事名を入れてください")
    with conn:
        cur = conn.execute(f"INSERT INTO award({', '.join(FIELDS)}) VALUES ({', '.join('?' * len(FIELDS))})",
                           [data[k] for k in FIELDS])
        audit.log(conn, None, "落札結果を登録", data["name"])
    return cur.lastrowid


def delete(conn: sqlite3.Connection, award_id: int) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("DELETE FROM award WHERE id=?", (award_id,))


def import_csv(conn: sqlite3.Connection, path: str | Path) -> int:
    rows = read_csv_rows(path)
    for r in rows:
        kw = {}
        for col, f in CSV_COLS.items():
            v = r.get(col, "")
            kw[f] = _to_float(v) if f in NUMS else v
        add(conn, **kw)
    return len(rows)


def rows(conn: sqlite3.Connection, orderer: str = "", work_type: str = "") -> list[sqlite3.Row]:
    q = "SELECT * FROM award WHERE 1=1"
    args: list = []
    if orderer:
        q += " AND orderer=?"
        args.append(orderer)
    if work_type:
        q += " AND work_type=?"
        args.append(work_type)
    return list(conn.execute(q + " ORDER BY date DESC, id DESC", args))


@dataclass
class Stats:
    count: int
    award_ratio: float | None      # 落札額 ÷ 予定価格 の平均
    threshold_ratio: float | None  # 基準価格 ÷ 予定価格 の平均
    accuracy: float | None         # 自社積算 ÷ 予定価格 の平均（1より小さい＝自社が低く見ている）
    accuracy_sd: float | None
    win_count: int

    def predict_planned(self, our_estimate: float) -> float | None:
        """自社の積算額から、過去の傾向で補正した予定価格の見込み。"""
        if not self.accuracy:
            return None
        return our_estimate / self.accuracy


def stats(conn: sqlite3.Connection, orderer: str = "", work_type: str = "", our_name: str = "自社") -> Stats:
    rs = rows(conn, orderer, work_type)
    ar = [r["award_price"] / r["planned"] for r in rs if r["planned"] and r["award_price"]]
    tr = [r["threshold"] / r["planned"] for r in rs if r["planned"] and r["threshold"]]
    ac = [r["our_estimate"] / r["planned"] for r in rs if r["planned"] and r["our_estimate"]]
    wins = sum(1 for r in rs if r["winner"] == our_name)
    return Stats(len(rs), mean(ar) if ar else None, mean(tr) if tr else None, mean(ac) if ac else None,
                 pstdev(ac) if len(ac) > 1 else None, wins)
