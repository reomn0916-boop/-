"""ソフトの自動更新：最新版の確認・取得（共有フォルダにも置く）・展開・入れ替え役の用意。"""
import functools
import http.server
import json
import threading
import zipfile

import pytest

from sekisan import updater


@pytest.fixture
def site(tmp_path):
    root = tmp_path / "site"
    root.mkdir()
    z = root / updater.ZIP_NAME
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("積算アプリ/積算アプリ.exe", b"MZ new")
        f.writestr("積算アプリ/_internal/a.txt", "x")
        f.writestr("積算アプリ/見本データ/b.csv", "y")
    (root / updater.INFO_NAME).write_text(json.dumps({"version": "2026.12.01.0900-abcdef1", "commit": "abcdef1",
                                                      "notes": ["施工パッケージを追加", "諸経費率を正式な式に"]},
                                                     ensure_ascii=False), encoding="utf-8")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/"
    srv.shutdown()


def test_check_download_extract(site, tmp_path):
    shared = tmp_path / "共有" / "更新"
    rel, errors = updater.check(site, shared)
    assert rel and rel.source == "GitHub" and rel.version.startswith("2026.12.01") and not errors
    assert rel.newer_than("2026.11.21.1500-1234567") and not rel.newer_than("2026.12.01.0900-abcdef1")
    assert not rel.newer_than("開発版")
    zp = updater.download(rel, tmp_path / "dl", shared=shared)
    assert zipfile.is_zipfile(zp)
    # ほかのパソコン用に共有フォルダにも置いた → 次からは共有フォルダが使われる（同じ版なら社内のほう）
    assert (shared / updater.ZIP_NAME).exists() and json.loads((shared / updater.INFO_NAME).read_text("utf-8"))["version"] == rel.version
    rel2, _ = updater.check(site, shared)
    assert rel2.source == "共有フォルダ"
    src = updater.extract(zp, tmp_path / "new")
    assert (src / "積算アプリ.exe").read_bytes() == b"MZ new" and (src / "見本データ" / "b.csv").exists()


def test_github_down_uses_shared(tmp_path):
    shared = tmp_path / "更新"
    shared.mkdir()
    with zipfile.ZipFile(shared / updater.ZIP_NAME, "w") as f:
        f.writestr("積算アプリ/積算アプリ.exe", b"MZ")
    (shared / updater.INFO_NAME).write_text(json.dumps({"version": "2026.12.02.0000-1111111"}), encoding="utf-8")
    rel, errors = updater.check("http://127.0.0.1:9/", shared)
    assert rel.source == "共有フォルダ" and errors


def test_bad_zip_and_script(tmp_path):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as f:
        f.writestr("../evil.exe", b"x")
    with pytest.raises(ValueError):
        updater.extract(bad, tmp_path / "x")
    with pytest.raises(RuntimeError):
        updater.apply(bad)   # 開発用（Python）では入れ替えない


def test_finish_copies_over_and_records(tmp_path, monkeypatch):
    """新しい版（一時フォルダ）が古いフォルダにかぶせる。結果は次に起動したときに読める。"""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    new = tmp_path / "new" / "積算アプリ"
    (new / "_internal").mkdir(parents=True)
    (new / "積算アプリ.exe").write_bytes(b"MZ new")
    (new / "_internal" / "lib.dll").write_bytes(b"new lib")
    old = tmp_path / "old" / "積算アプリ"
    (old / "_internal").mkdir(parents=True)
    (old / "積算アプリ.exe").write_bytes(b"MZ old")
    (old / "_internal" / "lib.dll").write_bytes(b"old lib")
    (old / "見本データ").mkdir()
    monkeypatch.setattr(updater, "install_dir", lambda: new)
    monkeypatch.setattr(updater, "current_version", lambda: "2026.12.01.0900-abcdef1")
    assert updater.finish(str(old), 0, restart=False) == 0
    assert (old / "積算アプリ.exe").read_bytes() == b"MZ new" and (old / "_internal" / "lib.dll").read_bytes() == b"new lib"
    assert (old / "見本データ").exists()
    assert updater.last_result() == {"done": "2026.12.01.0900-abcdef1"} and updater.last_result() == {}
    assert "入れ替え完了" in updater.log_path().read_text("utf-8")
    # 置き換えられなかったとき（フォルダがない場所など）は失敗を記録する
    monkeypatch.setattr(updater, "_copy_over", lambda s, d: (_ for _ in ()).throw(OSError("つかまれています")))
    assert updater.finish(str(old), 0, restart=False) == 1
    assert "つかまれています" in updater.last_result()["failed"]


def test_main_routes_finish_and_selftest(monkeypatch):
    from sekisan import __main__ as m
    called = {}
    monkeypatch.setattr(updater, "finish", lambda d, p, restart=True: called.setdefault("finish", (d, p, restart)) and 0)
    m.main(["--finish-update", "C:/x", "123", "--no-restart"])
    assert called["finish"] == ("C:/x", 123, False)
