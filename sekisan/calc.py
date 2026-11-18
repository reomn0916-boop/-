"""計算：歩掛から単価を作り、直接工事費・諸経費・工事価格を出す。

計算ルール（端数処理・率・消費税）は年度ごとの表から読み、ここには書き込まない。
"""
from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal

DEFAULT_RULES = {
    "単価の有効桁数": "4",
    "単価の端数処理": "切捨て",   # 切捨て / 四捨五入 / 切上げ
    "率の小数桁": "2",
    "工事価格の端数単位": "1000",  # 一般管理費等で調整して、この単位未満を切り捨てる
    "消費税率": "10",
    # 低入札価格調査基準価格・最低制限価格の計算式（中央公契連モデル型）。
    # 発注者ごとに違うので、奈良県・各市町村の公表内容に合わせて年度のルール.csvで上書きする。
    "基準価格_直接工事費": "0.97",
    "基準価格_共通仮設費": "0.90",
    "基準価格_現場管理費": "0.90",
    "基準価格_一般管理費等": "0.68",
    "基準価格_下限": "0.75",
    "基準価格_上限": "0.92",
    "基準価格の端数単位": "1",
}

_MODES = {"切捨て": ROUND_FLOOR, "四捨五入": ROUND_HALF_UP, "切上げ": ROUND_CEILING}

DESIGN = "設計"    # 発注者の単価で計算（入札・内訳書用）
COMPANY = "実行"   # 自社単価を優先して計算（実行予算用）


def round_sig(x: float, digits: int, mode: str = "切捨て") -> float:
    """有効桁数で丸める（例: 12345.6 → 有効4桁切捨て → 12340）。"""
    if x == 0:
        return 0.0
    d = Decimal(repr(x))
    exp = d.copy_abs().adjusted()
    quant = Decimal(1).scaleb(exp - digits + 1)
    return float(d.quantize(quant, rounding=_MODES[mode]))


