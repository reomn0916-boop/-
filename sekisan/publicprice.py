"""① 公表単価の取り込み：奈良県の設計単価や公共工事設計労務単価の Excel・CSV・PDF を読み、
年度マスタ（単価）に入れる。

対応する表の形
- 縦長の表：見出し行に「名称」「単価」（あれば コード・規格・単位）がある一覧
- 労務単価の表：見出し行に職種（普通作業員・特殊作業員…）が並び、行が都道府県になっている表
  → 指定した都道府県（既定は奈良）の行だけを労務単価として取り込む
"""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from . import audit
from .importer import read_text

NAME_KEYS = ("名称", "品名", "品目", "資材名", "職種", "工種")
PRICE_KEYS = ("単価", "価格", "金額", "円")
CODE_KEYS = ("コード", "番号", "No", "NO", "Ｎｏ")
SPEC_KEYS = ("規格", "寸法", "仕様", "形状")
UNIT_KEYS = ("単位",)
LABOR_HINTS = ("普通作業員", "特殊作業員", "軽作業員", "とび工", "鉄筋工", "運転手", "型わく工", "大工", "左官")


def _n(s) -> str:
    """セルの値（表記はそのまま。全角かっこなどを変えると既存の名称と合わなくなる）"""
    return ("" if s is None else str(s)).strip()


def _k(s) -> str:
    """見出しの判定用（全角・半角をそろえる）"""
    return unicodedata.normalize("NFKC", s or "")


def _price(s) -> float | None:
    t = _k(_n(s)).replace(",", "").replace("円", "").replace("¥", "")
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def read_table(path: str | Path) -> list[list[str]]:
    """Excel（最初のシート）・CSV・PDF（表）を行の並びにする。"""
    path = Path(path)
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(path, data_only=True, read_only=True)
        rows = []
        for ws in wb.worksheets:
            for r in ws.iter_rows(values_only=True):
                rows.append([_n(c) for c in r])
            if rows:
                break
        return rows
    if ext == ".csv":
        import csv
        import io
        return [[_n(c) for c in r] for r in csv.reader(io.StringIO(read_text(path)))]
    if ext == ".pdf":
        import pdfplumber
        rows = []
        with pdfplumber.open(str(path)) as pdf:
            for page in pdf.pages:
                for t in page.extract_tables():
                    rows.extend([_n(c) for c in r] for r in t)
        return rows
    raise ValueError(f"読めないファイルの種類です: {ext}（Excel・CSV・PDF に対応）")


@dataclass
class PriceRow:
    kind: str
    code: str
    name: str
    spec: str
    unit: str
    price: float
    region: str = ""
    status: str = ""   # 新規 / 更新 / 同じ / 物価資料 / 未設定（取り込み前の確認用）
    old_price: float | None = None
    source: str = "県単価"   # 県単価 / 物価資料（○） / 未設定（空欄）
    ref: str = ""


def _find_col(header: list[str], keys) -> int | None:
    for i, h in enumerate(header):
        if any(_k(k) in _k(h) for k in keys):
            return i
    return None


def parse_long(rows: list[list[str]], kind: str) -> list[PriceRow]:
    for hi, header in enumerate(rows[:30]):
        cn, cp = _find_col(header, NAME_KEYS), _find_col(header, PRICE_KEYS)
        if cn is not None and cp is not None and cn != cp:
            cc, cs, cu = _find_col(header, CODE_KEYS), _find_col(header, SPEC_KEYS), _find_col(header, UNIT_KEYS)
            out = []
            for r in rows[hi + 1:]:
                def g(i):
                    return r[i] if i is not None and i < len(r) else ""
                name, price = g(cn), _price(g(cp))
                if not name or price is None:
                    continue
                out.append(PriceRow(kind, g(cc), name, g(cs), g(cu), price))
            return out
    return []


def parse_labor_wide(rows: list[list[str]], prefecture: str = "奈良") -> list[PriceRow]:
    for hi, header in enumerate(rows[:30]):
        hits = [i for i, h in enumerate(header) if any(k in _k(h) for k in LABOR_HINTS)]
        if len(hits) < 2:
            continue
        for r in rows[hi + 1:]:
            if r and any(prefecture in c for c in r[:2]):
                out = []
                for i, h in enumerate(header):
                    if i >= len(r) or not h or "都道府県" in h or "地域" in h or prefecture in r[i]:
                        continue
                    p = _price(r[i])
                    if p is not None and p > 1000:  # 日額の単価だけ（番号などを拾わない）
                        out.append(PriceRow("労務", "", h, "", "人", p))
                return out
    return []


