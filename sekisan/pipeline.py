"""一括処理：設計書CSVの取り込みから、内訳書・実行予算の出力までを一度に行う。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from . import calc, change, export, importer


@dataclass
class Check:
    key: str
    ours: float
    reference: float

    @property
    def diff(self) -> float:
        return self.ours - self.reference

    @property
    def ok(self) -> bool:
        return abs(self.diff) < 0.5


def verify(conn: sqlite3.Connection, project_id: int, res: calc.Result | None = None) -> list[Check]:
    """外注時代の積算結果と比べる（答え合わせ）。"""
    res = res or calc.calculate(conn, project_id)
    ours: dict[str, float] = {str(i.seq): i.amount for i in res.items}
    ours.update({n: a for n, _, a in res.summary.as_rows()})
    # 金抜き設計書から作った単価表（単1・施1 …）の1単位あたりの単価
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    cl = calc.Calculator(conn, p["fy"], p["region"], calc.DESIGN, calc.project_conditions(conn, project_id),
                         p["orderer"], p["price_date"], project_id)
    for b in conn.execute("SELECT code FROM bukake WHERE fy=? AND project_id=?", (p["fy"], project_id)):
        up = cl.unit_price(b["code"])
        if up:
            ours[b["code"].split("/")[-1]] = up.price
    for k in conn.execute("SELECT code FROM package WHERE fy=? AND project_id=?", (p["fy"], project_id)):
        up = cl.package_price(k["code"])
        if up:
            ours[k["code"].split("/")[-1]] = up.price
    checks = []
    for r in conn.execute("SELECT key, amount FROM reference_result WHERE project_id=? ORDER BY rowid", (project_id,)):
        checks.append(Check(r["key"], ours.get(r["key"], 0.0), r["amount"]))
    return checks


def run(conn: sqlite3.Connection, project_id: int, out_dir: str | Path) -> dict[str, object]:
    project = dict(conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone())
    design = calc.calculate(conn, project_id, calc.DESIGN)
    company = calc.calculate(conn, project_id, calc.COMPANY)
    out_dir = Path(out_dir)
    safe = "".join(ch for ch in project["name"] if ch not in '\\/:*?"<>|')[:60] or f"工事{project_id}"
    bid = calc.bid_check(design, company, int(project["bid_price"])) if project["bid_price"] else None
    est = export.export_estimate(out_dir / f"{safe}_積算結果.xlsx", project, design, bid)
    bud = export.export_budget(out_dir / f"{safe}_実行予算.xlsx", project, design, company)
    files = [est, bud, export.export_ebid_csv(out_dir / f"{safe}_電子入札用内訳書.csv", project, design)]
    if project.get("parent_id"):
        comp = change.compare(conn, project_id)
        if comp:
            files.append(export.export_change(out_dir / f"{safe}_変更対比表.xlsx", project, comp))
    return {"design": design, "company": company, "bid": bid, "files": files,
            "checks": verify(conn, project_id, design)}


def import_and_run(
    conn: sqlite3.Connection,
    csv_path: str | Path,
    name: str,
    fy: str,
    work_type: str,
    out_dir: str | Path,
    region: str = "",
    mapping_file: str | Path | None = None,
    orderer: str = "",
) -> dict[str, object]:
    items = importer.parse_design_csv(csv_path, mapping_file)
    pid = importer.create_project(conn, name, fy, items, region, work_type, str(csv_path), orderer)
    result = run(conn, pid, out_dir)
    result["project_id"] = pid
    return result
