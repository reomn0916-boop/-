"""建設廃棄物の受入価格：処分場を選ぶと単価表・明細に入る。損料算定表は機械の単価になる。"""
from pathlib import Path

import pytest

from sekisan import calc, db, disposal, importer, publicprice

SAMPLE = Path(__file__).resolve().parent.parent / "sample"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    return c


def _doc(price_far=3000, price_near=3500):
    d = disposal.Doc("2026-10-01", "2027-03-31")
    d.rows = [disposal.Row("木くず", "昼間", "0001", "遠い処分場(株)", "十津川村", 33.97, 135.84, "0746-00-0000", "中間",
                           "根", price_far, "円/m3"),
              disposal.Row("木くず", "昼間", "0002", "近い処分場(株)", "奈良市", 34.69, 135.81, "0742-00-0000", "中間",
                           "根", price_near, "円/m3", note="※4t車")]
    return d


def test_choose_site_and_price(conn):
    assert disposal.import_doc(conn, _doc(), "test.pdf") == 2
    pid = conn.execute("INSERT INTO project(name, fy, region) VALUES ('試験', 'R8', '')").lastrowid
    conn.commit()
    disposal.set_site(conn, pid, *disposal.parse_latlon("34.6851, 135.8048"))
    p = conn.execute("SELECT site_lat, site_lon FROM project WHERE id=?", (pid,)).fetchone()
    sites = disposal.search(conn, "木くず", "根", "昼間", p["site_lat"], p["site_lon"])
    assert [s.no for s in sites] == ["0001", "0002"]          # 安い順
    assert sites[1].km < 2 < sites[0].km                       # 距離も出る
    code = disposal.code_of("木くず", "根")
    item = calc.add_item(conn, pid, "処分費", "木くず 根", "m3", 10, code=code)
    r = calc.calculate(conn, pid)
    assert r.items[0].how == "未設定" and any("処分場が選ばれていません" in w for w in r.warnings)
    disposal.choose(conn, pid, "木くず", "根", "0002")
    r = calc.calculate(conn, pid)
    assert (r.items[0].how, r.items[0].unit_price, r.items[0].amount) == ("受入価格", 3500, 35000)
    assert item and disposal.chosen(conn, pid)[0]["site"].company == "近い処分場(株)"
    # 訂正後の資料を取り込み直すと、同じ適用日の分は入れ替わる
    disposal.import_doc(conn, _doc(price_near=3300))
    assert calc.calculate(conn, pid).items[0].unit_price == 3300


def test_latlon_and_candidates(conn):
    assert disposal.parse_latlon("135.8048, 34.6851") == (34.6851, 135.8048)
    assert disposal.parse_latlon("なし") == (None, None)
    disposal.import_doc(conn, _doc())
    assert disposal.candidates(conn)[0].startswith("処分:木くず/根")


def test_loss_pdf(tmp_path):
    """損料算定表の形（機械損料一覧）を読む。"""
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    path = tmp_path / "r808nara_depreciation.pdf"
    c = canvas.Canvas(str(path), pagesize=landscape(A4))
    c.setFont("HeiseiKakuGo-W5", 12)
    c.drawString(60, 500, "建設機械等損料算定表 土木工事設計単価資料")
    c.drawString(60, 470, "（令和８年８月１日より適用）")
    c.showPage()
    h = 595
    c.setFont("HeiseiKakuGo-W5", 9)
    c.drawString(54, h - 60, "機械損料一覧（令和８年８月改定）")
    for x, t in ((196, "名称"), (326, "規格"), (405, "重量"), (445, "価格"), (485, "年数"), (685, "単位"),
                 (716, "(13)"), (758, "(15)")):
        c.drawString(x, h - 95, t)
    for y, row in ((h - 125, ("M007000230", "流速計", "ﾌﾟﾗｲｽ電気式", "0.01", "280,000", "5.5", "供用日", "515", "0")),
                   (h - 140, ("M007000180", "ﾊﾟﾄﾛｰﾙｶｰ 4×4D", "普通", "1.9", "4,420,000", "10", "時間", "2,020", "4,920"))):
        code, name, spec, wt, base, yrs, unit, per, day = row
        for x, t in ((62, "1"), (76, code), (140, name), (272, spec), (412, wt), (437, base), (492, yrs), (687, unit),
                     (720, per), (762, day)):
            c.drawString(x, y, t)
    c.showPage()
    c.save()
    assert publicprice.is_loss_pdf(path) and publicprice.effective_date(path) == "2026-08-01"
    rows = {r.code: r for r in publicprice.parse(path)}
    assert (rows["M007000230"].unit, rows["M007000230"].price) == ("供用日", 515)
    assert (rows["M007000180"].name, rows["M007000180"].spec, rows["M007000180"].unit, rows["M007000180"].price) == \
        ("ﾊﾟﾄﾛｰﾙｶｰ 4×4D", "普通", "時間", 2020)
