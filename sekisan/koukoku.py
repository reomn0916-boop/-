"""入札公告・入札説明書（PDF・テキスト）から、積算と入札に要る条件を抜き出して工事に入れる。

抜き出すもの：工事名・工事番号・工事場所・工期・入札方式・参加資格（等級）、
日程（公告日・質問締切・回答日・入札締切・開札日・工期の終わり）、予定価格（事前公表なら金額）・最低制限価格・
調査基準価格の有無、提出する書類。
様式は発注者ごとに違うので、見つかったものだけを出し、どこから読んだか（前後の文）も残す。入れる前に人が確かめる。
"""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import audit

ERA = {"令和": 2018, "R": 2018}
DATE_RE = re.compile(r"(令和|R)\s*(\d{1,2}|元)\s*[年.．]\s*(\d{1,2})\s*[月.．]\s*(\d{1,2})\s*日?")
ISO_RE = re.compile(r"(20\d\d)\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?")
YEN_RE = re.compile(r"([\d,]{4,})\s*円")
DOCS = ("入札書", "工事費内訳書", "内訳書", "技術資料", "施工計画", "配置予定技術者", "競争参加資格確認申請書", "資格確認資料",
        "委任状", "誓約書", "低入札価格調査", "総合評価", "見積書")


@dataclass
class Found:
    key: str
    value: str
    source: str = ""     # 読んだところ（前後の文）


@dataclass
class Notice:
    items: list[Found] = field(default_factory=list)

    def get(self, key: str) -> str:
        return next((f.value for f in self.items if f.key == key), "")

    def add(self, key: str, value: str, source: str = "") -> None:
        if value and not self.get(key):
            self.items.append(Found(key, value, source.strip()[:120]))


def _n(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"[ \t　]+", " ", s)


def read_text(path: str | Path) -> str:
    p = Path(path)
    if p.suffix.lower() == ".pdf":
        import pdfplumber
        with pdfplumber.open(str(p)) as pdf:
            return "\n".join((pg.extract_text() or "") for pg in pdf.pages)
    raw = p.read_bytes()
    for enc in ("utf-8", "cp932"):
        try:
            t = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        t = raw.decode("utf-8", errors="replace")
    if p.suffix.lower() in (".htm", ".html"):
        t = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", t, flags=re.S | re.I)
        t = re.sub(r"<br\s*/?>|</p>|</tr>|</li>|</h\d>", "\n", t, flags=re.I)
        t = re.sub(r"<[^>]+>", " ", t)
    return t


