"""公表額（予定価格・最低制限価格）から直接工事費と内訳を逆算する。"""
from pathlib import Path

import pytest

from sekisan import calc, db, importer, reverse

SAMPLE = Path(__file__).resolve().parent.parent / "sample"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    return c


def _project(conn):
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    return importer.create_project(conn, "試験", "R8", items, "", "道路改良（ダミー）")


def test_reverse_from_planned_price(conn):
    pid = _project(conn)
    s = calc.calculate(conn, pid).summary
    assert s.direct > 0 and s.price > 0
    # 自社積算そのものの予定価格から逆算すると、自社積算の直接工事費を含む範囲が出て、差はほぼ0
    r = reverse.solve(conn, pid, s.price)
    assert r.exact and r.direct_low <= s.direct <= r.direct_high
    assert r.implied.price == s.price and abs(r.gap) <= (r.direct_high - r.direct_low)
    # 公表された予定価格が1割高いと、直接工事費も高く出て、最低制限価格の見込みも上がる
    r2 = reverse.solve(conn, pid, s.price * 11 // 10 // 1000 * 1000)
    assert r2.exact and r2.gap > 0 and r2.implied.threshold > s.threshold
    # 税込から・最低制限価格からも
    assert reverse.solve(conn, pid, r2.implied.total, "予定価格（税込）").implied.price == r2.implied.price
    r3 = reverse.solve(conn, pid, r2.implied.threshold, "最低制限価格（税抜）")
    assert r3.implied.threshold == r2.implied.threshold
    with pytest.raises(ValueError):
        reverse.solve(conn, pid, 0)
    reverse.save(conn, pid, "予定価格（税抜）", s.price)
    assert conn.execute("SELECT published_amount FROM project WHERE id=?", (pid,)).fetchone()[0] == s.price