def parse(path: str | Path, kind: str = "材料", prefecture: str = "奈良", progress=None) -> list[PriceRow]:
    """奈良県の単価資料PDFなら専用の読み方（種類はコードから決まる）、それ以外は表の形から読む。"""
    if is_loss_pdf(path):
        return parse_loss_pdf(path, progress)
    if is_nara_pdf(path):
        return [PriceRow(i.kind, i.code, i.name, i.spec, i.unit, i.price, i.region, source=i.source, ref=i.ref)
                for i in parse_nara_pdf(path, progress)]
    rows = read_table(path)
    if kind == "労務":
        wide = parse_labor_wide(rows, prefecture)
        if wide:
            return wide
    return parse_long(rows, kind)


def preview(conn: sqlite3.Connection, fy: str, rows: list[PriceRow], region: str = "") -> list[PriceRow]:
    """コードがない行は、同じ種類・名称・規格の既存コードを使う（なければ作る）。新規か更新かも付ける。"""
    used = {r["code"] for r in conn.execute("SELECT code FROM master_price WHERE fy=?", (fy,))}
    prefix = {"労務": "L", "材料": "Z", "機械": "M", "市場単価": "K"}
    n = 1
    for r in rows:
        r.region = r.region or region
        if r.price is None:
            r.status = r.source
            continue
        if not r.code:
            hit = conn.execute("SELECT code FROM master_price WHERE fy=? AND kind=? AND name=? AND spec=? LIMIT 1",
                               (fy, r.kind, r.name, r.spec)).fetchone()
            if hit:
                r.code = hit["code"]
            else:
                while f"{prefix.get(r.kind, 'X')}{n:04d}" in used:
                    n += 1
                r.code = f"{prefix.get(r.kind, 'X')}{n:04d}"
                used.add(r.code)
        old = conn.execute("SELECT price FROM master_price WHERE fy=? AND kind=? AND code=? AND region=?",
                           (fy, r.kind, r.code, region)).fetchone()
        r.old_price = old["price"] if old else None
        r.status = "新規" if old is None else ("同じ" if abs(old["price"] - r.price) < 0.005 else "更新")
    return rows


def apply(conn: sqlite3.Connection, fy: str, rows: list[PriceRow], source: str = "") -> int:
    """単価がある行は年度の単価に入れる。単価がない行（○＝物価資料・空欄）は「公表品目」として名称・規格だけ控え、
    当てはめ候補と「物価資料で調べる単価」の一覧に使う。戻り値は単価を入れた件数。"""
    audit.require(conn, "master")
    priced = [r for r in rows if r.price is not None]
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES (?,?,?,?,?,?,?,?)",
            [(fy, r.kind, r.code, r.name, r.spec, r.unit, r.price, r.region) for r in priced],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO public_item(fy, kind, code, name, spec, unit, region, source, price, ref, file)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [(fy, r.kind, r.code, r.name, r.spec, r.unit, r.region, r.source, r.price, r.ref, source) for r in rows],
        )
        changed = sum(r.status in ("新規", "更新") for r in priced)
        audit.log(conn, None, f"{fy}年度 公表単価を取り込み",
                  f"単価あり {len(priced)}件（新規・更新 {changed}件）・物価資料 {sum(r.source == FROM_BOOK for r in rows)}件"
                  f"・空欄 {sum(r.source == BLANK for r in rows)}件　{source}")
    return len(priced)


# ---------------------------------------------------------------- 物価資料で調べる単価
@dataclass
class BookItem:
    kind: str
    code: str
    name: str
    spec: str
    unit: str
    region: str
    ref: str
    used_in: str          # どの明細・歩掛で使うか


