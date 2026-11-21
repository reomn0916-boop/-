"""金抜き設計書（奈良県の積算システムが出す「実施設計書」PDF）を読み、工事・明細・単価表を作る。

読むもの
- 表紙・設計条件：工事名、工事番号、工事箇所、単価地区、適用工種、単価・歩掛の適用年月、諸経費の補正条件
- 設計内訳書：レベル1〜3（工事区分・工種・種別）と細別、規格・単位・数量、参照する単価表（単N号）
- 単価表（1次〜3次）：単N号ごとの名称・規格・単位・割戻数量と、中身（名称・規格・条件・単位・数量、参照する単M号・施N号）
- 構成比（施工パッケージ）：施N号ごとの構成比
金抜きなので単価・金額はなく、歩掛の数量（労務の人数など）も伏せてあることが多い。
伏せてある数量は 0 で作り「数量を入れる」印を付ける（標準歩掛で確かめて入れる）。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

TOTAL_NAMES = {"直接工事費", "純工事費", "現場管理費", "工事原価", "一般管理費等", "工事価格", "消費税相当額", "工事費",
               "本工事費"}
REF_RE = re.compile(r"^(単|施|代|機)$")


def _n(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def _num(s: str) -> float | None:
    t = _n(s).replace(",", "").strip("()（）")
    try:
        return float(t)
    except ValueError:
        return None


def _lines(page) -> list[list[dict]]:
    ws = sorted(page.extract_words(), key=lambda w: (round(w["top"]), w["x0"]))
    rows: list[list[dict]] = []
    for w in ws:
        if rows and abs(rows[-1][0]["top"] - w["top"]) <= 3:
            rows[-1].append(w)
        else:
            rows.append([w])
    return [sorted(r, key=lambda w: w["x0"]) for r in rows]


def _text(ws) -> str:
    return " ".join(w["text"] for w in ws).strip()


def _center(w) -> float:
    return (w["x0"] + w["x1"]) / 2


def _classify(words, centers: dict[str, float]) -> dict[str, float]:
    """数字の語を、見出しの中心にいちばん近い列（数量・単価・金額…）に振り分ける。"""
    out: dict[str, float] = {}
    for w in words:
        v = _num(w["text"])
        if v is None or re.fullmatch(r"\(.*\)", _n(w["text"])):
            continue
        col = min(centers, key=lambda k: abs(centers[k] - _center(w)))
        out.setdefault(col, v)
    return out


def _ref(ws) -> str:
    """「単 13 号」「施 1 号」→ 単13 / 施1"""
    t = [w["text"] for w in ws]
    for i, x in enumerate(t):
        m = re.fullmatch(r"(単|施|代|機)(\d+)号?", x)
        if m:
            return m.group(1) + m.group(2)
        if REF_RE.match(x) and i + 1 < len(t):
            m2 = re.fullmatch(r"(\d+)号?", t[i + 1])
            if m2:
                return x + m2.group(1)
    return ""


@dataclass
class DocItem:
    level1: str
    level2: str
    level3: str
    name: str
    spec: str
    unit: str
    qty: float
    ref: str            # 単1 など
    category: str       # 直接 / 共通仮設 / 現場管理
    price: float | None = None    # 金入り設計書の単価
    amount: float | None = None   # 金入り設計書の金額


@dataclass
class TableLine:
    name: str
    spec: str
    cond: str
    unit: str
    qty: float | None   # None = 金抜きで伏せてある
    ref: str            # 単13 / 施1（ほかの単価表を使う行）
    ratio: float | None = None   # 構成比（施工パッケージ、%）
    std_name: str = ""           # 構成比の「標準」名称
    price: float | None = None   # 金入り設計書の単価
    amount: float | None = None  # 金入り設計書の金額


@dataclass
class UnitTable:
    ref: str            # 単1 / 施1
    order: str          # 1次 / 2次 / 3次 / 構成比
    name: str
    spec: str
    unit: str
    per_qty: float
    lines: list[TableLine] = field(default_factory=list)
    conditions: list[str] = field(default_factory=list)  # J01 時間的制約の有無 無し など
    unit_price: float | None = None  # 金入り設計書のこの単価表の単価（1単位あたり）
    total: float | None = None       # 金入り設計書の「計」


@dataclass
class KinnukiDoc:
    meta: dict[str, str]
    items: list[DocItem]
    tables: dict[str, UnitTable]
    totals: dict[str, float] = field(default_factory=dict)  # 金入り：直接工事費〜工事費

    @property
    def priced(self) -> bool:
        """金入り設計書（単価・金額が入っている）か"""
        return any(i.amount for i in self.items) or bool(self.totals)

    @property
    def fy(self) -> str:
        m = re.search(r"令和\s*(\d+)\s*年度", _n(self.meta.get("年度", "")))
        return f"R{int(m.group(1))}" if m else ""

    @property
    def price_date(self) -> str:
        return _wareki_month(self.meta.get("単価適用年月", ""))


def _wareki_month(s: str) -> str:
    m = re.search(r"令和\s*(\d+)\s*年\s*(\d+)\s*月", _n(s))
    if not m:
        m2 = re.search(r"(20\d\d)\.(\d\d)", s)
        return f"{m2.group(1)}-{m2.group(2)}-01" if m2 else ""
    return f"{2018 + int(m.group(1)):04d}-{int(m.group(2)):02d}-01"


# ---------------------------------------------------------------------- 表紙・設計条件
META_KEYS = ["工事名", "工事番号", "工事箇所", "路線・河川名", "事務所名", "課名・係名", "単価地区", "適用工種",
             "調整区分", "施工地域区分", "現場環境改善費", "単価適用年月", "歩掛適用年月", "損料適用年月", "諸経費適用年月",
             "契約保証", "作成年月日", "工事延長"]


def _meta(pages_lines: list[list[list[dict]]]) -> dict[str, str]:
    meta: dict[str, str] = {}
    for lines in pages_lines[:3]:
        for ln in lines:
            raw = _text(ln)
            flat = re.sub(r"\s+", "", raw)
            if "年度" in flat and "実施設計書" in flat:
                m = re.search(r"令和\d+年度", _n(flat))
                if m:
                    meta["年度"] = m.group(0)
            # 左の欄（〜x=420）と右の欄（x=420〜）に分けて「見出し 値」を読む
            for side in ([w for w in ln if w["x0"] < 420], [w for w in ln if w["x0"] >= 420]):
                if not side:
                    continue
                # 見出しは1文字ずつ離して書かれていることがあるので、値の始まり（x の大きな隙間）で切る
                key_ws, val_ws = [], []
                for w in side:
                    if val_ws or (key_ws and w["x0"] - key_ws[-1]["x1"] > 14 and "".join(x["text"] for x in key_ws)
                                  in META_KEYS + ["契約保証", "前払"]):
                        val_ws.append(w)
                    else:
                        key_ws.append(w)
                key = "".join(w["text"] for w in key_ws)
                val = " ".join(w["text"] for w in val_ws)
                if key in META_KEYS and val and key not in meta:
                    meta[key] = val
                if key.startswith("一般管理費前払") or key == "一般管理費":
                    meta["一般管理費前払補正"] = val or key
    # 工事名は表紙で2つに分かれて書かれていることがある（内訳書の見出しの方を使う）
    return meta


# ---------------------------------------------------------------------- 設計内訳書
def _breakdown(lines: list[list[dict]], state: dict) -> list[DocItem]:
    head = next((i for i, ln in enumerate(lines) if any("工事区分・工種" in w["text"] for w in ln)), None)
    if head is None:
        return []
    hx = {w["text"]: w["x0"] for w in lines[head]}
    hc = {w["text"]: _center(w) for w in lines[head]}
    centers = {"qty": hc.get("数量", 417), "price": hc.get("単価", 492), "amount": hc.get("金額", 575)}
    spec_x = hx.get("規格", 267) - 70          # 規格の列の左端（見出しは中央寄せ）
    unit_x = hx.get("単位", 359) - 15
    qty_x = hx.get("数量", 409) - 20
    price_x = hx.get("単価", 484) - 20
    marker_x = 700
    items: list[DocItem] = []
    cur: dict | None = None

    def close():
        nonlocal cur
        if not cur:
            return
        name, spec, marker, unit, qty = cur["name"], cur["spec"], cur["marker"], cur["unit"], cur["qty"]
        price, amount = cur["price"], cur["amount"]
        cur = None
        if not name:
            return
        lv = re.fullmatch(r"レベル(\d)", marker or "")
        if lv:
            k = int(lv.group(1))
            state["levels"] = state["levels"][:k - 1] + [name]
            if k == 1:
                state["category"] = ("共通仮設" if "共通仮設" in name else "現場管理" if "現場管理" in name else "直接")
                if state["category"] != "直接" and amount is not None:
                    state["totals"][f"{state['category']}費"] = amount
            return
        if name in TOTAL_NAMES or "率計上" in name:
            if amount is not None:
                state["totals"]["共通仮設費（率計上）" if "率計上" in name else name] = amount
            if name == "直接工事費":
                state["levels"] = []
            return
        lv3 = (state["levels"] + ["", "", ""])[:3]
        items.append(DocItem(lv3[0], lv3[1], lv3[2], name, spec, unit, qty or 0.0, marker or "", state["category"],
                             price, amount))

    for ln in lines[head + 1:]:
        txt = _text(ln)
        if re.match(r"R\d\d-[A-Z]\d+-\d+", txt) or "奈良県" in txt and "頁" in txt:
            break  # ページ下の設計書番号から先は読まない
        left = [w for w in ln if w["x0"] < unit_x]
        mid = [w for w in ln if unit_x <= w["x0"] < marker_x]
        right = [w for w in ln if w["x0"] >= marker_x]
        if left:
            if cur and (cur["marker"] or cur["unit"]):
                close()
            if not cur:
                cur = {"name": "", "spec": "", "marker": "", "unit": "", "qty": None, "price": None, "amount": None}
            nm = " ".join(w["text"] for w in left if w["x0"] < spec_x)
            sp = " ".join(w["text"] for w in left if w["x0"] >= spec_x)
            cur["name"] = (cur["name"] + " " + nm).strip() if nm else cur["name"]
            cur["spec"] = (cur["spec"] + " " + sp).strip() if sp else cur["spec"]
        if right and cur is not None:
            t = _text(right)
            m = re.fullmatch(r"レベル\s*(\d)", t)
            cur["marker"] = f"レベル{m.group(1)}" if m else (_ref(right) or cur["marker"])
        if mid and cur is not None:
            u = [w["text"] for w in mid if w["x0"] < qty_x and _num(w["text"]) is None]
            vals = _classify([w for w in mid if w["x0"] >= qty_x - 30], centers)
            if u:
                cur["unit"] = u[0]
            if "qty" in vals:
                cur["qty"] = vals["qty"]
            if "price" in vals:
                cur["price"] = vals["price"]
            if "amount" in vals:
                cur["amount"] = vals["amount"]
            if cur["unit"]:
                close()
    close()
    return items


# ---------------------------------------------------------------------- 単価表・構成比
def _tables(lines: list[list[dict]]) -> list[UnitTable]:
    out: list[UnitTable] = []
    order = ""
    i = 0
    while i < len(lines):
        ln = lines[i]
        t = re.sub(r"\s+", "", _text(ln))
        m = re.match(r"(\d)次単価表", t)
        if m:
            order = f"{m.group(1)}次"
        elif t.startswith("構成比"):
            order = "構成比"
        # 「単 1号 樹木伐採 幹周30cm未満」の見出し
        if ln and ln[0]["text"] in ("単", "施") and len(ln) > 1 and re.fullmatch(r"\d+号", ln[1]["text"]) and ln[0]["x0"] < 40:
            ref = ln[0]["text"] + ln[1]["text"].rstrip("号")
            rest = [w for w in ln[2:] if w["x0"] < 420]
            name = " ".join(w["text"] for w in rest if w["x0"] < 260)
            spec = " ".join(w["text"] for w in rest if w["x0"] >= 260)
            unit, per = "", 1.0
            table_price = None
            # 見出しと同じ行・次の数行に「単位 本 割戻数量 … 100」
            j = i
            col_head = None
            while j < len(lines) and j < i + 6:
                tx = [w["text"] for w in lines[j]]
                if "単位" in tx and "割戻数量" in tx:
                    ux = next(w for w in lines[j] if w["text"] == "単位")["x1"]
                    rw = next(w for w in lines[j] if w["text"] == "割戻数量")
                    rx = rw["x0"]
                    pw = next((w for w in lines[j] if w["text"] == "単価" and w["x0"] > rx), None)
                    unit = next((w["text"] for w in lines[j] if ux < w["x0"] < rx and w["text"] not in ("単価",)), unit)
                    # 「割戻数量 100　単価 1,234」の並び：単価の見出しより左の数字が割戻数量、右が単価
                    px = pw["x0"] if pw else 10_000

                    def pick(ws, vals):
                        for w in ws:
                            v = _num(w["text"])
                            if v is None or w["x0"] <= rx:
                                continue
                            vals.setdefault("per" if w["x1"] <= px else "price", v)
                    vals: dict[str, float] = {}
                    pick(lines[j], vals)
                    if j + 1 < len(lines) and not any(w["text"] == "名称・規格" for w in lines[j + 1]):
                        nxt = lines[j + 1]
                        if all(_num(w["text"]) is not None for w in nxt):  # 数字だけの次の行（割戻数量・単価の値）
                            pick(nxt, vals)
                    per = vals.get("per") or 1.0
                    table_price = vals.get("price")
                if "名称・規格" in tx:
                    col_head = j
                    break
                j += 1
            tb = UnitTable(ref, order, name, spec, unit, per)
            tb.unit_price = table_price
            if col_head is not None:
                i = _table_body(lines, col_head, tb)
                out.append(tb)
                continue
        i += 1
    return out


def _table_body(lines: list[list[dict]], head: int, tb: UnitTable) -> int:
    hx = {w["text"]: w["x0"] for w in lines[head]}
    hc = {w["text"]: _center(w) for w in lines[head]}
    package = "構成比" in hx
    centers = ({"price": hc.get("単価", 612), "amount": hc.get("金額", 690)} if package else
               {"qty": hc.get("数量", 496), "price": hc.get("単価", 568), "amount": hc.get("金額", 658)})
    cond_x = 268 if not package else 10_000
    std_x = hx.get("標準", 322) - 75 if package else 10_000
    unit_x = (hx.get("単位", 432) - 12) if not package else hx.get("標準", 322) + 140
    qty_x = (hx.get("数量", 488) - 5) if not package else hx.get("構成比", 541) - 10
    ref_x = 690
    cur: dict | None = None

    def close():
        nonlocal cur
        if cur and cur["name"]:
            tb.lines.append(TableLine(cur["name"], cur["spec"].strip(), cur["cond"].strip(), cur["unit"], cur["qty"],
                                      cur["ref"], cur["ratio"], cur["std"].strip(), cur["price"], cur["amount"]))
        cur = None

    i = head + 1
    while i < len(lines):
        ln = lines[i]
        t = _text(ln)
        tt = re.sub(r"\s+", "", t)
        if tt.startswith("計") and (tt == "計" or _num(tt[1:].replace(",", "")) is not None):
            close()
            nums = [_num(w["text"]) for w in ln if _num(w["text"]) is not None]
            if nums:
                tb.total = nums[-1]
            i += 1
            continue
        if (tt.startswith("単価") and len(ln) <= 3) or re.match(r"^[\d,.]*円/\S+$", tt):
            close()
            nums = [_num(w["text"]) for w in ln if _num(w["text"]) is not None]
            if nums:
                tb.unit_price = nums[-1]
            i += 1
            continue
        if re.match(r"^J\d\d", tt):
            close()
            tb.conditions.append(t)
            i += 1
            continue
        if (ln[0]["text"] in ("単", "施") and len(ln) > 1 and re.fullmatch(r"\d+号", ln[1]["text"]) and ln[0]["x0"] < 40) \
                or re.match(r"\d次単価表|構成比", tt) or re.match(r"R\d\d-[A-Z]\d+-\d+", tt):
            close()
            return i
        left = [w for w in ln if w["x0"] < min(cond_x, std_x)]
        std = [w for w in ln if std_x <= w["x0"] < unit_x - 40] if package else []
        cond = [w for w in ln if cond_x <= w["x0"] < unit_x]
        mid = [w for w in ln if unit_x <= w["x0"] < ref_x]
        refw = [w for w in ln if w["x0"] >= ref_x]
        if left:
            if cur and cur["done"]:
                close()
            if not cur:
                cur = {"name": "", "spec": "", "cond": "", "unit": "", "qty": None, "ref": "", "ratio": None,
                       "std": "", "done": False, "price": None, "amount": None}
                cur["name"] = left[0]["text"]
                cur["spec"] = " ".join(w["text"] for w in left[1:])
            else:
                cur["spec"] += " " + " ".join(w["text"] for w in left)
        if cur is None:
            i += 1
            continue
        if std:
            cur["std"] += " " + " ".join(w["text"] for w in std)
        if cond:
            cur["cond"] += " " + " ".join(w["text"] for w in cond if w["text"] != "標")
        if refw:
            cur["ref"] = _ref(refw) or cur["ref"]
        if mid:
            words = [w for w in mid if w["text"] != "標"]
            ratio = next((w for w in words if re.fullmatch(r"\(\d+(\.\d+)?\)", _n(w["text"]))), None)
            if ratio:
                cur["ratio"] = _num(ratio["text"])
            u = [w["text"] for w in words if w["x0"] < qty_x and w is not ratio and _num(w["text"]) is None]
            vals = _classify([w for w in words if w is not ratio and w["x0"] >= qty_x - 30], centers)
            if u and not cur["unit"]:
                cur["unit"] = u[0]
            if "qty" in vals:
                cur["qty"] = vals["qty"]
            if "price" in vals:
                cur["price"] = vals["price"]
            if "amount" in vals:
                cur["amount"] = vals["amount"]
            if u and (not package or cur["ratio"] is not None or cur["unit"]):
                # 単位が出た行で1項目が終わる（構成比は「標 単位 (比率)」の次の行にもう一度単位が出る）
                if not package or (package and cur["ratio"] is not None and len(u) == 1 and not ratio):
                    cur["done"] = True
        i += 1
    close()
    return i


# ---------------------------------------------------------------------- まとめ
def is_kinnuki(path: str | Path) -> bool:
    import pdfplumber
    if Path(path).suffix.lower() != ".pdf":
        return False
    with pdfplumber.open(str(path)) as pdf:
        text = "".join((p.extract_text() or "") for p in pdf.pages[:6])
    flat = re.sub(r"\s+", "", text)
    return "設計内訳書" in flat and ("実施設計書" in flat or "単価表" in flat)


def parse(path: str | Path) -> KinnukiDoc:
    import pdfplumber
    with pdfplumber.open(str(path)) as pdf:
        pages = [_lines(p) for p in pdf.pages]
        texts = [re.sub(r"\s+", "", p.extract_text() or "") for p in pdf.pages]
    meta = _meta(pages)
    items: list[DocItem] = []
    state = {"levels": [], "category": "直接", "totals": {}}
    tables: dict[str, UnitTable] = {}
    for lines, flat in zip(pages, texts):
        if "設計内訳書" in flat:
            items.extend(_breakdown(lines, state))
            for ln in lines:  # 内訳書の見出しの工事名（表紙より正確）
                ws = [w for w in ln if w["x0"] < 540]
                if ws and ws[0]["text"] == "工事名" or any(w["text"] == "工事名" for w in ln):
                    nm = " ".join(w["text"] for w in sorted(ln, key=lambda w: w["x0"]) if w["x0"] > 60 and w["x0"] < 540)
                    if nm and "工事名" not in meta.get("_内訳工事名", "x"):
                        meta.setdefault("_内訳工事名", nm)
        elif "単価表" in flat or flat.startswith("構成比"):
            for tb in _tables(lines):
                if tb.ref in tables:  # 2ページにまたがる単価表は続きをつなぐ
                    tables[tb.ref].lines.extend(tb.lines)
                    tables[tb.ref].conditions.extend(tb.conditions)
                else:
                    tables[tb.ref] = tb
    if meta.get("_内訳工事名"):
        meta["工事名"] = meta.pop("_内訳工事名")
    return KinnukiDoc(meta, items, tables, state["totals"])


# ====================================================================== データベースへ取り込む
NEED_QTY = "数量を入れる"     # 金抜きで伏せてある
NEED_RES = "単価を当てる"     # 名称から年度の単価・県の品目を見つけられなかった
NEED_MISC = "諸雑費率を入れる"
FROM_MEMORY = "前回の値"


def _key(*parts: str) -> str:
    return "|".join(re.sub(r"\s+", "", _n(p)) for p in parts)


def doc_id(path: str | Path) -> str:
    """フッターの設計書番号（R08-K236951-00009）。なければファイル名。"""
    import pdfplumber
    with pdfplumber.open(str(path)) as pdf:
        t = pdf.pages[0].extract_text() or ""
    m = re.search(r"R\d\d-[A-Z]\d+-\d+", t)
    return m.group(0) if m else Path(path).stem


def _guess_kind(unit: str) -> str:
    u = _n(unit)
    if u in ("人",):
        return "労務"
    if u in ("日", "時間", "供用日", "h"):
        return "機械"
    return "材料"


def _match_resource(conn, fy: str, line: TableLine):
    """行の名称・規格・単位から、年度の単価または県の品目を探す。(種類, コード, 点数) / None"""
    from . import suggest
    cands = suggest.candidates(conn, fy, line.name, line.spec, line.unit, 5)
    for c in cands:
        kind = c.kind.split("・")[0]
        if kind not in ("労務", "材料", "機械", "市場単価") or c.score < 0.78:
            continue
        # 規格が書いてあるのに大きく違うもの（吐出量10.5m3/min と 15m3/min など）は当てない
        if line.spec and c.spec and suggest.sim(line.spec, c.spec) < 0.8:
            continue
        if line.spec and not c.spec or not line.spec and c.spec and kind != "労務":
            continue
        return kind, c.code, c.score
    return None


def orderer_of(meta: dict) -> str:
    """表紙の事務所名・発注者から市町村名（例：御所市）を取り出す。県の事務所なら空。"""
    for k in ("発注者", "事務所名", "発注機関", "課名・係名"):
        v = _n(meta.get(k, ""))
        if not v or v.startswith("奈良県"):
            continue
        m = re.match(r"^(\S{1,6}?[市町村])", v)
        if m:
            return m.group(1)
    return ""


def import_doc(conn, path: str | Path, work_type: str | None = None, orderer: str = "奈良県") -> dict:
    """金抜き設計書PDFから、工事・明細・単価表（歩掛）・施工パッケージを作る。"""
    import json
    from . import audit, importer
    audit.require(conn, "edit")
    doc = parse(path)
    if not doc.items:
        raise ValueError("設計内訳書の明細が読み取れませんでした")
    did = doc_id(path)
    fy = doc.fy or "R8"
    region = re.sub(r"\s+", "", _n(doc.meta.get("単価地区", "")))
    stats = {"単価表": 0, "施工パッケージ": 0, "資源": 0, NEED_QTY: 0, NEED_RES: 0, NEED_MISC: 0, FROM_MEMORY: 0}

    name = doc.meta.get("工事名") or Path(path).stem
    if orderer == "奈良県":   # 市町村の設計書なら、その市町村を発注者にする（最低制限価格の式が変わる）
        orderer = orderer_of(doc.meta) or orderer
    pid = importer.create_project(conn, name, fy, [], region, work_type or doc.meta.get("適用工種", ""),
                                  str(path), orderer)

    def code_of(ref: str) -> str:
        # 工事ごとに別のコードにする（同じ設計書を2回取り込んでも、前の工事の単価表を書き換えない）
        return f"{did}#{pid}/{ref}"

    items = [importer.DesignItem(k + 1, it.level1, it.level2, it.level3, it.name, it.spec, it.unit, it.qty,
                                 code_of(it.ref) if it.ref else "", it.category)
             for k, it in enumerate(doc.items)]
    conn.executemany(
        "INSERT INTO project_item(project_id, seq, level1, level2, level3, name, spec, unit, qty, bukake_code, category)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [(pid, i.seq, i.level1, i.level2, i.level3, i.name, i.spec, i.unit, i.qty, i.bukake_code, i.category)
         for i in items])
    with conn:
        conn.execute("UPDATE project SET price_date=?, doc_meta=? WHERE id=?",
                     (doc.price_date, json.dumps({**doc.meta, "設計書番号": did}, ensure_ascii=False), pid))
        for ref, tb in doc.tables.items():
            code = code_of(ref)
            tkey = _key(tb.name, tb.spec, tb.unit)
            if ref.startswith("施"):
                stats["施工パッケージ"] += 1
                conn.execute("DELETE FROM package_component WHERE fy=? AND package_code=?", (fy, code))
                seen = conn.execute(
                    "SELECT price, month, src FROM table_price WHERE table_key=? AND cond_key=? AND region IN (?, '')"
                    " ORDER BY month DESC LIMIT 1", (tkey, _key(*tb.conditions), region)).fetchone()
                if seen:  # 前に金入り設計書で同じ条件の施工パッケージの単価を見ている → その単価を使う
                    conn.execute("INSERT OR REPLACE INTO package(fy, code, name, spec, unit, std_price, project_id, note,"
                                 " conditions) VALUES (?,?,?,?,?,?,?,?,?)",
                                 (fy, code, tb.name, tb.spec, tb.unit, seen["price"], pid,
                                  f"{FROM_MEMORY}（{seen['src']} {seen['month'][:7]}）",
                                  json.dumps(tb.conditions, ensure_ascii=False)))
                    stats[FROM_MEMORY] += 1
                    continue
                conn.execute("INSERT OR REPLACE INTO package(fy, code, name, spec, unit, std_price, project_id, conditions)"
                             " VALUES (?,?,?,?,?,?,?,?)", (fy, code, tb.name, tb.spec, tb.unit, 0, pid,
                                                          json.dumps(tb.conditions, ensure_ascii=False)))
                seq = 0
                for ln in tb.lines:
                    if ln.ratio is None:
                        continue
                    seq += 1
                    m = _match_resource(conn, fy, ln)
                    kind, res = (m[0], m[1]) if m else (_guess_kind(ln.unit), "")
                    conn.execute("INSERT INTO package_component(fy, package_code, seq, kind, res_code, ratio, base_price, src)"
                                 " VALUES (?,?,?,?,?,?,?,?)",
                                 (fy, code, seq, kind, res, ln.ratio / 100, 0, f"{ln.std_name or ln.name} {ln.spec}".strip()))
                continue
            stats["単価表"] += 1
            notes = []
            misc_rate = 0.0
            conn.execute("DELETE FROM bukake_component WHERE fy=? AND bukake_code=?", (fy, code))
            seq = 0
            for ln in tb.lines:
                if ln.name.startswith("諸雑費"):
                    known = _misc_rate_of(tb)
                    mem = conn.execute("SELECT qty FROM bukake_memory WHERE table_key=? AND line_key=?",
                                       (tkey, MISC_KEY)).fetchone()
                    if known is not None:
                        misc_rate = known
                    elif mem and mem["qty"] is not None:
                        misc_rate = mem["qty"]
                        notes.append(f"{ln.name}は{FROM_MEMORY}（{misc_rate:g}%）")
                        stats[FROM_MEMORY] += 1
                    else:
                        notes.append(f"{ln.name}は率が伏せてあります（{NEED_MISC}）")
                        stats[NEED_MISC] += 1
                    continue
                seq += 1
                lkey = _key(ln.name, ln.spec, ln.unit)
                mem = conn.execute("SELECT * FROM bukake_memory WHERE table_key=? AND line_key=?", (tkey, lkey)).fetchone()
                note = []
                if ln.ref:
                    kind = "パッケージ" if ln.ref.startswith("施") else "歩掛"
                    res = code_of(ln.ref)
                else:
                    stats["資源"] += 1
                    if mem and mem["res_code"]:
                        kind, res = mem["kind"], mem["res_code"]
                    else:
                        m = _match_resource(conn, fy, ln)
                        kind, res = (m[0], m[1]) if m else (_guess_kind(ln.unit), "")
                        if not m:
                            note.append(NEED_RES)
                            stats[NEED_RES] += 1
                qty = ln.qty
                if qty is None and mem and mem["qty"] is not None:
                    qty = mem["qty"]
                    note.append(FROM_MEMORY)
                    stats[FROM_MEMORY] += 1
                if qty is None:
                    qty = 0.0
                    note.append(NEED_QTY)
                    stats[NEED_QTY] += 1
                src = " ".join(x for x in (ln.name, ln.spec, f"〔{ln.cond}〕" if ln.cond else "", f"({ln.unit})") if x)
                conn.execute("INSERT INTO bukake_component(fy, bukake_code, seq, kind, res_code, qty, src, note)"
                             " VALUES (?,?,?,?,?,?,?,?)", (fy, code, seq, kind, res, qty, src, "・".join(note)))
            if tb.conditions:
                notes.append("条件: " + " / ".join(tb.conditions))
            conn.execute("INSERT OR REPLACE INTO bukake(fy, code, name, spec, unit, per_qty, misc_rate, note, project_id)"
                         " VALUES (?,?,?,?,?,?,?,?,?)",
                         (fy, code, f"{tb.name}（{ref}号）", tb.spec, tb.unit, tb.per_qty or 1, misc_rate,
                          "\n".join(notes), pid))
        audit.log(conn, pid, "金抜き設計書から作成",
                  f"{did} 明細{len(items)}行・単価表{stats['単価表']}・施工パッケージ{stats['施工パッケージ']}"
                  f"（数量を入れる {stats[NEED_QTY]}・単価を当てる {stats[NEED_RES]}）")
    # 施工パッケージの標準単価（国交省の標準単価表を取り込んであれば）と、労務の東京の基準単価
    from . import sekopkg
    stats["標準単価表"] = sum(ok for _n, _r, ok in sekopkg.apply(conn, pid))
    sekopkg.fill_bases(conn, pid)
    stats["project_id"] = pid
    stats["doc_id"] = did
    return stats


MISC_KEY = "__諸雑費率__"


def _misc_rate_of(tb: UnitTable) -> float | None:
    """金入りの単価表から諸雑費率（%）を割り出す：諸雑費の金額 ÷ ほかの行の金額の合計。"""
    misc = [l for l in tb.lines if l.name.startswith("諸雑費") and l.amount is not None]
    base = sum(l.amount for l in tb.lines if not l.name.startswith("諸雑費") and l.amount)
    if not misc or not base:
        return None
    return round(sum(l.amount for l in misc) / base * 100, 2)


def learn(conn, doc: KinnukiDoc, src: str = "") -> dict:
    """金入り設計書から「答え」を覚える。
    - 単価表の各行の数量と当てた資源（次の金抜き設計書で「前回の値」として入る）
    - 単価表ごとの諸雑費率
    - 物価資料などで年度の単価がない品目の単価（設計書実績として計算に使う）
    - 単価表・施工パッケージの1単位あたりの単価（答え合わせ用、施工パッケージは次から単価として使う）"""
    from . import audit
    audit.require(conn, "edit")
    fy = doc.fy or "R8"
    region = re.sub(r"\s+", "", _n(doc.meta.get("単価地区", "")))
    month = doc.price_date
    st = {"数量": 0, "諸雑費率": 0, "単価（設計書実績）": 0, "単価表の単価": 0}
    with conn:
        for ref, tb in doc.tables.items():
            tkey = _key(tb.name, tb.spec, tb.unit)
            if tb.unit_price:
                conn.execute("INSERT OR REPLACE INTO table_price(table_key, cond_key, region, month, price, src)"
                             " VALUES (?,?,?,?,?,?)", (tkey, _key(*tb.conditions), region, month, tb.unit_price, src))
                st["単価表の単価"] += 1
            if ref.startswith("施"):
                continue
            rate = _misc_rate_of(tb)
            if rate is not None:
                conn.execute("INSERT OR REPLACE INTO bukake_memory(table_key, line_key, kind, res_code, qty, updated_at)"
                             " VALUES (?,?,?,?,?,datetime('now','localtime'))", (tkey, MISC_KEY, "", "", rate))
                st["諸雑費率"] += 1
            for ln in tb.lines:
                if ln.name.startswith("諸雑費"):
                    continue
                lkey = _key(ln.name, ln.spec, ln.unit)
                old = conn.execute("SELECT * FROM bukake_memory WHERE table_key=? AND line_key=?", (tkey, lkey)).fetchone()
                kind, res = (old["kind"], old["res_code"]) if old else ("", "")
                m = None if ln.ref else _match_resource(conn, fy, ln)
                if m and not res:
                    kind, res = m[0], m[1]
                if not res and not ln.ref and ln.price:
                    # 年度の単価表に同じものがない資源も、設計書の単価がわかれば「設計書実績」の資源として使う
                    kind, res = _guess_kind(ln.unit), "実績:" + re.sub(r"\s+", " ", _n(f"{ln.name} {ln.spec}")).strip()
                if ln.qty is not None:
                    conn.execute("INSERT OR REPLACE INTO bukake_memory(table_key, line_key, kind, res_code, qty, updated_at)"
                                 " VALUES (?,?,?,?,?,datetime('now','localtime'))", (tkey, lkey, kind, res, ln.qty))
                    st["数量"] += 1
                if ln.price and not ln.ref and res:
                    has = conn.execute("SELECT 1 FROM master_price WHERE fy=? AND code=? AND region IN (?, '')",
                                       (fy, res, region)).fetchone()
                    if not has:  # 年度の単価がない（物価資料の○など）ものだけ、設計書の単価を控える
                        reg = region if conn.execute("SELECT 1 FROM public_item WHERE fy=? AND code=? AND region=?",
                                                     (fy, res, region)).fetchone() else ""
                        conn.execute("INSERT OR REPLACE INTO observed_price(fy, code, region, month, price, name, spec, unit, src)"
                                     " VALUES (?,?,?,?,?,?,?,?,?)",
                                     (fy, res, reg, month, ln.price, ln.name, ln.spec, ln.unit, src))
                        st["単価（設計書実績）"] += 1
        audit.log(conn, None, "金入り設計書から覚えた", f"{src} " + "、".join(f"{k}{v}件" for k, v in st.items()))
    return st


TOTAL_KEYS = {"直接工事費": "直接工事費", "共通仮設費": "共通仮設費", "純工事費": "純工事費", "現場管理費": "現場管理費",
              "工事原価": "工事原価", "一般管理費等": "一般管理費等", "工事価格": "工事価格", "消費税相当額": "消費税相当額",
              "工事費": "工事費計"}


def attach_answers(conn, project_id: int, doc: KinnukiDoc) -> int:
    """金入り設計書の金額を、その工事の答え合わせ（過去の積算結果）に入れる。"""
    rows = []
    for k, it in enumerate(doc.items, 1):
        if it.amount is not None:
            rows.append((project_id, str(k), it.amount))
    for name, key in TOTAL_KEYS.items():
        if name in doc.totals:
            rows.append((project_id, key, doc.totals[name]))
    for ref, tb in doc.tables.items():
        if tb.unit_price is not None:
            rows.append((project_id, ref, tb.unit_price))
    with conn:
        conn.execute("DELETE FROM reference_result WHERE project_id=?", (project_id,))
        conn.executemany("INSERT OR REPLACE INTO reference_result(project_id, key, amount) VALUES (?,?,?)", rows)
    return len(rows)


def _line_key_from_src(src: str) -> str:
    m = re.match(r"(.*?)(?: 〔.*〕)? \((.*)\)$", src or "")
    body, unit = (m.group(1), m.group(2)) if m else (src or "", "")
    parts = body.split(" ", 1)
    return _key(parts[0], parts[1] if len(parts) > 1 else "", unit)


def apply_memory(conn, project_id: int) -> int:
    """覚えている数量・資源・諸雑費率・施工パッケージの単価を、すでにある工事の単価表に入れる
    （「数量を入れる」「単価を当てる」「諸雑費率を入れる」の印が残っているところだけ）。入れた数を返す。"""
    p = conn.execute("SELECT fy, region FROM project WHERE id=?", (project_id,)).fetchone()
    fy, region = p["fy"], p["region"]
    n = 0
    with conn:
        for b in list(conn.execute("SELECT * FROM bukake WHERE fy=? AND project_id=?", (fy, project_id))):
            tkey = _key(re.sub(r"（[単施]\d+号）$", "", b["name"]), b["spec"], b["unit"])
            for c in list(conn.execute("SELECT * FROM bukake_component WHERE fy=? AND bukake_code=?", (fy, b["code"]))):
                note = c["note"] or ""
                if NEED_QTY not in note and NEED_RES not in note:
                    continue
                mem = conn.execute("SELECT * FROM bukake_memory WHERE table_key=? AND line_key=?",
                                   (tkey, _line_key_from_src(c["src"]))).fetchone()
                if not mem:
                    continue
                notes = [x for x in note.split("・") if x]
                qty, res, kind = c["qty"], c["res_code"], c["kind"]
                if NEED_QTY in notes and mem["qty"] is not None:
                    qty = mem["qty"]
                    notes = [x for x in notes if x != NEED_QTY] + [FROM_MEMORY]
                if NEED_RES in notes and mem["res_code"]:
                    res, kind = mem["res_code"], mem["kind"] or kind
                    notes = [x for x in notes if x != NEED_RES]
                if (qty, res) != (c["qty"], c["res_code"]):
                    conn.execute("UPDATE bukake_component SET qty=?, res_code=?, kind=?, note=? WHERE fy=? AND "
                                 "bukake_code=? AND seq=?", (qty, res, kind, "・".join(dict.fromkeys(notes)), fy,
                                                             b["code"], c["seq"]))
                    n += 1
            if NEED_MISC in (b["note"] or ""):
                mem = conn.execute("SELECT qty FROM bukake_memory WHERE table_key=? AND line_key=?",
                                   (tkey, MISC_KEY)).fetchone()
                if mem and mem["qty"] is not None:
                    note = "\n".join(l for l in (b["note"] or "").split("\n") if NEED_MISC not in l)
                    conn.execute("UPDATE bukake SET misc_rate=?, note=? WHERE fy=? AND code=?",
                                 (mem["qty"], note + f"\n諸雑費率は{FROM_MEMORY}（{mem['qty']:g}%）", fy, b["code"]))
                    n += 1
        for k in list(conn.execute("SELECT * FROM package WHERE fy=? AND project_id=? AND std_price=0", (fy, project_id))):
            tkey = _key(k["name"], k["spec"], k["unit"])
            seen = conn.execute("SELECT price, month, src FROM table_price WHERE table_key=? AND region IN (?, '')"
                                " ORDER BY month DESC LIMIT 1", (tkey, region)).fetchone()
            if seen:
                conn.execute("DELETE FROM package_component WHERE fy=? AND package_code=?", (fy, k["code"]))
                conn.execute("UPDATE package SET std_price=?, note=? WHERE fy=? AND code=?",
                             (seen["price"], f"{FROM_MEMORY}（{seen['src']}）", fy, k["code"]))
                n += 1
    return n


def find_project(conn, did: str) -> int | None:
    r = conn.execute("SELECT id FROM project WHERE doc_meta LIKE ? ORDER BY id DESC LIMIT 1", (f"%{did}%",)).fetchone()
    return r["id"] if r else None


def import_priced(conn, path: str | Path, work_type: str | None = None, orderer: str = "奈良県") -> dict:
    """金入り設計書：答えを覚え、同じ設計書の工事があれば答え合わせに金額を入れる（なければ工事を作ってから入れる）。"""
    doc = parse(path)
    if not doc.priced:
        raise ValueError("金額が読み取れませんでした。金入りの設計書ではないようです。")
    did = doc_id(path)
    learned = learn(conn, doc, did)
    pid = find_project(conn, did)
    created = pid is None
    st: dict = {}
    if created:
        st = import_doc(conn, path, work_type, orderer)
        pid = st["project_id"]
    filled = 0 if created else apply_memory(conn, pid)
    n = attach_answers(conn, pid, doc)
    return {"project_id": pid, "created": created, "learned": learned, "answers": n, "import": st, "doc_id": did,
            "filled": filled}


def remember(conn, fy: str, bukake_code: str, seq: int) -> None:
    """単価表の1行に入れた数量・資源を覚える（次の金抜き設計書で同じ単価表が出たら自動で入れる）。"""
    b = conn.execute("SELECT * FROM bukake WHERE fy=? AND code=?", (fy, bukake_code)).fetchone()
    c = conn.execute("SELECT * FROM bukake_component WHERE fy=? AND bukake_code=? AND seq=?",
                     (fy, bukake_code, seq)).fetchone()
    if not b or not c or not c["src"]:
        return
    name = re.sub(r"（[単施]\d+号）$", "", b["name"])
    tkey = _key(name, b["spec"], b["unit"])
    src = c["src"]
    m = re.match(r"(.*?)(?: 〔.*〕)? \((.*)\)$", src)
    body, unit = (m.group(1), m.group(2)) if m else (src, "")
    parts = body.split(" ", 1)
    lkey = _key(parts[0], parts[1] if len(parts) > 1 else "", unit)
    conn.execute("INSERT OR REPLACE INTO bukake_memory(table_key, line_key, kind, res_code, qty, updated_at)"
                 " VALUES (?,?,?,?,?,datetime('now','localtime'))",
                 (tkey, lkey, c["kind"], c["res_code"], c["qty"] if NEED_QTY not in c["note"] else None))


def set_component(conn, fy: str, bukake_code: str, seq: int, qty: float | None = None,
                  res_code: str | None = None, kind: str | None = None) -> None:
    """単価表の1行の数量・資源を直す。直した行の「数量を入れる」「単価を当てる」の印は消え、値は覚える。"""
    from . import audit
    b = conn.execute("SELECT project_id FROM bukake WHERE fy=? AND code=?", (fy, bukake_code)).fetchone()
    audit.require_editable(conn, b["project_id"] if b else None)
    c = conn.execute("SELECT * FROM bukake_component WHERE fy=? AND bukake_code=? AND seq=?",
                     (fy, bukake_code, seq)).fetchone()
    notes = [x for x in (c["note"] or "").split("・") if x]
    with conn:
        if qty is not None:
            conn.execute("UPDATE bukake_component SET qty=? WHERE fy=? AND bukake_code=? AND seq=?",
                         (qty, fy, bukake_code, seq))
            notes = [x for x in notes if x not in (NEED_QTY, FROM_MEMORY)]
        if res_code is not None:
            conn.execute("UPDATE bukake_component SET res_code=?, kind=COALESCE(?, kind) WHERE fy=? AND bukake_code=? "
                         "AND seq=?", (res_code, kind, fy, bukake_code, seq))
            notes = [x for x in notes if x != NEED_RES]
        conn.execute("UPDATE bukake_component SET note=? WHERE fy=? AND bukake_code=? AND seq=?",
                     ("・".join(notes), fy, bukake_code, seq))
        remember(conn, fy, bukake_code, seq)
        audit.log(conn, b["project_id"] if b else None, "単価表の行",
                  f"{bukake_code} {seq}行目" + (f" 数量={qty:g}" if qty is not None else "")
                  + (f" 資源={res_code}" if res_code is not None else ""))
        audit.touch(conn, b["project_id"] if b else None)


def set_table(conn, fy: str, code: str, misc_rate: float | None = None, per_qty: float | None = None,
              std_price: float | None = None) -> None:
    """単価表の諸雑費率・割戻数量、施工パッケージの標準単価を直す。"""
    from . import audit
    tbl = "package" if std_price is not None else "bukake"
    r = conn.execute(f"SELECT project_id, note FROM {tbl} WHERE fy=? AND code=?", (fy, code)).fetchone()
    audit.require_editable(conn, r["project_id"] if r else None)
    with conn:
        if std_price is not None:
            conn.execute("UPDATE package SET std_price=? WHERE fy=? AND code=?", (std_price, fy, code))
        if misc_rate is not None:
            note = "\n".join(l for l in (r["note"] or "").split("\n") if NEED_MISC not in l)
            conn.execute("UPDATE bukake SET misc_rate=?, note=? WHERE fy=? AND code=?", (misc_rate, note, fy, code))
        if per_qty is not None:
            conn.execute("UPDATE bukake SET per_qty=? WHERE fy=? AND code=?", (per_qty, fy, code))
        audit.log(conn, r["project_id"] if r else None, "単価表", f"{code} 諸雑費率={misc_rate} 割戻={per_qty} 標準単価={std_price}")
        audit.touch(conn, r["project_id"] if r else None)


def set_package_component(conn, fy: str, code: str, seq: int, base_price: float | None = None,
                          res_code: str | None = None, kind: str | None = None) -> None:
    from . import audit
    r = conn.execute("SELECT project_id FROM package WHERE fy=? AND code=?", (fy, code)).fetchone()
    audit.require_editable(conn, r["project_id"] if r else None)
    with conn:
        if base_price is not None:
            conn.execute("UPDATE package_component SET base_price=? WHERE fy=? AND package_code=? AND seq=?",
                         (base_price, fy, code, seq))
        if res_code is not None:
            conn.execute("UPDATE package_component SET res_code=?, kind=COALESCE(?, kind) WHERE fy=? AND package_code=? "
                         "AND seq=?", (res_code, kind, fy, code, seq))


@dataclass
class TableStatus:
    code: str
    name: str
    spec: str
    unit: str
    is_package: bool
    todo: int          # 数量を入れる・単価を当てる・諸雑費率 の残り


def tables_of(conn, project_id: int) -> list[TableStatus]:
    p = conn.execute("SELECT fy FROM project WHERE id=?", (project_id,)).fetchone()
    out = []
    for b in conn.execute("SELECT * FROM bukake WHERE fy=? AND project_id=? ORDER BY rowid", (p["fy"], project_id)):
        todo = conn.execute("SELECT COUNT(*) FROM bukake_component WHERE fy=? AND bukake_code=? AND "
                            "(note LIKE ? OR note LIKE ?)", (p["fy"], b["code"], f"%{NEED_QTY}%", f"%{NEED_RES}%")).fetchone()[0]
        todo += NEED_MISC in (b["note"] or "")
        out.append(TableStatus(b["code"], b["name"], b["spec"], b["unit"], False, todo))
    for k in conn.execute("SELECT * FROM package WHERE fy=? AND project_id=? ORDER BY rowid", (p["fy"], project_id)):
        todo = (k["std_price"] == 0) + conn.execute(
            "SELECT COUNT(*) FROM package_component WHERE fy=? AND package_code=? AND (base_price=0 OR res_code='')",
            (p["fy"], k["code"])).fetchone()[0]
        out.append(TableStatus(k["code"], k["name"], k["spec"], k["unit"], True, todo))
    return out
