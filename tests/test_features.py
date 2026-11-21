"""追加した10機能のテスト（数字はすべてダミーデータでの手計算）。"""
from pathlib import Path

import pytest

from sekisan import audit, awards, calc, change, db, export, importer, pdfcheck, quotes, settings

SAMPLE = Path(__file__).resolve().parent.parent / "sample"
WORK = "道路改良（ダミー）"


@pytest.fixture(autouse=True)
def user(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    settings.save({"user_name": "作成者A"})


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    importer.import_company_prices(c, SAMPLE / "自社単価.csv")
    importer.import_orderer_rules(c, SAMPLE / "発注者設定.csv")
    return c


@pytest.fixture
def pid(conn):
    items = importer.parse_design_csv(SAMPLE / "設計書.csv")
    return importer.create_project(conn, "テスト", "R8", items, "北部", WORK)


def item_id(conn, pid, seq):
    return conn.execute("SELECT id FROM project_item WHERE project_id=? AND seq=?", (pid, seq)).fetchone()["id"]


def by_seq(res):
    return {i.seq: i for i in res.items}


# ---------------------------------------------------------------- ② 補正係数・割増
def test_project_condition_night(conn, pid):
    calc.set_project_conditions(conn, pid, ["夜間"])
    r = by_seq(calc.calculate(conn, pid))[1]
    # (0.7×42000×1.2 + 0.3×20000×1.5) / 100 = 442.8（有効4桁）
    assert r.unit_price == 442.8
    assert {l.factor for l in r.detail.lines} == {1.2, 1.5}


def test_item_condition_only_matching_bukake(conn, pid):
    calc.set_item_conditions(conn, item_id(conn, pid, 1), "小規模")
    calc.set_item_conditions(conn, item_id(conn, pid, 3), "小規模")  # B003 には効かない設定
    res = by_seq(calc.calculate(conn, pid))
    assert res[1].unit_price == 442.5  # 35400 × 1.25 / 100
    assert res[3].unit_price == 23110  # 変わらない


def test_rate_conditions(conn, pid):
    base = calc.calculate(conn, pid).summary
    calc.set_project_conditions(conn, pid, ["山間部"])
    s = calc.calculate(conn, pid).summary
    assert s.common_temp_rate == round(base.common_temp_rate * 1.1, 2)
    assert s.price > base.price


# ---------------------------------------------------------------- ③ 機械経費
def test_machine_cost(conn):
    c = calc.Calculator(conn, "R8")
    price, name, unit, src = c.resource_price("機械", "M02")
    # 1500×6 + 4×6×150 + 1×24000 = 36600
    assert (price, unit, src) == (36600, "日", "機械経費")
    up = c.unit_price("B005")
    assert up.price == round((0.5 * 36600 + 0.2 * 20000) / 10)


# ---------------------------------------------------------------- ④ 間接費の対象額
def test_excluded_from_rate_base(conn, pid):
    calc.set_category(conn, item_id(conn, pid, 5), calc.DIRECT_EXCLUDED)  # 区画線 124,000
    s = calc.calculate(conn, pid).summary
    assert s.direct == 1397675 and s.direct_excluded == 124000
    base = s.direct - 124000
    assert s.common_temp_rate == round(30 * base ** -0.1, 2)
    assert s.common_temp_rated == int(base * s.common_temp_rate / 100)


# ---------------------------------------------------------------- ⑤ 見積単価
def test_quote_adoption(conn, pid):
    quotes.save(conn, "Q01", "特注グレーチング（ダミー）", "W300", "枚")
    for v, p in (("甲社", 5000), ("乙社", 4800), ("丙社", 5200)):
        quotes.add_offer(conn, "Q01", v, p)
    assert quotes.get(conn, "Q01").adopted == 4800
    quotes.save(conn, "Q01", "特注グレーチング（ダミー）", "W300", "枚", rule="平均")
    assert quotes.get(conn, "Q01").adopted == 5000
    iid = calc.add_item(conn, pid, "グレーチング", "W300", "枚", 10, "Q01", "側溝工")
    r = next(i for i in calc.calculate(conn, pid).items if i.item_id == iid)
    assert r.how == "見積" and r.amount == 50000


# ---------------------------------------------------------------- ⑥ 単価の時点修正・スライド
def test_price_revision_and_slide(conn, pid):
    before = by_seq(calc.calculate(conn, pid, as_of="2026-04-01"))[1]
    after = by_seq(calc.calculate(conn, pid, as_of="2027-03-02"))[1]
    assert before.unit_price == 354
    assert after.unit_price == 357  # (29400 + 0.3×21000)/100
    sr = change.slide(conn, pid, "2026-04-01", "2027-03-02", remaining=0.5)
    assert sr.p2 > sr.p1
    assert sr.burden == int(sr.p1 * 0.015)
    assert sr.slide == max(0, sr.change - sr.burden)


# ---------------------------------------------------------------- ⑦ 落札結果
def test_awards_stats(conn):
    assert awards.import_csv(conn, SAMPLE / "落札実績.csv") == 3
    st = awards.stats(conn, orderer="奈良県（ダミー）")
    assert st.count == 2 and st.win_count == 1
    assert st.accuracy == pytest.approx((19.6 / 20 + 34.3 / 35) / 2)
    assert st.predict_planned(9_800_000) == pytest.approx(9_800_000 / st.accuracy)


# ---------------------------------------------------------------- ⑧ 発注者ごとの設定
def test_orderer_rules(conn, pid, tmp_path):
    calc.set_project_fields(conn, pid, orderer="〇〇市（ダミー）")
    res = calc.calculate(conn, pid)
    assert res.rules["基準価格_上限"] == "0.80"
    assert res.summary.threshold <= res.summary.price * 0.80
    project = dict(conn.execute("SELECT * FROM project WHERE id=?", (pid,)).fetchone())
    path = export.export_ebid_csv(tmp_path / "e.csv", project, res)
    text = path.read_text(encoding="utf-8")
    assert "掘削工" in text and "バックホウ" not in text  # 種別（階層2）までしか出さない


# ---------------------------------------------------------------- ⑨ PDF照合
def test_pdf_check(conn, pid):
    lines = (SAMPLE / "金抜き設計書_テキスト.txt").read_text(encoding="utf-8").splitlines()
    res = {c.seq: c for c in pdfcheck.check(calc.calculate(conn, pid).items, lines)}
    assert res[1].status == "一致"
    assert res[2].status == "一致"
    assert res[3].status == "数量違い" and res[3].pdf_qty == 15.5
    assert res[6].status == "見つからない"


# ---------------------------------------------------------------- ⑩ 履歴・ダブルチェック・ロック
def test_double_check_and_lock(conn, pid):
    with pytest.raises(PermissionError):
        audit.mark_checked(conn, pid)  # 作成者本人は確認できない
    with pytest.raises(PermissionError):
        audit.submit(conn, pid)        # 確認前は提出できない
    settings.save({"user_name": "確認者B"})
    audit.mark_checked(conn, pid)
    audit.submit(conn, pid)
    with pytest.raises(audit.Locked):
        calc.set_qty(conn, item_id(conn, pid, 1), 900)
    with pytest.raises(ValueError):
        audit.unlock(conn, pid, "")
    audit.unlock(conn, pid, "数量の誤りを修正")
    calc.set_qty(conn, item_id(conn, pid, 1), 900)
    actions = [h["action"] for h in audit.history(conn, pid)]
    assert "ロックを解除" in actions and "数量" in actions and "確認済にした" in actions
    users = {h["user"] for h in audit.history(conn, pid)}
    assert {"作成者A", "確認者B"} <= users


def test_edit_after_check_resets_status(conn, pid):
    settings.save({"user_name": "確認者B"})
    audit.mark_checked(conn, pid)
    calc.set_note(conn, item_id(conn, pid, 1), "見直し")
    assert conn.execute("SELECT status FROM project WHERE id=?", (pid,)).fetchone()["status"] == "作成中"


# ---------------------------------------------------------------- ① 設計変更
def test_design_change(conn, pid, tmp_path):
    cid = change.create_change(conn, pid)
    p = conn.execute("SELECT * FROM project WHERE id=?", (cid,)).fetchone()
    assert p["parent_id"] == pid and p["change_no"] == 1 and "第1回変更" in p["name"]
    calc.set_qty(conn, item_id(conn, cid, 1), 1000)        # 増
    calc.delete_item(conn, item_id(conn, cid, 5))          # 削除
    calc.add_item(conn, cid, "排水構造物", "U300", "m", 20, "B004", "側溝工")  # 新規
    comp = change.compare(conn, cid)
    st = {r.name: r.status for r in comp.rows}
    assert st["掘削"] == "増" and st["区画線"] == "削除" and st["排水構造物"] == "新規" and st["コンクリート"] == "同じ"
    exc = next(r for r in comp.rows if r.name == "掘削")
    assert exc.diff == 150 * 354
    assert comp.after.direct - comp.before.direct == sum(r.diff for r in comp.rows)
    # 2回目の変更は第2回
    c2 = change.create_change(conn, cid)
    assert conn.execute("SELECT change_no FROM project WHERE id=?", (c2,)).fetchone()[0] == 2
    project = dict(p)
    out = export.export_change(tmp_path / "c.xlsx", project, comp)
    assert out.exists()


def test_pdf_file_end_to_end(conn, pid, tmp_path):
    """文字入りのPDFを実際に作って照合する（reportlab がない環境では飛ばす）。"""
    rl = pytest.importorskip("reportlab.pdfgen.canvas")
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    path = tmp_path / "k.pdf"
    c = rl.Canvas(str(path))
    c.setFont("HeiseiKakuGo-W5", 10)
    lines = (SAMPLE / "金抜き設計書_テキスト.txt").read_text(encoding="utf-8").splitlines()[1:]
    for i, line in enumerate(lines):
        c.drawString(40, 780 - i * 20, line)
    c.save()
    res = {r.seq: r for r in pdfcheck.check_pdf(calc.calculate(conn, pid).items, path)}
    assert res[1].status == "一致" and res[3].status == "数量違い" and res[3].pdf_qty == 15.5