def book_items_for(conn: sqlite3.Connection, project_id: int) -> list[BookItem]:
    """この工事で使うのに年度の単価がなく、県の資料で「○（物価資料）」になっている品目。"""
    from . import calc
    p = conn.execute("SELECT fy, region FROM project WHERE id=?", (project_id,)).fetchone()
    res = calc.calculate(conn, project_id)
    want: dict[str, set[str]] = {}
    for it in res.items:
        if it.code:
            want.setdefault(it.code, set()).add(f"明細{it.seq}")
        if it.detail:
            for l in it.detail.lines:
                if l.source == "不明" and l.code:
                    want.setdefault(l.code, set()).add(f"明細{it.seq}（{it.detail.code}の中）")
    out = []
    for code, used in want.items():
        has = conn.execute("SELECT 1 FROM master_price WHERE fy=? AND code=? AND region IN (?, '')",
                           (p["fy"], code, p["region"])).fetchone() or conn.execute(
            "SELECT 1 FROM observed_price WHERE fy=? AND code=? AND region IN (?, '')",
            (p["fy"], code, p["region"])).fetchone()
        if has:
            continue
        r = conn.execute("SELECT * FROM public_item WHERE fy=? AND code=? AND region IN (?, '') AND price IS NULL"
                         " ORDER BY region DESC LIMIT 1", (p["fy"], code, p["region"])).fetchone()
        if r:
            out.append(BookItem(r["kind"], code, r["name"], r["spec"], r["unit"], r["region"], r["ref"],
                                "、".join(sorted(used))))
    return out


def set_book_price(conn: sqlite3.Connection, fy: str, kind: str, code: str, price: float, region: str = "",
                   note: str = "物価資料") -> None:
    """物価資料（積算資料・建設物価）で調べた単価を年度の単価に入れる。"""
    audit.require(conn, "master")
    r = conn.execute("SELECT * FROM public_item WHERE fy=? AND code=? ORDER BY region DESC LIMIT 1",
                     (fy, code)).fetchone()
    name, spec, unit = (r["name"], r["spec"], r["unit"]) if r else (code, "", "")
    with conn:
        conn.execute("INSERT OR REPLACE INTO master_price(fy, kind, code, name, spec, unit, price, region)"
                     " VALUES (?,?,?,?,?,?,?,?)", (fy, kind, code, name, spec, unit, price, region))
        audit.log(conn, None, "物価資料の単価を入力", f"{fy} {code} {name} {spec} {price:,.0f}（{note}）")


# ====================================================================== 奈良県「土木工事設計単価資料」のPDF
# 労務単価（単価コード R…）と資材単価（Z…・V…＝材料、Q…・L…＝損料・賃料）に対応する。
# 単価欄の「○」は「刊行物（積算資料・建設物価）の単価を使う」という意味で、県のPDFには金額がない。
CODE_RE = re.compile(r"^(\d*)(R[H]?\d{4}|[ZVQL][0-9A-Z]{9})$")  # 前の番号とくっついて読めた場合も拾う
NARA_AREAS = {
    "1地区": "奈良市（旧月ヶ瀬村・旧都祁村を除く）、大和郡山市、天理市、生駒市、平群町、三郷町、斑鳩町、安堵町、川西町、"
             "三宅町、田原本町、上牧町、王寺町、河合町",
    "2地区": "奈良市（旧月ヶ瀬村・旧都祁村）、宇陀市、山添村、東吉野村",
    "3地区": "曽爾村、御杖村",
    "4地区": "大和高田市、橿原市、桜井市、五條市（西吉野町・大塔町を除く）、御所市、香芝市、葛城市、高取町、明日香村、広陵町、大淀町",
    "5地区": "五條市（西吉野町）、吉野町、下市町、黒滝村",
    "6地区": "川上村",
    "7地区": "五條市（大塔町）、野迫川村",
    "8地区": "天川村",
    "9地区": "上北山村",
    "10地区": "十津川村",
    "11地区": "下北山村",
}
FROM_BOOK = "物価資料"   # ○：積算資料・建設物価の単価を使う
BLANK = "未設定"         # 単価欄が空欄（取引が少なく県が単価を決めていない）


def kind_of_code(code: str) -> str:
    # Q…は「標識柱設置」「表面含浸工」など工事の単価（市場単価・施工単価）、L…は機械・仮設材の賃料
    return {"R": "労務", "Z": "材料", "V": "材料", "Q": "市場単価", "L": "機械"}.get(code[:1], "材料")


