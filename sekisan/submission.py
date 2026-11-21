"""役所に出す書類：入札額に合わせた工事費内訳書（Excel・PDF）・入札書・委任状・電子入札CSV と、提出前のチェック。

内訳書の工事価格は入札額と同じにする（違うと無効になる発注者が多い）。合わせ方は2通り。
- 一般管理費等で合わせる：直接工事費・共通仮設費・現場管理費は積算のまま、差を一般管理費等で調整する
- 全体を同じ率で合わせる：各明細の単価・共通仮設費・現場管理費に同じ率を掛け、端数は一般管理費等で調整する
様式は発注者ごとに決まっていることがあるので、指定の様式があればそちらを使う（ここで作るのは一般的な形）。
"""
from __future__ import annotations

import dataclasses
import json
import math
import sqlite3
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import audit, calc, export

FIT_GENERAL = "一般管理費等で合わせる"
FIT_RATIO = "全体を同じ率で合わせる"
FITS = (FIT_GENERAL, FIT_RATIO)
COMPANY_KEYS = ("商号", "所在地", "代表者役職", "代表者氏名", "電話", "FAX", "業者番号", "代理人氏名")


# ------------------------------------------------------------------ 会社の情報（全員で共通）
def _ensure(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS company_info (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")


def company(conn: sqlite3.Connection) -> dict[str, str]:
    _ensure(conn)
    have = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM company_info")}
    return {k: have.get(k, "") for k in COMPANY_KEYS}


def set_company(conn: sqlite3.Connection, info: dict[str, str]) -> None:
    audit.require(conn, "master")
    _ensure(conn)
    with conn:
        for k in COMPANY_KEYS:
            if k in info:
                conn.execute("INSERT OR REPLACE INTO company_info(key, value) VALUES (?, ?)", (k, (info[k] or "").strip()))
        audit.log(conn, None, "会社の情報", "、".join(f"{k}" for k in COMPANY_KEYS if info.get(k)))


# ------------------------------------------------------------------ 入札額に合わせる
def fit(res: calc.Result, bid: int, method: str = FIT_GENERAL) -> tuple[calc.Result, list[str]]:
    """工事価格が入札額になるよう内訳を合わせた Result と、注意を返す。"""
    s = res.summary
    notes: list[str] = []
    if bid <= 0:
        return res, ["入札額が入っていません"]
    if method == FIT_GENERAL:
        general = bid - s.cost
        if general >= 0:
            ns = dataclasses.replace(s, general=general, price=bid,
                                     general_rate=round(general / s.cost * 100, 2) if s.cost else 0.0)
            return dataclasses.replace(res, summary=_with_tax(ns, res)), notes
        notes.append("入札額が工事原価より低いため、一般管理費等だけでは合わせられません。全体を同じ率で合わせました。")
    k = bid / s.price if s.price else 1.0
    items = []
    for it in res.items:
        up = math.floor(it.unit_price * k) if it.unit_price else 0
        items.append(dataclasses.replace(it, unit_price=up, amount=calc.floor_yen(up * it.qty)))
    direct = sum(i.amount for i in items if calc.is_direct(i.category))
    ct_stack = sum(i.amount for i in items if i.category == "共通仮設")
    sm_stack = sum(i.amount for i in items if i.category == "現場管理")
    ct = math.floor(s.common_temp_rated * k) + ct_stack
    net = direct + ct
    sm = math.floor((s.site_mgmt - s.site_mgmt_stacked) * k) + sm_stack
    cost = net + sm
    general = bid - cost
    if general < 0:   # 端数で足りないときは、いちばん大きい明細の単価を下げる
        biggest = max((i for i in items if i.qty), key=lambda i: i.amount, default=None)
        if biggest:
            cut = math.ceil(-general / biggest.qty)
            idx = items.index(biggest)
            items[idx] = dataclasses.replace(biggest, unit_price=biggest.unit_price - cut,
                                             amount=calc.floor_yen((biggest.unit_price - cut) * biggest.qty))
            direct = sum(i.amount for i in items if calc.is_direct(i.category))
            net, cost = direct + ct, direct + ct + sm
            general = bid - cost
    ns = dataclasses.replace(s, direct=direct, common_temp=ct, common_temp_rated=ct - ct_stack,
                             common_temp_stacked=ct_stack, net=net, site_mgmt=sm, site_mgmt_stacked=sm_stack,
                             cost=cost, general=general, price=bid,
                             general_rate=round(general / cost * 100, 2) if cost else 0.0)
    notes.append(f"明細の単価・共通仮設費・現場管理費に {k * 100:.2f}% を掛けました（端数は一般管理費等で調整）。")
    return dataclasses.replace(res, items=items, summary=_with_tax(ns, res)), notes


def _with_tax(s: calc.Summary, res: calc.Result) -> calc.Summary:
    tax = calc.floor_yen(s.price * float(res.rules.get("消費税率", "10")) / 100)
    return dataclasses.replace(s, tax=tax, total=s.price + tax)


# ------------------------------------------------------------------ 提出前チェック
@dataclass
class Check:
    ok: bool
    item: str
    detail: str = ""
    level: str = ""     # bad（出してはいけない）/ warn（確かめる）


@dataclass
class Package:
    project: dict
    info: dict
    company: dict
    fitted: calc.Result
    notes: list[str] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)

    @property
    def blocking(self) -> list[Check]:
        return [c for c in self.checks if not c.ok and c.level == "bad"]


def meta_of(project: dict) -> dict:
    try:
        return json.loads(project.get("doc_meta") or "{}") or {}
    except ValueError:
        return {}


def default_info(project: dict) -> dict:
    """書類に入れる工事の情報（金抜き設計書の表紙から）。画面で直せる。"""
    m = meta_of(project)
    orderer = project.get("orderer") or "奈良県"
    return {
        "宛先": "奈良県知事" if orderer in ("奈良県", "") else f"{orderer}長",
        "工事名": project.get("name", ""),
        "工事番号": m.get("工事番号", ""),
        "工事場所": m.get("工事箇所", ""),
        "提出日": date.today().isoformat(),
        "合わせ方": FIT_GENERAL,
        "代理人": "",
    }


def saved_info(project: dict) -> dict:
    try:
        return json.loads(project.get("submit_info") or "{}") or {}
    except ValueError:
        return {}


def save_info(conn: sqlite3.Connection, project_id: int, info: dict) -> None:
    audit.require_editable(conn, project_id)
    with conn:
        conn.execute("UPDATE project SET submit_info=? WHERE id=?", (json.dumps(info, ensure_ascii=False), project_id))


def build(conn: sqlite3.Connection, project_id: int, info: dict | None = None,
          threshold: int | None = None, planned: int | None = None) -> Package:
    p = dict(conn.execute("SELECT * FROM project WHERE id=?", (project_id,)).fetchone())
    info = {**default_info(p), **saved_info(p), **(info or {})}
    res = calc.calculate(conn, project_id)
    bid = int(p.get("bid_price") or 0)
    fitted, notes = fit(res, bid, info.get("合わせ方", FIT_GENERAL))
    co = company(conn)
    if not (threshold and planned) and p.get("published_amount"):   # 公表額があれば、そこからの逆算を使う
        from . import reverse
        try:
            rv = reverse.solve(conn, project_id, int(p["published_amount"]), p.get("published_basis") or reverse.BASES[0])
            planned = planned or rv.implied.price
            threshold = threshold or (rv.target if rv.basis == "最低制限価格（税抜）" else rv.implied.threshold)
        except ValueError:
            pass
    th = threshold or res.summary.threshold
    pl = planned or res.summary.price
    s = fitted.summary
    checks = [
        Check(bid > 0, "入札額が入っている", f"¥{bid:,}" if bid else "「入札検討」で入札額を決めてください", "bad"),
        Check(bid >= th, "最低制限価格（見込み）を下回っていない", f"見込み ¥{th:,}", "bad"),
        Check(bid <= pl, "予定価格（見込み）を超えていない", f"見込み ¥{pl:,}", "bad"),
        Check(s.price == bid, "内訳書の工事価格が入札額と同じ", f"内訳書 ¥{s.price:,}", "bad"),
        Check(s.general >= 0, "一般管理費等がマイナスでない", f"¥{s.general:,}", "bad"),
        Check(not res.unresolved, "単価が決まっていない明細がない",
              f"{len(res.unresolved)} 件（「明細」「不明な単価」で埋める）" if res.unresolved else "", "bad"),
        Check(all(i.amount > 0 for i in fitted.items if i.qty), "金額が0円の明細がない",
              "、".join(f"明細{i.seq}" for i in fitted.items if i.qty and i.amount <= 0)[:80], "warn"),
        Check(bool(co["商号"] and co["所在地"] and co["代表者氏名"]), "会社の情報（商号・所在地・代表者）が入っている",
              "", "bad"),
        Check(bool(info.get("工事名")), "工事名が入っている", "", "bad"),
        Check(bool(info.get("工事番号")), "工事番号が入っている", "公告の工事番号と同じか確かめる", "warn"),
        Check(p.get("status") in ("確認済", "提出済"), "別の人の確認が済んでいる（ダブルチェック）",
              f"今は「{p.get('status') or '作成中'}」：「工事の設定」で確認済にする", "warn"),
    ]
    return Package(p, info, co, fitted, notes, checks)


# ------------------------------------------------------------------ 書類を作る
def write_all(pkg: Package, out_dir: str | Path) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch for ch in pkg.info["工事名"] if ch not in '\\/:*?"<>|')[:60] or "工事"
    files = [
        write_breakdown_xlsx(pkg, out / f"{safe}_工事費内訳書.xlsx"),
        write_breakdown_pdf(pkg, out / f"{safe}_工事費内訳書.pdf"),
        write_bid_form(pkg, out / f"{safe}_入札書.xlsx"),
        export.export_ebid_csv(out / f"{safe}_電子入札用内訳書.csv", pkg.project, pkg.fitted),
        write_checklist(pkg, out / f"{safe}_提出前チェック.xlsx"),
    ]
    if pkg.info.get("代理人") or pkg.company.get("代理人氏名"):
        files.insert(3, write_proxy(pkg, out / f"{safe}_委任状.xlsx"))
    return files


