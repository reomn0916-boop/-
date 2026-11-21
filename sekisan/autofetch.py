"""奈良県の公表単価（土木工事設計単価資料）を、県のサイトから自動で集める。

見つけ方は2通り。
1. 単価資料の一覧ページ（設定で登録）にある PDF のリンクを読む
2. 一覧ページが読めないときだけ、県のファイル名の決まり（r0811nara_materialprice.pdf など）から最近の月の PDF を確かめる
県のサイトは短い間に何度も取りに行くと受け付けなくなるので、間をあけて行き、断られたらそこでやめる。
見つけた PDF はダウンロードして、取り込むまで「新しい単価資料」として控える。
取り込むと、年度の単価を最新にしたうえで、その月の単価を「単価改定」（適用日つき）としても残す。
単価の適用日を入れた工事は、その時点の単価で計算される。
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path

from . import audit, publicprice


class SiteBusy(Exception):
    """県のサイトが受け付けなかった（混雑・短い間の取りすぎなど）。続けて取りに行かない。"""

    def __init__(self, url: str = "") -> None:
        super().__init__("県のサイトが今は受け付けていません（混んでいるか、短い間に何度も取りに行ったため）。"
                         "1時間ほどおいて「取り込む」をもう一度押してください。"
                         "急ぐときは、ブラウザで PDF を保存して、この画面にドロップすれば取り込めます。")
        self.url = url


def _pace(tick=None) -> None:
    """前に県のサイトへ行ってから PACE_SECONDS たつまで待つ（tick は待つ間に画面を動かすため）。"""
    import time
    global _last_request
    while (rest := _last_request + PACE_SECONDS - time.monotonic()) > 0:
        if tick:
            tick()
        time.sleep(min(rest, 0.1))
    _last_request = time.monotonic()

ALLOWED_HOSTS = ("www.pref.nara.lg.jp", "www.pref.nara.jp")
EXTRA_HOSTS: tuple[str, ...] = ()   # 試験用（手元のサーバー）。ふだんは空
# 奈良県 県土マネジメント部の「土木工事設計単価資料」の一覧ページ（いつも最初に見る）
DEFAULT_PAGES = ("https://www.pref.nara.lg.jp/n134/66514.html",)
# 県のサイトで単価資料が置かれている場所（ファイル名の決まりから確かめるときに使う）
PROBE_BASES = ("https://www.pref.nara.lg.jp/documents/8708/",)
# ファイル名の決まり：r + 令和の年2桁 + 月2桁 + 種類
NAME_PATTERNS = {
    "資材単価": "r{yy:02d}{mm:02d}nara_materialprice.pdf",
    "労務単価": "r{yy:02d}{mm:02d}_roumuprice.pdf",
    "再生資材単価": "r{yy:02d}{mm:02d}nara_recycleprice.pdf",
    "土砂受入単価": "r{yy:02d}{mm:02d}nara_soilprice.pdf",
}
KIND_WORDS = {"materialprice": "資材単価", "roumuprice": "労務単価", "recycleprice": "再生資材単価",
              "soilprice": "土砂受入単価", "再生資材": "再生資材単価", "土砂": "土砂受入単価",
              "再生材": "再生資材単価", "資材単価": "資材単価", "労務単価": "労務単価", "設計単価": "資材単価"}
# 「訂正前後」は変わったところだけを並べた資料なので取り込まない（「訂正後」が本体）
SKIP_RE = re.compile(r"訂正前後|teiseizengo", re.I)
# 県のサイトに続けて取りに行かない間隔（秒）。短い間に何度も取りに行くと、県のサイトが受け付けなくなる
PACE_SECONDS = 3.0
_last_request = 0.0
FILE_RE = re.compile(r"r(\d{1,2})(\d{2})(?:nara)?_?(materialprice|roumuprice|recycleprice|soilprice)\.pdf$", re.I)
USER_AGENT = "SekisanApp/1.0 (public price collector)"


@dataclass
class Found:
    url: str
    kind: str
    yymm: str          # 例: 0811（令和8年11月）。わからなければ空
    status: str = ""   # 新しい / ダウンロード済み / 取り込み済み
    file: str = ""

    @property
    def label(self) -> str:
        if self.yymm:
            return f"令和{int(self.yymm[:2])}年{int(self.yymm[2:])}月"
        return ""


# ------------------------------------------------------------------ 通信
def _allowed(url: str, extra_hosts: tuple[str, ...] = ()) -> bool:
    u = urllib.parse.urlparse(url)
    return u.scheme in ("https", "http") and (u.hostname or "") in ALLOWED_HOSTS + EXTRA_HOSTS + extra_hosts


BUSY_CODES = (403, 408, 429, 503)


def _open(url: str, method: str = "GET", timeout: float = 15, tick=None):
    import urllib.error
    _pace(tick)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code in BUSY_CODES:
            raise SiteBusy(url) from e
        raise


def _is_block_page(data: bytes) -> bool:
    """県のサイトが断ったときに返すページ（「このページは表示できません」）"""
    head = data[:3000].decode("utf-8", errors="ignore")
    return "表示できません" in head or "インシデント" in head


def exists(url: str, timeout: float = 10) -> bool:
    import urllib.error
    try:
        with _open(url, "HEAD", timeout) as r:
            return 200 <= r.status < 300
    except SiteBusy:
        raise
    except urllib.error.HTTPError as e:
        if e.code not in (403, 405, 501):  # 404 などは「ない」
            return False
    except Exception:  # 接続できないなど
        return False
    try:  # HEAD を受け付けないサーバーは、先頭だけ読んで PDF か確かめる
        with _open(url, "GET", timeout) as r:
            return r.read(4) == b"%PDF"
    except SiteBusy:
        raise
    except Exception:
        return False


class _Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.links.append((self._href, "".join(self._text).strip()))
            self._href = None


def _nfkc(s: str) -> str:
    import unicodedata
    return unicodedata.normalize("NFKC", s or "")


def kind_of(url: str, text: str = "") -> str:
    """ファイル名かリンクの文字から種類を決める（県の新しいサイトはファイル名が日時の数字のことがある）。"""
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1]).lower()
    t = _nfkc(text)
    for w, k in KIND_WORDS.items():
        if w.lower() in name or w in t:
            return k
    return ""


def yymm_of(url: str, text: str = "") -> str:
    m = FILE_RE.search(urllib.parse.unquote(url))
    if m:
        return f"{int(m.group(1)):02d}{m.group(2)}"
    m = re.search(r"令和\s*(\d+)\s*年\s*(\d+)\s*月", _nfkc(text))
    return f"{int(m.group(1)):02d}{int(m.group(2)):02d}" if m else ""


def scan_page(url: str, extra_hosts: tuple[str, ...] = ()) -> list[Found]:
    """一覧ページの PDF リンクのうち、単価資料らしいものを返す。"""
    if not _allowed(url, extra_hosts):
        raise ValueError(f"奈良県のサイト以外は見に行きません: {url}")
    with _open(url) as r:
        raw = r.read()
        html = raw.decode(r.headers.get_content_charset() or "utf-8", errors="replace")
    if _is_block_page(raw) and ".pdf" not in html.lower():
        raise SiteBusy(url)
    p = _Links()
    p.feed(html)
    out = []
    for href, text in p.links:
        full = urllib.parse.urljoin(url, href)
        if not full.lower().split("?")[0].endswith(".pdf") or not _allowed(full, extra_hosts):
            continue
        if SKIP_RE.search(urllib.parse.unquote(full)) or SKIP_RE.search(_nfkc(text)):
            continue
        k = kind_of(full, text)
        if k:
            out.append(Found(full, k, yymm_of(full, text)))
    return out


def recent_months(today: date, back: int = 12) -> list[tuple[int, int]]:
    """今月から back か月前まで（令和の年, 月）"""
    y, m = today.year, today.month
    out = []
    for _ in range(back + 1):
        out.append((y - 2018, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def probe(today: date | None = None, back: int = 12, bases: tuple[str, ...] | None = None,
          kinds: tuple[str, ...] = tuple(NAME_PATTERNS),
          extra_hosts: tuple[str, ...] = ()) -> list[Found]:
    """県のファイル名の決まりから、最近の月の PDF があるかを確かめる。"""
    today = today or date.today()
    cands = []
    for base in bases or PROBE_BASES:
        for yy, mm in recent_months(today, back):
            for k in kinds:
                url = base + NAME_PATTERNS[k].format(yy=yy, mm=mm)
                if _allowed(url, extra_hosts):
                    cands.append(Found(url, k, f"{yy:02d}{mm:02d}"))
    # 県のサイトに負担をかけないよう、1つずつ間をあけて確かめる
    return [f for f in cands if exists(f.url)]


# ------------------------------------------------------------------ 控え
def _ensure(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS fetched_doc (
        url TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT '', yymm TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL DEFAULT '', sha256 TEXT NOT NULL DEFAULT '',
        found_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), imported_at TEXT NOT NULL DEFAULT '',
        fy TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '')""")


