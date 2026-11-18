"""① 設計変更（当初と変更の対比）と ⑥ スライド（物価変動）の計算。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from . import audit, calc, importer


# ------------------------------------------------------------------ 設計変更
def create_change(conn: sqlite3.Connection, project_id: int, csv_path: str | Path | None = None) -> int:
    """工事を複製して「第n回変更」を作る。csv_path を渡せば、変更設計書のCSVから明細を作る。"""
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    root = p["parent_id"] or p["id"]
    n = conn.execute("SELECT COALESCE(MAX(change_no), 0) + 1 FROM project WHERE id=? OR parent_id=?",
                     (root, root)).fetchone()[0]
    base_name = conn.execute("SELECT name FROM project WHERE id=?", (root,)).fetchone()["name"]
    name = f"{base_name}（第{n}回変更）"
    if csv_path:
        items = importer.parse_design_csv(csv_path)
    else:
        items = [
            importer.DesignItem(r["seq"], r["level1"], r["level2"], r["level3"], r["name"], r["spec"], r["unit"],
                                r["qty"], r["bukake_code"], r["category"], r["conditions"])
            for r in conn.execute("SELECT * FROM project_item WHERE project_id=? ORDER BY seq", (project_id,))
        ]
    new_id = importer.create_project(conn, name, p["fy"], items, p["region"], p["work_type"],
                                     str(csv_path or ""), p["orderer"], parent_id=project_id, change_no=n)
    with conn:
        conn.execute("UPDATE project SET price_date=?, bid_price=? WHERE id=?", (p["price_date"], p["bid_price"], new_id))
        conn.executemany("INSERT INTO project_condition(project_id, code) VALUES (?,?)",
                         [(new_id, c) for c in calc.project_conditions(conn, project_id)])
        # 手で付けたメモも引き継ぐ（seqで対応）
        if not csv_path:
            conn.execute(
                "UPDATE project_item SET note=(SELECT o.note FROM project_item o WHERE o.project_id=? "
                "AND o.seq=project_item.seq) WHERE project_id=?", (project_id, new_id))
        audit.log(conn, new_id, "設計変更を作成", f"元: {p['name']}")
    return new_id


@dataclass
class CompareRow:
    key: tuple
    level1: str
    level2: str
    level3: str
    name: str
    spec: str
    unit: str
    qty0: float | None   # 変更前（None=新規）
    qty1: float | None   # 変更後（None=削除）
    price0: float
    price1: float
    amount0: int
    amount1: int

    @property
    def status(self) -> str:
        if self.qty0 is None:
            return "新規"
        if self.qty1 is None:
            return "削除"
        if abs(self.qty1 - self.qty0) > 1e-9:
            return "増" if self.qty1 > self.qty0 else "減"
        if abs(self.price1 - self.price0) > 1e-9:
            return "単価"
        return "同じ"

    @property
    def diff(self) -> int:
        return self.amount1 - self.amount0


@dataclass
class Comparison:
    before_id: int
    after_id: int
    rows: list[CompareRow]
    before: calc.Summary
    after: calc.Summary


def _key(i: calc.ItemResult) -> tuple:
    return (i.level1, i.level2, i.level3, i.name, i.spec, i.unit)


def compare(conn: sqlite3.Connection, project_id: int, before_id: int | None = None) -> Comparison | None:
    """変更（project_id）を、その元の工事（parent_id）と比べる。"""
    p = conn.execute("SELECT parent_id FROM project WHERE id=?", (project_id,)).fetchone()
    before_id = before_id or (p["parent_id"] if p else None)
    if not before_id:
        return None
    a = calc.calculate(conn, before_id)
    b = calc.calculate(conn, project_id)
    def keyed(items: list[calc.ItemResult]) -> list[tuple[tuple, calc.ItemResult]]:
        # 同じ名称・規格の行が複数あっても、出てきた順番で対応させる
        seen: dict[tuple, int] = {}
        out = []
        for i in items:
            k = _key(i)
            seen[k] = seen.get(k, 0) + 1
            out.append((k + (seen[k],), i))
        return out

    rows: dict[tuple, CompareRow] = {}
    for k, i in keyed(a.items):
        rows[k] = CompareRow(k, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, i.qty, None, i.unit_price, 0,
                             i.amount, 0)
    for k, i in keyed(b.items):
        r = rows.get(k)
        if r is None:
            r = rows[k] = CompareRow(k, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, None, None, 0, 0, 0, 0)
        r.qty1, r.price1, r.amount1 = i.qty, i.unit_price, i.amount
    out = list(rows.values())
    return Comparison(before_id, project_id, out, a.summary, b.summary)


# ------------------------------------------------------------------ スライド（物価変動）
@dataclass
class SlideResult:
    date_from: str
    date_to: str
    remaining: float       # 残工事の割合（0〜1）
    p1: int                # 変動前の単価で積算した残工事の直接工事費
    p2: int                # 変動後の単価で積算した残工事の直接工事費
    change: int            # p2 − p1
    burden: int            # 受注者の負担（p1 × 負担率）
    slide: int             # スライド額（変動額 − 負担。0未満なら0）
    burden_rate: float


def slide(conn: sqlite3.Connection, project_id: int, date_from: str, date_to: str, remaining: float = 1.0) -> SlideResult:
    """全体スライドの目安。残工事の直接工事費を、2つの時点の単価で積算し直して比べる。
    （実際のスライド額は工事価格ベース・請負比率などで決まるので、発注者の運用に合わせて確認すること）"""
    a = calc.calculate(conn, project_id, as_of=date_from)
    b = calc.calculate(conn, project_id, as_of=date_to)
    p1 = calc.floor_yen(a.summary.direct * remaining)
    p2 = calc.floor_yen(b.summary.direct * remaining)
    rate = float(a.rules.get("スライド_負担率", "0.015"))
    burden = calc.floor_yen(p1 * rate)
    change = p2 - p1
    return SlideResult(date_from, date_to, remaining, p1, p2, change, burden, max(0, change - burden), rate)
