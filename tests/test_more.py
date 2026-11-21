"""追加した10機能（その2）のテスト。数字はダミーデータでの手計算。"""
from datetime import date
from pathlib import Path

import pytest
from openpyxl import load_workbook

from sekisan import (aftercontract, audit, backup, calc, db, export, importer, inquiry, pdfcheck, publicprice,
                     qtycalc, quotes, schedule, settings, suggest, template)

SAMPLE = Path(__file__).resolve().parent.parent / "sample"
WORK = "道路改良（ダミー）"


@pytest.fixture(autouse=True)
def user(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    settings.save({"user_name": "山田"})


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


def iid(conn, pid, seq):
    return conn.execute("SELECT id FROM project_item WHERE project_id=? AND seq=?", (pid, seq)).fetchone()["id"]


# ---------------------------------------------------------------- ① 公表単価の取り込み
def test_public_price_long_excel(conn):
    rows = publicprice.parse(SAMPLE / "公表単価_材料（ダミー）.xlsx", "材料")
    assert [r.name for r in rows][:2] == ["生コンクリート（ダミー）", "再生砕石（ダミー）"]
    assert rows[0].price == 16200
    rows = publicprice.preview(conn, "R8", rows)
    st = {r.name: (r.code, r.status) for r in rows}
    assert st["生コンクリート（ダミー）"] == ("Z01", "更新")   # 既存コードを名称・規格で見つける
    assert st["U形側溝（ダミー）"][1] == "新規" and st["U形側溝（ダミー）"][0].startswith("Z")
    publicprice.apply(conn, "R8", rows)
    assert conn.execute("SELECT price FROM master_price WHERE fy='R8' AND code='Z01' AND region=''").fetchone()[0] == 16200


def test_public_price_labor_wide(conn):
    rows = publicprice.parse(SAMPLE / "公表単価_労務（ダミー）.csv", "労務", "奈良")
    got = {r.name: r.price for r in rows}
    assert got == {"特殊作業員": 25700, "普通作業員": 21000, "軽作業員": 15800, "とび工": 27000, "特殊運転手": 24500}


# ---------------------------------------------------------------- ② 当てはめ候補
def test_suggest_candidates(conn):
    cs = suggest.candidates(conn, "R8", "基礎砕石", "t=10cm", "m2")
    assert cs[0].code == "B002" and cs[0].score > 0.9
    cs = suggest.candidates(conn, "R8", "生コン", "18-8-40", "m3")
    assert "Z01" in [c.code for c in cs]


def test_auto_assign(conn, pid):
    done = suggest.auto_assign(conn, pid)
    assert [(seq, c.code) for seq, c in done] == [(2, "B002")]
    assert not calc.calculate(conn, pid).unresolved


# ---------------------------------------------------------------- ③ 権限
def test_roles(conn, pid):
    audit.set_user(conn, "山田", "管理者")
    audit.set_user(conn, "佐藤", "積算")
    audit.set_user(conn, "鈴木", "閲覧")
    with pytest.raises(ValueError):
        audit.set_user(conn, "山田", "積算")  # 管理者がいなくなる
    settings.save({"user_name": "鈴木"})
    with pytest.raises(PermissionError):
        calc.set_qty(conn, iid(conn, pid, 1), 1)
    settings.save({"user_name": "佐藤"})
    calc.set_qty(conn, iid(conn, pid, 1), 900)            # 積算はできる
    with pytest.raises(PermissionError):
        importer.import_master_folder(conn, "R8", SAMPLE / "master" / "R8")  # マスタはできない
    with pytest.raises(PermissionError):
        audit.mark_checked(conn, pid)                     # 確認もできない
    settings.save({"user_name": "知らない人"})
    assert audit.role(conn) == "閲覧"


def test_first_user_must_be_admin(conn):
    with pytest.raises(ValueError):
        audit.set_user(conn, "佐藤", "積算")


# ---------------------------------------------------------------- ④ スケジュール
def test_schedule_and_deadlines(conn, pid):
    schedule.set_dates(conn, pid, {"入札締切": "2026-11-25", "開札日": "2026-11-27", "工期終了": "2027-03-31"})
    items = schedule.checklist(conn, pid)
    assert len(items) == len(schedule.DEFAULT_CHECKLIST)
    schedule.set_done(conn, items[0]["id"], True)
    dl = schedule.upcoming(conn, today=date(2026, 11, 20))
    assert [(d.kind, d.days) for d in dl] == [("入札締切", 5), ("開札日", 7)]
    assert dl[0].open_items == len(items) - 1
    with pytest.raises(ValueError):
        schedule.set_dates(conn, pid, {"入札締切": "11月25日"})


# ---------------------------------------------------------------- ⑤ 数量計算書
def test_qty_expr():
    assert qtycalc.evaluate("10.5×2.0×0.3") == pytest.approx(6.3)
    assert qtycalc.evaluate("（3＋4）÷2") == pytest.approx(3.5)
    for bad in ("__import__('os')", "a*2", "1/0", ""):
        with pytest.raises(ValueError):
            qtycalc.evaluate(bad)


def test_qty_apply(conn, pid, tmp_path):
    i = iid(conn, pid, 3)
    qtycalc.add_line(conn, i, "20.0×0.5×0.6", "No.1〜No.3")
    qtycalc.add_line(conn, i, "8.5×0.5×0.6", "No.3〜No.4")
    assert qtycalc.total(conn, i) == pytest.approx(8.55)
    qtycalc.apply_total(conn, i)
    assert conn.execute("SELECT qty FROM project_item WHERE id=?", (i,)).fetchone()[0] == pytest.approx(8.55)
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    assert export.export_qty_sheet(tmp_path / "q.xlsx", p, qtycalc.sheet_rows(conn, pid)).exists()


# ---------------------------------------------------------------- ⑥ 質疑書
def test_inquiry_from_pdf(conn, pid, tmp_path):
    lines = (SAMPLE / "金抜き設計書_テキスト.txt").read_text(encoding="utf-8").splitlines()
    checks = pdfcheck.check(calc.calculate(conn, pid).items, lines)
    n = inquiry.from_pdf_check(conn, pid, checks)
    assert n == sum(c.status != "一致" for c in checks)
    assert inquiry.from_pdf_check(conn, pid, checks) == 0       # 同じ質問は重ねない
    q = inquiry.rows(conn, pid)[0]
    inquiry.update(conn, q["id"], answer="14.5m3が正です")
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    out = export.export_inquiry(tmp_path / "s.xlsx", p, inquiry.rows(conn, pid))
    ws = load_workbook(out).active
    assert "数量" in ws.cell(7, 3).value and ws.cell(7, 4).value == "14.5m3が正です"


# ---------------------------------------------------------------- ⑦ 低入札調査の資料
def test_lowbid_report(conn, pid, tmp_path):
    quotes.save(conn, "Q01", "グレーチング", "W300", "枚")
    quotes.add_offer(conn, "Q01", "甲社", 4800)
    calc.add_item(conn, pid, "グレーチング", "W300", "枚", 5, "Q01")
    d, c = calc.calculate(conn, pid), calc.calculate(conn, pid, calc.COMPANY)
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    out = export.export_lowbid(tmp_path / "l.xlsx", p, d, c, d.summary.threshold - 10000, quotes.all_quotes(conn),
                               list(conn.execute("SELECT * FROM company_price")))
    wb = load_workbook(out)
    assert wb.sheetnames == ["総括", "明細ごとの単価と根拠", "見積の一覧", "手持ちの労務・機械"]
    basis = {r[1].value: r[9].value for r in wb["明細ごとの単価と根拠"].iter_rows(min_row=2)}
    assert "自社" in basis["掘削"] and basis["グレーチング"] == "見積"


# ---------------------------------------------------------------- ⑧ 単価合意・出来高
def test_agreement_and_progress(conn, pid, tmp_path):
    planned = calc.calculate(conn, pid).summary.price
    aftercontract.set_contract_price(conn, pid, planned * 0.9)
    ag = aftercontract.agreement(conn, pid)
    assert ag.ratio == pytest.approx(0.9, abs=1e-6)
    dig = next(a for a in ag.items if a.seq == 1)
    assert dig.agreed_price == calc.round_sig(354 * ag.ratio, 4)
    aftercontract.set_progress(conn, pid, "第1回", iid(conn, pid, 1), 425)   # 掘削の半分
    aftercontract.set_progress(conn, pid, "第2回", iid(conn, pid, 1), 850)
    p1 = aftercontract.progress(conn, pid, "第1回")
    p2 = aftercontract.progress(conn, pid, "第2回")
    assert p1.rows[0].rate == 0.5 and p1.paid_before == 0
    assert p1.payable == int(p1.contract_done * 0.9)
    assert p2.paid_before == p1.payable
    assert p2.payable == int(p2.contract_done * 0.9) - p1.payable
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    assert export.export_agreement(tmp_path / "a.xlsx", p, ag, p2).exists()


# ---------------------------------------------------------------- ⑨ 自社の書式
def test_template_fill(conn, pid, tmp_path):
    res = calc.calculate(conn, pid)
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    out = template.fill(SAMPLE / "自社書式_見積書（見本）.xlsx", tmp_path / "m.xlsx", p, res)
    ws = load_workbook(out).active
    assert ws["B3"].value == "テスト"
    assert ws["B5"].value == res.summary.price
    names = [ws.cell(9 + k, 2).value for k in range(len(res.items))]
    assert names == [i.name for i in res.items]
    assert ws.cell(9, 7).value == res.items[0].amount
    # 明細の下にあった合計行は、明細の数だけ下にずれる
    assert ws.cell(9 + len(res.items) + 2, 7).value == res.summary.price
    assert not any("{{" in str(c.value) for row in ws.iter_rows() for c in row if c.value)


# ---------------------------------------------------------------- ⑩ バックアップ
def test_backup_restore(conn, pid, tmp_path):
    dbp = tmp_path / "t.sqlite"
    dest = tmp_path / "bk"
    b = backup.make(dbp, dest)
    assert backup.integrity(b) == "ok" and not backup.due(dest)
    calc.set_qty(conn, iid(conn, pid, 1), 1)
    conn.close()
    safety = backup.restore(b, dbp)
    c2 = db.connect(dbp)
    assert c2.execute("SELECT qty FROM project_item WHERE project_id=? AND seq=1", (pid,)).fetchone()[0] == 850
    assert safety.exists()
    for _ in range(5):
        backup.make(dbp, dest, keep=3)
    assert len(backup.list_backups(dest)) <= 3


# ---------------------------------------------------------------- 奈良県の単価資料PDF（同じ並びの小さなPDFを作って読む）
def _nara_pdf(path, regional: bool, cover: str = "土木工事設計資材単価表（令和８年１１月１日より適用）"):
    rl = pytest.importorskip("reportlab.pdfgen.canvas")
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    c = rl.Canvas(str(path), pagesize=(842, 595))
    c.setFont("HeiseiKakuGo-W5", 9)
    c.drawString(40, 560, cover)
    c.showPage()
    c.setFont("HeiseiKakuGo-W5", 6)
    y = 520
    if regional:
        head = [(47, "項番"), (78, "地区"), (122, "単価コード"), (245, "名称"), (403, "規格"), (507, "単位"), (566, "単価（円）")]
        rows = [[(51, "5"), (83, "1"), (102, "Z002010012"), (173, "生コンクリート"), (331, "21-18-25(20)"),
                 (508, "ｍ３"), (593, "○"), (624, "202610積"), (678, "P.118")],
                [(83, "2"), (102, "Z002010012"), (575, "28,000")],
                [(83, "3"), (102, "Z002010012")]]
    else:
        head = [(43, "項番"), (84, "単価コード"), (226, "名称"), (404, "規格"), (506, "単位"), (555, "単価（円）")]
        rows = [[(43, "1441"), (61, "Z006412002"), (137, "メタルクラウン"), (330, "φ４１ｍｍ"), (509, "個"), (580, "○"),
                 (616, "202610積"), (664, "P.309")],
                [(43, "1443"), (61, "ZA06416010"), (137, "ケーシング"), (170, "φ96mm"), (191, "ｶｯﾌﾟﾘﾝｸﾞ付"),
                 (330, "二重管工法削孔φ96mm"), (509, "個"), (575, "12,300")],
                [(43, "1778"), (61, "Q040015036"), (137, "モノレール機械器具損料"), (330, "50m以下"), (509, "日"),
                 (575, "2,200")]]
    for x, t in head:
        c.drawString(x, y, t)
    for r in rows:
        y -= 12
        for x, t in r:
            c.drawString(x, y, t)
    c.save()


def test_nara_pdf_regional(tmp_path, conn):
    p = tmp_path / "r.pdf"
    _nara_pdf(p, True)
    assert publicprice.is_nara_pdf(p) and publicprice.effective_date(p) == "2026-11-01"
    items = publicprice.parse_nara_pdf(p)
    got = [(i.region, i.name, i.spec, i.unit, i.price, i.source) for i in items]
    assert got == [("1地区", "生コンクリート", "21-18-25(20)", "ｍ３", None, "物価資料"),
                   ("2地区", "生コンクリート", "21-18-25(20)", "ｍ３", 28000, "県単価"),
                   ("3地区", "生コンクリート", "21-18-25(20)", "ｍ３", None, "未設定")]
    assert items[0].ref.startswith("202610積")
    rows = publicprice.preview(conn, "R8", publicprice.parse(p))
    assert publicprice.apply(conn, "R8", rows, "r.pdf") == 1
    assert conn.execute("SELECT price FROM master_price WHERE code='Z002010012' AND region='2地区'").fetchone()[0] == 28000
    assert conn.execute("SELECT COUNT(*) FROM public_item WHERE code='Z002010012'").fetchone()[0] == 3


def test_nara_pdf_uniform_and_book_items(tmp_path, conn, pid):
    p = tmp_path / "u.pdf"
    _nara_pdf(p, False)
    items = {i.code: i for i in publicprice.parse_nara_pdf(p)}
    k = items["ZA06416010"]
    # 名称の中の空白は文字の間隔しだいで詰まることがあるので、空白を除いて比べる
    assert (k.name.replace(" ", ""), k.spec, k.price) == ("ケーシングφ96mmｶｯﾌﾟﾘﾝｸﾞ付", "二重管工法削孔φ96mm", 12300)
    assert items["Q040015036"].kind == "市場単価" and items["Z006412002"].source == "物価資料"
    publicprice.apply(conn, "R8", publicprice.preview(conn, "R8", publicprice.parse(p)), "u.pdf")
    # ○の品目を明細に当てると「物価資料で調べる単価」に出て、入れると単価が付く
    iid_ = calc.add_item(conn, pid, "メタルクラウン", "φ41mm", "個", 4, "Z006412002")
    res = calc.calculate(conn, pid)
    assert any("物価資料" in w for w in res.warnings)
    waiting = next(i for i in res.items if i.item_id == iid_)
    assert waiting.how == "物価資料待ち" and waiting in res.unresolved
    assert not [x for x, _ in suggest.auto_assign(conn, pid) if x == waiting.seq]  # 別のコードに変えない
    book = publicprice.book_items_for(conn, pid)
    assert [b.code for b in book] == ["Z006412002"] and "P.309" in book[0].ref
    publicprice.set_book_price(conn, "R8", "材料", "Z006412002", 8500)
    r = next(i for i in calc.calculate(conn, pid).items if i.item_id == iid_)
    assert r.amount == 34000 and not publicprice.book_items_for(conn, pid)
    # 当てはめ候補にも出る
    cs = suggest.candidates(conn, "R8", "モノレール機械器具損料", "50m以下", "日")
    assert cs[0].code == "Q040015036"


# ---------------------------------------------------------------- 金抜き設計書（実施設計書）PDF
def _kinnuki_pdf(path, priced=False):
    rl = pytest.importorskip("reportlab.pdfgen.canvas")
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    H = 595
    c = rl.Canvas(str(path), pagesize=(842, H))

    def P(words, extra):  # 金入りのときだけ単価・金額を足す
        return words + extra if priced else words

    def page(rows, size=6):
        c.setFont("HeiseiKakuGo-W5", size)
        for top, words in rows:
            for x, t in words:
                c.drawString(x, H - top, t)
        c.drawString(34, H - 545, "R08-K999999-00001")
        c.showPage()

    page([(56, [(191, "令和"), (267, "8"), (286, "年度"), (399, "実施設計書")]),
          (221, [(39, "工"), (57, "事"), (74, "番"), (91, "号"), (119, "第"), (136, "1-工-9"), (177, "号")])])
    page([(186, [(46, "単"), (64, "価"), (81, "地"), (98, "区"), (133, "４地区"), (433, "損料適用年月"), (523, "令和"),
                 (552, "8年"), (575, "8月")]),
          (236, [(46, "適"), (64, "用"), (81, "工"), (98, "種"), (133, "公園工事")]),
          (87, [(433, "単価適用年月"), (523, "令和"), (552, "8年"), (575, "8月")])])
    page([(83, [(359, "設計内訳書")]),
          (114, [(34, "工事名"), (73, "テスト公園"), (137, "伐採工事")]),
          (142, [(59, "工事区分・工種・種別・細別"), (267, "規格"), (359, "単位"), (409, "数量"), (484, "単価"),
                 (567, "金額"), (704, "摘要")]),
          (157, [(30, "基盤整備")]), (160, [(765, "レベル1")]), (178, [(365, "式"), (425, "1")]),
          (192, [(35, "樹木伐採工")]), (196, [(765, "レベル2")]), (213, [(365, "式"), (425, "1")]),
          (263, [(45, "樹木伐採"), (205, "幹周30cm未満")]), (266, [(765, "単"), (788, "1"), (797, "号")]),
          (284, P([(365, "本"), (421, "30")], [(484, "900"), (567, "27,000")])),
          (298, [(45, "伐木処分")]), (302, [(765, "単"), (788, "3"), (797, "号")]), (320, P([(365, "m3"), (416, "14.0")], [(484, "1,500"), (567, "21,000")])),
          (334, [(45, "直接工事費")]), (355, P([(365, "式"), (425, "1")], [(567, "48,000")]))])
    page([(48, [(235, "1"), (259, "次"), (295, "単"), (331, "価"), (367, "表")]),
          (80, [(31, "単"), (49, "1号"), (102, "樹木伐採"), (270, "幹周30cm未満")]),
          (86, [(431, "単位"), (495, "本"), (553, "割戻数量"), (707, "単価")]), (95, P([(669, "100")], [(740, "900")])),
          (108, [(124, "名称・規格"), (334, "条件"), (432, "単位"), (488, "数量"), (560, "単価"), (650, "金額"), (750, "摘要")]),
          (119, [(30, "普通作業員")]), (143, P([(453, "人")], [(495, "3"), (556, "20,000"), (645, "60,000")])),
          (156, [(30, "ﾁｪｰﾝｿｰ運転"), (707, "単"), (730, "2"), (744, "号")]),
          (179, P([(453, "日")], [(495, "1.5"), (556, "20,000"), (645, "30,000")])),
          (191, P([(58, "計")], [(645, "90,000")])), (252, [(707, "円/本")]),
          (299, [(174, "2"), (198, "次"), (234, "単"), (270, "価"), (306, "表(参考資料)")]),
          (331, [(31, "単"), (49, "2号"), (102, "ﾁｪｰﾝｿｰ運転")]),
          (338, [(431, "単位"), (495, "日"), (553, "割戻数量"), (707, "単価")]), (346, [(669, "1")]),
          (359, [(124, "名称・規格"), (334, "条件"), (432, "単位"), (488, "数量"), (560, "単価"), (650, "金額")]),
          (370, [(30, "普通作業員")]), (395, P([(453, "人")], [(495, "1"), (556, "20,000"), (645, "20,000")])),
          (406, [(30, "軽油")]), (431, P([(453, "L"), (505, "2.7")], [(556, "150"), (645, "405")])),
          (442, [(30, "諸雑費（率）"), (334, "率")]), (466, P([(453, "式"), (505, "1")], [(645, "408")])),
          (478, [(58, "計")])])
    page([(48, [(235, "1"), (259, "次"), (295, "単"), (331, "価"), (367, "表")]),
          (80, [(31, "単"), (49, "3号"), (102, "伐木処分")]),
          (86, [(431, "単位"), (495, "m3"), (553, "割戻数量"), (707, "単価")]), (95, [(669, "1")]),
          (108, [(124, "名称・規格"), (334, "条件"), (432, "単位"), (488, "数量"), (560, "単価")]),
          (119, [(30, "処分費"), (80, "伐木")]), (143, P([(453, "m3"), (505, "1")], [(556, "1,500"), (645, "1,500")])),
          (191, [(58, "計")])])
    c.save()


def test_kinnuki_parse_and_import(tmp_path, conn):
    from sekisan import kinnuki
    p = tmp_path / "k.pdf"
    _kinnuki_pdf(p)
    assert kinnuki.is_kinnuki(p)
    d = kinnuki.parse(p)
    assert (d.fy, d.price_date, d.meta["単価地区"], d.meta["適用工種"]) == ("R8", "2026-08-01", "４地区", "公園工事")
    assert [(i.level1, i.level2, i.name, i.spec, i.unit, i.qty, i.ref) for i in d.items] == [
        ("基盤整備", "樹木伐採工", "樹木伐採", "幹周30cm未満", "本", 30, "単1"),
        ("基盤整備", "樹木伐採工", "伐木処分", "", "m3", 14, "単3")]
    t1, t2 = d.tables["単1"], d.tables["単2"]
    assert (t1.order, t1.unit, t1.per_qty) == ("1次", "本", 100)
    assert [(l.name, l.unit, l.qty, l.ref) for l in t1.lines] == [("普通作業員", "人", None, ""), ("ﾁｪｰﾝｿｰ運転", "日", None, "単2")]
    assert [(l.name, l.qty) for l in t2.lines] == [("普通作業員", None), ("軽油", 2.7), ("諸雑費（率）", 1)]

    st = kinnuki.import_doc(conn, p)
    pid = st["project_id"]
    assert st["数量を入れる"] == 3 and st["諸雑費率を入れる"] == 1
    proj = conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone()
    assert (proj["region"], proj["work_type"], proj["price_date"]) == ("4地区", "公園工事", "2026-08-01")
    fy = "R8"
    code1, code2 = f"R08-K999999-00001#{pid}/単1", f"R08-K999999-00001#{pid}/単2"
    comp = {r["seq"]: r for r in conn.execute("SELECT * FROM bukake_component WHERE bukake_code=?", (code1,))}
    assert comp[1]["res_code"] == "L01" and comp[2]["kind"] == "歩掛" and comp[2]["res_code"] == code2
    # 同じ設計書を2回取り込んでも、前の工事の単価表はそのまま
    other = kinnuki.import_doc(conn, p)["project_id"]
    assert conn.execute("SELECT project_id FROM bukake WHERE code=?", (code1,)).fetchone()[0] == pid != other
    # 伏せてある数量を入れると単価が出る：単2（1日）= 普通作業員1人×20000 + 軽油2.7L×0（軽油は未登録）
    kinnuki.set_component(conn, fy, code2, 1, qty=1.0)
    kinnuki.set_component(conn, fy, code1, 1, qty=3.0)   # 100本あたり 3人
    kinnuki.set_component(conn, fy, code1, 2, qty=1.5)   # 100本あたり チェーンソー運転 1.5日
    kinnuki.set_table(conn, fy, code2, misc_rate=0)
    item = calc.calculate(conn, pid).items[0]
    assert item.unit_price == calc.round_sig((3 * 20000 + 1.5 * 20000) / 100, 4)   # 900
    assert [s.todo for s in kinnuki.tables_of(conn, pid) if s.code == code1] == [0]

    # 同じ単価表が出てくる次の金抜き設計書では、入れた数量が自動で入る
    st2 = kinnuki.import_doc(conn, p)
    assert st2["前回の値"] == 3 and st2["数量を入れる"] == 0
    st2 = {**st2}
    assert calc.calculate(conn, st2["project_id"]).items[0].unit_price == item.unit_price


def test_kinnuki_priced_learn_and_answers(tmp_path, conn):
    """金入り設計書から答え（数量・諸雑費率・物価資料の単価・単価表の単価）を覚え、答え合わせに入れる。"""
    from sekisan import kinnuki, pipeline
    kin, pri = tmp_path / "k.pdf", tmp_path / "p.pdf"
    _kinnuki_pdf(kin)
    _kinnuki_pdf(pri, priced=True)
    d = kinnuki.parse(pri)
    assert d.priced and not kinnuki.parse(kin).priced
    assert (d.items[0].price, d.items[0].amount) == (900, 27000)
    assert d.totals["直接工事費"] == 48000
    t1, t2 = d.tables["単1"], d.tables["単2"]
    assert (t1.per_qty, t1.unit_price, t1.total) == (100, 900, 90000)
    assert [(l.qty, l.price, l.amount) for l in t1.lines] == [(3, 20000, 60000), (1.5, 20000, 30000)]
    assert kinnuki._misc_rate_of(t2) == 2.0          # 408 ÷ (20,000 + 405)

    # 処分費は県の資料で○（物価資料）の品目として控えてある
    conn.execute("INSERT INTO public_item(fy, kind, code, name, spec, unit, region, source) "
                 "VALUES ('R8','材料','Z9999','処分費','伐木','m3','','物価資料')")
    conn.commit()
    # 先に金抜きで工事を作る（数量は伏せてある）
    st0 = kinnuki.import_doc(conn, kin)
    assert st0["数量を入れる"] == 3
    # 金入りを取り込むと：覚えて、同じ設計書番号の工事の答え合わせに金額が入る（工事は増えない）
    r = kinnuki.import_priced(conn, pri)
    assert r["project_id"] == st0["project_id"] and not r["created"]
    assert r["filled"] >= 4   # 先に作ってあった工事の単価表にも、覚えた数量・諸雑費率が入る
    c1 = [(x["qty"], x["note"]) for x in conn.execute(
        "SELECT qty, note FROM bukake_component WHERE bukake_code=? ORDER BY seq",
        (f"R08-K999999-00001#{st0['project_id']}/単1",))]
    assert [q for q, _ in c1] == [3, 1.5] and all("数量を入れる" not in n for _, n in c1)
    assert r["learned"]["数量"] >= 4 and r["learned"]["諸雑費率"] == 1 and r["learned"]["単価（設計書実績）"] == 2  # 処分費（○の品目）と軽油（単価表に同じ規格がない）
    checks = {c.key: c for c in pipeline.verify(conn, r["project_id"])}
    assert {"1", "2", "直接工事費", "単1"} <= set(checks)
    assert checks["直接工事費"].reference == 48000 and checks["単1"].reference == 900

    # 次の金抜き設計書では、覚えた数量・諸雑費率・物価資料の単価が自動で入る
    st2 = kinnuki.import_doc(conn, kin)
    assert st2["数量を入れる"] == 0 and st2["諸雑費率を入れる"] == 0 and st2["前回の値"] >= 4
    res = calc.calculate(conn, st2["project_id"])
    disposal = res.items[1]
    assert disposal.unit_price == 1500 and disposal.how == "歩掛"
    assert any(l.source == "設計書実績" for l in disposal.detail.lines)
    code2 = f"R08-K999999-00001#{st2['project_id']}/単2"
    assert conn.execute("SELECT misc_rate FROM bukake WHERE code=? AND project_id=?",
                        (code2, st2["project_id"])).fetchone()[0] == 2.0


def test_award_threshold_accuracy(conn):
    from sekisan import awards
    awards.add(conn, name="A", planned=10_000_000, threshold=9_000_000, our_threshold=9_000_000, tie_count=5,
               lottery="外れ", award_price=9_000_000, winner="B建設")
    awards.add(conn, name="B", planned=20_000_000, threshold=18_000_000, our_threshold=18_000_350, tie_count=3,
               lottery="当たり", award_price=18_000_000, winner="自社")
    awards.add(conn, name="C", planned=5_000_000, threshold=4_500_000, our_threshold=4_499_000)
    st = awards.stats(conn)
    assert (st.th_n, st.th_exact) == (3, 1)
    assert st.th_mae == pytest.approx((0 + 350 + 1000) / 3) and st.th_max == 1000
    assert st.th_bias == pytest.approx((0 + 350 - 1000) / 3)
    assert (st.tie_avg, st.lottery_n, st.lottery_wins) == (4, 2, 1)
    with pytest.raises(ValueError):
        awards.add(conn, name="D", lottery="まだ")