def check(conn: sqlite3.Connection, pages: list[str] | None = None, use_probe: bool = True,
          today: date | None = None, bases: tuple[str, ...] | None = None,
          extra_hosts: tuple[str, ...] = ()) -> tuple[list[Found], list[str]]:
    """新しい単価資料を探す。(見つけたもの, うまくいかなかったことの説明) を返す。"""
    _ensure(conn)
    found: dict[str, Found] = {}
    errors: list[str] = []
    busy = False
    for page in dict.fromkeys(list(DEFAULT_PAGES) + list(pages or [])):
        try:
            for f in scan_page(page, extra_hosts):
                found.setdefault(f.url, f)
        except SiteBusy as e:
            errors.append(str(e))
            busy = True
            break
        except Exception as e:
            errors.append(f"{page}: {e}")
    # ファイル名の決まりから確かめるのは、一覧ページが読めなかったときだけ（何十回も取りに行くため）
    if use_probe and not found and not busy:
        try:
            for f in probe(today, bases=bases, extra_hosts=extra_hosts):
                found.setdefault(f.url, f)
        except SiteBusy as e:
            errors.append(str(e))
        except Exception as e:
            errors.append(f"ファイル名の決まりから確かめる: {e}")
    with conn:
        for f in found.values():
            r = conn.execute("SELECT * FROM fetched_doc WHERE url=?", (f.url,)).fetchone()
            if not r:
                conn.execute("INSERT INTO fetched_doc(url, kind, yymm) VALUES (?,?,?)", (f.url, f.kind, f.yymm))
        conn.execute("INSERT OR REPLACE INTO rule(fy, key, value) VALUES ('_', '公表単価_最終確認', ?)",
                     (datetime.now().strftime("%Y-%m-%d %H:%M"),))
    return list_found(conn), errors