def _wareki(iso: str) -> str:
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
    except ValueError:
        return iso
    return f"令和{y - 2018}年{m}月{d}日" if y >= 2019 else f"{y}年{m}月{d}日"


def _note(note: str) -> str:
    """摘要：社内のコードは出さない。金抜き設計書の単価表は「単1号」の形にする。率の注記はそのまま。"""
    import re
    if not note or note.startswith("率"):
        return note or ""
    m = re.search(r"/((?:単|施)\d+)$", note)
    return f"{m.group(1)}号" if m else ""


def _rows(pkg: Package) -> list[tuple]:
    return [(d, name, spec, unit, qty, price, amount, _note(note))
            for d, name, spec, unit, qty, price, amount, note in export.breakdown_rows(pkg.fitted, export._depth(pkg.fitted))]


def _header_block(ws, pkg: Package, title: str, last_col: str) -> int:
    from openpyxl.styles import Alignment, Font
    co, info = pkg.company, pkg.info
    ws.merge_cells(f"A1:{last_col}1")
    ws["A1"] = title
    ws["A1"].font = Font(bold=True, size=16)
    ws["A1"].alignment = Alignment(horizontal="center")
    ws["A3"] = f"{info['宛先']}　様"
    ws["A3"].font = Font(size=12)
    right = [("提出日", _wareki(info["提出日"])), ("所在地", co["所在地"]), ("商号又は名称", co["商号"]),
             ("代表者", f"{co['代表者役職']}　{co['代表者氏名']}".strip() + "　　印")]
    if info.get("代理人"):
        right.append(("代理人", f"{info['代理人']}　　印"))
    for k, (lab, val) in enumerate(right):
        ws.cell(3 + k, 4, lab)
        ws.cell(3 + k, 5, val)
    r = 4 + len(right)
    for lab, val in (("工事番号", info.get("工事番号", "")), ("工事名", info["工事名"]), ("工事場所", info.get("工事場所", ""))):
        ws.cell(r, 1, lab).font = Font(bold=True)
        ws.cell(r, 2, val)
        r += 1
    return r + 1


