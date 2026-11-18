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
