"""取り込み：発注者の設計書データ（CSV）と、年度ごとのマスタ（単価・歩掛・諸経費率）。

設計書CSVの正確な形式は見本ファイルが届いてから合わせる。それまでは
見出し名から列を推測する。合わない場合は列の対応表（JSON）を渡せる。
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

# 見出しの候補（左から順に探す）
DEFAULT_COLUMNS: dict[str, list[str]] = {
    "level1": ["工種", "費目", "レベル1"],
    "level2": ["種別", "レベル2"],
    "level3": ["細別", "レベル3"],
    "name": ["名称", "品名", "項目", "細目"],
    "spec": ["規格", "摘要", "形状寸法"],
    "unit": ["単位"],
    "qty": ["数量"],
    "bukake_code": ["コード", "単価コード", "歩掛コード", "代価コード"],
}


def read_text(path: str | Path) -> str:
    data = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp932"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"文字コードを判別できません: {path}")


def read_csv_rows(path: str | Path) -> list[dict[str, str]]:
    text = read_text(path)
    reader = csv.DictReader(io.StringIO(text))
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def _to_float(s: str) -> float:
    s = (s or "").replace(",", "").replace("，", "").strip()
    if not s:
        return 0.0
    return float(s)


@dataclass
class DesignItem:
    seq: int
    level1: str
    level2: str
    level3: str
    name: str
    spec: str
    unit: str
    qty: float
    bukake_code: str


def resolve_columns(headers: list[str], mapping: dict[str, list[str]] | None = None) -> dict[str, str | None]:
    mapping = mapping or DEFAULT_COLUMNS
    result: dict[str, str | None] = {}
    for field, candidates in mapping.items():
        if isinstance(candidates, str):
            candidates = [candidates]
        result[field] = next((c for c in candidates if c in headers), None)
    return result


def parse_design_csv(path: str | Path, mapping_file: str | Path | None = None) -> list[DesignItem]:
    """設計書CSVを読み、数量のある行を明細として返す。"""
    mapping = None
    if mapping_file:
        mapping = json.loads(Path(mapping_file).read_text(encoding="utf-8"))
    rows = read_csv_rows(path)
    if not rows:
        return []
    cols = resolve_columns(list(rows[0].keys()), mapping)
    if not cols.get("name") or not cols.get("qty"):
        raise ValueError(
            "設計書CSVに「名称」と「数量」の列が見つかりません。"
            f" 見出し: {list(rows[0].keys())}"
        )

    def get(row: dict[str, str], field: str) -> str:
        col = cols.get(field)
        return row.get(col, "") if col else ""

    items: list[DesignItem] = []
    for row in rows:
        name = get(row, "name")
        qty_s = get(row, "qty")
        if not name or not qty_s:
            continue  # 見出し行・小計行など
        try:
            qty = _to_float(qty_s)
        except ValueError:
            continue
        items.append(
            DesignItem(
                seq=len(items) + 1,
                level1=get(row, "level1"),
                level2=get(row, "level2"),
                level3=get(row, "level3"),
                name=name,
                spec=get(row, "spec"),
                unit=get(row, "unit"),
                qty=qty,
                bukake_code=get(row, "bukake_code"),
            )
        )
    return items


def create_project(
    conn: sqlite3.Connection,
    name: str,
    fy: str,
    items: list[DesignItem],
    region: str = "",
    work_type: str = "",
    source_file: str = "",
) -> int:
    cur = conn.execute(
        "INSERT INTO project(name, fy, region, work_type, source_file) VALUES (?,?,?,?,?)",
        (name, fy, region, work_type, source_file),
    )
    pid = cur.lastrowid
    conn.executemany(
        "INSERT INTO project_item(project_id, seq, level1, level2, level3, name, spec, unit, qty, bukake_code)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            (pid, it.seq, it.level1, it.level2, it.level3, it.name, it.spec, it.unit, it.qty, it.bukake_code)
            for it in items
        ],
    )
    conn.commit()
    return pid


# ---------------------------------------------------------------- マスタ取り込み
# 年度フォルダ（例: マスタ/R8/）に次のCSVを置く。
#   単価.csv      : 種類,コード,名称,規格,単位,単価,地区
#   歩掛.csv      : コード,名称,規格,単位,基準数量,諸雑費率
#   歩掛構成.csv  : 歩掛コード,種類,資源コード,数量
#   諸経費.csv    : 工種区分,費目,式,A,b,P下限,P上限
#   ルール.csv    : 項目,値


def import_master_folder(conn: sqlite3.Connection, fy: str, folder: str | Path) -> dict[str, int]:
    """年度のマスタを丸ごと入れ替える（同じ年度の古い内容は消える）。"""
    folder = Path(folder)
    counts: dict[str, int] = {}
    with conn:
        if (folder / "単価.csv").exists():
            conn.execute("DELETE FROM master_price WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "単価.csv")
            conn.executemany(
                "INSERT INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES (?,?,?,?,?,?,?,?)",
                [
                    (fy, r["種類"], r["コード"], r["名称"], r.get("規格", ""), r.get("単位", ""),
                     _to_float(r["単価"]), r.get("地区", ""))
                    for r in rows
                ],
            )
            counts["単価"] = len(rows)
        if (folder / "歩掛.csv").exists():
            conn.execute("DELETE FROM bukake WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "歩掛.csv")
            conn.executemany(
                "INSERT INTO bukake(fy, code, name, spec, unit, per_qty, misc_rate) VALUES (?,?,?,?,?,?,?)",
                [
                    (fy, r["コード"], r["名称"], r.get("規格", ""), r.get("単位", ""),
                     _to_float(r.get("基準数量", "1")) or 1.0, _to_float(r.get("諸雑費率", "0")))
                    for r in rows
                ],
            )
            counts["歩掛"] = len(rows)
        if (folder / "歩掛構成.csv").exists():
            conn.execute("DELETE FROM bukake_component WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "歩掛構成.csv")
            seqs: dict[str, int] = {}
            data = []
            for r in rows:
                code = r["歩掛コード"]
                seqs[code] = seqs.get(code, 0) + 1
                data.append((fy, code, seqs[code], r["種類"], r["資源コード"], _to_float(r["数量"])))
            conn.executemany(
                "INSERT INTO bukake_component(fy, bukake_code, seq, kind, res_code, qty) VALUES (?,?,?,?,?,?)",
                data,
            )
            counts["歩掛構成"] = len(rows)
        if (folder / "諸経費.csv").exists():
            conn.execute("DELETE FROM overhead_param WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "諸経費.csv")
            conn.executemany(
                "INSERT INTO overhead_param(fy, work_type, item, formula, a, b, p_min, p_max) VALUES (?,?,?,?,?,?,?,?)",
                [
                    (fy, r["工種区分"], r["費目"], r["式"], _to_float(r["A"]), _to_float(r["b"]),
                     _to_float(r["P下限"]), _to_float(r["P上限"]))
                    for r in rows
                ],
            )
            counts["諸経費"] = len(rows)
        if (folder / "ルール.csv").exists():
            conn.execute("DELETE FROM rule WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "ルール.csv")
            conn.executemany(
                "INSERT INTO rule(fy, key, value) VALUES (?,?,?)",
                [(fy, r["項目"], r["値"]) for r in rows],
            )
            counts["ルール"] = len(rows)
    return counts


def import_company_prices(conn: sqlite3.Connection, path: str | Path) -> int:
    """自社単価.csv : 種類,コード,名称,単位,単価,備考（同じコードは上書き）"""
    rows = read_csv_rows(path)
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO company_price(kind, code, name, unit, price, note) VALUES (?,?,?,?,?,?)",
            [
                (r["種類"], r["コード"], r["名称"], r.get("単位", ""), _to_float(r["単価"]), r.get("備考", ""))
                for r in rows
            ],
        )
    return len(rows)


def import_reference(conn: sqlite3.Connection, project_id: int, path: str | Path) -> int:
    """答え合わせ用.csv : 項目,金額
    項目は明細の番号（1, 2, …）か、合計名（直接工事費・共通仮設費・純工事費・現場管理費・
    工事原価・一般管理費等・工事価格）。"""
    rows = read_csv_rows(path)
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO reference_result(project_id, key, amount) VALUES (?,?,?)",
            [(project_id, r["項目"], _to_float(r["金額"])) for r in rows],
        )
    return len(rows)
