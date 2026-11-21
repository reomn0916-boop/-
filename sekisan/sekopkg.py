"""国土交通省「施工パッケージ型積算方式 標準単価表」（国総研・国交省のホームページで公表）を取り込み、
金抜き設計書の施工パッケージ（施N号）に標準単価を当てる。

標準単価表の1行 = 施工パッケージ名称 × 条件区分の組み合わせ（例：土砂等運搬・標準・バックホウ山積0.8m3・土砂・DID無し・0.3km以下）。
金抜き設計書の施工パッケージには条件（J01 土砂等発生現場 現場制約あり など）と機労材の構成比があるので、
名称が同じ行のうち、条件の値がすべて合い、構成比（K・R・Z の合計）が近い行の標準単価を使う。
"""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

from . import audit

INDEX_PAGE = "https://www.mlit.go.jp/tec/koujisekisan_00003.html"
ALLOWED_HOSTS = ("www.mlit.go.jp", "www.nilim.go.jp")
RATIO_LABELS = ("K", "K1", "K2", "K3", "R", "R1", "R2", "R3", "R4", "Z", "Z1", "Z2", "Z3", "Z4", "S")
NUM_RE = re.compile(r"^[\d,]+(\.\d+)?$")

# 標準単価表の基準年月の東京の労務単価（国交省「公共工事設計労務単価」都道府県別の表から。年度 → (適用年月, 単価)）
# 令和8年度の標準単価表は基準年月が令和7年4月 → 令和7年3月から適用の東京都の単価
TOKYO_LABOR = {
    "R8": ("2025-03", {"特殊作業員": 29900, "普通作業員": 26800, "軽作業員": 18500, "造園工": 27100, "法面工": 33400, "とび工": 32900, "石工": 32800, "ブロック工": 30500, "電工": 32600, "鉄筋工": 32600, "鉄骨工": 29600, "塗装工": 34500, "溶接工": 37000, "運転手(特殊)": 30500, "運転手(一般)": 25400, "潜かん工": 37000, "潜かん世話役": 44300, "さく岩工": 39600, "トンネル特殊工": 35800, "トンネル作業員": 31000, "トンネル世話役": 40500, "橋りょう特殊工": 34800, "橋りょう塗装工": 35500, "橋りょう世話役": 40600, "土木一般世話役": 32400, "高級船員": 38200, "普通船員": 30800, "潜水士": 49900, "潜水連絡員": 36500, "潜水送気員": 35400, "山林砂防工": 32100, "軌道工": 57400, "型わく工": 31700, "大工": 30400, "左官": 33000, "配管工": 28600, "はつり工": 30100, "防水工": 36100, "板金工": 34200, "タイル工": 27100, "サッシ工": 32100, "屋根ふき工": 33900, "内装工": 33000, "ガラス工": 31600, "ダクト工": 29600, "保温工": 27700, "設備機械工": 28000, "交通誘導警備員A": 20200, "交通誘導警備員B": 17600}),
}

TITLE_RE = re.compile(r"No\.(\d+)\s*【\s*(.+?)\s*】")
UNIT_RE = re.compile(r"積算単位[:：]\s*(.+?)\s*[＞>]")


def norm(s: str) -> str:
    """比べるための形：全角半角・空白・中点・かっこの違いをなくす"""
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\s･・]", "", s)
    return s.replace("〜", "~").replace("～", "~")


@dataclass
class StdRow:
    no: str
    name: str
    unit: str
    conds: dict[str, str]
    price: float
    ratios: dict[str, float] = field(default_factory=dict)
    page: int = 0

    @property
    def kind_ratio(self) -> dict[str, float]:
        """機械・労務・材料・市場単価（K・R・Z・S）の構成比の合計（%）"""
        return {k: self.ratios.get(k) or 0.0 for k in ("K", "R", "Z", "S")}