@dataclass
class NaraItem:
    kind: str
    code: str
    name: str
    spec: str
    unit: str
    region: str
    price: float | None
    source: str          # 県単価 / 物価資料 / 未設定
    page: int
    ref: str = ""        # 刊行物の掲載元（例: 202610積 P.120 202610物 WEB）


def _lines(page) -> list[list[dict]]:
    words = page.extract_words(keep_blank_chars=False, use_text_flow=False)
    rows: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if rows and abs(rows[-1][0]["top"] - w["top"]) <= 3:
            rows[-1].append(w)
        else:
            rows.append([w])
    return [sorted(r, key=lambda w: w["x0"]) for r in rows]


def parse_nara_pdf(path: str | Path, progress=None) -> list[NaraItem]:
    """progress(今のページ, 全ページ) を渡すと、ページごとに呼ぶ（画面の進み具合の表示用）。"""
    import pdfplumber
    from collections import Counter
    out: list[NaraItem] = []
    last: dict[str, NaraItem] = {}
    with pdfplumber.open(str(path)) as pdf:
        total = len(pdf.pages)
        for pno, page in enumerate(pdf.pages, 1):
            if progress:
                progress(pno, total)
            lines = _lines(page)
            head = None
            for i, ln in enumerate(lines):
                texts = [w["text"] for w in ln]
                if "単価コード" in texts and "単位" in texts and any(t.startswith("単価（") for t in texts):
                    head = i
                    break
            if head is None:
                continue
            hx = {w["text"]: w for w in lines[head]}
            unit_x = hx["単位"]["x0"]
            price_w = next(w for w in lines[head] if w["text"].startswith("単価（"))
            price_x = price_w["x0"]
            name_w = hx.get("職種") or hx.get("名称")
            spec_w = hx.get("規格")
            area_w = hx.get("地区")
            name_x = name_w["x0"] if name_w else hx["単価コード"]["x1"]
            # 規格の列の左端：名称の見出しより右・単位より左で、いちばん多い書き出し位置
            spec_left = None
            if spec_w:
                xs = Counter(round(w["x0"]) for ln in lines[head + 1:] for w in ln
                             if name_x < w["x0"] < unit_x - 8)
                spec_left = (xs.most_common(1)[0][0] - 3) if xs else (name_x + spec_w["x0"]) / 2
            for ln in lines[head + 1:]:
                code_w = next((w for w in ln if CODE_RE.match(w["text"])), None)
                if not code_w:
                    continue
                glued, code = CODE_RE.match(code_w["text"]).groups()
                region = ""
                if area_w:
                    nums = [w["text"] for w in ln if w["x1"] <= code_w["x0"] + 1 and w["text"].isdigit()
                            and w["x0"] >= area_w["x0"] - 12]
                    if glued and code_w["x0"] >= area_w["x0"] - 12:
                        nums.append(glued)
                    if nums:
                        region = f"{int(nums[-1])}地区"
                name, spec, unit, ref = [], [], [], []
                price_t = ""
                for w in ln:
                    x = w["x0"]
                    if x <= code_w["x0"]:
                        continue
                    if x < unit_x - 8:
                        (spec if spec_left is not None and x >= spec_left else name).append(w["text"])
                    elif x < price_x - 12:
                        unit.append(w["text"])
                    elif x < price_x + 50 and not price_t:
                        price_t = w["text"]
                    else:
                        ref.append(w["text"])
                if name:
                    base = NaraItem(kind_of_code(code), code, " ".join(name), " ".join(spec), " ".join(unit), region,
                                    None, BLANK, pno)
                elif code in last:  # 地区別の2行目以降は名称・規格・単位が省略されている
                    b = last[code]
                    base = NaraItem(b.kind, code, b.name, b.spec, b.unit, region, None, BLANK, pno)
                else:
                    continue
                base.ref = " ".join(ref)
                if price_t == "○":
                    base.source = FROM_BOOK
                else:
                    p = _price(price_t)
                    if p is not None:
                        base.price, base.source = p, "県単価"
                last[code] = base
                out.append(base)
    return out


def effective_date(path: str | Path) -> str:
    """表紙の「令和８年１１月１日より適用」から適用日（YYYY-MM-DD）を読む。読めなければ空。"""
    import pdfplumber
    with pdfplumber.open(str(path)) as pdf:
        text = unicodedata.normalize("NFKC", "".join((pdf.pages[i].extract_text() or "") for i in range(min(2, len(pdf.pages)))))
    m = re.search(r"令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*(?:より|以降)適用", text)
    if not m:
        return ""
    y, mo, d = (int(x) for x in m.groups())
    return f"{2018 + y:04d}-{mo:02d}-{d:02d}"


