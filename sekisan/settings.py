"""各パソコンの設定（データファイルの場所など）。%APPDATA%\\積算アプリ\\settings.json に保存する。"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "積算アプリ"


def load() -> dict:
    p = _dir() / "settings.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return {}


def save(data: dict) -> None:
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "settings.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def db_path() -> Path:
    """共有フォルダ上のデータファイル。未設定ならこのパソコン内に作る。"""
    s = load().get("db_path")
    return Path(s) if s else _dir() / "積算データ.sqlite"
