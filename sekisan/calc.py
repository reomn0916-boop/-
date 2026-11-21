"""計算：歩掛から単価を作り、直接工事費・諸経費・工事価格を出す。

計算ルール（端数処理・率・消費税）は年度ごとの表と発注者ごとの表から読み、ここには書き込まない。
優先順位：発注者のルール ＞ 年度のルール ＞ 既定値
"""
from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal

from . import audit, disposal, quotes

DEFAULT_RULES = {
    "単価の有効桁数": "4",
    "単価の端数処理": "切捨て",   # 切捨て / 四捨五入 / 切上げ
    "率の小数桁": "2",
    "工事価格の端数単位": "1000",  # 一般管理費等で調整して、この単位未満を切り捨てる
    "消費税率": "10",
    # 低入札価格調査基準価格・最低制限価格の計算式（中央公契連モデル型）。
    # 発注者ごとに違うので、奈良県・各市町村の公表内容に合わせて「発注者ごとの設定」で上書きする。
    "基準価格_直接工事費": "0.97",
    "基準価格_共通仮設費": "0.90",
    "基準価格_現場管理費": "0.90",
    "基準価格_一般管理費等": "0.68",
    "基準価格_下限": "0.75",
    "基準価格_上限": "0.92",
    "基準価格の端数単位": "1",
    # 全体スライドで受注者が負担する割合（残工事費の1.5%）
    "スライド_負担率": "0.015",
    # 電子入札用の内訳書CSV
    "電子入札_文字コード": "cp932",
    "内訳書_階層の深さ": "4",     # 1=工種まで 2=種別まで 3=細別まで 4=明細まで
    # 部分払い：出来高に掛ける割合（請負代金額×出来高率×9/10 が限度、の考え方）
    "部分払_割合": "0.9",
}

_MODES = {"切捨て": ROUND_FLOOR, "四捨五入": ROUND_HALF_UP, "切上げ": ROUND_CEILING}

DESIGN = "設計"    # 発注者の単価で計算（入札・内訳書用）
COMPANY = "実行"   # 自社単価を優先して計算（実行予算用）

DIRECT = "直接"
DIRECT_EXCLUDED = "直接（率対象外）"  # 直接工事費には入れるが、諸経費率の対象額から除く（処分費・支給品など）
CATEGORIES = (DIRECT, DIRECT_EXCLUDED, "共通仮設", "現場管理")
RESOURCE_KINDS = ("労務", "機械", "材料", "市場単価")
NO_PRICE = ("未設定", "物価資料待ち", "単価表待ち")
RATE_TARGETS = ("共通仮設費率", "現場管理費率")


def is_direct(category: str) -> bool:
    return category.startswith(DIRECT)


def round_sig(x: float, digits: int, mode: str = "切捨て") -> float:
    """有効桁数で丸める（例: 12345.6 → 有効4桁切捨て → 12340）。"""
    x = round(x, 8)  # 0.1+0.2 のような小数の誤差で切り捨てが1つ下がるのを防ぐ
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


def split_conditions(s: str) -> tuple[str, ...]:
    return tuple(x.strip() for x in s.replace("，", ",").replace("、", ",").split(",") if x.strip())


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
    source: str        # 設計 / 自社 / 改定 / 機械経費 / 見積 / 歩掛 / 不明
    factor: float = 1.0  # 補正係数（割増など）


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
    conditions: tuple[str, ...] = ()
    incomplete: bool = False  # 中に数量未入力・単価なし・率未入力がある（入れきっていない）


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
    how: str           # 歩掛 / パッケージ / 単価 / 見積 / 対応表 / 未設定
    unit_price: float
    amount: int
    detail: UnitPrice | None = None
    category: str = DIRECT
    note: str = ""
    conditions: str = ""

    @property
    def missing(self) -> bool:
        """単価がまだない（未設定、または県の資料で○のため物価資料の単価待ち）"""
        return self.how in NO_PRICE


