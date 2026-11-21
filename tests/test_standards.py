"""基準・ルールをソフトの中で直す：諸経費率・施工地域の補正・一般管理費等率の補正・最低制限価格の式・計算ルール。"""
import json

import pytest

from sekisan import calc, db, overhead_std, standards


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    return db.connect(tmp_path / "t.sqlite")


def test_overheads_edit_and_reset(conn):
    rows = standards.overheads(conn, "R8")
    park = next(o for o in rows if o.work_type == "公園工事" and o.item == "共通仮設費")
    assert park.source == "国交省（既定）" and park.rate(5e6) == 10.80
    assert calc.Calculator(conn, "R8").rate("公園工事", "共通仮設費", 5e6) == 10.80
    park.a = 60.0   # 国が式を変えたとする
    standards.save_overheads(conn, "R8", [park])
    assert calc.Calculator(conn, "R8").rate("公園工事", "共通仮設費", 5e6) == round(60.0 * 6e6 ** -0.0956, 2)
    assert next(o for o in standards.overheads(conn, "R8")
                if o.work_type == "公園工事" and o.item == "共通仮設費").source == "マスタ"
    with pytest.raises(ValueError):
        standards.save_overheads(conn, "R8", [standards.Overhead("公園工事", "共通仮設費", "exp", 1, 1, 1, 2)])
    standards.reset_overheads(conn, "R8")
    assert calc.Calculator(conn, "R8").rate("公園工事", "共通仮設費", 5e6) == 10.80


def test_parse_unyou_text():
    text = """別表第１
共通仮設費率
第１表
対象額 10億円を超える
600万円以下 600万円を超え10億円以下
もの
Ａ ｂ
河 川 工 事 12.53 238.6 －0.1888 4.77
公 園 工 事 10.80 48.0 －0.0956 6.62
誤 植 工 事 10.80 99.0 －0.0956 6.62
３) 算定式
別表第２
工種別現場管理費率
第１表
純工事費 700万円以下 700万円を超え10億円以下 10億円を超えるもの
Ａ ｂ
公 園 工 事 43.09 347.3 -0.1324 22.34
２) 算定式
工 事 原 価 500万円以下 500万円を超え30億円以下 30億円を超えるもの
Ｇp＝-5.21826×LOG(Ｃp)＋60.08343（％）
前払金支出割合区分 0％から5％以下 5％を超え15％以下 15％を超え25％以下 25％を超え35％以下
補 正 係 数 1.06 1.04 1.03 1.01
ケース１：発注者が金銭的保証を必要とする場合（工事請負契約書第４条を採用する場合)。 0.05
"""
    u = standards.parse_unyou(text)
    got = {(o.work_type, o.item): o for o in u.overheads}
    assert (got[("公園工事", "共通仮設費")].a, got[("公園工事", "共通仮設費")].p_min) == (48.0, 6e6)
    assert got[("公園工事", "現場管理費")].p_min == 7e6 and got[("公園工事", "一般管理費等")].a == -5.21826
    assert ("誤植工事", "共通仮設費") not in got and any("誤植工事" in p for p in u.problems)   # 表の率と合わない行は入れない
    assert u.advance[0] == ("0%から5%以下", 1.06) and u.guarantee == [("金銭", 0.05)]


def test_area_and_general_adjust_override(conn):
    pid = conn.execute("INSERT INTO project(name, fy, work_type, doc_meta) VALUES ('試験', 'R8', '公園工事', ?)",
                       (json.dumps({"施工地域区分": "山間僻地及び離島", "契約保証": "金銭的保証"}, ensure_ascii=False),)).lastrowid
    conn.commit()
    c = calc.Calculator(conn, "R8", project_id=pid)
    assert c.area_adjust("公園工事")[:2] == (1.3, 1.0) and c.general_adjust() == (1.0, 0.04)
    rows = [r if r[0] != "山間僻地及び離島" else ("山間僻地及び離島", 1.35, 1.05, 8, None, None)
            for r in standards.area_table(conn)]
    standards.set_area_table(conn, rows)
    standards.set_general_adjust_tables(conn, list(overhead_std.ADVANCE_FACTOR), [("金銭", 0.05), ("役務", 0.1)])
    c = calc.Calculator(conn, "R8", project_id=pid)
    assert c.area_adjust("公園工事")[:2] == (1.35, 1.05) and c.general_adjust() == (1.0, 0.05)
    standards.set_area_table(conn, None)
    standards.set_general_adjust_tables(conn, None, None)
    assert calc.Calculator(conn, "R8", project_id=pid).area_adjust("公園工事")[:2] == (1.3, 1.0)


def test_threshold_rules(conn):
    r = standards.threshold_rules(conn, "御所市")
    assert r["基準価格_一般管理費等"][0] == "0.68" and r["基準価格_一般管理費等"][1].startswith("既定")
    assert standards.threshold_rules(conn, "大和高田市")["基準価格_下限"][1] == "既定（国のモデル）"
    found = standards.parse_threshold_text(
        "最低制限基準比較価格は、直接工事費の額に100分の95、共通仮設費の90％、現場管理費の85％、一般管理費等の55％を合計した額"
        "（千円未満切捨て）とし、予定価格の10分の8から10分の9の範囲内")
    assert found == {"基準価格_直接工事費": "0.95", "基準価格_共通仮設費": "0.9", "基準価格_現場管理費": "0.85",
                     "基準価格_一般管理費等": "0.55", "基準価格_下限": "0.8", "基準価格_上限": "0.9", "基準価格の端数単位": "1000"}
    standards.save_threshold_rules(conn, "大和高田市", found, "要綱.pdf")
    assert calc.load_rules(conn, "R8", "大和高田市")["基準価格_下限"] == "0.8"
    assert standards.threshold_rules(conn, "大和高田市")["基準価格_下限"] == ("0.8", "設定")
    standards.reset_threshold_rules(conn, "大和高田市")
    assert calc.load_rules(conn, "R8", "大和高田市")["基準価格_下限"] == "0.75"
    # 太字で同じ字が4回並ぶPDF（奈良県の算定方法）：改定前後のうち改定後の値
    assert standards.parse_threshold_text("一般管理費等×５５５５５５５５％％％％ 一般管理費等×６６６６８８８８％％％％")[
        "基準価格_一般管理費等"] == "0.68"


