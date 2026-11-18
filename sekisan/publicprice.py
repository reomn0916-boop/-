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
    status: str = ""   # 新規 / 更新 / 同じ（取り込み前の確認用）
    old_price: float | None = None


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


def parse(path: str | Path, kind: str = "材料", prefecture: str = "奈良") -> list[PriceRow]:
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
        r.region = region
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
    audit.require(conn, "master")
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO master_price(fy, kind, code, name, spec, unit, price, region) VALUES (?,?,?,?,?,?,?,?)",
            [(fy, r.kind, r.code, r.name, r.spec, r.unit, r.price, r.region) for r in rows],
        )
        changed = sum(r.status != "同じ" for r in rows)
        audit.log(conn, None, f"{fy}年度 公表単価を取り込み", f"{len(rows)}件（新規・更新 {changed}件）{source}")
    return len(rows)
