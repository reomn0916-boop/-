"""施工パッケージ：国交省の標準単価表を読み、金抜き設計書の施工パッケージに当て、国交省の補正式で積算単価を出す。"""
import json
from pathlib import Path

import pytest

from sekisan import calc, db, sekopkg

SAMPLE = Path(__file__).resolve().parent.parent / "sample"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    return db.connect(tmp_path / "t.sqlite")


def test_formula_matches_mlit_example(conn):
    """国交省の計算例（Ｌ型擁壁・大阪 R8.4）：標準単価 51,343 → 54,380 円/m3"""
    conn.execute("INSERT INTO package(fy, code, name, spec, unit, std_price, std_ratios) VALUES "
                 "('R8', 'P1', 'Ｌ型擁壁', '', 'm3', 51343, ?)", (json.dumps({"K": 2.53, "R": 52.27, "Z": 45.20}),))
    comps = [("機械", "K1", 1.30, 52800, 52800), ("機械", "K2", 0.38, 910, 991), ("機械", "K3", 0.31, 747, 747),
             ("労務", "R1", 19.29, 26800, 23800), ("労務", "R2", 11.73, 31700, 33400), ("労務", "R3", 4.41, 32400, 30800),
             ("労務", "R4", 1.16, 29900, 27800), ("材料", "Z1", 42.51, 21400, 25700), ("材料", "Z2", 1.90, 99.5, 99.7),
             ("材料", "Z3", 0.72, 148.0, 132.0)]
    for k, (kind, code, ratio, tokyo, local) in enumerate(comps, 1):
        conn.execute("INSERT INTO package_component(fy, package_code, seq, kind, res_code, ratio, base_price, src) "
                     "VALUES ('R8', 'P1', ?, ?, ?, ?, ?, ?)", (k, kind, code, ratio / 100, tokyo, code))
        conn.execute("INSERT INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES "
                     "('R8', ?, ?, ?, '', '', ?, '')", (kind, code, code, local))
    conn.commit()
    up = calc.Calculator(conn, "R8").package_price("P1")
    assert abs(up.subtotal - 54377.53) < 0.05 and up.price == 54380


def _std_pdf(path):
    """標準単価表の1ページ（罫線つき）"""
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    w, h = landscape(A3)
    c = canvas.Canvas(str(path), pagesize=(w, h))
    c.setFont("HeiseiKakuGo-W5", 9)
    c.drawString(60, h - 60, "No.002【 土砂等運搬 】")
    c.drawString(60, h - 72, "＜ 積算単位：ｍ３ ＞")
    c.drawString(150, h - 86, "条件区分")
    xs = [60, 130, 200, 260, 300, 330, 360, 390, 420, 450, 480, 510]
    heads = ["土砂等発生現場", "積込機種", "運搬距離", "標準単価", "K", "K1", "R", "R1", "Z", "Z1", "S"]
    for x, t in zip(xs, heads):
        c.drawString(x + 3, h - 104, t)
    rows = [("標準", "人力", "27.5km以下", "10,571", "19.09", "19.09", "72.09", "72.09", "8.82", "8.82", "-"),
            ("現場制約あり", "人力", "27.5km以下", "11,200", "19.09", "19.09", "72.09", "72.09", "8.82", "8.82", "-"),
            ("現場制約あり", "人力", "1.0km以下", "1,520", "20.00", "20.00", "70.00", "70.00", "10.00", "10.00", "-")]
    ys = [h - 110] + [h - 110 - 30 * (i + 1) for i in range(len(rows))]
    for y in ys:
        c.line(60, y, xs[-1], y)
    for x in xs:
        c.line(x, ys[0], x, ys[-1])
    for i, r in enumerate(rows):
        for x, t in zip(xs, r):
            c.drawString(x + 3, ys[i] - 18, t)
    c.showPage()
    c.save()