# ------------------------------------------------------------------ 読む
def _lines_of(chars: list[dict]) -> str:
    """セルの文字を、上の行から順に左から並べる（折り返したセル）"""
    rows: list[list[dict]] = []
    for c in sorted(chars, key=lambda c: c["top"]):
        if rows and abs(rows[-1][0]["top"] - c["top"]) < 1.8:
            rows[-1].append(c)
        else:
            rows.append([c])
    return "".join("".join(c["text"] for c in sorted(r, key=lambda c: c["x0"])) for r in rows).strip()


def _page_rows(page, pno: int) -> list[StdRow]:
    head = unicodedata.normalize("NFKC", (page.extract_text() or "")[:200])
    m = TITLE_RE.search(head)
    if not m:
        return []
    no, name = m.group(1), m.group(2).strip()
    mu = UNIT_RE.search(head)
    unit = mu.group(1).strip() if mu else ""
    words = page.extract_words(x_tolerance=1.2)
    std = next((w for w in words if w["text"] == "標準単価"), None)
    cond_h = next((w for w in words if w["text"] == "条件区分"), None)
    s_lab = next((w for w in words if w["text"] == "S" and std and w["x0"] > std["x1"]), None)
    if not std or not s_lab:
        return []
    labels = {}
    for w in words:
        if w["text"] in RATIO_LABELS and std["x1"] < w["x0"] <= s_lab["x1"] + 1 and w["text"] not in labels:
            labels[w["text"]] = (w["x0"] + w["x1"]) / 2
    header_bottom = max([w["bottom"] for w in words if w["text"] in labels and abs((w["x0"] + w["x1"]) / 2 - labels[w["text"]]) < 1]
                        + [std["bottom"]]) + 2
    anchors = sorted({round(w["top"], 1) for w in words
                      if NUM_RE.match(w["text"]) and w["top"] > header_bottom
                      and std["x0"] - 8 <= (w["x0"] + w["x1"]) / 2 <= std["x1"] + 8})
    if not anchors:
        return []
    # 罫線から列と行の境目を取る（条件区分の列は、標準単価の列より左の縦線のあいだ）
    def dedupe(vals: list[float]) -> list[float]:
        out: list[float] = []
        for v in sorted(vals):
            if not out or v - out[-1] > 1.5:
                out.append(v)
        return out
    vx = dedupe([e["x0"] for e in page.edges if abs(e["x0"] - e["x1"]) < 0.8 and e["bottom"] - e["top"] > 3])
    hy = dedupe([e["top"] for e in page.edges if abs(e["top"] - e["bottom"]) < 0.8 and e["x1"] - e["x0"] > 100])
    left_lines = [x for x in vx if x <= std["x0"] + 1]
    if len(left_lines) < 2 or not hy:
        return []

    def band(a: float) -> tuple[float, float]:
        above = [y for y in hy if y < a - 1]
        below = [y for y in hy if y > a + 1]
        return (above[-1] if above else a - 15, below[0] if below else page.height - 30)
    first_top = band(anchors[0])[0]
    top0 = (cond_h["bottom"] + 1) if cond_h else first_top - 25
    bounds = []
    for l, r in zip(left_lines, left_lines[1:]):
        hc = [c for c in page.chars if top0 <= c["top"] < first_top - 0.5 and l <= (c["x0"] + c["x1"]) / 2 < r
              and c["text"].strip()]
        bounds.append((l, r, _lines_of(hc)))
    out = []
    for a in anchors:
        band_top, band_bot = band(a)
        line = [w for w in words if abs(w["top"] - a) < 2]
        price = next(float(w["text"].replace(",", "")) for w in line
                     if NUM_RE.match(w["text"]) and std["x0"] - 8 <= (w["x0"] + w["x1"]) / 2 <= std["x1"] + 8)
        ratios: dict[str, float] = {}
        for w in line:
            cx = (w["x0"] + w["x1"]) / 2
            if std["x1"] + 2 < cx <= s_lab["x1"] + 6 and labels:
                lab = min(labels, key=lambda k: abs(labels[k] - cx))
                if NUM_RE.match(w["text"]):
                    ratios[lab] = float(w["text"].replace(",", ""))
        conds = {}
        for left, right, label in bounds:
            cs = [c for c in page.chars if band_top <= c["top"] < band_bot and left <= (c["x0"] + c["x1"]) / 2 < right
                  and c["text"].strip()]
            val = _lines_of(cs)
            if val and val not in ("-", "－"):
                conds[label] = val
        out.append(StdRow(no, name, unit, conds, price, ratios, pno))
    return out


