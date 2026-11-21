"""建設廃棄物・建設発生土の受入価格（奈良県の土木工事設計単価資料）。

県の PDF の「受入価格一覧表」（昼間・夜間・休日）を、処分場ごと・品目ごとの単価として取り込む。
工事ごとに品目の処分場を選ぶと、単価表・明細の「処分:木くず/根」のようなコードにその処分場の単価が入る。
処分場は、安い順と現場からの距離（直線）で比べられる。
"""
from __future__ import annotations

import math
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from . import audit

PREFIX = "処分:"
TIMEBANDS = ("昼間", "夜間", "休日")
TITLE_RE = re.compile(r"^(.*?)(受入|販売)価格【(昼間|夜間|休日)】")
VALID_RE = re.compile(r"適用[:：]?\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*[〜~～-]\s*(\d{4})年(\d{1,2})月(\d{1,2})日")
UNIT_RE = re.compile(r"単位[:：]\s*(円[／/][^）)]+)")
FIXED = ("管理番", "号", "会社名", "処分地場所", "所在市町村", "緯度", "経度", "事務所連絡先", "処分場区", "分", "ページ")
NUM_RE = re.compile(r"^-?[\d,]+(\.\d+)?$")
TEL_RE = re.compile(r"^\d{2,5}-\d{1,4}-\d{3,4}$")


