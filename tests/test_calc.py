from pathlib import Path

import pytest
from openpyxl import load_workbook

from sekisan import calc, db, importer, pipeline

SAMPLE = Path(__file__).resolve().parent.parent / "sample"
WORK = "道路改良（ダミー）"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    importer.import_company_prices(c, SAMPLE / "自社単価.csv")
    return c


@pytest.fixture
def pid(conn):
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    return importer.create_project(conn, "テスト", "R8", items, "北部", WORK)


def test_round_sig():
    assert calc.round_sig(23119.32, 4) == 23110
    assert calc.round_sig(1504, 4) == 1504
    assert calc.round_sig(4368.9, 4) == 4368
    assert calc.round_sig(0.123456, 4) == 0.1234
    assert calc.round_sig(12345, 4, "四捨五入") == 12350


def test_parse_design(conn):
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    assert [i.name for i in items] == ["掘削", "基礎砕石", "コンクリート", "基礎工", "区画線"]
    assert items[2].qty == 14.5


def test_cp932(tmp_path):
    p = tmp_path / "s.csv"
    p.write_bytes("名称,単位,数量\n掘削,m3,1,000\n".replace("1,000", '"1,000"').encode("cp932"))
    assert importer.parse_design_csv(p)[0].qty == 1000


def test_unit_prices(conn, pid):
    res = calc.calculate(conn, pid)
    by = {i.seq: i for i in res.items}
    # 掘削: (0.7×42000 + 0.3×20000) / 100
    assert by[1].unit_price == 354 and by[1].amount == 300900
    # コンクリート（北部の特殊作業員単価を使う）: (1.02×15800 + 0.1×25500 + 0.2×20000)×1.02 → 有効4桁切捨て
    assert by[3].unit_price == 23110 and by[3].amount == 335095
    # 入れ子の歩掛: 0.6×1504 + 0.15×23110 = 4368.9 → 4368
    assert by[4].unit_price == 4368
    # 市場単価
    assert by[5].unit_price == 310 and by[5].how == "単価"
    # コード無し → 未設定
    assert by[2].how == "未設定" and by[2].amount == 0
    assert res.summary.direct == 1022075


def test_mapping_is_learned(conn, pid):
    item2 = conn.execute("SELECT id FROM project_item WHERE project_id=? AND seq=2", (pid,)).fetchone()["id"]
    calc.assign_code(conn, item2, "B002")
    assert calc.calculate(conn, pid).items[1].unit_price == 1504
    # 次の工事では同じ名称・規格・単位に自動で当たる
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    pid2 = importer.create_project(conn, "次の工事", "R8", items, "北部", WORK)
    r = calc.calculate(conn, pid2).items[1]
    assert r.how == "対応表" and r.unit_price == 1504


def test_summary(conn, pid):
    s = calc.calculate(conn, pid).summary
    assert s.net == s.direct + s.common_temp
    assert s.cost == s.net + s.site_mgmt
    assert s.price == s.cost + s.general
    assert s.price % 1000 == 0
    assert s.total == s.price + s.tax
    # 共通仮設費率 = 30 × P^-0.1（P=直接工事費）
    assert s.common_temp_rate == round(30 * 1022075 ** -0.1, 2)


def test_company_mode(conn, pid):
    r = calc.calculate(conn, pid, calc.COMPANY)
    # 掘削: (0.7×30000 + 0.3×17000)/100 = 261
    assert r.items[0].unit_price == 261
    assert any(l.source == "自社" for l in r.items[0].detail.lines)


def test_fiscal_years_are_separate(conn, tmp_path, pid):
    # 別年度のマスタが無ければ単価は出ない（年度をまたいで混ざらない）
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    p9 = importer.create_project(conn, "R9工事", "R9", items, "", WORK)
    res = calc.calculate(conn, p9)
    assert res.summary.direct == 0 and res.warnings


def test_pipeline_and_verify(conn, tmp_path):
    out = tmp_path / "out"
    res = pipeline.import_and_run(conn, SAMPLE / "設計書.csv", "一括", "R8", WORK, out, "北部")
    for f in res["files"]:
        assert Path(f).exists()
    wb = load_workbook(res["files"][0])
    assert wb.sheetnames == ["工事費内訳書", "明細", "単価表"]
    ref = tmp_path / "ref.csv"
    ref.write_text("項目,金額\n1,300900\n直接工事費,1000000\n", encoding="utf-8")
    importer.import_reference(conn, res["project_id"], ref)
    checks = {c.key: c for c in pipeline.verify(conn, res["project_id"])}
    assert checks["1"].ok
    assert not checks["直接工事費"].ok and checks["直接工事費"].diff == 22075