@dataclass
class Summary:
    direct: int = 0
    direct_excluded: int = 0       # うち諸経費率の対象外
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
            *([("　うち率対象外", None, self.direct_excluded)] if self.direct_excluded else []),
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
    conditions: tuple[str, ...] = ()
    rules: dict[str, str] = field(default_factory=dict)

    @property
    def unresolved(self) -> list[ItemResult]:
        return [i for i in self.items if i.missing]


def load_rules(conn: sqlite3.Connection, fy: str, orderer: str = "") -> dict[str, str]:
    rules = dict(DEFAULT_RULES)
    for r in conn.execute("SELECT key, value FROM rule WHERE fy=?", (fy,)):
        rules[r["key"]] = r["value"]
    if orderer:
        for r in conn.execute("SELECT key, value FROM orderer_rule WHERE orderer=?", (orderer,)):
            rules[r["key"]] = r["value"]
    return rules


class Calculator:
    def __init__(self, conn: sqlite3.Connection, fy: str, region: str = "", mode: str = DESIGN,
                 conditions: tuple[str, ...] = (), orderer: str = "", as_of: str = "", project_id: int | None = None):
        self.conn = conn
        self.fy = fy
        self.region = region
        self.mode = mode
        self.conditions = tuple(conditions)
        self.as_of = as_of
        self.rules = load_rules(conn, fy, orderer)
        self.project_id = project_id   # 工事で選んだ処分場を読むため
        self.warnings: list[str] = []
        self._cache: dict[tuple, UnitPrice | None] = {}
        self._adj = list(conn.execute("SELECT * FROM adjustment WHERE fy=?", (fy,)))
        known = {a["code"] for a in self._adj}
        for c in self.conditions:
            if c not in known:
                self.warnings.append(f"{fy}年度の補正に「{c}」がありません")

    # -------------------------------------------------- 補正係数
    def factor(self, conds: tuple[str, ...], target: str, bukake_code: str = "") -> float:
        f = 1.0
        for a in self._adj:
            if a["code"] in conds and a["target"] == target and a["bukake_code"] in ("", bukake_code):
                f *= a["factor"]
        return f

    # -------------------------------------------------- 資源の単価
    def resource_price(self, kind: str, code: str, _depth: int = 0) -> tuple[float, str, str, str]:
        """(単価, 名称, 単位, 出どころ)。自社 → 単価改定 → 年度の単価 → 機械経費 → 見積 の順に探す。"""
        if code.startswith(disposal.PREFIX):   # 処分費：工事で選んだ処分場の受入価格
            price, name, unit, warn = disposal.price_for(self.conn, self.project_id, code, self.as_of)
            if warn:
                self.warnings.append(warn)
            return price, name, unit, "受入価格" if not warn else "不明"
        if self.mode == COMPANY:
            r = self.conn.execute(
                "SELECT price, name, unit FROM company_price WHERE kind=? AND code=?", (kind, code)
            ).fetchone()
            if r:
                return r["price"], r["name"], r["unit"], "自社"
        base = self.conn.execute(
            "SELECT price, name, unit FROM master_price WHERE fy=? AND kind=? AND code=? AND region IN (?, '')"
            " ORDER BY region DESC LIMIT 1",
            (self.fy, kind, code, self.region),
        ).fetchone()
        if self.as_of:
            rv = self.conn.execute(
                "SELECT price FROM price_revision WHERE fy=? AND kind=? AND code=? AND region IN (?, '')"
                " AND valid_from<=? ORDER BY valid_from DESC, region DESC LIMIT 1",
                (self.fy, kind, code, self.region, self.as_of),
            ).fetchone()
            if rv:
                return rv["price"], base["name"] if base else code, base["unit"] if base else "", "改定"
        if base:
            return base["price"], base["name"], base["unit"], "設計"
        obs = self.conn.execute(
            "SELECT * FROM observed_price WHERE fy=? AND code=? AND region IN (?, '') AND (?='' OR month<=?)"
            " ORDER BY region DESC, month DESC LIMIT 1", (self.fy, code, self.region, self.as_of, self.as_of)).fetchone()
        if obs:
            return obs["price"], f"{obs['name']} {obs['spec']}".strip() or code, obs["unit"], "設計書実績"
        if kind == "機械":
            m = self.machine_price(code, _depth)
            if m is not None:
                return m
        q = quotes.adopted_price(self.conn, code)
        if q:
            return q[0], q[1]["name"], q[1]["unit"], "見積"
        pub = self.public_item(code)
        if pub:
            self.warnings.append(f"{pub['name']} {pub['spec']}（{code}）は県の単価資料で「{pub['source']}」です。"
                                 + ("物価資料（積算資料・建設物価）の単価を入れてください。" if pub["source"] == "物価資料"
                                    else "見積などで単価を決めてください。"))
            return 0.0, f"{pub['name']} {pub['spec']}".strip(), pub["unit"], "不明"
        self.warnings.append(f"{self.fy}年度の単価がありません: {kind} {code}")
        return 0.0, f"（不明 {code}）", "", "不明"

    def public_item(self, code: str):
        return self.conn.execute(
            "SELECT * FROM public_item WHERE fy=? AND code=? AND region IN (?, '') ORDER BY region DESC LIMIT 1",
            (self.fy, code, self.region)).fetchone()

    def machine_price(self, code: str, _depth: int = 0) -> tuple[float, str, str, str] | None:
        """③ 運転1日あたり = 損料×時間 + 燃料(L/h)×時間×燃料単価 + 運転手×労務単価、に諸雑費を足す。"""
        m = self.conn.execute("SELECT * FROM machine_cost WHERE fy=? AND code=?", (self.fy, code)).fetchone()
        if not m or _depth > 3:
            return None
        total = m["loss_per_hour"] * m["hours"]
        if m["fuel_code"]:
            fuel, *_ = self.resource_price("材料", m["fuel_code"], _depth + 1)
            total += m["fuel_per_hour"] * m["hours"] * fuel
        if m["operator_code"]:
            op, *_ = self.resource_price("労務", m["operator_code"], _depth + 1)
            total += m["operators"] * op
        total *= 1 + m["misc_rate"] / 100
        price = round_sig(total, int(self.rules["単価の有効桁数"]), self.rules["単価の端数処理"])
        return price, f"{m['name']} {m['spec']}".strip(), "日", "機械経費"

    # -------------------------------------------------- 歩掛から単価を作る
    def unit_price(self, code: str, conds: tuple[str, ...] = (), _depth: int = 0) -> UnitPrice | None:
        key = ("b", code, conds)
        if key in self._cache:
            return self._cache[key]
        if _depth > 10:
            raise ValueError(f"歩掛の入れ子が深すぎます（循環の可能性）: {code}")
        b = self.conn.execute("SELECT * FROM bukake WHERE fy=? AND code=?", (self.fy, code)).fetchone()
        if not b:
            self._cache[key] = None
            return None
        lines: list[Line] = []
        for c in self.conn.execute(
            "SELECT * FROM bukake_component WHERE fy=? AND bukake_code=? ORDER BY seq", (self.fy, code)
        ):
            f = 1.0
            note = c["note"] if "note" in c.keys() else ""
            src = c["src"] if "src" in c.keys() else ""
            if "数量を入れる" in note:
                self.warnings.append(f"{b['name']}：「{src}」の数量が未入力です（金抜きで伏せてあります。標準歩掛で確かめて"
                                     "「単価表」で入れてください）")
            if c["kind"] == "パッケージ":
                sub = self.package_price(c["res_code"], conds)
                price, name, unit, src_ = (sub.price, sub.name, sub.unit, "施工パッケージ") if sub else \
                    (0.0, f"（不明 {c['res_code']}）", "", "不明")
                lines.append(Line(c["kind"], c["res_code"], name, unit, c["qty"], price, c["qty"] * price, src_, 1.0))
                continue
            if not c["res_code"]:
                self.warnings.append(f"{b['name']}：「{src}」に単価が当たっていません（「単価表」で資源を選んでください）")
                lines.append(Line(c["kind"], "", src or "（資源なし）", "", c["qty"], 0.0, 0.0, "不明", 1.0))
                continue
            if c["kind"] == "歩掛":
                sub = self.unit_price(c["res_code"], conds, _depth + 1)
                if sub is None:
                    self.warnings.append(f"歩掛 {code} の中の歩掛 {c['res_code']} がありません")
                    price, name, unit, src = 0.0, f"（不明 {c['res_code']}）", "", "不明"
                else:
                    price, name, unit, src = sub.price, sub.name, sub.unit, "歩掛"
            else:
                price, name, unit, src = self.resource_price(c["kind"], c["res_code"])
                f = self.factor(conds, c["kind"], code) * self.factor(conds, "全体", code)
            lines.append(Line(c["kind"], c["res_code"], name, unit, c["qty"], price, c["qty"] * price * f, src, f))
        if "諸雑費率を入れる" in (b["note"] if "note" in b.keys() else ""):
            self.warnings.append(f"{b['name']}：諸雑費の率が伏せてあります（「単価表」で入れてください）")
        subtotal = sum(l.amount for l in lines) * (1 + b["misc_rate"] / 100)
        per = subtotal / (b["per_qty"] or 1)
        price = round_sig(per, int(self.rules["単価の有効桁数"]), self.rules["単価の端数処理"])
        up = UnitPrice(b["code"], b["name"], b["unit"], b["per_qty"], lines, b["misc_rate"], subtotal, price, conds)
        notes = [c["note"] for c in self.conn.execute(
            "SELECT note FROM bukake_component WHERE fy=? AND bukake_code=?", (self.fy, code))]
        nested_bad = False
        for c in self.conn.execute("SELECT kind, res_code FROM bukake_component WHERE fy=? AND bukake_code=?",
                                   (self.fy, code)):
            if c["kind"] == "歩掛":
                sub = self._cache.get(("b", c["res_code"], conds))
                nested_bad |= bool(sub is None or sub.incomplete)
            elif c["kind"] == "パッケージ":
                sub = self._cache.get(("p", c["res_code"], conds))
                nested_bad |= bool(sub is None or sub.incomplete)
        up.incomplete = (nested_bad or any(l.source == "不明" for l in lines)
                         or any(n and ("数量を入れる" in n or "単価を当てる" in n) for n in notes)
                         or "諸雑費率を入れる" in (b["note"] if "note" in b.keys() else ""))
        self._cache[key] = up
        return up

    # -------------------------------------------------- 施工パッケージ
    def package_price(self, code: str, conds: tuple[str, ...] = ()) -> UnitPrice | None:
        """積算単価 = 標準単価 × { Σ 構成比 × (当地の単価 ÷ 東京の基準単価) + (1 − Σ 構成比) }"""
        key = ("p", code, conds)
        if key in self._cache:
            return self._cache[key]
        pk = self.conn.execute("SELECT * FROM package WHERE fy=? AND code=?", (self.fy, code)).fetchone()
        if not pk:
            self._cache[key] = None
            return None
        p0 = pk["std_price"]
        if not p0:
            self.warnings.append(f"施工パッケージ「{pk['name']}」（{code}）の標準単価が未入力です"
                                 "（国の施工パッケージ型積算の標準単価表で確かめて「単価表」で入れてください）")
        lines: list[Line] = []
        ratio_sum = 0.0
        factor = 0.0
        for c in self.conn.execute(
            "SELECT * FROM package_component WHERE fy=? AND package_code=? ORDER BY seq", (self.fy, code)
        ):
            if not c["res_code"]:
                self.warnings.append(f"施工パッケージ {code} の「{c['src'] if 'src' in c.keys() else ''}」に単価が当たっていません")
                continue
            local, name, unit, src = self.resource_price(c["kind"], c["res_code"])
            if not c["base_price"]:
                self.warnings.append(f"施工パッケージ {code} の {c['res_code']} に東京の基準単価がありません")
                continue
            adj = self.factor(conds, c["kind"], code)
            f = c["ratio"] * local * adj / c["base_price"]
            ratio_sum += c["ratio"]
            factor += f
            lines.append(Line(c["kind"], c["res_code"], f"{name}（東京 {c['base_price']:,.0f}）", unit,
                              c["ratio"], local, p0 * f, src, adj))
        rest = max(0.0, 1 - ratio_sum)
        factor += rest
        lines.append(Line("その他", "", "補正しない分", "", rest, p0, p0 * rest, "設計"))
        whole = self.factor(conds, "全体", code)
        price = round_sig(p0 * factor * whole, int(self.rules["単価の有効桁数"]), self.rules["単価の端数処理"])
        up = UnitPrice(pk["code"], f"{pk['name']}（施工パッケージ・標準単価 {p0:,.0f}）", pk["unit"], 1, lines, 0,
                       p0 * factor * whole, price, conds)
        up.incomplete = (not p0 or any(l.source == "不明" for l in lines) or bool(self.conn.execute(
            "SELECT 1 FROM package_component WHERE fy=? AND package_code=? AND (res_code='' OR base_price=0)",
            (self.fy, code)).fetchone()))
        self._cache[key] = up
        return up

    # -------------------------------------------------- 明細1行
    def item(self, row: sqlite3.Row) -> ItemResult:
        code = row["bukake_code"]
        how = "未設定"
        unit_price = 0.0
        detail = None
        note = row["note"]
        conds = tuple(dict.fromkeys(self.conditions + split_conditions(row["conditions"])))
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
            detail = self.unit_price(code, conds)
            pkg = None if detail else self.package_price(code, conds)
            if detail:
                unit_price = detail.price
                how = "歩掛" if how == "未設定" else how
                if detail.incomplete:
                    how = "単価表待ち"
            elif pkg:
                detail = pkg
                unit_price = pkg.price
                how = "パッケージ" if how == "未設定" else how
                if pkg.incomplete:
                    how = "単価表待ち"
            elif code.startswith(disposal.PREFIX):
                p, *_ = self.resource_price("材料", code)
                unit_price = p * self.factor(conds, "全体", code)
                how = ("受入価格" if p else "未設定") if how == "未設定" else how
            else:
                # 歩掛ではなく、単価そのもの（市場単価・見積など）の場合
                r = self.conn.execute(
                    "SELECT kind FROM master_price WHERE fy=? AND code=? AND region IN (?, '')"
                    " ORDER BY region DESC LIMIT 1",
                    (self.fy, code, self.region),
                ).fetchone()
                q = None if r else quotes.adopted_price(self.conn, code)
                if r:
                    p, *_ = self.resource_price(r["kind"], code)
                    unit_price = p * self.factor(conds, r["kind"], code) * self.factor(conds, "全体", code)
                    how = "単価" if how == "未設定" else how
                elif q:
                    unit_price = q[0] * self.factor(conds, "全体", code)
                    how = "見積" if how == "未設定" else how
                else:
                    pub = self.public_item(code)
                    if pub:
                        self.warnings.append(f"明細{row['seq']}「{row['name']}」の {code}（{pub['name']} {pub['spec']}）は"
                                             f"県の単価資料で「{pub['source']}」のため単価がありません。"
                                             "「不明な単価」の画面で入れてください。")
                    else:
                        self.warnings.append(f"明細{row['seq']}「{row['name']}」のコード {code} が見つかりません")
                    how = "物価資料待ち" if pub and pub["source"] == "物価資料" else "未設定"
        amount = floor_yen(unit_price * row["qty"])
        return ItemResult(
            row["id"], row["seq"], row["level1"], row["level2"], row["level3"], row["name"], row["spec"],
            row["unit"], row["qty"], code, how, unit_price, amount, detail, row["category"], note,
            row["conditions"],
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

    def summary(self, direct: int, work_type: str, ct_stack: int = 0, sm_stack: int = 0,
                excluded: int = 0) -> Summary:
        """④ 率の対象額から「率対象外」を除き、② 地域・工期などの補正を率に掛ける。"""
        places = int(self.rules["率の小数桁"])
        s = Summary(direct=direct, direct_excluded=excluded)
        base_ct = direct - excluded
        s.common_temp_rate = round_dec(
            self.rate(work_type, "共通仮設費", base_ct) * self.factor(self.conditions, "共通仮設費率"), places)
        s.common_temp_rated = floor_yen(base_ct * s.common_temp_rate / 100)
        s.common_temp_stacked = ct_stack
        s.common_temp = s.common_temp_rated + ct_stack
        s.net = s.direct + s.common_temp
        base_sm = s.net - excluded
        s.site_mgmt_rate = round_dec(
            self.rate(work_type, "現場管理費", base_sm) * self.factor(self.conditions, "現場管理費率"), places)
        s.site_mgmt_stacked = sm_stack
        s.site_mgmt = floor_yen(base_sm * s.site_mgmt_rate / 100) + sm_stack
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


def project_conditions(conn: sqlite3.Connection, project_id: int) -> tuple[str, ...]:
    return tuple(r["code"] for r in conn.execute(
        "SELECT code FROM project_condition WHERE project_id=? ORDER BY code", (project_id,)))


def calculate(conn: sqlite3.Connection, project_id: int, mode: str = DESIGN, as_of: str | None = None) -> Result:
    p = conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone()
    if not p:
        raise ValueError(f"工事が見つかりません: {project_id}")
    conds = project_conditions(conn, project_id)
    calc = Calculator(conn, p["fy"], p["region"], mode, conds, p["orderer"],
                      p["price_date"] if as_of is None else as_of, project_id)
    items = [
        calc.item(r)
        for r in conn.execute("SELECT * FROM project_item WHERE project_id=? ORDER BY seq", (project_id,))
    ]

    def total(pred) -> int:
        return sum(i.amount for i in items if pred(i.category))

    summary = calc.summary(total(is_direct), p["work_type"], total(lambda c: c == "共通仮設"),
                           total(lambda c: c == "現場管理"), total(lambda c: c == DIRECT_EXCLUDED))
    for i in items:
        if i.how == "未設定":
            calc.warnings.append(f"明細{i.seq}「{i.name} {i.spec}」に歩掛・単価が当たっていません")
    warnings = list(dict.fromkeys(calc.warnings))  # 重複を除いて順番を保つ
    return Result(project_id, mode, items, summary, warnings, conds, calc.rules)


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


def bid_check(design: Result, company: Result, bid: int, planned: int | None = None,
              threshold: int | None = None) -> BidCheck:
    """入札額の検討。実行原価 = 自社単価での直接工事費 + 設計の共通仮設費・現場管理費（見込み）。
    予定価格が公表されていれば planned・threshold にその値（と逆算した最低制限価格）を渡す。"""
    d = design.summary
    cost = company.summary.direct + d.common_temp + d.site_mgmt
    planned = planned or d.price
    threshold = threshold or d.threshold
    return BidCheck(
        bid=bid, planned=planned, threshold=threshold, cost=cost,
        ratio=(bid / planned) if planned else 0.0, margin=bid - cost,
        below_threshold=bid < threshold, over_planned=bid > planned,
    )


# ====================================================================== 書き換え（履歴を残し、ロック中は断る）
def _item_edit(conn: sqlite3.Connection, item_id: int, action: str, detail: str):
    pid = audit.project_of_item(conn, item_id)
    audit.require_editable(conn, pid)
    row = conn.execute("SELECT * FROM project_item WHERE id=?", (item_id,)).fetchone()
    audit.log(conn, pid, action, f"明細{row['seq']}「{row['name']}」{detail}" if row else detail)
    audit.touch(conn, pid)
    return row


def set_bid(conn: sqlite3.Connection, project_id: int, bid: float) -> None:
    audit.require(conn, "edit")
    with conn:
        conn.execute("UPDATE project SET bid_price=? WHERE id=?", (bid, project_id))
        audit.log(conn, project_id, "入札額", f"{bid:,.0f}")


def set_note(conn: sqlite3.Connection, item_id: int, note: str, remember: bool = True) -> None:
    """積算根拠のメモ。remember=True なら同じ名称・規格・単位の項目に次回以降も表示する。"""
    with conn:
        row = _item_edit(conn, item_id, "メモ", note)
        conn.execute("UPDATE project_item SET note=? WHERE id=?", (note, item_id))
        if remember and row:
            conn.execute(
                "INSERT INTO item_mapping(name, spec, unit, bukake_code, note) VALUES (?,?,?,?,?)"
                " ON CONFLICT(name, spec, unit) DO UPDATE SET note=excluded.note",
                (row["name"], row["spec"], row["unit"], row["bukake_code"], note),
            )


def set_category(conn: sqlite3.Connection, item_id: int, category: str) -> None:
    if category not in CATEGORIES:
        raise ValueError(f"区分は {CATEGORIES} のどれかです")
    with conn:
        _item_edit(conn, item_id, "区分", category)
        conn.execute("UPDATE project_item SET category=? WHERE id=?", (category, item_id))


def set_qty(conn: sqlite3.Connection, item_id: int, qty: float) -> None:
    with conn:
        row = _item_edit(conn, item_id, "数量", f"{qty:g}")
        conn.execute("UPDATE project_item SET qty=? WHERE id=?", (qty, item_id))
        if row:
            audit.log(conn, row["project_id"], "数量（変更前）", f"{row['qty']:g}")


def set_item_conditions(conn: sqlite3.Connection, item_id: int, conditions: str) -> None:
    norm = ",".join(split_conditions(conditions))
    with conn:
        _item_edit(conn, item_id, "補正", norm or "（なし）")
        conn.execute("UPDATE project_item SET conditions=? WHERE id=?", (norm, item_id))


def assign_code(conn: sqlite3.Connection, item_id: int, code: str, remember: bool = True) -> None:
    """明細に歩掛コードを当てる。remember=True なら対応表に覚え、次の工事から自動で当てる。"""
    with conn:
        row = _item_edit(conn, item_id, "コード", code or "（なし）")
        conn.execute("UPDATE project_item SET bukake_code=? WHERE id=?", (code, item_id))
        if remember and row:
            conn.execute(
                "INSERT INTO item_mapping(name, spec, unit, bukake_code) VALUES (?,?,?,?)"
                " ON CONFLICT(name, spec, unit) DO UPDATE SET bukake_code=excluded.bukake_code",
                (row["name"], row["spec"], row["unit"], code),
            )


def add_item(conn: sqlite3.Connection, project_id: int, name: str, spec: str = "", unit: str = "", qty: float = 0,
             code: str = "", level1: str = "", level2: str = "", level3: str = "", category: str = DIRECT) -> int:
    audit.require_editable(conn, project_id)
    with conn:
        seq = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM project_item WHERE project_id=?",
                           (project_id,)).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO project_item(project_id, seq, level1, level2, level3, name, spec, unit, qty, bukake_code,"
            " category) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, seq, level1, level2, level3, name, spec, unit, qty, code, category),
        )
        audit.log(conn, project_id, "行を追加", f"明細{seq}「{name}」")
        audit.touch(conn, project_id)
    return cur.lastrowid


