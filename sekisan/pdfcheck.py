"""⑨ 金抜き設計書PDFとの照合。PDFの文字から各明細の名称と数量を探し、CSVと食い違いがないか確かめる。
文字が埋め込まれたPDFが対象（スキャンした画像のPDFは読めない）。"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .calc import ItemResult

# 英字の直後の数字（m3 の 3 など）は数量として扱わない
NUM = re.compile(r"(?<![\d.A-Za-z])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\d.,A-Za-z])\d+(?:\.\d+)?")


def norm(s: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s))


def extract_lines(pdf_path: str | Path) -> list[str]:
    import pdfplumber  # 必要なときだけ読み込む
    lines: list[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            lines.extend(l for l in text.splitlines() if l.strip())
    return lines


def numbers(line: str) -> list[float]:
    return [float(m.replace(",", "")) for m in NUM.findall(unicodedata.normalize("NFKC", line))]


@dataclass
class PdfCheck:
    seq: int
    name: str
    spec: str
    unit: str
    qty: float
    pdf_qty: float | None
    status: str          # 一致 / 数量違い / 見つからない
    line: str


def check(items: list[ItemResult], lines: list[str]) -> list[PdfCheck]:
    nlines = [(norm(l), l) for l in lines]
    out = []
    for it in items:
        name, spec = norm(it.name), norm(it.spec)
        cands = [(n, raw) for n, raw in nlines if name and name in n]
        if spec:
            # 規格がある行は規格まで一致する行だけを見る（「基礎工」が別の行の工種名に当たるのを防ぐ）
            with_spec = [c for c in cands if spec in c[0]]
            if not with_spec:
                out.append(PdfCheck(it.seq, it.name, it.spec, it.unit, it.qty, None, "見つからない", ""))
                continue
            cands = with_spec
        if not cands:
            out.append(PdfCheck(it.seq, it.name, it.spec, it.unit, it.qty, None, "見つからない", ""))
            continue
        hit = next(((n, raw) for n, raw in cands if any(abs(x - it.qty) < 1e-6 for x in numbers(raw))), None)
        if hit:
            out.append(PdfCheck(it.seq, it.name, it.spec, it.unit, it.qty, it.qty, "一致", hit[1]))
        else:
            raw = cands[0][1]
            # 名称・規格より後ろにある最後の数字を数量とみなす（金抜き設計書は数量が行の最後）
            tail = unicodedata.normalize("NFKC", raw)
            for key in (unicodedata.normalize("NFKC", it.spec), unicodedata.normalize("NFKC", it.name)):
                if key and key in tail:
                    tail = tail[tail.index(key) + len(key):]
                    break
            nums = numbers(tail)
            out.append(PdfCheck(it.seq, it.name, it.spec, it.unit, it.qty, nums[-1] if nums else None, "数量違い", raw))
    return out


def check_pdf(items: list[ItemResult], pdf_path: str | Path) -> list[PdfCheck]:
    lines = extract_lines(pdf_path)
    if not lines:
        raise ValueError("PDFから文字を読み取れませんでした（スキャンした画像のPDFかもしれません）。")
    return check(items, lines)