def _print_setup(ws, header_row: int) -> None:
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = "portrait"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = f"{header_row}:{header_row}"
    ws.oddFooter.center.text = "&P / &N"
    ws.page_margins.left = ws.page_margins.right = 0.5


def write_breakdown_xlsx(pkg: Package, path: Path) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook()
    ws = wb.active
    ws.title = "工事費内訳書"
    r0 = _header_block(ws, pkg, "工 事 費 内 訳 書", "G")
    rows = [["　" * max(d, 0) + name, spec, unit, qty, price, amount, note]
            for d, name, spec, unit, qty, price, amount, note in _rows(pkg)]
    export._table(ws, r0, ["費目・工種・種別・細別", "規格", "単位", "数量", "単価", "金額", "摘要"], rows,
                  {4: export.NUM, 5: export.YEN, 6: export.YEN}, [38, 24, 6, 10, 12, 16, 14])
    for k, (d, *_x) in enumerate(_rows(pkg)):
        if d == 0:
            for c in range(1, 8):
                ws.cell(r0 + 1 + k, c).font = Font(bold=True)
    _print_setup(ws, r0)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def _font() -> str:
    """PDF の日本語フォント：Windows の MS 明朝・游明朝を埋め込む。なければ reportlab の和文フォント。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    import os
    windir = os.environ.get("WINDIR", r"C:\Windows")
    for fname, idx in (("msmincho.ttc", 0), ("YuMincho.ttc", 0), ("msgothic.ttc", 0), ("ipaexm.ttf", None),
                       ("ipam.ttf", None)):
        for d in (Path(windir) / "Fonts", Path("/usr/share/fonts/truetype"), Path("/usr/share/fonts/opentype")):
            for f in ([d / fname] + (list(d.rglob(fname)) if d.exists() and not str(d).startswith(windir) else [])):
                if f.exists():
                    try:
                        pdfmetrics.registerFont(TTFont("JP", str(f), subfontIndex=idx or 0))
                        return "JP"
                    except Exception:   # noqa: BLE001 - 読めないフォントは飛ばす
                        continue
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
    return "HeiseiMin-W3"


def write_breakdown_pdf(pkg: Package, path: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from reportlab.lib.styles import ParagraphStyle
    jp = _font()
    co, info = pkg.company, pkg.info
    st = ParagraphStyle("jp", fontName=jp, fontSize=9, leading=12)
    indent = [ParagraphStyle(f"i{d}", parent=st, leftIndent=d * 3.5 * mm) for d in range(6)]
    title = ParagraphStyle("t", fontName=jp, fontSize=16, leading=22, alignment=1)
    story = [Paragraph("工 事 費 内 訳 書", title), Spacer(1, 6 * mm)]
    head = [[Paragraph(f"{info['宛先']}　様", ParagraphStyle("a", fontName=jp, fontSize=11)), ""],
            ["", f"提出日　{_wareki(info['提出日'])}"], ["", f"所在地　{co['所在地']}"],
            ["", f"商号又は名称　{co['商号']}"], ["", f"代表者　{co['代表者役職']}　{co['代表者氏名']}　　印"]]
    if info.get("代理人"):
        head.append(["", f"代理人　{info['代理人']}　　印"])
    ht = Table(head, colWidths=[90 * mm, 90 * mm])
    ht.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), jp, 9.5)]))
    story += [ht, Spacer(1, 4 * mm)]
    meta = [["工事番号", info.get("工事番号", "")], ["工事名", Paragraph(info["工事名"], st)],
            ["工事場所", Paragraph(info.get("工事場所", ""), st)]]
    mt = Table(meta, colWidths=[22 * mm, 158 * mm])
    mt.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), jp, 9.5), ("GRID", (0, 0), (-1, -1), 0.4, colors.grey)]))
    story += [mt, Spacer(1, 4 * mm)]

    def num(v, fmt="{:,.0f}"):
        return "" if v is None else fmt.format(v)
    data = [["費目・工種・種別・細別", "規格", "単位", "数量", "単価", "金額", "摘要"]]
    bold_rows = []
    for k, (d, name, spec, unit, qty, price, amount, note) in enumerate(_rows(pkg), 1):
        data.append([Paragraph(name, indent[min(max(d, 0), 5)]), Paragraph(spec or "", st), unit,
                     num(qty, "{:,.3g}" if qty and qty < 1000 else "{:,.0f}"), num(price), num(amount),
                     Paragraph(note or "", st)])
        if d == 0:
            bold_rows.append(k)
    t = Table(data, colWidths=[56 * mm, 38 * mm, 10 * mm, 15 * mm, 19 * mm, 26 * mm, 16 * mm], repeatRows=1)
    style = [("FONT", (0, 0), (-1, -1), jp, 8.5), ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
             ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDE7F0")), ("ALIGN", (3, 1), (5, -1), "RIGHT"),
             ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]
    style += [("BACKGROUND", (0, r), (-1, r), colors.HexColor("#F1F5F9")) for r in bold_rows]
    t.setStyle(TableStyle(style))
    story.append(t)

    def footer(canvas, doc):
        canvas.setFont(jp, 8)
        canvas.drawCentredString(A4[0] / 2, 10 * mm, f"{doc.page}")
    path.parent.mkdir(parents=True, exist_ok=True)
    SimpleDocTemplate(str(path), pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=14 * mm,
                      bottomMargin=16 * mm, title=f"工事費内訳書 {info['工事名']}").build(
        story, onFirstPage=footer, onLaterPages=footer)
    return path


def _digits(amount: int) -> list[str]:
    """入札書の金額欄（十億〜円の10桁）。先頭に￥を付け、上の空いた桁は空欄。"""
    s = f"{amount:d}"
    cells = [""] * (10 - len(s)) + list(s)
    if len(s) < 10:
        cells[9 - len(s)] = "￥"
    return cells[-10:]


def write_bid_form(pkg: Package, path: Path) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, Side
    wb = Workbook()
    ws = wb.active
    ws.title = "入札書"
    co, info = pkg.company, pkg.info
    thick = Side(style="medium")
    ws.merge_cells("A1:L1")
    ws["A1"] = "入　　札　　書"
    ws["A1"].font = Font(bold=True, size=20)
    ws["A1"].alignment = Alignment(horizontal="center")
    ws["B3"] = "金額"
    labels = ["十億", "億", "千万", "百万", "十万", "万", "千", "百", "十", "円"]
    for k, (lab, d) in enumerate(zip(labels, _digits(pkg.fitted.summary.price))):
        c1 = ws.cell(3, 3 + k, lab)
        c1.alignment = Alignment(horizontal="center")
        c1.font = Font(size=8)
        c2 = ws.cell(4, 3 + k, d)
        c2.font = Font(size=18, bold=True)
        c2.alignment = Alignment(horizontal="center", vertical="center")
        c2.border = Border(left=thick, right=thick, top=thick, bottom=thick)
        ws.column_dimensions[chr(ord("C") + k)].width = 6
    ws.row_dimensions[4].height = 36
    ws["B6"] = "（消費税及び地方消費税を含まない金額）"
    r = 8
    for lab, val in (("工事番号", info.get("工事番号", "")), ("工事名", info["工事名"]), ("工事場所", info.get("工事場所", ""))):
        ws.cell(r, 2, lab).font = Font(bold=True)
        ws.cell(r, 4, val)
        r += 1
    ws.cell(r + 1, 2, "上記の金額で請け負いたいので、入札条件・設計図書・契約書案等を承知のうえ入札します。")
    ws.cell(r + 3, 2, _wareki(info["提出日"]))
    ws.cell(r + 5, 2, f"{info['宛先']}　様")
    rr = r + 7
    for lab, val in (("所在地", co["所在地"]), ("商号又は名称", co["商号"]),
                     ("代表者", f"{co['代表者役職']}　{co['代表者氏名']}".strip() + "　　印")):
        ws.cell(rr, 6, lab)
        ws.cell(rr, 8, val)
        rr += 1
    if info.get("代理人"):
        ws.cell(rr, 6, "代理人")
        ws.cell(rr, 8, f"{info['代理人']}　　印")
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 12
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def write_proxy(pkg: Package, path: Path) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    wb = Workbook()
    ws = wb.active
    ws.title = "委任状"
    co, info = pkg.company, pkg.info
    agent = info.get("代理人") or co.get("代理人氏名", "")
    ws.merge_cells("A1:H1")
    ws["A1"] = "委　　任　　状"
    ws["A1"].font = Font(bold=True, size=20)
    ws["A1"].alignment = Alignment(horizontal="center")
    ws["B3"] = _wareki(info["提出日"])
    ws["B5"] = f"{info['宛先']}　様"
    r = 7
    for lab, val in (("委任者　所在地", co["所在地"]), ("商号又は名称", co["商号"]),
                     ("代表者", f"{co['代表者役職']}　{co['代表者氏名']}".strip() + "　　印")):
        ws.cell(r, 4, lab)
        ws.cell(r, 6, val)
        r += 1
    ws.cell(r + 1, 2, f"私は、{agent} を代理人と定め、下記の工事の入札及び見積に関する一切の権限を委任します。")
    ws.cell(r + 3, 4, "記").alignment = Alignment(horizontal="center")
    rr = r + 5
    for lab, val in (("工事番号", info.get("工事番号", "")), ("工事名", info["工事名"]), ("工事場所", info.get("工事場所", ""))):
        ws.cell(rr, 2, lab).font = Font(bold=True)
        ws.cell(rr, 4, val)
        rr += 1
    ws.cell(rr + 1, 2, "受任者（代理人）使用印鑑")
    ws.cell(rr + 1, 6, "印")
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 14
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def write_checklist(pkg: Package, path: Path) -> Path:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "提出前チェック"
    export._title(ws, f"提出前チェック　{pkg.info['工事名']}")
    rows = [["○" if c.ok else ("×" if c.level == "bad" else "△"), c.item, c.detail] for c in pkg.checks]
    rows += [["", "内訳書の合わせ方", f"{pkg.info.get('合わせ方')}　" + " ".join(pkg.notes)]]
    export._table(ws, 3, ["結果", "確かめること", "内容"], rows, None, [6, 46, 70])
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