def test_parse_match_and_apply(conn, tmp_path):
    pdf = tmp_path / "std.pdf"
    _std_pdf(pdf)
    _fy, rows = sekopkg.parse(pdf)
    assert [(r.conds.get("土砂等発生現場"), r.conds.get("運搬距離"), r.price) for r in rows] == [
        ("標準", "27.5km以下", 10571), ("現場制約あり", "27.5km以下", 11200), ("現場制約あり", "1.0km以下", 1520)]
    assert rows[0].kind_ratio == {"K": 19.09, "R": 72.09, "Z": 8.82, "S": 0.0}
    sekopkg.import_rows(conn, "R8", rows, "std.pdf")
    conds = ["J01 土砂等発生現場 現場制約あり", "J02 積込機種･規格 人力", "J17 運搬距離（km）（DID区間無） 27.5km以下"]
    m = sekopkg.match(conn, "R8", "土砂等運搬", conds, {"K": 19.09, "R": 72.09, "Z": 8.82})
    assert m.row and m.row.price == 11200
    # 「1.0km以下」は「11.0km以下」に含まれるが、ちょうど同じ値を優先する
    m2 = sekopkg.match(conn, "R8", "土砂等運搬", ["土砂等発生現場 現場制約あり", "積込機種 人力", "運搬距離 1.0km以下"])
    assert m2.row and m2.row.price == 1520
    assert not sekopkg.match(conn, "R8", "掘削", conds).row
    # 金抜き設計書の施工パッケージ（標準単価 0）に当てる。労務の東京の基準単価も入る
    conn.execute("INSERT INTO project(name, fy) VALUES ('試験', 'R8')")
    conn.execute("INSERT INTO package(fy, code, name, spec, unit, std_price, project_id, conditions) VALUES "
                 "('R8', 'D#1/施1', '土砂等運搬', '', 'm3', 0, 1, ?)", (json.dumps(conds, ensure_ascii=False),))
    conn.execute("INSERT INTO package_component(fy, package_code, seq, kind, res_code, ratio, base_price, src) VALUES "
                 "('R8', 'D#1/施1', 1, '労務', 'R0115', 0.7209, 0, '運転手（一般）')")
    conn.execute("INSERT INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES "
                 "('R8', '労務', 'R0115', '運転手（一般）', '', '人', 24400, '')")
    conn.commit()
    res = sekopkg.apply(conn, 1)
    assert res == [("土砂等運搬", m.reason, True)]
    assert sekopkg.fill_bases(conn, 1) == 1
    assert conn.execute("SELECT base_price FROM package_component").fetchone()[0] == 25400   # 東京 令和7年3月
    up = calc.Calculator(conn, "R8").package_price("D#1/施1")
    # 11,200 × (72.09%×24,400/25,400 + 27.91%) → 有効4桁切り上げ
    assert up.price == calc.round_sig(11200 * (0.7209 * 24400 / 25400 + (1 - 0.7209)), 4, "切上げ")


def test_labor_base_bundled():
    ym, prices = sekopkg.TOKYO_LABOR["R8"]
    assert ym == "2025-03" and prices["普通作業員"] == 26800 and prices["運転手(一般)"] == 25400


def test_official_overhead_rates(conn):
    """国交省の諸経費率（奈良県も読替規定でそのまま使う）。年度マスタにない工種区分はこれで計算する。"""
    from sekisan import overhead_std
    c = calc.Calculator(conn, "R8")
    # 表に載っている下限・上限の率と同じになる
    assert c.rate("公園工事", "共通仮設費", 5_000_000) == 10.80 and c.rate("公園工事", "共通仮設費", 2e9) == 6.62
    assert c.rate("公 園 工 事", "現場管理費", 5_000_000) == 43.09
    assert c.rate("道路維持工事", "共通仮設費", 1_000_000) == 23.94      # 第3表：200万円以下
    assert c.rate("ＰＣ橋工事", "現場管理費", 2e9) == 20.80
    assert c.rate("下水道工事（２）", "共通仮設費", 5e6) == 13.32
    assert c.rate("公園工事", "一般管理費等", 4e6) == 25.13 and c.rate("公園工事", "一般管理費等", 4e9) == 10.63
    # 式：共通仮設費率 Kr = A・P^b、一般管理費等率 Gp = -5.21826 log10(Cp) + 60.08343
    assert c.rate("河川工事", "共通仮設費", 50_000_000) == round(238.6 * 50_000_000 ** -0.1888, 2)
    assert c.rate("河川工事", "一般管理費等", 80_000_000) == round(-5.21826 * 7.903089987 + 60.08343, 2)
    assert not [w for w in c.warnings if "率がありません" in w]
    assert c.rate("存在しない工事", "共通仮設費", 5e6) == 0 and c.warnings
    assert overhead_std.advance_factor("0％から5％以下") == 1.05 and overhead_std.guarantee_add("役務的保証") == 0.09


