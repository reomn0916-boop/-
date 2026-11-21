"""基準・ルールの管理：国や発注者が変えたときに、ソフトの中で直せるようにする。

ソフトに入っている値（国交省の諸経費率・施工地域の補正・一般管理費等率の補正・発注者の最低制限価格の式）は「既定」で、
データファイル（全員で共通）に入れた値があればそちらを使う。新しい資料（国交省の積算要領PDF・発注者の要綱）を
読み込んで値を入れ替えることもできる。
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from . import audit, overhead_std

ITEMS = ("共通仮設費", "現場管理費", "一般管理費等")


def _ensure(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS std_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def _get(conn: sqlite3.Connection, key: str):
    _ensure(conn)
    r = conn.execute("SELECT value FROM std_setting WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else None


def _set(conn: sqlite3.Connection, key: str, value, what: str) -> None:
    audit.require(conn, "master")
    _ensure(conn)
    with conn:
        if value is None:
            conn.execute("DELETE FROM std_setting WHERE key=?", (key,))
            audit.log(conn, None, "基準を既定に戻す", what)
        else:
            conn.execute("INSERT OR REPLACE INTO std_setting(key, value) VALUES (?, ?)",
                         (key, json.dumps(value, ensure_ascii=False)))
            audit.log(conn, None, "基準を変更", what)


# ------------------------------------------------------------------ 施工地域の補正
def area_table(conn: sqlite3.Connection) -> list[tuple]:
    """(区分, 共通仮設費率の係数, 現場管理費率の係数, 優先, 対象の工種区分 or None, 対象外 or None)"""
    rows = _get(conn, "area")
    if not rows:
        return list(overhead_std.AREA)
    return [(r[0], float(r[1]), float(r[2]), int(r[3]), set(r[4]) if r[4] else None, set(r[5]) if r[5] else None)
            for r in rows]


def set_area_table(conn: sqlite3.Connection, rows: list[tuple] | None) -> None:
    data = None if rows is None else [[r[0], r[1], r[2], r[3], sorted(r[4]) if r[4] else None,
                                       sorted(r[5]) if r[5] else None] for r in rows]
    _set(conn, "area", data, "施工地域の補正" + ("（既定）" if rows is None else f" {len(rows)}行"))


# ------------------------------------------------------------------ 一般管理費等率の補正
def general_adjust_tables(conn: sqlite3.Connection) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
    """(前払金支出割合 → 係数, 契約保証の言葉 → 加算値)"""
    d = _get(conn, "general_adjust")
    if not d:
        return list(overhead_std.ADVANCE_FACTOR), list(overhead_std.GUARANTEE_ADD)
    return [tuple(x) for x in d["advance"]], [tuple(x) for x in d["guarantee"]]


def set_general_adjust_tables(conn: sqlite3.Connection, advance, guarantee) -> None:
    data = None if advance is None else {"advance": [list(x) for x in advance], "guarantee": [list(x) for x in guarantee]}
    _set(conn, "general_adjust", data, "一般管理費等率の補正")


# ------------------------------------------------------------------ 諸経費率（年度×工種区分）
@dataclass
class Overhead:
    work_type: str
    item: str
    formula: str
    a: float
    b: float
    p_min: float
    p_max: float
    source: str = ""     # マスタ / 国交省（既定）

    def rate(self, p: float) -> float:
        pp = min(max(p, self.p_min), self.p_max)
        v = self.a * pp ** self.b if self.formula == "power" else self.a * math.log10(pp) + self.b
        return round(v + 1e-9, 2)


def overheads(conn: sqlite3.Connection, fy: str) -> list[Overhead]:
    """その年度に使う諸経費率（マスタにあればマスタ、なければ国交省の既定）"""
    out: dict[tuple[str, str], Overhead] = {}
    std = overhead_std.STANDARD.get(fy) or overhead_std.STANDARD[max(overhead_std.STANDARD)]
    for w, it, f, a, b, lo, hi in std:
        out[(overhead_std.key(w), it)] = Overhead(w, it, f, a, b, lo, hi, "国交省（既定）")
    for w in overhead_std.WORK_TYPES:
        f, a, b, lo, hi = overhead_std.GENERAL
        out[(overhead_std.key(w), "一般管理費等")] = Overhead(w, "一般管理費等", f, a, b, lo, hi, "国交省（既定）")
    for r in conn.execute("SELECT * FROM overhead_param WHERE fy=?", (fy,)):
        out[(overhead_std.key(r["work_type"]), r["item"])] = Overhead(r["work_type"], r["item"], r["formula"], r["a"], r["b"],
                                                                     r["p_min"], r["p_max"], "マスタ")
    order = {k: i for i, k in enumerate(ITEMS)}
    return sorted(out.values(), key=lambda o: (overhead_std.WORK_TYPES.index(o.work_type)
                                               if o.work_type in overhead_std.WORK_TYPES else 99, o.work_type,
                                               order.get(o.item, 9)))


def save_overheads(conn: sqlite3.Connection, fy: str, rows: list[Overhead], source: str = "") -> int:
    """年度の諸経費率をマスタに入れる（同じ工種区分・費目は入れ替える）"""
    audit.require(conn, "master")
    for o in rows:
        if o.formula not in ("power", "log") or o.p_min <= 0 or o.p_max < o.p_min:
            raise ValueError(f"{o.work_type} {o.item}：式は power か log、下限・上限は 0 より大きく下限≦上限にしてください")
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO overhead_param(fy, work_type, item, formula, a, b, p_min, p_max) VALUES (?,?,?,?,?,?,?,?)",
            [(fy, o.work_type, o.item, o.formula, o.a, o.b, o.p_min, o.p_max) for o in rows])
        audit.log(conn, None, "諸経費率を変更", f"{fy} {len(rows)}行 {source}")
    return len(rows)


def reset_overheads(conn: sqlite3.Connection, fy: str) -> None:
    audit.require(conn, "master")
    with conn:
        conn.execute("DELETE FROM overhead_param WHERE fy=?", (fy,))
        audit.log(conn, None, "諸経費率を既定に戻す", fy)


# ------------------------------------------------------------------ 国交省「土木工事工事費積算要領及び基準の運用」PDFから読む
@dataclass
class Unyou:
    fy: str = ""
    overheads: list[Overhead] = field(default_factory=list)
    advance: list[tuple[str, float]] = field(default_factory=list)
    guarantee: list[tuple[str, float]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


_BOUND_RE = re.compile(r"([\d,.]+)\s*(万|億)円")


def _yen(num: str, unit: str) -> float:
    return float(num.replace(",", "")) * (1e4 if unit == "万" else 1e8)


def parse_unyou(path_or_text: str | Path) -> Unyou:
    """別表第1（共通仮設費率）・第2（現場管理費率）・第3（一般管理費等率）・第4・第5 を読む。
    各工種区分の A・b は、表に載っている下限・上限の率と式の計算が合うものだけを使う（合わないものは problems へ）。"""
    p = Path(str(path_or_text))
    if p.suffix.lower() == ".pdf" and p.exists():
        import pdfplumber
        with pdfplumber.open(str(p)) as pdf:
            text = "\n".join((pg.extract_text() or "") for pg in pdf.pages)
    else:
        text = str(path_or_text)
    t = unicodedata.normalize("NFKC", text)
    u = Unyou()
    m = re.search(r"令和\s*(\d+)\s*年度", t)
    u.fy = f"R{int(m.group(1))}" if m else ""

    def tables(start: str, end: str, item: str) -> None:
        i = t.find(start)
        if i < 0:
            u.problems.append(f"{item}の表（{start}）が見つかりません")
            return
        me = re.compile(end).search(t, i)
        sec = t[i: me.start() if me else i + 8000]
        parts = re.split(r"\n第\s*(\d)\s*表\s*\n", "\n" + sec)
        prev_name = ""
        for k in range(1, len(parts) - 1, 2):
            body = parts[k + 1]
            bounds = [_yen(a, b) for a, b in _BOUND_RE.findall(body[:200])]
            if len(bounds) < 2:
                u.problems.append(f"{item} 第{parts[k]}表：対象額の境目が読めません")
                continue
            lo, hi = min(bounds), max(bounds)
            for line in body.split("\n"):
                mm = re.match(r"^(.*?)\s*([\d.]+)\s+([\d,]+(?:\.\d+)?)\s+[-−－]\s*([\d.]+)\s+([\d.]+)\s*$", line)
                if not mm:
                    continue
                raw = re.sub(r"\s+", "", mm.group(1))
                name = raw if raw and not re.fullmatch(r"\(\d\)", raw) else prev_name
                if raw and not re.fullmatch(r"\(\d\)", raw):
                    prev_name = re.sub(r"\(\d\)$", "", raw)
                low, a, b, high = float(mm.group(2)), float(mm.group(3).replace(",", "")), -float(mm.group(4)), float(mm.group(5))
                name = name.replace("P・C橋", "PC橋")
                o = Overhead(name, item, "power", a, b, lo, hi, "国交省の積算要領")
                if abs(o.rate(lo) - low) > 0.011 or abs(o.rate(hi) - high) > 0.011:
                    u.problems.append(f"{item} {name}：表の率（{low}・{high}）と式の計算（{o.rate(lo)}・{o.rate(hi)}）が合いません")
                    continue
                u.overheads.append(o)
    tables("別表第1\n共通仮設費率", r"\n\s*\d\)\s*算定式", "共通仮設費")
    tables("別表第2\n工種別現場管理費率", r"\n\s*\d\)\s*算定式", "現場管理費")
    # 第4表の「(1)(2)」の行は、工種区分の名前が行をまたぐので、表の並び（共同溝等・トンネル・下水道）で名前を付け直す
    for item in ("共通仮設費", "現場管理費"):
        rows = [o for o in u.overheads if o.item == item and (o.p_min, o.p_max) == (1e7, 2e9)]
        names = ["共同溝等工事(1)", "共同溝等工事(2)", "トンネル工事", "下水道工事(1)", "下水道工事(2)", "下水道工事(3)"]
        if len(rows) == len(names):
            for o, n in zip(rows, names):
                o.work_type = n
    # 一般管理費等率
    mg = re.search(r"Gp\s*=\s*([-−－]?\s*[\d.]+)\s*[×x]\s*LOG\s*\(\s*Cp\s*\)\s*([+＋\-−－])\s*([\d.]+)", t, re.I)
    mb = re.search(r"工\s*事\s*原\s*価\s*([\d,.]+)\s*(万|億)円以下\s*([\d,.]+)\s*(万|億)円を超え([\d,.]+)\s*(万|億)円以下", t)
    if mg and mb:
        a = float(mg.group(1).replace(" ", "").replace("−", "-").replace("－", "-"))
        b = float(mg.group(3)) * (-1 if mg.group(2) in "-−－" else 1)
        lo, hi = _yen(mb.group(1), mb.group(2)), _yen(mb.group(5), mb.group(6))
        names = sorted({o.work_type for o in u.overheads}, key=lambda w: [o.work_type for o in u.overheads].index(w))
        for w in names:
            u.overheads.append(Overhead(w, "一般管理費等", "log", a, b, lo, hi, "国交省の積算要領"))
    else:
        u.problems.append("一般管理費等率の算定式が見つかりません")
    # 別表第4（前払金支出割合）・第5（契約保証）
    m4 = re.search(r"前払金支出割合区分\s*(.+?)\n\s*補\s*正\s*係\s*数\s*([\d.\s]+)", t)
    if m4:
        labels = re.findall(r"\d+%(?:から|を超え)\d+%以下", m4.group(1).replace(" ", ""))
        nums = [float(x) for x in m4.group(2).split()]
        if labels and len(labels) == len(nums):
            u.advance = list(zip(labels, nums))
    m5 = re.findall(r"(金銭|役務)的保証を必要とする場合[^\n]*?([\d.]+)\s*\n", t)
    if m5:
        u.guarantee = [(k, float(v)) for k, v in m5]
    return u


def apply_unyou(conn: sqlite3.Connection, fy: str, u: Unyou, source: str = "") -> int:
    n = save_overheads(conn, fy, u.overheads, source)
    if u.advance or u.guarantee:
        adv0, gua0 = general_adjust_tables(conn)
        set_general_adjust_tables(conn, u.advance or adv0, u.guarantee or gua0)
    return n


# ------------------------------------------------------------------ 最低制限価格（発注者ごと）
THRESHOLD_KEYS = ("基準価格_直接工事費", "基準価格_共通仮設費", "基準価格_現場管理費", "基準価格_一般管理費等",
                  "基準価格_下限", "基準価格_上限", "基準価格の端数単位")


def threshold_rules(conn: sqlite3.Connection, orderer: str) -> dict[str, tuple[str, str]]:
    """{項目: (値, 出どころ)}。出どころは 設定 / 既定（要綱） / 既定（国のモデル）"""
    from . import calc
    out = {k: (calc.DEFAULT_RULES[k], "既定（国のモデル）") for k in THRESHOLD_KEYS}
    for k, v in calc.ORDERER_PRESETS.get(orderer, {}).items():
        if k in out:
            out[k] = (v, f"既定（{calc.ORDERER_PRESETS[orderer].get('基準価格_出典', '要綱')}）")
    for r in conn.execute("SELECT key, value FROM orderer_rule WHERE orderer=?", (orderer,)):
        if r["key"] in out:
            out[r["key"]] = (r["value"], "設定")
    return out


def save_threshold_rules(conn: sqlite3.Connection, orderer: str, values: dict[str, str], source: str = "") -> None:
    audit.require(conn, "master")
    for k, v in values.items():
        if k not in THRESHOLD_KEYS:
            raise ValueError(f"最低制限価格の項目ではありません: {k}")
        float(v)
    with conn:
        for k, v in values.items():
            conn.execute("INSERT OR REPLACE INTO orderer_rule(orderer, key, value) VALUES (?,?,?)", (orderer, k, str(v)))
        if source:
            conn.execute("INSERT OR REPLACE INTO orderer_rule(orderer, key, value) VALUES (?, '基準価格_出典', ?)",
                         (orderer, source))
        audit.log(conn, None, "最低制限価格の式", f"{orderer} " + "、".join(f"{k}={v}" for k, v in values.items()))


def reset_threshold_rules(conn: sqlite3.Connection, orderer: str) -> None:
    audit.require(conn, "master")
    with conn:
        conn.execute("DELETE FROM orderer_rule WHERE orderer=? AND (key LIKE '基準価格%')", (orderer,))
        audit.log(conn, None, "最低制限価格の式を既定に戻す", orderer)


def _pct(v: str) -> str:
    """「97」「９７」「0.97」「10分の9.7」 → '0.97'"""
    v = v.strip()
    x = float(v)
    return f"{x / 100:g}" if x > 1.5 else f"{x:g}"


def parse_threshold_text(text: str) -> dict[str, str]:
    """要綱・算定方法の文章から、最低制限価格の係数・範囲・端数を読む。見つかったものだけ返す。"""
    t = unicodedata.normalize("NFKC", text or "")
    # 太字で同じ字が4回ずつ並ぶPDF（６６６６８８８８％％％％ → 68%）
    t = re.sub(r"((?:(\d)\2{3})+)(?=%)", lambda m: m.group(1)[::4], t)
    t = re.sub(r"%{2,}", "%", t)
    out: dict[str, str] = {}
    labels = {"基準価格_直接工事費": r"直接工事費", "基準価格_共通仮設費": r"共通仮設費",
              "基準価格_現場管理費": r"現場管理費", "基準価格_一般管理費等": r"一般管理費等?"}
    for key, lab in labels.items():
        cands = []
        for pat, div in ((rf"{lab}(?:の額)?(?:の|に)\s*(\d+(?:\.\d+)?)\s*%", 0), (rf"{lab}\s*[×x]\s*(\d+(?:\.\d+)?)\s*%", 0),
                         (rf"{lab}(?:の額)?\s*(?:に|×)?\s*100\s*分の\s*(\d+(?:\.\d+)?)", 100),
                         (rf"{lab}(?:の額)?\s*(?:に|×)?\s*10\s*分の\s*(\d+(?:\.\d+)?)", 10),
                         (rf"{lab}\s*[×x]\s*(0\.\d+)", 0)):
            for m in re.finditer(pat, t):
                v = m.group(1)
                cands.append((m.start(), f"{float(v) / div:g}" if div else _pct(v)))
        if cands:
            out[key] = max(cands)[1]   # 改定前後が並ぶ資料は、あとに書いてある（改定後の）値
    m = (re.search(r"(\d+(?:\.\d+)?)\s*/\s*10\s*[~～〜から]+\s*(\d+(?:\.\d+)?)\s*/\s*10", t)
         or re.search(r"10\s*分の\s*(\d+(?:\.\d+)?)\s*[~～〜から]+\s*10\s*分の\s*(\d+(?:\.\d+)?)", t))
    if m:
        out["基準価格_下限"], out["基準価格_上限"] = f"{float(m.group(1)) / 10:g}", f"{float(m.group(2)) / 10:g}"
    else:
        m = re.search(r"(\d{2}(?:\.\d+)?)\s*%\s*[~～〜から]+\s*(\d{2}(?:\.\d+)?)\s*%", t)
        if m:
            out["基準価格_下限"], out["基準価格_上限"] = _pct(m.group(1)), _pct(m.group(2))
    if re.search(r"千円未満[^。]{0,6}切(?:り)?捨", t):
        out["基準価格の端数単位"] = "1000"
    elif re.search(r"万円未満[^。]{0,6}切(?:り)?捨", t):
        out["基準価格の端数単位"] = "10000"
    elif re.search(r"円未満[^。]{0,6}切(?:り)?捨", t):
        out["基準価格の端数単位"] = "1"
    return out


def read_text(path: str | Path) -> str:
    from . import koukoku
    return koukoku.read_text(path)


# ------------------------------------------------------------------ 計算ルール（年度）
RULE_HELP = {
    "単価の有効桁数": "単価表の単価の有効桁数", "単価の端数処理": "切捨て / 四捨五入 / 切上げ", "率の小数桁": "諸経費率の小数の桁",
    "工事価格の端数単位": "工事価格の単位（奈良県 1000、国交省 10000）", "共通仮設費_端数単位": "共通仮設費（率計上）の切捨て単位",
    "現場管理費_端数単位": "現場管理費の切捨て単位", "消費税率": "％",
}


def year_rules(conn: sqlite3.Connection, fy: str) -> list[tuple[str, str, str, str]]:
    """(項目, 値, 出どころ, 説明)"""
    from . import calc
    have = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM rule WHERE fy=?", (fy,))}
    return [(k, have.get(k, v), "設定" if k in have else "既定", RULE_HELP.get(k, ""))
            for k, v in calc.DEFAULT_RULES.items() if not k.startswith("基準価格")]


def save_year_rules(conn: sqlite3.Connection, fy: str, values: dict[str, str]) -> None:
    from . import calc
    audit.require(conn, "master")
    with conn:
        for k, v in values.items():
            if k not in calc.DEFAULT_RULES:
                raise ValueError(f"ルールの項目ではありません: {k}")
            if v == calc.DEFAULT_RULES[k]:
                conn.execute("DELETE FROM rule WHERE fy=? AND key=?", (fy, k))
            else:
                conn.execute("INSERT OR REPLACE INTO rule(fy, key, value) VALUES (?,?,?)", (fy, k, v))
        audit.log(conn, None, "計算ルール", f"{fy} " + "、".join(f"{k}={v}" for k, v in values.items()))
