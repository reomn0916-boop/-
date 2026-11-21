"""役所に出す書類：入札額に合わせた内訳書・入札書・委任状と、提出前チェック。"""
from pathlib import Path

import pytest

from sekisan import calc, db, export, importer, submission

SAMPLE = Path(__file__).resolve().parent.parent / "sample"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    return c


def _project(conn):
    return importer.create_project(conn, "試験工事", "R8", importer.parse_design_csv(SAMPLE / "設計書.csv"), "",
                                   "道路改良（ダミー）")


def _sum_ok(res: calc.Result) -> None:
    s = res.summary
    assert s.direct == sum(i.amount for i in res.items if calc.is_direct(i.category))
    assert s.net == s.direct + s.common_temp and s.cost == s.net + s.site_mgmt and s.price == s.cost + s.general


@pytest.mark.parametrize("method", submission.FITS)
def test_fit_to_bid(conn, method):
    pid = _project(conn)
    res = calc.calculate(conn, pid)
    for bid in (res.summary.price, res.summary.threshold, (res.summary.price + res.summary.threshold) // 2 // 1000 * 1000):
        fitted, _notes = submission.fit(res, bid, method)
        assert fitted.summary.price == bid and fitted.summary.general >= 0
        assert fitted.summary.total == bid + fitted.summary.tax
        _sum_ok(fitted)
        # 内訳書の行（階層つき）の工事価格も入札額
        rows = export.breakdown_rows(fitted)
        assert next(r[6] for r in rows if r[1] == "工事価格") == bid


def test_documents_and_checks(conn, tmp_path):
    pid = _project(conn)
    res = calc.calculate(conn, pid)
    pkg = submission.build(conn, pid)
    bad = {c.item for c in pkg.blocking}
    assert "入札額が入っている" in bad and "会社の情報（商号・所在地・代表者）が入っている" in bad
    submission.set_company(conn, {"商号": "株式会社テスト建設", "所在地": "奈良県奈良市登大路町1", "代表者役職": "代表取締役",
                                  "代表者氏名": "奈良 太郎"})
    bid = (res.summary.price + res.summary.threshold) // 2 // 1000 * 1000
    calc.set_bid(conn, pid, bid)
    pkg = submission.build(conn, pid, {"工事番号": "第1-工-2号", "代理人": "生駒 次郎", "提出日": "2026-11-25"})
    assert pkg.fitted.summary.price == bid
    assert not [c for c in pkg.blocking if c.item != "単価が決まっていない明細がない"]
    files = submission.write_all(pkg, tmp_path / "提出")
    names = {f.name for f in files}
    assert {"試験工事_工事費内訳書.xlsx", "試験工事_工事費内訳書.pdf", "試験工事_入札書.xlsx", "試験工事_委任状.xlsx",
            "試験工事_電子入札用内訳書.csv", "試験工事_提出前チェック.xlsx"} == names
    assert all(f.stat().st_size > 0 for f in files)
    pdf = next(f for f in files if f.suffix == ".pdf")
    assert pdf.read_bytes().startswith(b"%PDF")
    import pdfplumber
    with pdfplumber.open(str(pdf)) as d:
        text = "".join(p.extract_text() or "" for p in d.pages)
    assert f"{bid:,}" in text and "株式会社テスト建設" in text
    from openpyxl import load_workbook
    ws = load_workbook(next(f for f in files if f.name.endswith("入札書.xlsx"))).active
    digits = "".join(str(ws.cell(4, c).value or "") for c in range(3, 13))
    assert digits == f"￥{bid}" and ws.cell(4, 12).value == str(bid)[-1]
    assert "令和8年11月25日" in [str(ws.cell(r, 2).value) for r in range(1, 30)]
    csv_text = next(f for f in files if f.suffix == ".csv").read_text(encoding="cp932")
    assert f",{bid}," in csv_text


def test_wareki_and_digits():
    assert submission._wareki("2026-04-01") == "令和8年4月1日"
    assert submission._digits(12345000) == ["", "", "￥", "1", "2", "3", "4", "5", "0", "0", "0"][-10:]
