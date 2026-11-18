"""② 歩掛・単価の当てはめ候補。名称・規格・単位の似ぐあいと、過去に当てたコードから順位をつける。"""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

from . import calc

AUTO_MIN_SCORE = 0.85   # 一括で当てるときの下限（これ未満は人が選ぶ）


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"[（(].*?ダミー.*?[)）]", "", s)
    return re.sub(r"[\s　・,、]", "", s)


def sim(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = SequenceMatcher(None, a, b).ratio()
    if a in b or b in a:
        r = max(r, 0.75 + 0.25 * min(len(a), len(b)) / max(len(a), len(b)))
    return r


@dataclass
class Candidate:
    code: str
    kind: str      # 歩掛 / 施工パッケージ / 単価の種類 / 見積 / 過去の当てはめ
    name: str
    spec: str
    unit: str
    score: float
    reason: str


def candidates(conn: sqlite3.Connection, fy: str, name: str, spec: str, unit: str, n: int = 5) -> list[Candidate]:
    pool: list[tuple[str, str, str, str, str]] = []
    for r in conn.execute("SELECT code, name, spec, unit FROM bukake WHERE fy=?", (fy,)):
        pool.append((r["code"], "歩掛", r["name"], r["spec"], r["unit"]))
    for r in conn.execute("SELECT code, name, spec, unit FROM package WHERE fy=?", (fy,)):
        pool.append((r["code"], "施工パッケージ", r["name"], r["spec"], r["unit"]))
    for r in conn.execute("SELECT DISTINCT kind, code, name, spec, unit FROM master_price WHERE fy=?", (fy,)):
        pool.append((r["code"], r["kind"], r["name"], r["spec"], r["unit"]))
    for r in conn.execute("SELECT code, name, spec, unit FROM quote"):
        pool.append((r["code"], "見積", r["name"], r["spec"], r["unit"]))
    have = {c for c, *_ in pool}
    for r in conn.execute("SELECT DISTINCT kind, code, name, spec, unit, source FROM public_item "
                          "WHERE fy=? AND price IS NULL", (fy,)):
        if r["code"] not in have:
            pool.append((r["code"], f"{r['kind']}・単価は{r['source']}", r["name"], r["spec"], r["unit"]))

    best: dict[str, Candidate] = {}

    def add(c: Candidate) -> None:
        if c.code not in best or best[c.code].score < c.score:
            best[c.code] = c

    for code, kind, cn, cs, cu in pool:
        s_name = sim(name, cn)
        if s_name < 0.4:
            continue
        if s_name < 1.0:
            s_name = min(s_name, 0.9)   # 名称が完全に同じものを、似ているだけのものより必ず上にする
        s_spec = sim(spec, cs) if spec and cs else (0.5 if not spec and not cs else 0.3)
        if s_spec < 1.0:
            s_spec = min(s_spec, 0.85)  # 規格も同じ考え方（RC-40 と C-40 を区別する）
        s_unit = 1.0 if norm(unit) == norm(cu) else 0.0
        score = 0.6 * s_name + 0.25 * s_spec + 0.15 * s_unit
        why = [f"名称{s_name * 100:.0f}%"]
        if spec or cs:
            why.append(f"規格{s_spec * 100:.0f}%")
        why.append("単位一致" if s_unit else "単位違い")
        add(Candidate(code, kind, cn, cs, cu, round(score, 3), "・".join(why)))

    # 過去に同じような名称へ当てたコード（実績があるので少し上げる）
    for m in conn.execute("SELECT name, spec, unit, bukake_code FROM item_mapping WHERE bukake_code<>''"):
        s_name = sim(name, m["name"])
        if s_name < 0.6:
            continue
        s_spec = sim(spec, m["spec"]) if spec and m["spec"] else 0.5
        s_unit = 1.0 if norm(unit) == norm(m["unit"]) else 0.0
        score = min(1.0, 0.6 * s_name + 0.25 * s_spec + 0.15 * s_unit + 0.05)
        add(Candidate(m["bukake_code"], "過去の当てはめ", m["name"], m["spec"], m["unit"], round(score, 3),
                      f"過去に「{m['name']} {m['spec']}」へ当てた"))
    return sorted(best.values(), key=lambda c: -c.score)[:n]


def auto_assign(conn: sqlite3.Connection, project_id: int, min_score: float = AUTO_MIN_SCORE) -> list[tuple[int, Candidate]]:
    """未設定の明細に、点数が高い1位の候補だけを当てる。当てた (明細番号, 候補) を返す。"""
    p = conn.execute("SELECT fy FROM project WHERE id=?", (project_id,)).fetchone()
    res = calc.calculate(conn, project_id)
    done = []
    for it in res.unresolved:
        if it.code:  # コードは当たっていて単価待ち（物価資料）なら、別のものに変えない
            continue
        cs = candidates(conn, p["fy"], it.name, it.spec, it.unit, 2)
        if not cs or cs[0].score < min_score:
            continue
        # 1位と2位が僅差なら迷うので当てない（名称・規格・単位が完全に同じなら迷わない）
        exact = cs[0].score >= 0.999
        if not exact and len(cs) > 1 and cs[0].score - cs[1].score < 0.05 and cs[0].code != cs[1].code:
            continue
        calc.assign_code(conn, it.item_id, cs[0].code, remember=True)
        done.append((it.seq, cs[0]))
    return done