def round_dec(x: float, places: int) -> float:
    return float(Decimal(repr(x)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def floor_yen(x: float) -> int:
    return int(Decimal(repr(x)).quantize(Decimal(1), rounding=ROUND_FLOOR))


@dataclass
class Line:
    """単価表の1行"""
    kind: str
    code: str
    name: str
    unit: str
    qty: float
    price: float
    amount: float
    source: str  # 設計 / 自社 / 不明


@dataclass
class UnitPrice:
    code: str
    name: str
    unit: str
    per_qty: float
    lines: list[Line]
    misc_rate: float
    subtotal: float
    price: float  # 1単位あたり（端数処理後）


@dataclass
class ItemResult:
    item_id: int
    seq: int
    level1: str
    level2: str
    level3: str
    name: str
    spec: str
    unit: str
    qty: float
    code: str
    how: str           # 歩掛 / パッケージ / 単価 / 対応表 / 未設定
    unit_price: float
    amount: int
    detail: UnitPrice | None = None
    category: str = "直接"
    note: str = ""


@dataclass
class Summary:
    direct: int = 0
    common_temp_rate: float = 0
    common_temp_rated: int = 0     # 率で計上した分
    common_temp_stacked: int = 0   # 積上げ分
    common_temp: int = 0
    net: int = 0
    site_mgmt_rate: float = 0
    site_mgmt_stacked: int = 0
    site_mgmt: int = 0
    cost: int = 0
    general_rate: float = 0
    general: int = 0
    price: int = 0
    tax: int = 0
    total: int = 0
    threshold: int = 0             # 調査基準価格・最低制限価格の試算（税抜）

    def as_rows(self) -> list[tuple[str, float | None, int]]:
        return [
            ("直接工事費", None, self.direct),
            ("共通仮設費", self.common_temp_rate, self.common_temp),
            *([("　うち率計上", self.common_temp_rate, self.common_temp_rated),
               ("　うち積上げ", None, self.common_temp_stacked)] if self.common_temp_stacked else []),
            ("純工事費", None, self.net),
            ("現場管理費", self.site_mgmt_rate, self.site_mgmt),
            *([("　うち積上げ", None, self.site_mgmt_stacked)] if self.site_mgmt_stacked else []),
            ("工事原価", None, self.cost),
            ("一般管理費等", self.general_rate, self.general),
            ("工事価格", None, self.price),
            ("消費税相当額", None, self.tax),
            ("工事費計", None, self.total),
        ]


@dataclass
class Result:
    project_id: int
    mode: str
    items: list[ItemResult]
    summary: Summary
    warnings: list[str] = field(default_factory=list)

    @property
    def unresolved(self) -> list[ItemResult]:
        return [i for i in self.items if i.how == "未設定"]


class Calculator:
    def __init__(self, conn: sqlite3.Connection, fy: str, region: str = "", mode: str = DESIGN):
        self.conn = conn
        self.fy = fy
        self.region = region
        self.mode = mode
        self.rules = dict(DEFAULT_RULES)
        for r in conn.execute("SELECT key, value FROM rule WHERE fy=?", (fy,)):
            self.rules[r["key"]] = r["value"]
        self.warnings: list[str] = []
        self._cache: dict[str, UnitPrice | None] = {}

    # -------------------------------------------------- 資源の単価
    def resource_price(self, kind: str, code: str) -> tuple[float, str, str, str]:
        """(単価, 名称, 単位, 出どころ)"""
        if self.mode == COMPANY:
            r = self.conn.execute(
                "SELECT price, name, unit FROM company_price WHERE kind=? AND code=?", (kind, code)
            ).fetchone()
            if r:
                return r["price"], r["name"], r["unit"], "自社"
        r = self.conn.execute(
            "SELECT price, name, unit FROM master_price WHERE fy=? AND kind=? AND code=? AND region IN (?, '')"
            " ORDER BY region DESC LIMIT 1",
            (self.fy, kind, code, self.region),
        ).fetchone()
        if r:
            return r["price"], r["name"], r["unit"], "設計"
        self.warnings.append(f"{self.fy}年度の単価がありません: {kind} {code}")
        return 0.0, f"（不明 {code}）", "", "不明"

    # -------------------------------------------------- 歩掛から単価を作る
    def unit_price(self, code: str, _depth: int = 0) -> UnitPrice | None:
        if code in self._cache:
            return self._cache[code]
        if _depth > 10:
            raise ValueError(f"歩掛の入れ子が深すぎます（循環の可能性）: {code}")
        b = self.conn.execute("SELECT * FROM bukake WHERE fy=? AND code=?", (self.fy, code)).fetchone()
        if not b:
            self._cache[code] = None
            return None
        lines: list[Line] = []
        for c in self.conn.execute(
            "SELECT * FROM bukake_component WHERE fy=? AND bukake_code=? ORDER BY seq", (self.fy, code)
        ):
            if c["kind"] == "歩掛":
                sub = self.unit_price(c["res_code"], _depth + 1)
                if sub is None:
                    self.warnings.append(f"歩掛 {code} の中の歩掛 {c['res_code']} がありません")
                    price, name, unit, src = 0.0, f"（不明 {c['res_code']}）", "", "不明"
                else:
                    price, name, unit, src = sub.price, sub.name, sub.unit, "歩掛"
            else:
                price, name, unit, src = self.resource_price(c["kind"], c["res_code"])
            lines.append(Line(c["kind"], c["res_code"], name, unit, c["qty"], price, c["qty"] * price, src))
        subtotal = sum(l.amount for l in lines) * (1 + b["misc_rate"] / 100)
        per = subtotal / (b["per_qty"] or 1)
        price = round_sig(per, int(self.rules["単価の有効桁数"]), self.rules["単価の端数処理"])
        up = UnitPrice(b["code"], b["name"], b["unit"], b["per_qty"], lines, b["misc_rate"], subtotal, price)
        self._cache[code] = up
        return up

    # -------------------------------------------------- 施工パッケージ
    def package_price(self, code: str) -> UnitPrice | None:
        """積算単価 = 標準単価 × { Σ 構成比 × (当地の単価 ÷ 東京の基準単価) + (1 − Σ 構成比) }"""
        key = "pkg:" + code
        if key in self._cache:
            return self._cache[key]
        pk = self.conn.execute("SELECT * FROM package WHERE fy=? AND code=?", (self.fy, code)).fetchone()
        if not pk:
            self._cache[key] = None
            return None
        p0 = pk["std_price"]
        lines: list[Line] = []
        ratio_sum = 0.0
        factor = 0.0
        for c in self.conn.execute(
            "SELECT * FROM package_component WHERE fy=? AND package_code=? ORDER BY seq", (self.fy, code)
        ):
            local, name, unit, src = self.resource_price(c["kind"], c["res_code"])
            if not c["base_price"]:
                self.warnings.append(f"施工パッケージ {code} の {c['res_code']} に東京の基準単価がありません")
                continue
            f = c["ratio"] * local / c["base_price"]
            ratio_sum += c["ratio"]
            factor += f
            lines.append(Line(c["kind"], c["res_code"], f"{name}（東京 {c['base_price']:,.0f}）", unit,
                              c["ratio"], local, p0 * f, src))
        rest = max(0.0, 1 - ratio_sum)
        factor += rest
        lines.append(Line("その他", "", "補正しない分", "", rest, p0, p0 * rest, "設計"))
        price = round_sig(p0 * factor, int(self.rules["単価の有効桁数"]), self.rules["単価の端数処理"])
        up = UnitPrice(pk["code"], f"{pk['name']}（施工パッケージ・標準単価 {p0:,.0f}）", pk["unit"], 1, lines, 0,
                       p0 * factor, price)
        self._cache[key] = up
        return up

    # -------------------------------------------------- 明細1行
    def item(self, row: sqlite3.Row) -> ItemResult:
        code = row["bukake_code"]
        how = "未設定"
        unit_price = 0.0
        detail = None
        note = row["note"]
        m = self.conn.execute(
            "SELECT bukake_code, note FROM item_mapping WHERE name=? AND spec=? AND unit=?",
            (row["name"], row["spec"], row["unit"]),
        ).fetchone()
        if m:
            note = note or m["note"]
            if not code:
                code = m["bukake_code"]
                how = "対応表"
        if code:
            detail = self.unit_price(code)
            pkg = None if detail else self.package_price(code)
            if detail:
                unit_price = detail.price
                how = "歩掛" if how == "未設定" else how
            elif pkg:
                detail = pkg
                unit_price = pkg.price
                how = "パッケージ" if how == "未設定" else how
            else:
                # 歩掛ではなく、単価そのもの（市場単価など）の場合
                r = self.conn.execute(
                    "SELECT kind FROM master_price WHERE fy=? AND code=? AND region IN (?, '')"
                    " ORDER BY region DESC LIMIT 1",
                    (self.fy, code, self.region),
                ).fetchone()
                if r:
                    unit_price, _, _, _ = self.resource_price(r["kind"], code)
                    how = "単価" if how == "未設定" else how
                else:
                    self.warnings.append(f"明細{row['seq']}「{row['name']}」のコード {code} が見つかりません")
                    how = "未設定"
        amount = floor_yen(unit_price * row["qty"])
        return ItemResult(
            row["id"], row["seq"], row["level1"], row["level2"], row["level3"], row["name"], row["spec"],
            row["unit"], row["qty"], code, how, unit_price, amount, detail, row["category"], note,
        )

    # -------------------------------------------------- 諸経費率
    def rate(self, work_type: str, item: str, p: float) -> float:
        r = self.conn.execute(
            "SELECT * FROM overhead_param WHERE fy=? AND work_type=? AND item=?", (self.fy, work_type, item)
        ).fetchone()
        if not r:
            self.warnings.append(f"{self.fy}年度「{work_type}」の{item}率がありません（0%で計算）")
            return 0.0
        pp = min(max(p, r["p_min"]), r["p_max"])
        if pp <= 0:
            return 0.0
        if r["formula"] == "power":
            v = r["a"] * pp ** r["b"]
        elif r["formula"] == "log":
            v = r["a"] * math.log10(pp) + r["b"]
        else:
            raise ValueError(f"諸経費の式の種類が不明です: {r['formula']}")
        return round_dec(v, int(self.rules["率の小数桁"]))

    def summary(self, direct: int, work_type: str, ct_stack: int = 0, sm_stack: int = 0) -> Summary:
        s = Summary(direct=direct)
        s.common_temp_rate = self.rate(work_type, "共通仮設費", direct)
        s.common_temp_rated = floor_yen(direct * s.common_temp_rate / 100)
        s.common_temp_stacked = ct_stack
        s.common_temp = s.common_temp_rated + ct_stack
        s.net = s.direct + s.common_temp
        s.site_mgmt_rate = self.rate(work_type, "現場管理費", s.net)
        s.site_mgmt_stacked = sm_stack
        s.site_mgmt = floor_yen(s.net * s.site_mgmt_rate / 100) + sm_stack
        s.cost = s.net + s.site_mgmt
        s.general_rate = self.rate(work_type, "一般管理費等", s.cost)
        general = floor_yen(s.cost * s.general_rate / 100)
        unit = int(self.rules["工事価格の端数単位"]) or 1
        s.price = (s.cost + general) // unit * unit
        s.general = s.price - s.cost
        s.tax = floor_yen(s.price * float(self.rules["消費税率"]) / 100)
        s.total = s.price + s.tax
        s.threshold = self.threshold(s)
        return s

    def threshold(self, s: Summary) -> int:
        """調査基準価格・最低制限価格の試算。予定価格は工事価格と同じとみなす。"""
        r = self.rules
        base = (s.direct * float(r["基準価格_直接工事費"]) + s.common_temp * float(r["基準価格_共通仮設費"])
                + s.site_mgmt * float(r["基準価格_現場管理費"]) + s.general * float(r["基準価格_一般管理費等"]))
        base = min(max(base, s.price * float(r["基準価格_下限"])), s.price * float(r["基準価格_上限"]))
        unit = int(r["基準価格の端数単位"]) or 1
        return floor_yen(base) // unit * unit


def calculate(conn: sqlite3.Connection, project_id: int, mode: str = DESIGN) -> Result:
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    if not p:
        raise ValueError(f"工事が見つかりません: {project_id}")
    calc = Calculator(conn, p["fy"], p["region"], mode)
    items = [
        calc.item(r)
        for r in conn.execute("SELECT * FROM project_item WHERE project_id=? ORDER BY seq", (project_id,))
    ]
    def total(cat: str) -> int:
        return sum(i.amount for i in items if i.category == cat)

    summary = calc.summary(total("直接"), p["work_type"], total("共通仮設"), total("現場管理"))
    for i in items:
        if i.how == "未設定":
            calc.warnings.append(f"明細{i.seq}「{i.name} {i.spec}」に歩掛・単価が当たっていません")
    # 重複を除いて順番を保つ
    warnings = list(dict.fromkeys(calc.warnings))
    return Result(project_id, mode, items, summary, warnings)


@dataclass
class BidCheck:
    bid: int                 # 入札額（税抜）
    planned: int             # 予定価格の見込み（＝工事価格）
    threshold: int           # 調査基準価格・最低制限価格の試算
    cost: int                # 実行原価の見込み
    ratio: float             # 入札額 ÷ 予定価格
    margin: int              # 入札額 − 実行原価
    below_threshold: bool
    over_planned: bool


def bid_check(design: Result, company: Result, bid: int) -> BidCheck:
    """入札額の検討。実行原価 = 自社単価での直接工事費 + 設計の共通仮設費・現場管理費（見込み）。"""
    d = design.summary
    cost = company.summary.direct + d.common_temp + d.site_mgmt
    return BidCheck(
        bid=bid, planned=d.price, threshold=d.threshold, cost=cost,
        ratio=(bid / d.price) if d.price else 0.0, margin=bid - cost,
        below_threshold=bid < d.threshold, over_planned=bid > d.price,
    )


def set_bid(conn: sqlite3.Connection, project_id: int, bid: float) -> None:
    with conn:
        conn.execute("UPDATE project SET bid_price=? WHERE id=?", (bid, project_id))


def set_note(conn: sqlite3.Connection, item_id: int, note: str, remember: bool = True) -> None:
    """積算根拠のメモ。remember=True なら同じ名称・規格・単位の項目に次回以降も表示する。"""
    row = conn.execute("SELECT * FROM project_item WHERE id=?", (item_id,)).fetchone()
    with conn:
        conn.execute("UPDATE project_item SET note=? WHERE id=?", (note, item_id))
        if remember and row:
            conn.execute(
                "INSERT INTO item_mapping(name, spec, unit, bukake_code, note) VALUES (?,?,?,?,?)"
                " ON CONFLICT(name, spec, unit) DO UPDATE SET note=excluded.note",
                (row["name"], row["spec"], row["unit"], row["bukake_code"], note),
            )


def set_category(conn: sqlite3.Connection, item_id: int, category: str) -> None:
    with conn:
        conn.execute("UPDATE project_item SET category=? WHERE id=?", (category, item_id))


def assign_code(conn: sqlite3.Connection, item_id: int, code: str, remember: bool = True) -> None:
    """明細に歩掛コードを当てる。remember=True なら対応表に覚え、次の工事から自動で当てる。"""
    row = conn.execute("SELECT * FROM project_item WHERE id=?", (item_id,)).fetchone()
    with conn:
        conn.execute("UPDATE project_item SET bukake_code=? WHERE id=?", (code, item_id))
        if remember and row:
            conn.execute(
                "INSERT INTO item_mapping(name, spec, unit, bukake_code) VALUES (?,?,?,?)"
                " ON CONFLICT(name, spec, unit) DO UPDATE SET bukake_code=excluded.bukake_code",
                (row["name"], row["spec"], row["unit"], code),
            )