def test_area_correction_and_orderer(conn):
    """施工地域を考慮した補正（表－２・表－３）と、御所市の最低制限価格の式。"""
    from sekisan import overhead_std
    assert overhead_std.classify("補正を行わない") == ""
    assert overhead_std.classify("市街地（ＤＩＤ補正）（１）－３") == "市街地(DID補正)"
    assert overhead_std.classify("山間僻地及び離島") == "山間僻地及び離島"
    # 同じ「市街地」でも工種区分で係数が変わる
    assert overhead_std.area_coefs("市街地(DID補正)", "公園工事") == (1.2, 1.1, "市街地(DID補正)(1)-3")
    assert overhead_std.area_coefs("市街地(DID補正)", "舗装工事") == (1.4, 1.2, "市街地(DID補正)(1)-1")
    assert overhead_std.area_coefs("市街地(DID補正)", "鋼橋架設工事") == (1.3, 1.1, "市街地(DID補正)(1)-2")
    assert overhead_std.area_coefs("山間僻地及び離島", "河川工事") == (1.3, 1.0, "山間僻地及び離島")
    assert overhead_std.area_coefs("山間僻地及び離島", "フィルダム")[2] == ""
    pid = conn.execute("INSERT INTO project(name, fy, work_type, orderer, doc_meta) VALUES "
                       "('試験', 'R8', '公園工事', '御所市', ?)",
                       (json.dumps({"施工地域区分": "市街地（DID補正）（１）－３"}, ensure_ascii=False),)).lastrowid
    conn.commit()
    c = calc.Calculator(conn, "R8", orderer="御所市", project_id=pid)
    s = c.summary(30_000_000, "公園工事")
    kr = round(48.0 * 30_000_000 ** -0.0956, 2)
    assert s.area == "市街地(DID補正)(1)-3" and s.common_temp_rate == round(kr * 1.2, 2)
    # 工事の設定で「補正しない」を選べば補正しない
    conn.execute("UPDATE project SET area_class=? WHERE id=?", (overhead_std.NO_AREA, pid))
    assert calc.Calculator(conn, "R8", project_id=pid).summary(30_000_000, "公園工事").common_temp_rate == kr
    # 御所市：直接×0.97＋共通仮設×0.90＋現場管理×0.90＋一般管理×0.68、千円未満切捨て、予定価格の75〜92%
    assert c.rules["基準価格の端数単位"] == "1000" and c.rules["基準価格_一般管理費等"] == "0.68"
    raw = s.direct * 0.97 + s.common_temp * 0.90 + s.site_mgmt * 0.90 + s.general * 0.68
    want = min(max(raw, s.price * 0.75), s.price * 0.92)
    assert s.threshold == int(want) // 1000 * 1000


def test_orderer_from_cover():
    from sekisan import kinnuki
    assert kinnuki.orderer_of({"事務所名": "御所市 都市建設部 土木課"}) == "御所市"
    assert kinnuki.orderer_of({"事務所名": "奈良県総務部知事公室防災統括室"}) == ""


def test_nara_threshold(conn):
    """奈良県：(直接×0.97＋共通仮設×0.90＋現場管理×0.90＋一般管理×0.68) を予定価格の7.5/10〜9.2/10に収め、千円未満切捨て。"""
    c = calc.Calculator(conn, "R8", orderer="奈良県")
    for direct in (3_000_000, 30_000_000, 300_000_000):
        s = c.summary(direct, "道路改良工事")
        raw = s.direct * 0.97 + s.common_temp * 0.90 + s.site_mgmt * 0.90 + s.general * 0.68
        want = min(max(raw, s.price * 0.75), s.price * 0.92)
        assert s.threshold == int(want) // 1000 * 1000 and s.threshold % 1000 == 0
    # 税込は千円未満を切り捨てたあとに消費税を加算する
    assert c.rules["基準価格の端数単位"] == "1000"