def is_nara_pdf(path: str | Path) -> bool:
    import pdfplumber
    if Path(path).suffix.lower() != ".pdf":
        return False
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages[:30]:
            t = page.extract_text() or ""
            if "単価コード" in t and "単価（円）" in t:
                return True
    return False


# ---------------------------------------------------------------- 建設機械等損料算定表（県が独自に定める分）
def is_loss_pdf(path: str | Path) -> bool:
    import pdfplumber
    if Path(path).suffix.lower() != ".pdf":
        return False
    with pdfplumber.open(str(path)) as pdf:
        t = _n("".join((p.extract_text() or "") for p in pdf.pages[:1]))
    return "損料算定表" in t


def parse_loss_pdf(path: str | Path, progress=None) -> list[PriceRow]:
    """「機械損料一覧」の表。単価は (13) 運転1時間当り換算値損料（単位が「日」「供用日」の機械は、その単位当りの値が入っている）。"""
    import pdfplumber
    out: list[PriceRow] = []
    with pdfplumber.open(str(path)) as pdf:
        n = len(pdf.pages)
        for pno, page in enumerate(pdf.pages):
            if progress:
                progress(pno + 1, n)
            if "損料一覧" not in _n((page.extract_text() or "")[:80]):
                continue
            words = page.extract_words(x_tolerance=1.5)
            lines: dict[float, list[dict]] = {}
            for w in words:
                key = next((k for k in lines if abs(k - w["top"]) < 2.5), w["top"])
                lines.setdefault(key, []).append(w)
            def center(*names: str) -> float | None:
                for w in words:
                    if _n(w["text"]) in names and w["top"] < 110:
                        return (w["x0"] + w["x1"]) / 2
                return None
            x_name, x_spec, x_unit = center("名称"), center("規格"), center("単位")
            nums = {}
            for label, key in (("重量", "weight"), ("価格", "base"), ("年数", "years"), ("(13)", "per_run"),
                               ("(15)", "per_day"), ("(3)", "run_hours"), ("(4)", "run_days"), ("(5)", "use_days"),
                               ("(6)", "repair"), ("(7)", "manage"), ("(%)", "residual")):
                c = center(label, _n(label))
                if c is not None:
                    nums[key] = c
            if None in (x_name, x_spec, x_unit) or "per_run" not in nums:
                continue
            split = (x_name + x_spec) / 2
            for t in sorted(lines):
                ws = sorted(lines[t], key=lambda w: w["x0"])
                code = next((_n(w["text"]) for w in ws if re.fullmatch(r"M\d{9}", _n(w["text"]))), None)
                if not code:
                    continue
                name, spec, unit, vals = [], [], "", {}
                for w in ws:
                    s, cx = _n(w["text"]), (w["x0"] + w["x1"]) / 2
                    if s == code or (re.fullmatch(r"\d+", s) and w["x1"] < 75):
                        continue
                    if abs(cx - x_unit) < 12 and not re.match(r"^[\d,.]+$", s):
                        unit = s
                    elif re.fullmatch(r"[\d,]+(\.\d+)?", s) and cx > split + 40:
                        key = min(nums, key=lambda k: abs(nums[k] - cx))
                        vals[key] = float(s.replace(",", ""))
                    elif w["x0"] < split:
                        name.append(s)
                    else:
                        spec.append(s)
                per = vals.get("per_run")
                if per is None:
                    continue
                ref = "県の損料算定表"
                if vals.get("base"):
                    ref += f"　基礎価格 {vals['base']:,.0f}円"
                if vals.get("years"):
                    ref += f"・標準使用 {vals['years']:g}年"
                if vals.get("per_day"):
                    ref += f"・供用1日当り {vals['per_day']:,.0f}円"
                out.append(PriceRow("機械", code, " ".join(name), " ".join(spec), unit or "時間", per, ref=ref))
    return out


def summarize(items: list[NaraItem]) -> dict[str, int]:
    from collections import Counter
    return dict(Counter(i.source for i in items))
