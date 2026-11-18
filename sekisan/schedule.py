"""④ 入札スケジュールと提出物のチェックリスト。"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from . import audit

KINDS = ("公告日", "質問締切", "回答日", "入札締切", "開札日", "工期開始", "工期終了")
DEFAULT_CHECKLIST = ("入札書", "工事費内訳書", "技術資料（総合評価の場合）", "配置予定技術者の資料", "質疑書（必要なら）",
                     "低入札価格調査の資料（基準価格を下回る場合）")


def get(conn: sqlite3.Connection, project_id: int) -> dict[str, str]:
    return {r["kind"]: r["date"] for r in conn.execute(
        "SELECT kind, date FROM project_schedule WHERE project_id=?", (project_id,))}


def set_dates(conn: sqlite3.Connection, project_id: int, dates: dict[str, str]) -> None:
    audit.require(conn, "edit")
    with conn:
        for k, v in dates.items():
            if k not in KINDS:
                raise ValueError(f"日程の種類は {KINDS} のどれかです")
            if v:
                date.fromisoformat(v)  # 形がおかしければ止める
                conn.execute("INSERT OR REPLACE INTO project_schedule(project_id, kind, date) VALUES (?,?,?)",
                             (project_id, k, v))
            else:
                conn.execute("DELETE FROM project_schedule WHERE project_id=? AND kind=?", (project_id, k))
        audit.log(conn, project_id, "日程", "、".join(f"{k}={v or '（なし）'}" for k, v in dates.items()))


def checklist(conn: sqlite3.Connection, project_id: int, create: bool = True) -> list[sqlite3.Row]:
    rows = list(conn.execute("SELECT * FROM project_checklist WHERE project_id=? ORDER BY id", (project_id,)))
    if not rows and create:
        with conn:
            conn.executemany("INSERT INTO project_checklist(project_id, item) VALUES (?,?)",
                             [(project_id, i) for i in DEFAULT_CHECKLIST])
        rows = list(conn.execute("SELECT * FROM project_checklist WHERE project_id=? ORDER BY id", (project_id,)))
    return rows


def add_check(conn: sqlite3.Connection, project_id: int, item: str) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("INSERT INTO project_checklist(project_id, item) VALUES (?,?)", (project_id, item))


def set_done(conn: sqlite3.Connection, check_id: int, done: bool) -> None:
    audit.require(conn, "edit")
    with conn:
        r = conn.execute("SELECT * FROM project_checklist WHERE id=?", (check_id,)).fetchone()
        conn.execute("UPDATE project_checklist SET done=? WHERE id=?", (1 if done else 0, check_id))
        if r:
            audit.log(conn, r["project_id"], "提出物", f"{r['item']}：{'済' if done else '未'}")


def delete_check(conn: sqlite3.Connection, check_id: int) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("DELETE FROM project_checklist WHERE id=?", (check_id,))


@dataclass
class Deadline:
    project_id: int
    project: str
    kind: str
    date: str
    days: int          # 今日から何日後か（過ぎていればマイナス）
    open_items: int    # 未提出の提出物の数


def upcoming(conn: sqlite3.Connection, today: date | None = None, within: int = 30,
             include_past: int = 3) -> list[Deadline]:
    """近い締切（工期以外）を日付順に。少し前に過ぎたものも出す。"""
    today = today or date.today()
    out = []
    for r in conn.execute(
            "SELECT s.project_id, s.kind, s.date, p.name FROM project_schedule s JOIN project p ON p.id=s.project_id "
            "WHERE s.kind NOT IN ('工期開始','工期終了') AND s.date<>''"):
        d = (date.fromisoformat(r["date"]) - today).days
        if -include_past <= d <= within:
            n = conn.execute("SELECT COUNT(*) FROM project_checklist WHERE project_id=? AND done=0",
                             (r["project_id"],)).fetchone()[0]
            out.append(Deadline(r["project_id"], r["name"], r["kind"], r["date"], d, n))
    return sorted(out, key=lambda x: (x.date, x.kind))
