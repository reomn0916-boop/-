"""公表単価の自動収集：県のサイトの代わりに手元に小さなサーバーを立てて確かめる。"""
import functools
import http.server
import threading
from datetime import date
from pathlib import Path

import pytest

from sekisan import autofetch, calc, db, importer, settings

SAMPLE = Path(__file__).resolve().parent.parent / "sample"


@pytest.fixture(autouse=True)
def user(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    settings.save({"user_name": "山田"})


@pytest.fixture
def site(tmp_path):
    """県のサイトの代わり：/list.html（一覧ページ）と documents/8708/ の PDF"""
    from test_more import _nara_pdf
    root = tmp_path / "site"
    docs = root / "documents" / "8708"
    docs.mkdir(parents=True)
    _nara_pdf(docs / "r0811nara_materialprice.pdf", True)      # 地区別の見本（令和8年11月1日より適用）
    _nara_pdf(docs / "r0808nara_materialprice.pdf", False,     # 県下同一の見本（令和8年8月1日より適用）
              "土木工事設計資材単価表（令和８年８月１日より適用）")
    # 県の新しいサイトの形：ファイル名が日時の数字で、種類と年月はリンクの文字にだけある
    other = root / "documents" / "22312"
    other.mkdir(parents=True)
    _nara_pdf(other / "20260317193550.pdf", False, "土木工事設計資材単価表（令和８年９月１日より適用）")
    # 県のサイトが断ったときに返すページ（拡張子は .pdf でも中身は HTML）
    (docs / "busy.pdf").write_text(
        "<html><title>エラー</title><body>このページは表示できません。インシデント ID: 1。</body></html>", encoding="utf-8")
    (root / "list.html").write_text(
        '<html><body><a href="documents/8708/r0811nara_materialprice.pdf">資材単価（令和8年11月）</a>'
        '<a href="/documents/22312/20260317193550.pdf">土木工事設計資材単価表（令和８年９月１日以降適用）（PDF：2MB）</a>'
        '<a href="documents/8708/r0811nara_materialprice_teiseizengo.pdf">令和8年11月改定 土木工事設計資材単価表訂正前後（PDF：300KB）</a>'
        '<a href="documents/8708/other.pdf">関係のない資料</a><a href="https://example.com/x.pdf">外のサイト</a>'
        '</body></html>', encoding="utf-8")
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

        def do_GET(self):
            if "/slow/" in self.path:
                self.send_error(408)
            else:
                super().do_GET()
    handler = functools.partial(Quiet, directory=str(root))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    yield base
    srv.shutdown()


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.sqlite")
    importer.import_master_folder(c, "R8", SAMPLE / "master" / "R8")
    return c


HOST = ("127.0.0.1",)


@pytest.fixture(autouse=True)
def no_real_site(monkeypatch):
    # 試験では本物の県のサイトには行かない
    monkeypatch.setattr(autofetch, "DEFAULT_PAGES", ())
    monkeypatch.setattr(autofetch, "PACE_SECONDS", 0)


def test_names_and_fiscal_year():
    assert autofetch.DEFAULT_PAGES == ()  # （試験中だけ空。ふだんは県の一覧ページ）
    assert autofetch.yymm_of("https://x/20260317193550.pdf", "資材単価（令和８年１１月１日以降適用）") == "0811"
    assert autofetch.kind_of("https://x/20260317193550.pdf", "再生資材単価表") == "再生資材単価"
    assert autofetch.yymm_of("https://x/r0811nara_materialprice.pdf") == "0811"
    assert autofetch.yymm_of("https://x/r0803_roumuprice.pdf") == "0803"
    assert autofetch.kind_of("https://x/r0803_roumuprice.pdf") == "労務単価"
    assert autofetch.target_fy("2026-11-01") == "R8"
    assert autofetch.target_fy("2026-03-01") == "R8"   # 3月適用の労務単価は次の年度の工事で使う
    assert autofetch.target_fy("2027-02-01") == "R8"
    assert autofetch.recent_months(date(2026, 1, 15), 2) == [(8, 1), (7, 12), (7, 11)]
    assert not autofetch._allowed("https://example.com/a.pdf")
    assert autofetch._allowed("https://www.pref.nara.lg.jp/documents/8708/a.pdf")


def test_scan_page_and_probe(site, conn):
    found = autofetch.scan_page(site + "list.html", HOST)
    # 関係のない資料・外のサイト・訂正前後（変わったところだけの資料）は拾わない。
    # 日時の数字のファイル名は、リンクの文字（全角）から種類と年月を読む
    assert [(f.kind, f.yymm) for f in found] == [("資材単価", "0811"), ("資材単価", "0809")]
    hits = autofetch.probe(date(2026, 11, 21), back=4, bases=(site + "documents/8708/",), extra_hosts=HOST)
    assert sorted(f.yymm for f in hits) == ["0808", "0811"]
    with pytest.raises(ValueError):
        autofetch.scan_page("https://example.com/list.html")


def test_check_download_import(site, conn, tmp_path):
    found, errors = autofetch.check(conn, [site + "list.html"], today=date(2026, 11, 21),
                                    bases=(site + "documents/8708/",), extra_hosts=HOST)
    # 一覧ページが読めたので、ファイル名の決まりからは確かめない（0808 は一覧にないので見つからない）
    assert not errors and {f.yymm for f in found} == {"0809", "0811"}
    assert all(f.status == "新しい" for f in found) and autofetch.last_checked(conn)
    new = next(f for f in found if f.yymm == "0811")
    path = autofetch.download(conn, new.url, tmp_path / "dl", HOST)
    assert path.read_bytes().startswith(b"%PDF")
    r = autofetch.import_file(conn, path, new.url)
    assert (r["fy"], r["valid_from"], r["priced"]) == ("R8", "2026-11-01", 1)
    assert conn.execute("SELECT price FROM master_price WHERE fy='R8' AND code='Z002010012' AND region='2地区'"
                        ).fetchone()[0] == 28000
    assert conn.execute("SELECT COUNT(*) FROM price_revision WHERE fy='R8' AND valid_from='2026-11-01'").fetchone()[0] == 1
    st = {f.yymm: f.status for f in autofetch.list_found(conn)}
    assert st == {"0811": "取り込み済み", "0809": "新しい"}
    # 古い月を後から取り込んでも、年度の単価は新しい月のまま（単価改定としてだけ残る）
    old = next(f for f in found if f.yymm == "0809")
    r2 = autofetch.import_file(conn, autofetch.download(conn, old.url, tmp_path / "dl", HOST), old.url)
    assert "単価改定として残しました" in r2["result"]
    assert conn.execute("SELECT price FROM master_price WHERE fy='R8' AND code='Z002010012' AND region='2地区'"
                        ).fetchone()[0] == 28000


def test_price_by_date(site, conn, tmp_path):
    """単価の適用日を入れた工事は、その時点の単価で計算される。"""
    found, _ = autofetch.check(conn, [], today=date(2026, 11, 21), bases=(site + "documents/8708/",), extra_hosts=HOST)
    f = next(x for x in found if x.yymm == "0811")
    autofetch.import_file(conn, autofetch.download(conn, f.url, tmp_path / "dl", HOST), f.url)
    c = calc.Calculator(conn, "R8", "2地区", as_of="2026-11-05")
    assert c.resource_price("材料", "Z002010012")[0] == 28000


def test_month_from_cover_when_unknown(site, conn, tmp_path):
    """リンクの文字にも年月がない資料は、取り込んだあとPDFの表紙の適用日で年月が入る。"""
    url = site + "documents/22312/20260317193550.pdf"
    autofetch._ensure(conn)
    conn.execute("INSERT INTO fetched_doc(url, kind, yymm) VALUES (?, '資材単価', '')", (url,))
    conn.commit()
    r = autofetch.import_file(conn, autofetch.download(conn, url, tmp_path / "dl", HOST), url)
    assert r["valid_from"] == "2026-09-01" and r["fy"] == "R8"
    assert conn.execute("SELECT yymm FROM fetched_doc WHERE url=?", (url,)).fetchone()[0] == "0809"


def test_site_busy(site, conn, tmp_path):
    """県のサイトが断ったら、はっきり伝えて、続けて取りに行かない。"""
    with pytest.raises(autofetch.SiteBusy, match="1時間ほどおいて"):
        autofetch.download(conn, site + "documents/8708/busy.pdf", tmp_path / "dl", HOST)
    with pytest.raises(autofetch.SiteBusy):
        autofetch.download(conn, site + "slow/r0811nara_materialprice.pdf", tmp_path / "dl", HOST)
    found, errors = autofetch.check(conn, [site + "slow/list.html"], bases=(site + "documents/8708/",),
                                    today=date(2026, 11, 21), extra_hosts=HOST)
    # 一覧ページで断られたら、ファイル名の決まりから何十回も確かめには行かない
    assert found == [] and len(errors) == 1 and "受け付けていません" in errors[0]


def test_pace(monkeypatch):
    """県のサイトへは間をあけて行く。"""
    import time
    monkeypatch.setattr(autofetch, "PACE_SECONDS", 0.3)
    ticks = []
    autofetch._pace()
    t = time.monotonic()
    autofetch._pace(lambda: ticks.append(1))
    assert time.monotonic() - t >= 0.25 and ticks
