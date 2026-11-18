"""データベース（SQLite）。

データファイルは社内の共有フォルダに1つ置き、各パソコンのソフトから開く。
共有フォルダ上ではWALモードが使えないため、従来のジャーナル方式で開き、
他の人が書き込み中のときは待つ。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
-- 年度ごとの単価（労務・材料・機械・市場単価）
CREATE TABLE IF NOT EXISTS master_price (
    fy TEXT NOT NULL,           -- 年度 例: R8
    kind TEXT NOT NULL,         -- 労務 / 材料 / 機械 / 市場単価
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL,
    region TEXT NOT NULL DEFAULT '',   -- 地区（空欄は全地区共通）
    PRIMARY KEY (fy, kind, code, region)
);

-- 年度ごとの歩掛（単価表・代価表）
CREATE TABLE IF NOT EXISTS bukake (
    fy TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    per_qty REAL NOT NULL DEFAULT 1,   -- 何単位あたりの歩掛か（例: 10m3あたり）
    misc_rate REAL NOT NULL DEFAULT 0, -- 諸雑費率（%）
    PRIMARY KEY (fy, code)
);

CREATE TABLE IF NOT EXISTS bukake_component (
    fy TEXT NOT NULL,
    bukake_code TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,         -- 労務 / 材料 / 機械 / 市場単価 / 歩掛（入れ子）
    res_code TEXT NOT NULL,
    qty REAL NOT NULL,
    PRIMARY KEY (fy, bukake_code, seq)
);

-- 年度ごとの諸経費率の式
CREATE TABLE IF NOT EXISTS overhead_param (
    fy TEXT NOT NULL,
    work_type TEXT NOT NULL,    -- 工種区分 例: 道路改良
    item TEXT NOT NULL,         -- 共通仮設費 / 現場管理費 / 一般管理費等
    formula TEXT NOT NULL,      -- power: 率=A×P^b  /  log: 率=A×log10(P)+b
    a REAL NOT NULL,
    b REAL NOT NULL,
    p_min REAL NOT NULL,        -- Pの下限（これ未満は下限で計算）
    p_max REAL NOT NULL,        -- Pの上限（これ超は上限で計算）
    PRIMARY KEY (fy, work_type, item)
);

-- 年度ごとの計算ルール（端数処理・消費税率など）
CREATE TABLE IF NOT EXISTS rule (
    fy TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (fy, key)
);

-- 自社の実行単価（作業員の日当・保有重機・下請け単価など）
CREATE TABLE IF NOT EXISTS company_price (
    kind TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (kind, code)
);

-- 設計書の項目 → 歩掛コード の対応（一度決めたら次回から自動で当てはまる）
CREATE TABLE IF NOT EXISTS item_mapping (
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    bukake_code TEXT NOT NULL,
    PRIMARY KEY (name, spec, unit)
);

CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    fy TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    work_type TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS project_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    level1 TEXT NOT NULL DEFAULT '',   -- 工種
    level2 TEXT NOT NULL DEFAULT '',   -- 種別
    level3 TEXT NOT NULL DEFAULT '',   -- 細別
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    qty REAL NOT NULL DEFAULT 0,
    bukake_code TEXT NOT NULL DEFAULT ''
);

-- 施工パッケージ（東京地区の標準単価を、機労材の構成比で地域・時期に補正する）
CREATE TABLE IF NOT EXISTS package (
    fy TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    std_price REAL NOT NULL,           -- 標準単価（東京地区・基準年月）
    PRIMARY KEY (fy, code)
);

CREATE TABLE IF NOT EXISTS package_component (
    fy TEXT NOT NULL,
    package_code TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- 機械 / 労務 / 材料 / 市場単価
    res_code TEXT NOT NULL,            -- 代表機労材のコード（単価.csv のコード）
    ratio REAL NOT NULL,               -- 構成比（0〜1）
    base_price REAL NOT NULL,          -- 東京地区の基準単価
    PRIMARY KEY (fy, package_code, seq)
);

-- 外注していた頃の積算結果（答え合わせ用）
CREATE TABLE IF NOT EXISTS reference_result (
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    key TEXT NOT NULL,          -- 項目番号 または 合計名（直接工事費・工事価格 など）
    amount REAL NOT NULL,
    PRIMARY KEY (project_id, key)
);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = DELETE")  # 共有フォルダではWAL不可
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _add_column(conn: sqlite3.Connection, table: str, col: str, decl: str) -> None:
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if col not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def _migrate(conn: sqlite3.Connection) -> None:
    """古い版で作ったデータファイルに、後から増えた列を足す。"""
    # 区分: 直接 / 共通仮設 / 現場管理（共通仮設・現場管理は率に加える積上げ分）
    _add_column(conn, "project_item", "category", "TEXT NOT NULL DEFAULT '直接'")
    _add_column(conn, "project_item", "note", "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "item_mapping", "note", "TEXT NOT NULL DEFAULT ''")  # 積算根拠のメモ（次の工事にも出る）
    _add_column(conn, "project", "bid_price", "REAL NOT NULL DEFAULT 0")   # 入札額（税抜）
    conn.commit()
