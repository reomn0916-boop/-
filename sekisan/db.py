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

-- ② 補正係数・割増（年度ごと）。対象: 労務 / 機械 / 材料 / 市場単価 / 全体 / 共通仮設費率 / 現場管理費率
CREATE TABLE IF NOT EXISTS adjustment (
    fy TEXT NOT NULL,
    code TEXT NOT NULL,           -- 条件のコード 例: 夜間
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    factor REAL NOT NULL,         -- 掛ける係数 例: 1.5
    bukake_code TEXT NOT NULL DEFAULT '',  -- 空欄はすべての歩掛に効く
    PRIMARY KEY (fy, code, target, bukake_code)
);

-- 工事に付ける条件（工事全体）
CREATE TABLE IF NOT EXISTS project_condition (
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    PRIMARY KEY (project_id, code)
);

-- ③ 機械経費（損料表から運転1日あたりの単価を作る）
CREATE TABLE IF NOT EXISTS machine_cost (
    fy TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    hours REAL NOT NULL,            -- 1日の運転時間
    loss_per_hour REAL NOT NULL,    -- 運転1時間あたり損料（換算値）
    fuel_per_hour REAL NOT NULL DEFAULT 0,   -- 燃料消費量（L/h）
    fuel_code TEXT NOT NULL DEFAULT '',      -- 燃料の材料コード
    operator_code TEXT NOT NULL DEFAULT '',  -- 運転手の労務コード
    operators REAL NOT NULL DEFAULT 0,       -- 運転手の人数
    misc_rate REAL NOT NULL DEFAULT 0,       -- 諸雑費率（%）
    PRIMARY KEY (fy, code)
);

-- ⑤ 見積単価（業者見積を比べて採用単価を決める）
CREATE TABLE IF NOT EXISTS quote (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    rule TEXT NOT NULL DEFAULT '最低',   -- 最低 / 平均 / 指定
    fixed_price REAL NOT NULL DEFAULT 0, -- rule=指定 のときの単価
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS quote_offer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL REFERENCES quote(code) ON DELETE CASCADE,
    vendor TEXT NOT NULL,
    price REAL NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL DEFAULT ''        -- 見積書ファイルの場所
);

-- ⑥ 単価の改定（適用日から新しい単価に切り替える）
CREATE TABLE IF NOT EXISTS price_revision (
    fy TEXT NOT NULL,
    kind TEXT NOT NULL,
    code TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    valid_from TEXT NOT NULL,            -- YYYY-MM-DD
    price REAL NOT NULL,
    PRIMARY KEY (fy, kind, code, region, valid_from)
);

-- ⑦ 落札結果
CREATE TABLE IF NOT EXISTS award (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL DEFAULT '',
    orderer TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    work_type TEXT NOT NULL DEFAULT '',
    planned REAL NOT NULL DEFAULT 0,       -- 予定価格（税抜）
    threshold REAL NOT NULL DEFAULT 0,     -- 最低制限・調査基準価格
    award_price REAL NOT NULL DEFAULT 0,   -- 落札額
    winner TEXT NOT NULL DEFAULT '',
    our_bid REAL NOT NULL DEFAULT 0,       -- 自社の入札額
    our_estimate REAL NOT NULL DEFAULT 0,  -- 自社の積算（工事価格）
    note TEXT NOT NULL DEFAULT ''
);

-- ⑧ 発注者ごとのルール（年度のルールより優先）
CREATE TABLE IF NOT EXISTS orderer_rule (
    orderer TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (orderer, key)
);

-- ⑩ 変更履歴
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    user TEXT NOT NULL,
    project_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);

-- 県の単価資料に載っている品目（単価が○＝物価資料、空欄のものも含めて控える）
CREATE TABLE IF NOT EXISTS public_item (
    fy TEXT NOT NULL,
    kind TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,          -- 県単価 / 物価資料 / 未設定
    price REAL,
    ref TEXT NOT NULL DEFAULT '',  -- 刊行物の掲載元
    file TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (fy, code, region)
);

-- ③ 利用者と権限（空なら全員が管理者として動く）
CREATE TABLE IF NOT EXISTS app_user (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL            -- 管理者 / 確認 / 積算 / 閲覧
);

-- ④ 入札スケジュールと提出物
CREATE TABLE IF NOT EXISTS project_schedule (
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,           -- 公告日 / 質問締切 / 回答日 / 入札締切 / 開札日 / 工期開始 / 工期終了
    date TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS project_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
);

-- ⑤ 数量計算書（明細ごとの計算式）
CREATE TABLE IF NOT EXISTS qty_calc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES project_item(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',  -- 場所・測点など
    expr TEXT NOT NULL,              -- 例: 10.5×2.0×0.3
    value REAL NOT NULL
);

-- ⑥ 質疑書
CREATE TABLE IF NOT EXISTS inquiry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    place TEXT NOT NULL DEFAULT '',  -- 該当箇所
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ⑧ 出来高（部分払い）
CREATE TABLE IF NOT EXISTS progress (
    project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    period TEXT NOT NULL,            -- 例: 第1回（2027-01）
    item_id INTEGER NOT NULL REFERENCES project_item(id) ON DELETE CASCADE,
    qty REAL NOT NULL,               -- その回までの累計出来高数量
    PRIMARY KEY (project_id, period, item_id)
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
    _add_column(conn, "project_item", "conditions", "TEXT NOT NULL DEFAULT ''")  # この行だけの補正（読点区切り）
    _add_column(conn, "project", "parent_id", "INTEGER")                     # 設計変更の元の工事
    _add_column(conn, "project", "change_no", "INTEGER NOT NULL DEFAULT 0")  # 0=当初, 1=第1回変更…
    _add_column(conn, "project", "orderer", "TEXT NOT NULL DEFAULT ''")      # 発注者
    _add_column(conn, "project", "price_date", "TEXT NOT NULL DEFAULT ''")   # 単価の適用日（空欄=年度の単価）
    _add_column(conn, "project", "status", "TEXT NOT NULL DEFAULT '作成中'")  # 作成中 / 確認済 / 提出済
    _add_column(conn, "project", "created_by", "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "project", "checked_by", "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "project", "checked_at", "TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "project", "contract_price", "REAL NOT NULL DEFAULT 0")  # 契約額（税抜）
    conn.commit()