def list_found(conn: sqlite3.Connection) -> list[Found]:
    _ensure(conn)
    out = []
    for r in conn.execute("SELECT * FROM fetched_doc ORDER BY yymm DESC, kind"):
        if SKIP_RE.search(urllib.parse.unquote(r["url"])) and not r["imported_at"]:
            continue
        st = "取り込み済み" if r["imported_at"] else ("ダウンロード済み" if r["file"] else "新しい")
        out.append(Found(r["url"], r["kind"], r["yymm"], st, r["file"]))
    return out


def last_checked(conn: sqlite3.Connection) -> str:
    r = conn.execute("SELECT value FROM rule WHERE fy='_' AND key='公表単価_最終確認'").fetchone()
    return r["value"] if r else ""


def download(conn: sqlite3.Connection, url: str, dest: str | Path, extra_hosts: tuple[str, ...] = (),
             tick=None) -> Path:
    if not _allowed(url, extra_hosts):
        raise ValueError(f"奈良県のサイト以外からはダウンロードしません: {url}")
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1]) or "単価資料.pdf"
    path = dest / name
    with _open(url, timeout=120, tick=tick) as r:
        data = r.read()
    if not data.startswith(b"%PDF") and _is_block_page(data):
        raise SiteBusy(url)
    if not data.startswith(b"%PDF"):
        raise ValueError(f"PDF ではありませんでした: {url}")
    path.write_bytes(data)
    _ensure(conn)
    with conn:
        conn.execute("INSERT INTO fetched_doc(url, file, sha256) VALUES (?,?,?) ON CONFLICT(url) DO UPDATE SET "
                     "file=excluded.file, sha256=excluded.sha256", (url, str(path), hashlib.sha256(data).hexdigest()))
    return path


