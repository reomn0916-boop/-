"""入札公告・入札説明書から条件を抜き出して工事に入れる。"""
from pathlib import Path

import pytest

from sekisan import db, importer, koukoku, schedule, submission

SAMPLE = Path(__file__).resolve().parent.parent / "sample"
TEXT = """入札公告
令和８年１１月２０日
奈良県知事
次のとおり条件付一般競争入札（電子入札）に付します。
１ 工事概要
（１）工事番号 第 1-工-2 号
（２）工事名 南部中核拠点 クビアカツヤカミキリ防除対策工事
（３）工事場所 五條市阪合部新田町他
（４）工期 契約締結の日から令和９年３月１９日まで
（５）予定価格 ５，８３０，０００円（消費税及び地方消費税相当額を含まない。）
（６）最低制限価格 設定する（事後公表）
２ 競争参加資格
奈良県の建設工事入札参加資格のうち、とび・土工・コンクリート工事のＣ等級に格付けされている者
３ 日程
（１）質問書の受付期間 令和８年１１月２０日から令和８年１１月２７日午後５時まで
（２）質問に対する回答日 令和８年１２月１日
（３）入札書の受付期間 令和８年１２月３日から令和８年１２月８日正午まで
（４）開札日時 令和８年１２月９日 午前１０時
４ 提出書類
入札書と同時に工事費内訳書を提出すること。
"""


def test_parse_text():
    nt = koukoku.parse_text(TEXT)
    got = {f.key: f.value for f in nt.items}
    assert got["工事名"] == "南部中核拠点 クビアカツヤカミキリ防除対策工事"
    assert got["工事番号"] == "第 1-工-2 号" and got["工事場所"] == "五條市阪合部新田町他"
    assert got["工期終了"] == "2027-03-19" and got["公告日"] == "2026-11-20"
    assert (got["質問締切"], got["回答日"], got["入札締切"], got["開札日"]) == \
        ("2026-11-27", "2026-12-01", "2026-12-08", "2026-12-09")
    assert got["予定価格（税抜）"] == "5830000" and got["最低制限価格"] == "設定あり（事後公表）"
    assert got["参加資格"] == "とび・土工・コンクリート工事 C等級"
    assert "条件付一般競争入札" in got["入札方式"] and "電子入札" in got["入札方式"]
    assert "工事費内訳書" in got["提出書類"] and "内訳書、" not in got["提出書類"]


def test_apply_to_project(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    conn = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(conn, "R8", SAMPLE / "master" / "R8")
    pid = importer.create_project(conn, "試験", "R8", importer.parse_design_csv(SAMPLE / "設計書.csv"))
    p = tmp_path / "koukoku.txt"
    p.write_text(TEXT, encoding="cp932")
    nt = koukoku.parse(p)
    done = koukoku.apply(conn, pid, nt)
    assert schedule.get(conn, pid)["開札日"] == "2026-12-09"
    pr = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    assert (pr["published_basis"], pr["published_amount"]) == ("予定価格（税抜）", 5830000)
    assert submission.saved_info(pr)["工事番号"] == "第 1-工-2 号"
    assert any("工事費内訳書" in r["item"] for r in schedule.checklist(conn, pid))
    assert len(done) >= 4
    # 選んだ項目だけ入れる
    pid2 = importer.create_project(conn, "試験2", "R8", [])
    koukoku.apply(conn, pid2, nt, {"開札日"})
    assert schedule.get(conn, pid2) == {"開札日": "2026-12-09"}
    assert conn.execute("SELECT published_amount FROM project WHERE id=?", (pid2,)).fetchone()[0] == 0