def to_iso(s: str) -> str:
    m = DATE_RE.search(s)
    if m:
        y = 1 if m.group(2) == "元" else int(m.group(2))
        try:
            return date(ERA[m.group(1)] + y, int(m.group(3)), int(m.group(4))).isoformat()
        except ValueError:
            return ""
    m = ISO_RE.search(s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return ""
    return ""


def _dates_in(s: str) -> list[str]:
    out = []
    for m in list(DATE_RE.finditer(s)) + list(ISO_RE.finditer(s)):
        iso = to_iso(m.group(0))
        if iso:
            out.append((m.start(), iso))
    return [d for _p, d in sorted(out)]


def _after(text: str, label_re: str, span: int = 160, last: bool = False) -> tuple[str, str]:
    """見出し（label_re）のあとに出てくる日付（期間なら last=True で終わりの日）と、読んだ文。"""
    for m in re.finditer(label_re, text):
        seg = text[m.end(): m.end() + span]
        lines = seg.split("\n")
        # 見出しの行に日付があればその行だけ、なければ次の行まで（ほかの見出しの日付を拾わない）
        seg = lines[0] if _dates_in(lines[0]) else "\n".join(lines[:2])
        ds = _dates_in(seg)
        if ds:
            # 次の見出し（数字＋見出し）より前の日付だけを見る
            return (ds[-1] if last else ds[0]), text[m.start(): m.end() + span].replace("\n", " ")
    return "", ""


def _value_after(text: str, label_re: str) -> tuple[str, str]:
    """「工事名 ○○工事」「1 工事名：○○工事」のような、見出しと同じ行の値"""
    m = re.search(rf"(?:^|\n)\s*(?:[\d(（]+[)）.]?\s*)?(?:{label_re})\s*[:：]?\s*(.+)", text)
    if not m:
        return "", ""
    v = m.group(1).strip()
    v = re.split(r"\s{2,}|　", v)[0].strip(" ：:")
    return v, m.group(0).strip()


def parse_text(text: str) -> Notice:
    t = _n(text)
    nt = Notice()
    v, src = _value_after(t, r"工\s*事\s*名|件\s*名")
    nt.add("工事名", v, src)
    m = re.search(r"第\s*[\d０-９]+\s*[-－‐ー]\s*[^\s号]{1,3}\s*[-－‐ー]\s*[\d０-９]+\s*号", t)
    if m:
        nt.add("工事番号", re.sub(r"\s+", " ", m.group(0)), m.group(0))
    else:
        v, src = _value_after(t, r"工事番号")
        nt.add("工事番号", v, src)
    v, src = _value_after(t, r"工事場所|施工場所|履行場所")
    nt.add("工事場所", v, src)
    # 工期
    m = re.search(r"工\s*期\s*[:：]?\s*(.{0,80})", t)
    if m:
        seg = m.group(1).split("\n")[0]
        nt.add("工期", seg.strip(), m.group(0))
        ds = _dates_in(seg)
        if ds:
            nt.add("工期終了", ds[-1], m.group(0))
        dm = re.search(r"(\d+)\s*日間", seg)
        if dm:
            nt.add("工期の日数", dm.group(1), m.group(0))
    # 入札方式・資格
    for k in ("一般競争入札", "指名競争入札", "条件付一般競争入札", "制限付一般競争入札", "総合評価落札方式", "電子入札"):
        if k in t:
            nt.add("入札方式", "・".join(x for x in ("一般競争入札", "指名競争入札", "条件付一般競争入札", "制限付一般競争入札",
                                                   "総合評価落札方式", "電子入札") if x in t), k)
            break
    m = re.search(r"([^\s、。:：]{2,12}工事)\s*(?:の|において)?\s*[「(（]?\s*([A-DＡ-Ｄ])\s*[」)）]?\s*等級", t)
    if m:
        nt.add("参加資格", f"{m.group(1)} {unicodedata.normalize('NFKC', m.group(2))}等級", m.group(0))
    # 日程
    d, src = _after(t, r"公告日|公\s*告\s*の?\s*日", 60)
    if not d:
        head = _dates_in(t[:400])
        d = head[0] if head else ""
        src = t[:120].replace("\n", " ")
    nt.add("公告日", d, src)
    d, src = _after(t, r"質問(?:書)?の?(?:提出|受付)?(?:期限|期間|締切)", 160, last=True)
    nt.add("質問締切", d, src)
    d, src = _after(t, r"(?:質問に対する)?回答(?:の)?(?:日|期日|予定日|閲覧)", 120)
    nt.add("回答日", d, src)
    d, src = _after(t, r"入札書の?(?:提出|受付)(?:期限|期間|締切|日時)|入札(?:の)?締切|入札期間", 160, last=True)
    nt.add("入札締切", d, src)
    d, src = _after(t, r"開\s*札(?:の)?(?:日時|日|予定日)?", 80)
    nt.add("開札日", d, src)
    # 予定価格・最低制限価格
    m = re.search(r"予定価格(.{0,120})", t, re.S)
    if m:
        seg = m.group(1)
        if "事後" in seg[:40]:
            nt.add("予定価格", "事後公表", m.group(0))
        else:
            ym = YEN_RE.search(seg)
            if ym:
                tax_in = "含む" in seg[:ym.start() + 40] and "含まない" not in seg[:ym.start() + 40]
                nt.add("予定価格" + ("（税込）" if tax_in else "（税抜）"), ym.group(1).replace(",", ""), m.group(0))
            elif "事前" in seg[:40]:
                nt.add("予定価格", "事前公表（金額は別紙）", m.group(0))
    for label in ("最低制限価格", "調査基準価格"):
        m = re.search(label + r"(.{0,100})", t, re.S)
        if not m:
            continue
        seg = m.group(1)
        ym = YEN_RE.search(seg)
        if ym:
            nt.add(label, ym.group(1).replace(",", ""), m.group(0))
        elif re.search(r"設けない|設定しない|なし", seg[:40]):
            nt.add(label, "設定しない", m.group(0))
        elif re.search(r"設け|設定", seg[:40]):
            nt.add(label, "設定あり" + ("（事後公表）" if "事後" in seg[:60] else ""), m.group(0))
    # 提出書類
    docs = [d for d in DOCS if d in t]
    if "工事費内訳書" in docs and "内訳書" in docs:
        docs.remove("内訳書")
    nt.add("提出書類", "、".join(docs), "")
    return nt


def parse(path: str | Path) -> Notice:
    return parse_text(read_text(path))


# ------------------------------------------------------------------ 工事に入れる
SCHEDULE_KEYS = {"公告日": "公告日", "質問締切": "質問締切", "回答日": "回答日", "入札締切": "入札締切", "開札日": "開札日",
                 "工期終了": "工期終了"}


def apply(conn: sqlite3.Connection, project_id: int, nt: Notice, keys: set[str] | None = None) -> list[str]:
    """選んだ項目（keys。省略はすべて）を工事に入れる。入れたものの説明を返す。"""
    import json

    from . import reverse, schedule, submission
    audit.require_editable(conn, project_id)
    use = (lambda k: keys is None or k in keys)
    done = []
    dates = {SCHEDULE_KEYS[k]: nt.get(k) for k in SCHEDULE_KEYS if nt.get(k) and use(k)}
    if dates:
        schedule.set_dates(conn, project_id, dates)
        done.append("日程：" + "、".join(f"{k} {v}" for k, v in dates.items()))
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone())
    info = submission.saved_info(p)
    for k in ("工事番号", "工事場所"):
        if nt.get(k) and use(k):
            info[k] = nt.get(k)
            done.append(f"{k}：{nt.get(k)}")
    if info != submission.saved_info(p):
        submission.save_info(conn, project_id, info)
    for key, basis in (("予定価格（税抜）", "予定価格（税抜）"), ("予定価格（税込）", "予定価格（税込）"),
                       ("最低制限価格", "最低制限価格（税抜）")):
        v = nt.get(key)
        if v.isdigit() and use(key):
            reverse.save(conn, project_id, basis, int(v))
            done.append(f"公表額：{basis} ¥{int(v):,}（入札検討の逆算に使います）")
            break
    want = [d for d in nt.get("提出書類").split("、") if d]
    if want and use("提出書類"):
        have = {r["item"] for r in schedule.checklist(conn, project_id)}
        for d in want:
            if not any(d in h for h in have):
                schedule.add_check(conn, project_id, d)
        done.append("提出物のチェックリスト：" + "、".join(want))
    with conn:
        meta = json.loads(p.get("doc_meta") or "{}") if p.get("doc_meta") else {}
        meta["公告"] = {f.key: f.value for f in nt.items}
        conn.execute("UPDATE project SET doc_meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), project_id))
        audit.log(conn, project_id, "公告を読み込み", " / ".join(done))
    return done