def parse(path: str | Path, progress=None) -> tuple[str, list[StdRow]]:
    """(年度 例: R8, 行)"""
    import pdfplumber
    rows: list[StdRow] = []
    fy = ""
    with pdfplumber.open(str(path)) as pdf:
        n = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            if progress:
                progress(i + 1, n)
            if not fy and i < 4:
                m = re.search(r"令和\s*(\d+)\s*年度", unicodedata.normalize("NFKC", page.extract_text() or ""))
                if m:
                    fy = f"R{int(m.group(1))}"
            if "【" not in (page.extract_text() or "")[:60]:
                continue
            rows.extend(_page_rows(page, i + 1))
    return fy, rows


# ------------------------------------------------------------------ 控える
def _ensure(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS std_base (
        fy TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (fy, kind, name))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS std_package (
        fy TEXT NOT NULL, no TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '',
        conds TEXT NOT NULL DEFAULT '{}', price REAL NOT NULL, ratios TEXT NOT NULL DEFAULT '{}', page INTEGER,
        source TEXT NOT NULL DEFAULT '', PRIMARY KEY (fy, no, seq))""")


def import_rows(conn: sqlite3.Connection, fy: str, rows: list[StdRow], source: str = "") -> int:
    audit.require(conn, "master")
    _ensure(conn)
    with conn:
        conn.execute("DELETE FROM std_package WHERE fy=?", (fy,))
        conn.executemany(
            "INSERT INTO std_package(fy, no, seq, name, unit, conds, price, ratios, page, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(fy, r.no, k, r.name, r.unit, json.dumps(r.conds, ensure_ascii=False), r.price,
              json.dumps(r.ratios), r.page, source) for k, r in enumerate(rows)])
        audit.log(conn, None, "施工パッケージ標準単価表を取り込み", f"{fy} {len(rows)}行（{len({r.no for r in rows})}パッケージ）{source}")
    return len(rows)


def count(conn: sqlite3.Connection, fy: str) -> int:
    _ensure(conn)
    return conn.execute("SELECT COUNT(*) FROM std_package WHERE fy=?", (fy,)).fetchone()[0]


def rows_for(conn: sqlite3.Connection, fy: str, name: str) -> list[StdRow]:
    _ensure(conn)
    out = []
    for r in conn.execute("SELECT * FROM std_package WHERE fy=? ORDER BY seq", (fy,)):
        if norm(r["name"]) == norm(name):
            out.append(StdRow(r["no"], r["name"], r["unit"], json.loads(r["conds"]), r["price"], json.loads(r["ratios"]),
                              r["page"] or 0))
    return out


# ------------------------------------------------------------------ 当てる
def cond_values(conditions: list[str]) -> list[str]:
    """金抜き設計書の条件「J17 運搬距離（km）（DID区間無） 27.5km以下」から値（27.5km以下）を取り出す"""
    out = []
    for c in conditions:
        parts = unicodedata.normalize("NFKC", c).split()
        if parts and re.fullmatch(r"[A-Z]\d+", parts[0]):
            parts = parts[1:]
        if len(parts) >= 2:
            out.append(norm(parts[-1]))
        elif parts:
            out.append(norm(parts[0]))
    return out


@dataclass
class Match:
    row: StdRow | None
    reason: str
    candidates: int = 0


def match(conn: sqlite3.Connection, fy: str, name: str, conditions: list[str],
          kind_ratio: dict[str, float] | None = None) -> Match:
    rows = rows_for(conn, fy, name)
    if not rows:
        return Match(None, f"標準単価表（{fy}）に「{name}」がありません")
    have = cond_values(conditions)
    # まず値がちょうど同じ行。なければ、表記ゆれを見込んで含む／含まれるでも合わせる
    # （「1.0km以下」は「11.0km以下」に含まれるので、ちょうど同じを先に見る）
    ok = [r for r in rows if all(norm(v) in have for v in r.conds.values())]
    if not ok:
        ok = [r for r in rows
              if all(any(norm(v) in h or h in norm(v) for h in have) for v in r.conds.values())]
    if not ok:
        return Match(None, f"「{name}」の条件に合う行がありません（条件：{' / '.join(conditions) or 'なし'}）", len(rows))
    if kind_ratio and len(ok) > 1:   # 構成比（K・R・Z）が近いものを選ぶ
        def dist(r: StdRow) -> float:
            kr = r.kind_ratio
            return sum(abs(kr.get(k, 0) - kind_ratio.get(k, 0)) for k in ("K", "R", "Z", "S"))
        ok.sort(key=dist)
        if dist(ok[0]) > 1.0:
            return Match(None, f"「{name}」の条件に合う行はありますが、構成比が合いません（{len(ok)}行）", len(rows))
        best = [r for r in ok if abs(dist(r) - dist(ok[0])) < 1e-6]
    else:
        best = ok
    # 条件の数が多い行（より細かく合っている行）を優先
    best.sort(key=lambda r: -len(r.conds))
    if len(best) > 1 and len(best[0].conds) == len(best[1].conds) and best[0].price != best[1].price:
        return Match(None, f"「{name}」で条件に合う行が{len(best)}行あり、1つに決められません", len(rows))
    r = best[0]
    return Match(r, f"No.{r.no} {r.name}（{' / '.join(r.conds.values())}）", len(rows))


def _kind_ratio_of(conn: sqlite3.Connection, fy: str, code: str) -> dict[str, float]:
    key = {"機械": "K", "労務": "R", "材料": "Z", "市場単価": "S"}
    out: dict[str, float] = {}
    for c in conn.execute("SELECT kind, ratio FROM package_component WHERE fy=? AND package_code=?", (fy, code)):
        k = key.get(c["kind"], "Z")
        out[k] = out.get(k, 0) + c["ratio"] * 100
    return out


def apply(conn: sqlite3.Connection, project_id: int | None = None, overwrite: bool = False) -> list[tuple[str, str, bool]]:
    """標準単価が入っていない施工パッケージに、標準単価表から単価を入れる。(パッケージ名, 説明, 入れたか)"""
    _ensure(conn)
    q = "SELECT * FROM package WHERE " + ("project_id=?" if project_id is not None else "1=1")
    out = []
    docs: dict[str, object] = {}
    for p in list(conn.execute(q, (project_id,) if project_id is not None else ())):
        if p["std_price"] and not overwrite:
            continue
        conds = json.loads(p["conditions"] or "[]") if "conditions" in p.keys() and p["conditions"] else []
        if not conds:   # 前の版で取り込んだ工事：金抜き設計書のPDFから条件を読み直す
            conds = _conditions_from_source(conn, p, docs)
        m = match(conn, p["fy"], p["name"], conds, _kind_ratio_of(conn, p["fy"], p["code"]))
        if m.row:
            with conn:
                conn.execute("UPDATE package SET std_price=?, note=?, std_ratios=? WHERE fy=? AND code=?",
                             (m.row.price, f"標準単価表 {m.reason}", json.dumps(m.row.kind_ratio), p["fy"], p["code"]))
                audit.log(conn, p["project_id"], "施工パッケージの標準単価", f"{p['name']} {m.row.price:,g} ← {m.reason}")
        out.append((p["name"], m.reason, bool(m.row)))
    return out


# ------------------------------------------------------------------ 国交省のサイトから集める
def _conditions_from_source(conn: sqlite3.Connection, p, docs: dict) -> list[str]:
    pr = conn.execute("SELECT source_file FROM project WHERE id=?", (p["project_id"],)).fetchone() if p["project_id"] else None
    src = pr["source_file"] if pr else ""
    if not src or not Path(src).exists() or not src.lower().endswith(".pdf") or "/" not in p["code"]:
        return []
    if src not in docs:
        from . import kinnuki
        try:
            docs[src] = kinnuki.parse(src)
        except Exception:   # noqa: BLE001 - 読めなければ条件なしのまま
            docs[src] = None
    doc = docs[src]
    tb = doc.tables.get(p["code"].rsplit("/", 1)[-1]) if doc else None
    if not tb:
        return []
    with conn:
        conn.execute("UPDATE package SET conditions=? WHERE fy=? AND code=?",
                     (json.dumps(tb.conditions, ensure_ascii=False), p["fy"], p["code"]))
    return list(tb.conditions)


def find_latest(index_url: str = INDEX_PAGE) -> tuple[str, str] | None:
    """国交省のページから、いちばん新しい年度の標準単価表（被災地向けを除く）の (URL, 年度) を探す。"""
    from html.parser import HTMLParser

    from .autofetch import USER_AGENT, _pace
    import urllib.request

    class Links(HTMLParser):
        def __init__(self):
            super().__init__()
            self.items, self._h, self._t = [], None, []

        def handle_starttag(self, tag, attrs):
            if tag == "a":
                self._h, self._t = dict(attrs).get("href"), []

        def handle_data(self, d):
            if self._h is not None:
                self._t.append(d)

        def handle_endtag(self, tag):
            if tag == "a" and self._h is not None:
                self.items.append((self._h, "".join(self._t)))
                self._h = None
    _pace()
    req = urllib.request.Request(index_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", errors="replace")
    p = Links()
    p.feed(html)
    best = None
    for href, text in p.items:
        t = unicodedata.normalize("NFKC", text)
        m = re.search(r"令和\s*(\d+)\s*年度\s*施工パッケージ型積算方式\s*標準単価表", t)
        if not m or "被災地" in t or not href.lower().endswith(".pdf"):
            continue
        fy = int(m.group(1))
        if not best or fy > best[1]:
            best = (urllib.parse.urljoin(index_url, href), fy)
    return (best[0], f"R{best[1]}") if best else None


def download(url: str, dest: str | Path) -> Path:
    from .autofetch import SiteBusy, USER_AGENT, _pace
    import urllib.request
    host = urllib.parse.urlparse(url).hostname or ""
    if host not in ALLOWED_HOSTS:
        raise ValueError(f"国交省・国総研のサイト以外からはダウンロードしません: {url}")
    _pace()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    if not data.startswith(b"%PDF"):
        raise SiteBusy(url)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / urllib.parse.unquote(url.rsplit("/", 1)[-1])
    path.write_bytes(data)
    return path


# ------------------------------------------------------------------ 東京の基準単価（労務）
def parse_labor_table(path: str | Path, pref: str = "東京都") -> tuple[str, dict[str, float]]:
    """国交省「公共工事設計労務単価」（都道府県別の表）のPDFから、1つの都道府県の職種別単価を読む。
    戻り値は (適用年月 例: 2025-03, {職種: 単価})"""
    import pdfplumber
    out: dict[str, float] = {}
    ym = ""
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            text = unicodedata.normalize("NFKC", page.extract_text() or "")
            if "公共工事設計労務単価" not in text[:120] or pref not in text:
                continue
            m = re.search(r"令和\s*(\d+)\s*年\s*(\d+)\s*月から適用", text)
            if m and not ym:
                ym = f"{int(m.group(1)) + 2018:04d}-{int(m.group(2)):02d}"
            words = page.extract_words(x_tolerance=1)
            hdr = next((w for w in words if w["text"] == "都道府県名"), None)
            row = next((w for w in words if w["text"] == pref), None)
            if not hdr or not row:
                continue
            first = min((w["top"] for w in words if w["top"] > hdr["bottom"] + 2 and NUM_RE.match(w["text"])
                         and "," in w["text"]), default=None)
            if first is None:
                continue
            heads = [w for w in words if hdr["top"] - 12 <= w["top"] < first - 2 and w["x0"] > hdr["x1"]]
            groups: list[list[dict]] = []
            for w in sorted(heads, key=lambda w: w["x0"]):
                for g in groups:
                    if min(x["x1"] for x in g) > w["x0"] - 1 and max(x["x0"] for x in g) < w["x1"] + 1:
                        g.append(w)
                        break
                else:
                    groups.append([w])
            cols = [((min(w["x0"] for w in g) + max(w["x1"] for w in g)) / 2,
                     "".join(w["text"] for w in sorted(g, key=lambda w: w["top"]))) for g in groups]
            if not cols:
                continue
            for w in words:
                if abs(w["top"] - row["top"]) < 2 and NUM_RE.match(w["text"]) and "," in w["text"]:
                    cx = (w["x0"] + w["x1"]) / 2
                    name = min(cols, key=lambda c: abs(c[0] - cx))[1]
                    out.setdefault(unicodedata.normalize("NFKC", name), float(w["text"].replace(",", "")))
    return ym, out


def import_labor_base(conn: sqlite3.Connection, fy: str, prices: dict[str, float], source: str = "") -> int:
    """標準単価表（fy）の基準年月の東京の労務単価を控える。"""
    audit.require(conn, "master")
    _ensure(conn)
    with conn:
        conn.executemany("INSERT OR REPLACE INTO std_base(fy, kind, name, price, source) VALUES (?, '労務', ?, ?, ?)",
                         [(fy, norm(k), v, source) for k, v in prices.items()])
    return len(prices)


def labor_base(conn: sqlite3.Connection, fy: str) -> dict[str, float]:
    _ensure(conn)
    have = {r["name"]: r["price"] for r in conn.execute("SELECT name, price FROM std_base WHERE fy=? AND kind='労務'", (fy,))}
    if not have and fy in TOKYO_LABOR:
        have = {norm(k): v for k, v in TOKYO_LABOR[fy][1].items()}
    return have


def fill_bases(conn: sqlite3.Connection, project_id: int | None = None) -> int:
    """施工パッケージの労務の「東京の基準単価」が空なら、東京の労務単価（基準年月）を入れる。入れた数を返す。"""
    q = ("SELECT c.*, p.fy AS pfy FROM package_component c JOIN package p ON p.fy=c.fy AND p.code=c.package_code "
         "WHERE c.kind='労務' AND c.base_price=0" + (" AND p.project_id=?" if project_id is not None else ""))
    n = 0
    for c in list(conn.execute(q, (project_id,) if project_id is not None else ())):
        base = labor_base(conn, c["fy"])
        names = [c["src"] if "src" in c.keys() else ""]
        if c["res_code"]:
            r = conn.execute("SELECT name FROM master_price WHERE fy=? AND code=? LIMIT 1", (c["fy"], c["res_code"])).fetchone()
            if r:
                names.insert(0, r["name"])
        price = next((base[norm(x)] for x in names if x and norm(x) in base), None)
        if price is None:
            price = next((v for x in names if x for k, v in base.items() if norm(x).startswith(k)), None)
        if price:
            with conn:
                conn.execute("UPDATE package_component SET base_price=? WHERE fy=? AND package_code=? AND seq=?",
                             (price, c["fy"], c["package_code"], c["seq"]))
            n += 1
    return n
