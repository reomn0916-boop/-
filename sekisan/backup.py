"""⑩ バックアップと復元。データファイルを日付つきで別の場所に保存し、壊れたときに戻せるようにする。"""
from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

PREFIX = "積算データ_"


def default_dir(db_path: str | Path) -> Path:
    return Path(db_path).parent / "バックアップ"


def integrity(db_path: str | Path) -> str:
    """'ok' なら正常。"""
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        conn.close()


def make(db_path: str | Path, dest: str | Path | None = None, keep: int = 30) -> Path:
    """使っている最中でも安全に写せる SQLite のバックアップ機能で保存し、古いものは keep 個を残して消す。"""
    db_path = Path(db_path)
    dest = Path(dest) if dest else default_dir(db_path)
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"{PREFIX}{datetime.now():%Y%m%d_%H%M%S}.sqlite"
    src = sqlite3.connect(str(db_path), timeout=30)
    dst = sqlite3.connect(str(out))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for old in list_backups(dest)[keep:]:
        old.unlink(missing_ok=True)
    return out


def list_backups(dest: str | Path) -> list[Path]:
    d = Path(dest)
    return sorted(d.glob(f"{PREFIX}*.sqlite"), reverse=True) if d.exists() else []


def due(dest: str | Path, hours: float = 24) -> bool:
    b = list_backups(dest)
    if not b:
        return True
    return datetime.now() - datetime.fromtimestamp(b[0].stat().st_mtime) > timedelta(hours=hours)


def auto(db_path: str | Path, dest: str | Path | None = None, hours: float = 24) -> Path | None:
    """前回から hours 時間たっていればバックアップする（起動時に呼ぶ）。"""
    dest = Path(dest) if dest else default_dir(db_path)
    if Path(db_path).exists() and due(dest, hours):
        return make(db_path, dest)
    return None


def restore(backup_file: str | Path, db_path: str | Path) -> Path:
    """バックアップから戻す。戻す前の状態も「復元前_」として残す。"""
    backup_file, db_path = Path(backup_file), Path(db_path)
    if integrity(backup_file) != "ok":
        raise ValueError("このバックアップは壊れているため戻せません")
    safety = db_path.with_name(f"復元前_{datetime.now():%Y%m%d_%H%M%S}_{db_path.name}")
    if db_path.exists():
        shutil.copy2(db_path, safety)
    src = sqlite3.connect(str(backup_file))
    dst = sqlite3.connect(str(db_path), timeout=30)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return safety