def _n(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


@dataclass
class Row:
    category: str      # 例: 木くず / その他 / 建設発生土
    timeband: str      # 昼間 / 夜間 / 休日
    no: str            # 管理番号
    company: str
    city: str
    lat: float | None
    lon: float | None
    tel: str
    site_type: str     # 中間 / 最終(安定) / 最終(管理)
    item: str          # 例: 根 / コンクリート塊
    price: float
    unit: str          # 円/㎥ など
    factor: float | None = None   # 重量換算（t/㎥）。書いてあるときだけ
    note: str = ""     # ※4t車 など
    page: int = 0


@dataclass
class Doc:
    valid_from: str = ""
    valid_to: str = ""
    rows: list[Row] = field(default_factory=list)

    @property
    def categories(self) -> list[str]:
        return sorted({r.category for r in self.rows})


# ------------------------------------------------------------------ 読む
def is_disposal_pdf(path: str | Path) -> bool:
    """表紙が「〜受入価格」の資料（建設廃棄物等受入価格・建設発生土受入価格）"""
    import pdfplumber
    if Path(path).suffix.lower() != ".pdf":
        return False
    with pdfplumber.open(str(path)) as pdf:
        t = _n("".join((p.extract_text() or "") for p in pdf.pages[:1]))
    return "受入価格" in t and "土木工事設計単価資料" in t


def _category(title: str) -> str:
    """「建設廃棄物（木くず）」→ 木くず、「建設発生土」→ 建設発生土"""
    m = re.search(r"[（(]([^）)]+)[）)]", title)
    return (m.group(1) if m else title).strip() or title


def _cols(words: list[dict], top: float, bottom: float, left: float, right: float) -> list[tuple[float, str]]:
    """見出しの品目の列（中心の x, 名前）。2行に分かれた見出しはつなぐ。"""
    hs = [w for w in words if top <= w["top"] < bottom and w["x0"] >= left and w["x1"] <= right
          and _n(w["text"]) not in TIMEBANDS and "t/" not in _n(w["text"]) and not NUM_RE.match(_n(w["text"]))]
    hs.sort(key=lambda w: (w["x0"], w["top"]))
    groups: list[list[dict]] = []
    for w in hs:
        for g in groups:
            if min(x["x1"] for x in g) > w["x0"] - 1 and max(x["x0"] for x in g) < w["x1"] + 1:
                g.append(w)
                break
        else:
            groups.append([w])
    out = []
    for g in groups:
        g.sort(key=lambda w: w["top"])
        x0, x1 = min(w["x0"] for w in g), max(w["x1"] for w in g)
        out.append(((x0 + x1) / 2, "".join(_n(w["text"]) for w in g)))
    return sorted(out)


def _col_of(x: float, cols: list[tuple[float, str]]) -> int:
    """数字（右寄せ）は見出しの中心より右に出るので、中心が左にある一番近い列にする。"""
    left = [i for i, (c, _) in enumerate(cols) if c <= x + 8]
    if left:
        return left[-1]
    return min(range(len(cols)), key=lambda i: abs(cols[i][0] - x))


def _page_rows(page, pno: int, doc: Doc) -> list[Row]:
    words = page.extract_words(x_tolerance=1.5, keep_blank_chars=False)
    if not words:
        return []
    lines: dict[float, list[dict]] = {}
    for w in words:
        key = next((k for k in lines if abs(k - w["top"]) < 2.5), w["top"])
        lines.setdefault(key, []).append(w)
    tops = sorted(lines)
    first = " ".join(_n(w["text"]) for w in sorted(lines[tops[0]], key=lambda w: w["x0"]))
    m = TITLE_RE.search(first)
    if not m:
        return []
    category, timeband = _category(m.group(1)), m.group(3)
    head_text = _n(" ".join(" ".join(w["text"] for w in lines[t]) for t in tops[:3]))
    mu = UNIT_RE.search(head_text)
    unit = mu.group(1).replace("／", "/") if mu else ""
    mv = VALID_RE.search(head_text)
    if mv and not doc.valid_from:
        y1, m1, d1, y2, m2, d2 = (int(x) for x in mv.groups())
        doc.valid_from, doc.valid_to = f"{y1:04d}-{m1:02d}-{d1:02d}", f"{y2:04d}-{m2:02d}-{d2:02d}"

    def find(text: str) -> dict | None:
        return next((w for w in words if _n(w["text"]) == text), None)
    w_no, w_type, w_page = find("管理番"), find("処分場区"), find("ページ")
    w_comp, w_city = find("会社名"), find("所在市町村")
    if not (w_no and w_type):
        return []
    # データの行：左端に4桁の管理番号
    data_tops = [t for t in tops if any(re.fullmatch(r"\d{4}", _n(w["text"])) and w["x1"] <= w_no["x1"] + 10
                                        for w in lines[t])]
    if not data_tops:
        return []
    head_top = min(w_no["top"], w_type["top"]) - 1
    right = w_page["x0"] - 2 if w_page else page.width
    cols = _cols(words, head_top, data_tops[0] - 1, w_type["x1"] + 2, right)
    if not cols:
        return []
    # 重量換算（t/㎥）の行：見出しとデータの間
    factors: dict[int, float] = {}
    for t in tops:
        if head_top < t < data_tops[0] - 1:
            for w in lines[t]:
                if re.fullmatch(r"\d+(\.\d+)?", _n(w["text"])) and w["x0"] > w_type["x1"]:
                    factors[_col_of((w["x0"] + w["x1"]) / 2 + 20, cols)] = float(_n(w["text"]))
    # 表の下の注記（※は、〜／緯度経度は〜）から下は読まない
    def lead(t: float) -> str:
        return _n(min(lines[t], key=lambda w: w["x0"])["text"])
    foot = min((t for t in tops if t > data_tops[0] and re.match(r"^(※は|緯度経度は)", lead(t))), default=page.height)
    w_lat = find("緯度")
    comp_x = (w_no["x1"] + 5, (w_city["x0"] - 8) if w_city else 190)
    city_x = (comp_x[1], (w_lat["x0"] - 4) if w_lat else 265)
    rows: list[Row] = []
    extra: dict[float, dict[str, list[str]]] = {t: {"company": [], "city": [], "type": [], "note": []} for t in data_tops}
    for t in tops:
        if t in extra or t <= data_tops[0] - 12 or t >= foot:
            continue
        near = min(data_tops, key=lambda d: abs(d - t))
        if abs(near - t) > 9:
            continue
        for w in sorted(lines[t], key=lambda w: w["x0"]):
            x, s = w["x0"], _n(w["text"])
            if s.startswith("※"):
                extra[near]["note"].append(s)
            elif comp_x[0] - 6 <= x < comp_x[1]:
                extra[near]["company"].append((s, t < near))
            elif x < city_x[1] and x >= comp_x[1] - 6:
                extra[near]["city"].append((s, t < near))
            elif w_type["x0"] - 8 <= x <= w_type["x1"] + 4:
                extra[near]["type"].append((s, t < near))

    def joined(inline: list[str], parts: list[tuple[str, bool]]) -> str:
        before = [s for s, up in parts if up]
        after = [s for s, up in parts if not up]
        return "".join(before + inline + after)

    for t in data_tops:
        ws = sorted(lines[t], key=lambda w: w["x0"])
        no = next(_n(w["text"]) for w in ws if re.fullmatch(r"\d{4}", _n(w["text"])))
        comp, city, typ, tel, lat, lon = [], [], [], "", None, None
        prices: dict[int, float] = {}
        for w in ws:
            s, x = _n(w["text"]), w["x0"]
            if s == no and x < comp_x[0]:
                continue
            if TEL_RE.match(s):
                tel = s
            elif re.fullmatch(r"3[2-6]\.\d+", s) and lat is None and x < w_type["x0"]:
                lat = float(s)
            elif re.fullmatch(r"13[3-8]\.\d+", s) and lon is None and x < w_type["x0"]:
                lon = float(s)
            elif x >= w_type["x1"] + 2 and NUM_RE.match(s) and (not w_page or x < w_page["x0"] - 4):
                prices[_col_of((w["x0"] + w["x1"]) / 2, cols)] = float(s.replace(",", ""))
            elif w_type["x0"] - 8 <= x <= w_type["x1"] + 4:
                typ.append(s)
            elif s.startswith("※"):
                extra[t]["note"].append(s)
            elif comp_x[0] - 6 <= x < comp_x[1]:
                comp.append(s)
            elif comp_x[1] - 6 <= x < city_x[1]:
                city.append(s)
        e = extra[t]
        company = joined(comp, e["company"])
        site_type = joined(typ, e["type"])
        for i, price in sorted(prices.items()):
            rows.append(Row(category, timeband, no, company, joined(city, e["city"]), lat, lon, tel, site_type,
                            cols[i][1], price, unit, factors.get(i), " ".join(e["note"]), pno))
    return rows


def parse(path: str | Path, progress=None) -> Doc:
    import pdfplumber
    doc = Doc()
    with pdfplumber.open(str(path)) as pdf:
        n = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            if progress:
                progress(i + 1, n)
            t = _n((page.extract_text() or "")[:120])
            if "価格【" not in t:
                continue
            doc.rows.extend(_page_rows(page, i + 1, doc))
    if not doc.valid_from:
        from . import publicprice
        doc.valid_from = publicprice.effective_date(path)
    return doc


# ------------------------------------------------------------------ 取り込む
def import_doc(conn: sqlite3.Connection, doc: Doc, source: str = "") -> int:
    """同じ適用日・同じ種類の分は入れ替える（訂正後の資料を取り込み直したとき）。"""
    audit.require(conn, "master")
    with conn:
        for c in doc.categories:
            conn.execute("DELETE FROM disposal_price WHERE valid_from=? AND category=?", (doc.valid_from, c))
        conn.executemany(
            "INSERT OR REPLACE INTO disposal_price(valid_from, valid_to, category, timeband, no, company, city, lat, lon,"
            " tel, site_type, item, price, unit, factor, note, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(doc.valid_from, doc.valid_to, r.category, r.timeband, r.no, r.company, r.city, r.lat, r.lon, r.tel,
              r.site_type, r.item, r.price, r.unit, r.factor, r.note, source) for r in doc.rows])
        audit.log(conn, None, "受入価格を取り込み",
                  f"{doc.valid_from}〜 {'・'.join(doc.categories)} {len(doc.rows)}件　{source}")
    return len(doc.rows)


