"""⑩ 変更履歴・ダブルチェック・提出後のロック。"""
from __future__ import annotations

import getpass
import sqlite3

from . import settings

STATUSES = ("作成中", "確認済", "提出済")

# ③ 権限。利用者を1人も登録していないあいだは、全員が管理者として動く。
ROLES = ("管理者", "確認", "積算", "閲覧")
PERMS = {
    "管理者": {"edit", "check", "master", "admin"},
    "確認": {"edit", "check"},
    "積算": {"edit"},
    "閲覧": set(),
}
PERM_LABEL = {"edit": "積算の変更", "check": "確認・提出", "master": "マスタの変更", "admin": "管理（ロック解除・利用者）"}


class Locked(Exception):
    """提出済み（ロック中）の工事を変えようとした。"""


def current_user() -> str:
    name = settings.load().get("user_name", "").strip()
    if name:
        return name
    try:
        return getpass.getuser()
    except Exception:  # 取れない環境もある
        return "不明"


def role(conn: sqlite3.Connection, user: str | None = None) -> str:
    if conn.execute("SELECT COUNT(*) FROM app_user").fetchone()[0] == 0:
        return "管理者"
    r = conn.execute("SELECT role FROM app_user WHERE name=?", (user or current_user(),)).fetchone()
    return r["role"] if r else "閲覧"


def can(conn: sqlite3.Connection, perm: str) -> bool:
    return perm in PERMS.get(role(conn), set())


def require(conn: sqlite3.Connection, perm: str) -> None:
    if not can(conn, perm):
        raise PermissionError(f"{current_user()}（{role(conn)}）には「{PERM_LABEL[perm]}」の権限がありません。"
                              "管理者に頼んでください。")


def users(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(conn.execute("SELECT * FROM app_user ORDER BY name"))


def set_user(conn: sqlite3.Connection, name: str, user_role: str) -> None:
    if user_role not in ROLES:
        raise ValueError(f"役割は {ROLES} のどれかです")
    if not name.strip():
        raise ValueError("名前を入れてください")
    empty = conn.execute("SELECT COUNT(*) FROM app_user").fetchone()[0] == 0
    if empty and user_role != "管理者":
        raise ValueError("最初の1人は管理者にしてください（登録すると、登録していない人は閲覧だけになります）")
    if not empty:
        require(conn, "admin")
        if _would_remove_last_admin(conn, name, user_role):
            raise ValueError("管理者が1人もいなくなります")
    with conn:
        conn.execute("INSERT OR REPLACE INTO app_user(name, role) VALUES (?,?)", (name.strip(), user_role))
        log(conn, None, "利用者の設定", f"{name}={user_role}")


def delete_user(conn: sqlite3.Connection, name: str) -> None:
    require(conn, "admin")
    if _would_remove_last_admin(conn, name, None):
        raise ValueError("管理者が1人もいなくなります")
    with conn:
        conn.execute("DELETE FROM app_user WHERE name=?", (name,))
        log(conn, None, "利用者を削除", name)


def _would_remove_last_admin(conn: sqlite3.Connection, name: str, new_role: str | None) -> bool:
    admins = [r["name"] for r in conn.execute("SELECT name FROM app_user WHERE role='管理者'")]
    return admins == [name] and new_role != "管理者"


def log(conn: sqlite3.Connection, project_id: int | None, action: str, detail: str = "") -> None:
    conn.execute("INSERT INTO audit_log(user, project_id, action, detail) VALUES (?,?,?,?)",
                 (current_user(), project_id, action, detail))


def project_of_item(conn: sqlite3.Connection, item_id: int) -> int | None:
    r = conn.execute("SELECT project_id FROM project_item WHERE id=?", (item_id,)).fetchone()
    return r["project_id"] if r else None


def require_editable(conn: sqlite3.Connection, project_id: int | None) -> None:
    require(conn, "edit")
    if project_id is None:
        return
    r = conn.execute("SELECT status FROM project WHERE id=?", (project_id,)).fetchone()
    if r and r["status"] == "提出済":
        raise Locked("提出済みの工事はロックされています。直す場合はロックを解除してください（理由が記録されます）。")


def history(conn: sqlite3.Connection, project_id: int | None = None, limit: int = 500) -> list[sqlite3.Row]:
    if project_id is None:
        return list(conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)))
    return list(conn.execute("SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?",
                             (project_id, limit)))


def mark_checked(conn: sqlite3.Connection, project_id: int, allow_self: bool = False) -> None:
    """ダブルチェック：作った人とは別の人が「確認済」にする。"""
    require(conn, "check")
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    user = current_user()
    if p["status"] == "提出済":
        raise Locked("提出済みの工事です。")
    if not allow_self and p["created_by"] and p["created_by"] == user:
        raise PermissionError(f"作成者（{user}）以外の人が確認してください。")
    with conn:
        conn.execute("UPDATE project SET status='確認済', checked_by=?, checked_at=datetime('now','localtime')"
                     " WHERE id=?", (user, project_id))
        log(conn, project_id, "確認済にした")


def submit(conn: sqlite3.Connection, project_id: int) -> None:
    require(conn, "check")
    p = conn.execute("SELECT status FROM project WHERE id=?", (project_id,)).fetchone()
    if p["status"] != "確認済":
        raise PermissionError("確認済みになっていない工事は提出（ロック）できません。")
    with conn:
        conn.execute("UPDATE project SET status='提出済' WHERE id=?", (project_id,))
        log(conn, project_id, "提出済にした（ロック）")


def unlock(conn: sqlite3.Connection, project_id: int, reason: str) -> None:
    require(conn, "admin")
    if not reason.strip():
        raise ValueError("ロックを解除する理由を入れてください。")
    with conn:
        conn.execute("UPDATE project SET status='作成中', checked_by='', checked_at='' WHERE id=?", (project_id,))
        log(conn, project_id, "ロックを解除", reason)


def touch(conn: sqlite3.Connection, project_id: int | None) -> None:
    """中身が変わったら確認をやり直す（確認済 → 作成中）。"""
    if project_id is None:
        return
    conn.execute("UPDATE project SET status='作成中', checked_by='', checked_at='' "
                 "WHERE id=? AND status='確認済'", (project_id,))