def target_fy(valid_from: str, yymm: str = "") -> str:
    """どの年度の単価にするか。適用日の年度（4月〜翌3月）。ただし3月適用（労務単価）は次の年度の工事で使うので次の年度。"""
    if valid_from:
        y, m = int(valid_from[:4]), int(valid_from[5:7])
    elif yymm:
        y, m = int(yymm[:2]) + 2018, int(yymm[2:])
    else:
        t = date.today()
        y, m = t.year, t.month
    fy = y if m >= 4 else y - 1
    if m == 3:
        fy += 1
    return f"R{fy - 2018}"


def import_file(conn: sqlite3.Connection, path: str | Path, url: str = "", fy: str | None = None,
                progress=None) -> dict:
    """ダウンロードした単価資料を取り込む。年度の単価を最新にし、その月の単価を単価改定（適用日つき）としても残す。"""
    audit.require(conn, "master")
    path = Path(path)
    valid = publicprice.effective_date(path) if path.suffix.lower() == ".pdf" else ""
    r = conn.execute("SELECT yymm FROM fetched_doc WHERE url=?", (url,)).fetchone() if url else None
    fy = fy or target_fy(valid, r["yymm"] if r else "")
    rows = publicprice.preview(conn, fy, publicprice.parse(path, progress=progress))
    kinds = sorted({x.kind for x in rows})
    newer = None
    if valid and kinds:
        newer = conn.execute(
            f"SELECT MAX(valid_from) FROM price_revision WHERE fy=? AND kind IN ({','.join('?' * len(kinds))})",
            (fy, *kinds)).fetchone()[0]
    older = bool(newer and newer > valid)
    # より新しい月をすでに取り込んでいるなら、年度の単価は書き換えず、単価改定としてだけ残す
    if older:
        audit.require(conn, "master")
        with conn:  # 年度の単価にない品目だけは入れる（ある品目は新しい月の単価のまま）
            conn.executemany(
                "INSERT OR IGNORE INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES (?,?,?,?,?,?,?,?)",
                [(fy, x.kind, x.code, x.name, x.spec, x.unit, x.price, x.region) for x in rows if x.price is not None])
            conn.executemany(
                "INSERT OR IGNORE INTO public_item(fy, kind, code, name, spec, unit, region, source, price, ref, file)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(fy, x.kind, x.code, x.name, x.spec, x.unit, x.region, x.source, x.price, x.ref, path.name) for x in rows])
        n = sum(x.price is not None for x in rows)
    else:
        n = publicprice.apply(conn, fy, rows, path.name)
    if valid:
        with conn:
            conn.executemany(
                "INSERT OR REPLACE INTO price_revision(fy, kind, code, region, valid_from, price) VALUES (?,?,?,?,?,?)",
                [(fy, x.kind, x.code, x.region, valid, x.price) for x in rows if x.price is not None])
    if url and valid:  # 年月がわからなかった資料（ファイル名が日時の数字など）は、表紙の適用日で埋める
        _ensure(conn)
        with conn:
            conn.execute("UPDATE fetched_doc SET yymm=? WHERE url=? AND yymm=''",
                         (f"{int(valid[:4]) - 2018:02d}{valid[5:7]}", url))
    result = (f"単価 {n}件（新しい月の単価があるため、{valid} からの単価改定として残しました）" if older else
              f"単価 {n}件（新規・更新 {sum(x.status in ('新規', '更新') for x in rows)}件）")
    if url:
        _ensure(conn)
        with conn:
            conn.execute("UPDATE fetched_doc SET imported_at=datetime('now','localtime'), fy=?, result=? WHERE url=?",
                         (fy, result, url))
    return {"fy": fy, "valid_from": valid, "priced": n, "rows": len(rows), "result": result}