def _latest_from(conn: sqlite3.Connection, category: str, as_of: str = "") -> str:
    r = conn.execute("SELECT MAX(valid_from) FROM disposal_price WHERE category=? AND (?='' OR valid_from<=?)",
                     (category, as_of, as_of)).fetchone()
    return r[0] or ""


def categories(conn: sqlite3.Connection) -> list[str]:
    return [r[0] for r in conn.execute("SELECT DISTINCT category FROM disposal_price ORDER BY category")]


def items(conn: sqlite3.Connection, category: str) -> list[tuple[str, str]]:
    """(品目, 単位)"""
    vf = _latest_from(conn, category)
    return [(r[0], r[1]) for r in conn.execute(
        "SELECT item, MIN(unit) FROM disposal_price WHERE category=? AND valid_from=? GROUP BY item ORDER BY MIN(rowid)",
        (category, vf))]


def distance_km(lat1, lon1, lat2, lon2) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def parse_latlon(text: str) -> tuple[float | None, float | None]:
    """「34.6851, 135.8048」（地図アプリからコピーした形）を読む。"""
    nums = re.findall(r"-?\d+(?:\.\d+)?", _n(text))
    if len(nums) >= 2:
        a, b = float(nums[0]), float(nums[1])
        if 20 < a < 50 and 120 < b < 155:
            return a, b
        if 20 < b < 50 and 120 < a < 155:
            return b, a
    return None, None


@dataclass
class Site:
    no: str
    company: str
    city: str
    site_type: str
    tel: str
    price: float
    unit: str
    km: float | None
    note: str
    lat: float | None
    lon: float | None
    factor: float | None
    valid_from: str