def delete_item(conn: sqlite3.Connection, item_id: int) -> None:
    with conn:
        _item_edit(conn, item_id, "行を削除", "")
        conn.execute("DELETE FROM project_item WHERE id=?", (item_id,))


def set_project_conditions(conn: sqlite3.Connection, project_id: int, codes: list[str]) -> None:
    audit.require_editable(conn, project_id)
    with conn:
        conn.execute("DELETE FROM project_condition WHERE project_id=?", (project_id,))
        conn.executemany("INSERT INTO project_condition(project_id, code) VALUES (?,?)",
                         [(project_id, c) for c in dict.fromkeys(codes)])
        audit.log(conn, project_id, "工事の補正", "、".join(codes) or "（なし）")
        audit.touch(conn, project_id)


PROJECT_FIELDS = ("name", "fy", "region", "work_type", "orderer", "price_date")


def set_project_fields(conn: sqlite3.Connection, project_id: int, **fields: str) -> None:
    bad = set(fields) - set(PROJECT_FIELDS)
    if bad:
        raise ValueError(f"変えられない項目です: {bad}")
    audit.require_editable(conn, project_id)
    with conn:
        for k, v in fields.items():
            conn.execute(f"UPDATE project SET {k}=? WHERE id=?", (v, project_id))
        audit.log(conn, project_id, "工事の設定", "、".join(f"{k}={v}" for k, v in fields.items()))
        audit.touch(conn, project_id)
