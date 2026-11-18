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
    "category": ["区分", "費用区分"],
    "conditions": ["補正", "条件"],
}

from .calc import CATEGORIES, DIRECT, DIRECT_EXCLUDED  # noqa: E402,F401
from . import audit  # noqa: E402


def normalize_category(s: str) -> str:
    if "共通仮設" in s:
        return "共通仮設"
    if "現場管理" in s:
        return "現場管理"
    if "対象外" in s:
        return DIRECT_EXCLUDED
    return DIRECT


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
    category: str = "直接"
    conditions: str = ""


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
                category=normalize_category(get(row, "category")),
                conditions=get(row, "conditions"),
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
    orderer: str = "",
    parent_id: int | None = None,
    change_no: int = 0,
) -> int:
    cur = conn.execute(
        "INSERT INTO project(name, fy, region, work_type, source_file, orderer, parent_id, change_no, created_by)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (name, fy, region, work_type, source_file, orderer, parent_id, change_no, audit.current_user()),
    )
    pid = cur.lastrowid
    conn.executemany(
        "INSERT INTO project_item(project_id, seq, level1, level2, level3, name, spec, unit, qty, bukake_code,"
        " category, conditions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (pid, it.seq, it.level1, it.level2, it.level3, it.name, it.spec, it.unit, it.qty, it.bukake_code,
             it.category, it.conditions)
            for it in items
        ],
    )
    audit.log(conn, pid, "工事を作成", f"{name}（{len(items)}行）{source_file}")
    conn.commit()
    return pid


# ---------------------------------------------------------------- マスタ取り込み
# 年度フォルダ（例: マスタ/R8/）に次のCSVを置く。
#   単価.csv      : 種類,コード,名称,規格,単位,単価,地区
#   歩掛.csv      : コード,名称,規格,単位,基準数量,諸雑費率
#   歩掛構成.csv  : 歩掛コード,種類,資源コード,数量
#   諸経費.csv    : 工種区分,費目,式,A,b,P下限,P上限
#   ルール.csv    : 項目,値
#   施工パッケージ.csv      : コード,名称,規格,単位,標準単価
#   施工パッケージ構成.csv  : パッケージコード,種類,資源コード,構成比,基準単価
#   補正.csv      : コード,名称,対象,係数,歩掛コード
#   機械損料.csv  : コード,名称,規格,運転時間,損料_1時間,燃料_1時間,燃料コード,運転手コード,運転手人数,諸雑費率
#   単価改定.csv  : 種類,コード,地区,適用日,単価


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
        if (folder / "施工パッケージ.csv").exists():
            conn.execute("DELETE FROM package WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "施工パッケージ.csv")
            conn.executemany(
                "INSERT INTO package(fy, code, name, spec, unit, std_price) VALUES (?,?,?,?,?,?)",
                [(fy, r["コード"], r["名称"], r.get("規格", ""), r.get("単位", ""), _to_float(r["標準単価"]))
                 for r in rows],
            )
            counts["施工パッケージ"] = len(rows)
        if (folder / "施工パッケージ構成.csv").exists():
            conn.execute("DELETE FROM package_component WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "施工パッケージ構成.csv")
            seqs = {}
            data = []
            for r in rows:
                code = r["パッケージコード"]
                seqs[code] = seqs.get(code, 0) + 1
                data.append((fy, code, seqs[code], r["種類"], r["資源コード"], _to_float(r["構成比"]),
                             _to_float(r["基準単価"])))
            conn.executemany(
                "INSERT INTO package_component(fy, package_code, seq, kind, res_code, ratio, base_price)"
                " VALUES (?,?,?,?,?,?,?)",
                data,
            )
            counts["施工パッケージ構成"] = len(rows)
        if (folder / "補正.csv").exists():
            conn.execute("DELETE FROM adjustment WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "補正.csv")
            conn.executemany(
                "INSERT INTO adjustment(fy, code, name, target, factor, bukake_code) VALUES (?,?,?,?,?,?)",
                [(fy, r["コード"], r.get("名称", r["コード"]), r["対象"], _to_float(r["係数"]),
                  r.get("歩掛コード", "")) for r in rows],
            )
            counts["補正"] = len(rows)
        if (folder / "機械損料.csv").exists():
            conn.execute("DELETE FROM machine_cost WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "機械損料.csv")
            conn.executemany(
                "INSERT INTO machine_cost(fy, code, name, spec, hours, loss_per_hour, fuel_per_hour, fuel_code,"
                " operator_code, operators, misc_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(fy, r["コード"], r["名称"], r.get("規格", ""), _to_float(r["運転時間"]),
                  _to_float(r["損料_1時間"]), _to_float(r.get("燃料_1時間", "0")), r.get("燃料コード", ""),
                  r.get("運転手コード", ""), _to_float(r.get("運転手人数", "0")), _to_float(r.get("諸雑費率", "0")))
                 for r in rows],
            )
            counts["機械損料"] = len(rows)
        if (folder / "単価改定.csv").exists():
            conn.execute("DELETE FROM price_revision WHERE fy=?", (fy,))
            rows = read_csv_rows(folder / "単価改定.csv")
            conn.executemany(
                "INSERT INTO price_revision(fy, kind, code, region, valid_from, price) VALUES (?,?,?,?,?,?)",
                [(fy, r["種類"], r["コード"], r.get("地区", ""), r["適用日"], _to_float(r["単価"])) for r in rows],
            )
            counts["単価改定"] = len(rows)
        if counts:
            audit.log(conn, None, f"{fy}年度マスタを取り込み", "、".join(f"{k}{v}件" for k, v in counts.items()))
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


def import_orderer_rules(conn: sqlite3.Connection, path: str | Path) -> int:
    """発注者.csv : 発注者,項目,値（同じ発注者・項目は上書き）"""
    rows = read_csv_rows(path)
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO orderer_rule(orderer, key, value) VALUES (?,?,?)",
            [(r["発注者"], r["項目"], r["値"]) for r in rows],
        )
        audit.log(conn, None, "発注者ごとの設定を取り込み", f"{len(rows)}件")
    return len(rows)
