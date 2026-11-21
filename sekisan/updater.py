"""ソフトの自動更新：新しい版をGitHubの「最新版」（または共有フォルダ）から取ってきて、入れ替えて起動し直す。

- 新しい版は、変更をGitHubに上げるたびにビルドして「最新版」として公開される（sekisan-windows.zip と version.json）。
- 取ってきた版は共有フォルダ（データファイルと同じ場所の「更新」フォルダ）にも置くので、ほかのパソコンはそこから更新できる。
- 入れ替えはソフトを閉じてから行う（使っている最中のファイルは置き換えられないため）。データファイル・設定はそのまま。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

REPO = "reomn0916-boop/-"
RELEASE_BASE = f"https://github.com/{REPO}/releases/download/latest/"
ZIP_NAME = "sekisan-windows.zip"
INFO_NAME = "version.json"
EXE_NAME = "積算アプリ.exe"


def current_version() -> str:
    try:
        from ._version import VERSION
        return VERSION
    except ImportError:
        return "開発版"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def install_dir() -> Path:
    return Path(sys.executable).parent


@dataclass
class Release:
    version: str
    commit: str = ""
    built_at: str = ""
    notes: list[str] = field(default_factory=list)
    source: str = ""      # GitHub / 共有フォルダ
    zip_url: str = ""     # GitHub の zip、または共有フォルダの zip のパス

    def newer_than(self, version: str) -> bool:
        """版の番号は「年.月.日.時分-コミット」なので、文字の並びで新しさを比べられる。開発版は更新しない。"""
        if version == "開発版":
            return False
        return self.version.split("-")[0] > version.split("-")[0]


def _get(url: str, timeout: float = 30) -> bytes:
    from .autofetch import USER_AGENT
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _release_of(info: dict, source: str, zip_url: str) -> Release:
    notes = info.get("notes") or []
    if isinstance(notes, str):
        notes = [notes]
    return Release(str(info.get("version", "")), info.get("commit", ""), info.get("built_at", ""), list(notes), source, zip_url)


def shared_dir() -> Path:
    from . import settings
    return Path(settings.db_path()).parent / "更新"


def check(base: str = RELEASE_BASE, shared: Path | None = None) -> tuple[Release | None, list[str]]:
    """いちばん新しい版（GitHub と共有フォルダの新しいほう）と、うまくいかなかったことの説明。"""
    found: list[Release] = []
    errors: list[str] = []
    try:
        info = json.loads(_get(base + INFO_NAME).decode("utf-8-sig"))
        found.append(_release_of(info, "GitHub", base + ZIP_NAME))
    except Exception as e:   # noqa: BLE001 - ネットにつながらないときなど
        errors.append(f"GitHub：{e}")
    sd = shared if shared is not None else shared_dir()
    try:
        if (sd / INFO_NAME).exists() and (sd / ZIP_NAME).exists():
            info = json.loads((sd / INFO_NAME).read_text(encoding="utf-8-sig"))
            found.append(_release_of(info, "共有フォルダ", str(sd / ZIP_NAME)))
    except Exception as e:   # noqa: BLE001
        errors.append(f"共有フォルダ：{e}")
    if not found:
        return None, errors
    # 同じ版なら共有フォルダ（社内なので速い）を使う
    best = max(found, key=lambda r: (r.version.split("-")[0], r.source == "共有フォルダ"))
    return best, errors


def download(rel: Release, dest_dir: Path, progress=None, shared: Path | None = None) -> Path:
    """zip を手元に取ってくる。GitHub から取ったときは共有フォルダにも置く（ほかのパソコン用）。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / ZIP_NAME
    if rel.source == "共有フォルダ":
        shutil.copyfile(rel.zip_url, path)
    else:
        from .autofetch import USER_AGENT
        req = urllib.request.Request(rel.zip_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if progress:
                    progress(got, total)
        sd = shared if shared is not None else shared_dir()
        try:   # 共有フォルダに置けなくても（権限がないなど）、このパソコンの更新は続ける
            sd.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, sd / (ZIP_NAME + ".tmp"))
            os.replace(sd / (ZIP_NAME + ".tmp"), sd / ZIP_NAME)
            (sd / INFO_NAME).write_text(json.dumps({"version": rel.version, "commit": rel.commit, "built_at": rel.built_at,
                                                    "notes": rel.notes}, ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            pass
    if not zipfile.is_zipfile(path):
        raise ValueError("更新ファイルが壊れています（zip ではありません）")
    return path


def _entry_name(info: zipfile.ZipInfo) -> str:
    """zip の中の日本語のファイル名（UTF-8 の印がない zip でも読めるように）"""
    name = info.filename
    if not info.flag_bits & 0x800:
        try:
            name = name.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return name


def extract(zip_path: Path, dest: Path) -> Path:
    """zip を展開し、積算アプリ.exe のあるフォルダを返す。"""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = _entry_name(info).replace("\\", "/")
            if name.startswith("/") or ".." in Path(name).parts:
                raise ValueError(f"更新ファイルの中に不正な場所があります: {name}")
            target = dest / name
            if info.is_dir() or name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    exe = next(dest.rglob(EXE_NAME), None)
    if not exe:
        raise ValueError(f"更新ファイルの中に {EXE_NAME} がありません")
    return exe.parent


def log_path() -> Path:
    from . import settings
    return settings._dir() / "update.log"


def log(msg: str) -> None:
    """更新の記録（うまくいかなかったときに原因を見るため）"""
    from datetime import datetime
    try:
        p = log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except OSError:
        pass


def _wait_pid(pid: int, timeout: float = 60) -> None:
    """古いソフトが閉じるのを待つ（Windows）"""
    import time
    if pid <= 0:
        return
    if os.name == "nt":
        import ctypes
        SYNCHRONIZE = 0x00100000
        h = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if h:
            ctypes.windll.kernel32.WaitForSingleObject(h, int(timeout * 1000))
            ctypes.windll.kernel32.CloseHandle(h)
        time.sleep(1)
        return
    end = time.time() + timeout
    while time.time() < end:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.3)


def _copy_over(src: Path, dst: Path) -> int:
    """新しい版のファイルを古いフォルダにかぶせる。ウイルス対策などで一瞬つかまれているファイルは何度かやり直す。"""
    import time
    n = 0
    for f in src.rglob("*"):
        rel = f.relative_to(src)
        target = dst / rel
        if f.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        for k in range(20):
            try:
                shutil.copy2(f, target)
                n += 1
                break
            except OSError as e:
                if k == 19:
                    raise OSError(f"{rel} を置き換えられません：{e}") from e
                time.sleep(0.5)
    return n


def finish(dst: str, pid: int, restart: bool = True) -> int:
    """新しい版のほう（一時フォルダに展開した exe）で動く：古いソフトが閉じるのを待ち、古いフォルダにかぶせて、起動し直す。"""
    src = install_dir()
    dstp = Path(dst)
    log(f"入れ替え開始：{src} → {dstp}（古いソフト pid {pid}）")
    try:
        _wait_pid(pid)
        n = _copy_over(src, dstp)
        log(f"入れ替え完了：{n} ファイル")
    except Exception as e:   # noqa: BLE001
        log(f"入れ替え失敗：{e}")
        _save_state({"failed": str(e), "version": current_version()})
        if restart:   # 置き換えられなかったときは、古い版を起動し直す（使えないままにしない）
            _start(dstp / EXE_NAME)
        return 1
    _save_state({"done": current_version()})
    if restart:
        _start(dstp / EXE_NAME)
    return 0


def _start(exe: Path) -> None:
    import subprocess
    try:
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen([str(exe)], cwd=str(exe.parent), creationflags=flags, close_fds=True)
        log(f"起動：{exe}")
    except OSError as e:
        log(f"起動できません：{exe} {e}")


def _state_path() -> Path:
    from . import settings
    return settings._dir() / "update_state.json"


def _save_state(d: dict) -> None:
    try:
        _state_path().parent.mkdir(parents=True, exist_ok=True)
        _state_path().write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def last_result() -> dict:
    """前回の更新の結果（起動したときに知らせる）。読んだら消す。"""
    try:
        d = json.loads(_state_path().read_text(encoding="utf-8"))
        _state_path().unlink()
        return d
    except (OSError, ValueError):
        return {}


def apply(zip_path: Path) -> None:
    """展開して、新しい版の exe に入れ替えを頼む（PowerShell などは使わない）。呼んだあとはソフトを終了すること。"""
    if not is_frozen():
        raise RuntimeError("開発用（Pythonで動かしている）ときは自動で入れ替えません")
    import subprocess
    work = Path(tempfile.gettempdir()) / "積算アプリ_更新"
    src = extract(zip_path, work / "new")
    exe = src / EXE_NAME
    _save_state({"pending": current_version()})
    log(f"更新を開始：{current_version()} → 展開先 {src}")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([str(exe), "--finish-update", str(install_dir()), str(os.getpid())], cwd=str(src),
                     creationflags=flags, close_fds=True)