def search(conn: sqlite3.Connection, category: str, item: str, timeband: str = "昼間",
           lat: float | None = None, lon: float | None = None, as_of: str = "") -> list[Site]:
    """その品目を受け入れる処分場を、安い順に（同じ値段なら近い順に）。"""
    vf = _latest_from(conn, category, as_of)
    out = []
    for r in conn.execute("SELECT * FROM disposal_price WHERE category=? AND item=? AND timeband=? AND valid_from=?",
                          (category, item, timeband, vf)):
        km = distance_km(lat, lon, r["lat"], r["lon"])
        out.append(Site(r["no"], r["company"], r["city"], r["site_type"], r["tel"], r["price"], r["unit"],
                        None if km is None else round(km, 1), r["note"], r["lat"], r["lon"], r["factor"], vf))
    out.sort(key=lambda s: (s.price, s.km if s.km is not None else 1e9))
    return out


# ------------------------------------------------------------------ 工事ごとの処分場
def code_of(category: str, item: str) -> str:
    return f"{PREFIX}{category}/{item}"


def split_code(code: str) -> tuple[str, str] | None:
    if not code.startswith(PREFIX) or "/" not in code:
        return None
    c, i = code[len(PREFIX):].split("/", 1)
    return c, i


def choose(conn: sqlite3.Connection, project_id: int, category: str, item: str, no: str,
           timeband: str = "昼間") -> None:
    audit.require_editable(conn, project_id)
    s = next((x for x in search(conn, category, item, timeband) if x.no == no), None)
    if not s:
        raise ValueError(f"{category} {item}（{timeband}）を受け入れる処分場 {no} がありません")
    with conn:
        conn.execute("INSERT OR REPLACE INTO project_disposal(project_id, category, item, timeband, no) VALUES (?,?,?,?,?)",
                     (project_id, category, item, timeband, no))
        audit.log(conn, project_id, "処分場を選択",
                  f"{category} {item}（{timeband}）→ {s.company}（{s.city}） {s.price:,.0f}{s.unit}")


def unchoose(conn: sqlite3.Connection, project_id: int, category: str, item: str) -> None:
    audit.require_editable(conn, project_id)
    with conn:
        conn.execute("DELETE FROM project_disposal WHERE project_id=? AND category=? AND item=?",
                     (project_id, category, item))
        audit.log(conn, project_id, "処分場の選択を外す", f"{category} {item}")


def chosen(conn: sqlite3.Connection, project_id: int, as_of: str = "") -> list[dict]:
    out = []
    for c in conn.execute("SELECT * FROM project_disposal WHERE project_id=? ORDER BY category, item", (project_id,)):
        s = next((x for x in search(conn, c["category"], c["item"], c["timeband"], as_of=as_of) if x.no == c["no"]), None)
        out.append({"category": c["category"], "item": c["item"], "timeband": c["timeband"], "no": c["no"],
                    "code": code_of(c["category"], c["item"]), "site": s})
    return out


def price_for(conn: sqlite3.Connection, project_id: int | None, code: str,
              as_of: str = "") -> tuple[float, str, str, str | None]:
    """(単価, 名称, 単位, 注意)。処分場を選んでいなければ単価0で注意を返す。"""
    ci = split_code(code)
    if not ci:
        return 0.0, code, "", f"処分のコードが読めません: {code}"
    cat, item = ci
    name = f"処分費 {cat} {item}"
    if project_id is None:
        return 0.0, name, "", f"{name}：工事を開いてから処分場を選んでください"
    c = conn.execute("SELECT * FROM project_disposal WHERE project_id=? AND category=? AND item=?",
                     (project_id, cat, item)).fetchone()
    if not c:
        return 0.0, name, "", f"{name}：処分場が選ばれていません（「処分場」の画面で選んでください）"
    s = next((x for x in search(conn, cat, item, c["timeband"], as_of=as_of) if x.no == c["no"]), None)
    if not s:
        return 0.0, name, "", f"{name}：選んだ処分場（{c['no']}）の{c['timeband']}の受入価格が、今の資料にありません"
    unit = s.unit.replace("円/", "") if s.unit else ""
    return s.price, f"{name}（{s.company}）", unit, None


def set_site(conn: sqlite3.Connection, project_id: int, lat: float | None, lon: float | None) -> None:
    audit.require_editable(conn, project_id)
    with conn:
        conn.execute("UPDATE project SET site_lat=?, site_lon=? WHERE id=?", (lat, lon, project_id))
        audit.log(conn, project_id, "現場の位置", "" if lat is None else f"{lat:.5f}, {lon:.5f}")


def candidates(conn: sqlite3.Connection) -> list[str]:
    """単価表の資源コードの候補（処分:種類/品目）"""
    out = []
    for c in categories(conn):
        for item, unit in items(conn, c):
            out.append(f"{code_of(c, item)}　処分費 {c}　{item}　[受入価格・{unit.replace('円/', '')}]")
    return out