def test_year_rules(conn):
    rules = dict((k, (v, s)) for k, v, s, _h in standards.year_rules(conn, "R8"))
    assert rules["工事価格の端数単位"] == ("1000", "既定")
    standards.save_year_rules(conn, "R8", {"工事価格の端数単位": "10000", "消費税率": "10"})
    assert calc.load_rules(conn, "R8")["工事価格の端数単位"] == "10000"
    assert conn.execute("SELECT COUNT(*) FROM rule WHERE fy='R8' AND key='消費税率'").fetchone()[0] == 0   # 既定と同じは残さない


def test_delete_project(tmp_path, monkeypatch):
    """工事を消す：明細・単価表などは消え、覚えた答え・落札実績・設計変更の工事は残る。提出済みは消せない。"""
    from pathlib import Path

    from sekisan import audit, importer
    sample = Path(__file__).resolve().parent.parent / "sample"
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    conn = db.connect(tmp_path / "d.sqlite")
    importer.import_master_folder(conn, "R8", sample / "master" / "R8")
    pid = importer.create_project(conn, "消す工事", "R8", importer.parse_design_csv(sample / "設計書.csv"))
    child = importer.create_project(conn, "第1回変更", "R8", [], parent_id=pid, change_no=1)
    conn.execute("INSERT INTO bukake(fy, code, name, spec, unit, per_qty, project_id) VALUES ('R8','D#x/単1','t','','m',1,?)", (pid,))
    conn.execute("INSERT INTO bukake_component(fy, bukake_code, seq, kind, res_code, qty) VALUES ('R8','D#x/単1',1,'労務','R1',1)")
    conn.execute("INSERT INTO bukake_memory(table_key, line_key, qty) VALUES ('k','l',1)")
    conn.execute("INSERT INTO award(date, orderer, name, project_id) VALUES ('2026-11-01','奈良県','消す工事',?)", (pid,))
    conn.execute("INSERT INTO project_schedule(project_id, kind, date) VALUES (?, '開札日', '2026-12-09')", (pid,))
    conn.commit()
    info = calc.delete_summary(conn, pid)
    assert info["items"] > 0 and info["tables"] == 1 and info["changes"] == 1 and info["awards"] == 1
    conn.execute("UPDATE project SET status='提出済' WHERE id=?", (pid,))
    conn.commit()
    with pytest.raises(audit.Locked):
        calc.delete_project(conn, pid)
    conn.execute("UPDATE project SET status='作成中' WHERE id=?", (pid,))
    conn.commit()
    calc.delete_project(conn, pid)
    one = (lambda sql, *a: conn.execute(sql, a).fetchone()[0])
    assert one("SELECT COUNT(*) FROM project WHERE id=?", pid) == 0
    assert one("SELECT COUNT(*) FROM project_item WHERE project_id=?", pid) == 0
    assert one("SELECT COUNT(*) FROM project_schedule WHERE project_id=?", pid) == 0
    assert one("SELECT COUNT(*) FROM bukake_component WHERE bukake_code='D#x/単1'") == 0
    assert one("SELECT COUNT(*) FROM bukake_memory") == 1                                   # 覚えた答えは残る
    assert one("SELECT project_id IS NULL FROM award WHERE name='消す工事'") == 1             # 落札実績は残る
    assert one("SELECT parent_id IS NULL FROM project WHERE id=?", child) == 1               # 設計変更の工事は残る
    assert one("SELECT COUNT(*) FROM audit_log WHERE action='工事を削除'") == 1


def test_admin_mistake_recovery(conn, monkeypatch):
    """最初の管理者を別の名前で登録して締め出されないように。間違えたときは、使われていない管理者なら自分を管理者にできる。"""
    from sekisan import audit, settings
    monkeypatch.setattr(audit, "current_user", lambda: "山田")
    with pytest.raises(ValueError, match="担当者名"):
        audit.set_user(conn, "やまだ", "管理者")          # 最初の管理者は自分の名前で
    # 前の版で間違えて登録してしまった状態
    conn.execute("INSERT INTO app_user(name, role) VALUES ('やまだ', '管理者')")
    conn.commit()
    assert audit.role(conn) == "閲覧"
    with pytest.raises(PermissionError):
        audit.set_user(conn, "佐藤", "確認")
    assert audit.can_recover_admin(conn)
    assert audit.recover_admin(conn) == "山田" and audit.role(conn) == "管理者"
    audit.set_user(conn, "佐藤", "確認")
    audit.delete_user(conn, "やまだ")
    assert {u["name"]: u["role"] for u in audit.users(conn)} == {"山田": "管理者", "佐藤": "確認"}
    # 本当の管理者が使っている（履歴がある）なら、ほかの人は乗っ取れない
    monkeypatch.setattr(audit, "current_user", lambda: "佐藤")
    assert not audit.can_recover_admin(conn)
    with pytest.raises(PermissionError):
        audit.recover_admin(conn)
