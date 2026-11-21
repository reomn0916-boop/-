#!/usr/bin/env python3
"""スイングトレード用のデータを作る。

株価（日足）とニュース（RSS）を集め、テクニカル指標とニュースの材料から
銘柄ごとに点数をつけて swing/data/latest.json に書き出す。
標準ライブラリだけで動く（GitHub Actions で平日に自動実行する）。

  python3 swing/scripts/update.py          # 本番（ネットから取得）
  python3 swing/scripts/update.py --demo   # ネットなしのサンプルデータ（画面の確認用）

※ 点数は機械的なスクリーニングの結果であり、売買をすすめるものではない。
"""
from __future__ import annotations

import argparse
import email.utils
import hashlib
import json
import math
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; swing-board/1.0)"
CHART_DAYS = 120          # アプリのチャートに載せる日数
PER_STOCK_NEWS = 25       # 個別にニュースを検索する銘柄の数（点数の上位から）
NEWS_KEEP_DAYS = 4        # これより古いニュースは捨てる

INDICES = [
    {"sym": "^N225", "name": "日経平均", "kind": "jp"},
    {"sym": "1306.T", "name": "TOPIX連動ETF", "kind": "jp"},
    {"sym": "^GSPC", "name": "S&P500", "kind": "us"},
    {"sym": "^IXIC", "name": "ナスダック", "kind": "us"},
    {"sym": "^SOX", "name": "SOX指数", "kind": "us"},
    {"sym": "JPY=X", "name": "ドル円", "kind": "fx"},
    {"sym": "^VIX", "name": "VIX", "kind": "vol"},
    {"sym": "^TNX", "name": "米10年金利", "kind": "rate"},
]

MARKET_FEEDS = [
    ("NHK 経済", "https://www3.nhk.or.jp/rss/news/cat5.xml"),
    ("Yahoo!ニュース 経済", "https://news.yahoo.co.jp/rss/topics/business.xml"),
    ("Google ニュース", "https://news.google.com/rss/search?q=" + urllib.parse.quote("日経平均 OR 東証 when:2d") + "&hl=ja&gl=JP&ceid=JP:ja"),
    ("Google ニュース", "https://news.google.com/rss/search?q=" + urllib.parse.quote("上方修正 OR 自社株買い OR 増配 OR 下方修正 when:2d") + "&hl=ja&gl=JP&ceid=JP:ja"),
    ("Google ニュース", "https://news.google.com/rss/search?q=" + urllib.parse.quote("株価 急騰 OR 急落 OR ストップ高 when:2d") + "&hl=ja&gl=JP&ceid=JP:ja"),
]

# ---- ニュースの言葉 ---------------------------------------------------------
POS_WORDS = {
    "上方修正": 3, "最高益": 3, "過去最高": 2, "増配": 3, "自社株買い": 3, "自己株式取得": 3, "復配": 3,
    "黒字転換": 3, "上振れ": 2, "好決算": 3, "増益": 2, "株式分割": 2, "ストップ高": 2, "格上げ": 2,
    "目標株価引き上げ": 2, "目標株価を引き上げ": 2, "受注": 1, "提携": 1, "承認": 1, "好調": 1, "急騰": 1,
    "続伸": 1, "反発": 1, "上昇": 1, "大幅高": 1, "買い優勢": 1, "TOB": 2, "株主還元": 2,
}
NEG_WORDS = {
    "下方修正": -3, "赤字": -2, "減配": -3, "無配": -3, "下振れ": -2, "減益": -2, "ストップ安": -2,
    "格下げ": -2, "目標株価引き下げ": -2, "目標株価を引き下げ": -2, "不祥事": -3, "不正": -2, "リコール": -2,
    "訴訟": -1, "延期": -1, "中止": -1, "減産": -1, "急落": -1, "続落": -1, "反落": -1, "下落": -1,
    "大幅安": -1, "懸念": -1, "売り優勢": -1, "撤退": -1, "業務停止": -3, "公募増資": -2, "希薄化": -2,
}
# 材料の種類（見出しにつける札）
TAGS = {
    "決算": ["決算", "業績", "営業利益", "純利益", "増益", "減益", "最高益"],
    "業績修正": ["上方修正", "下方修正", "上振れ", "下振れ"],
    "株主還元": ["自社株買い", "自己株式取得", "増配", "減配", "復配", "株主還元", "株式分割"],
    "M&A": ["TOB", "買収", "経営統合", "合併", "MBO"],
    "格付け": ["格上げ", "格下げ", "目標株価", "レーティング"],
    "受注・提携": ["受注", "提携", "契約", "協業"],
    "不祥事": ["不祥事", "不正", "リコール", "業務停止", "訴訟"],
    "増資": ["公募増資", "第三者割当", "希薄化"],
}
# 相場全体のテーマ → 影響を受けやすい業種（+ は追い風、- は向かい風）
THEMES = [
    {"theme": "円安", "words": ["円安", "円下落", "ドル高"], "up": ["自動車", "電機", "精密", "機械"], "down": ["小売", "食品", "電力・ガス", "空運"]},
    {"theme": "円高", "words": ["円高", "円上昇", "ドル安"], "up": ["小売", "食品", "電力・ガス", "空運"], "down": ["自動車", "電機", "精密", "機械"]},
    {"theme": "半導体", "words": ["半導体", "AI", "生成AI", "エヌビディア", "NVIDIA", "データセンター", "HBM"], "up": ["半導体", "電機"], "down": []},
    {"theme": "金利上昇", "words": ["利上げ", "金利上昇", "長期金利上昇", "金融引き締め"], "up": ["銀行", "保険"], "down": ["不動産", "情報・サービス"]},
    {"theme": "金利低下", "words": ["利下げ", "金利低下", "金融緩和"], "up": ["不動産", "情報・サービス"], "down": ["銀行", "保険"]},
    {"theme": "原油高", "words": ["原油高", "原油価格上昇", "原油上昇", "OPEC"], "up": ["資源・エネルギー", "商社"], "down": ["空運", "陸運", "素材・化学"]},
    {"theme": "防衛", "words": ["防衛費", "防衛装備", "防衛予算"], "up": ["防衛・重工"], "down": []},
    {"theme": "インバウンド", "words": ["インバウンド", "訪日客", "訪日外国人"], "up": ["小売", "空運", "陸運", "ゲーム・娯楽"], "down": []},
    {"theme": "関税・貿易摩擦", "words": ["関税", "貿易摩擦", "輸出規制"], "up": [], "down": ["自動車", "半導体", "機械"]},
    {"theme": "米国株高", "words": ["米国株高", "ダウ最高値", "ナスダック最高値", "米株高"], "up": ["半導体", "電機"], "down": []},
    {"theme": "米国株安", "words": ["米国株安", "米株安", "ダウ急落", "ナスダック急落"], "up": [], "down": ["半導体", "電機"]},
]

SETUP_LABEL = {"pullback": "押し目", "breakout": "高値ブレイク", "rebound": "売られすぎ反発", "trend": "上昇トレンド", "none": "様子見"}


# ---- 取得 -----------------------------------------------------------------
def http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_daily(sym: str) -> dict | None:
    """Yahoo Finance の日足（約1年）。取れなければ None。"""
    q = urllib.parse.quote(sym)
    for host in ("query1", "query2"):
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?range=1y&interval=1d&includePrePost=false"
        try:
            data = json.loads(http_get(url))
            res = data["chart"]["result"][0]
            off = res.get("meta", {}).get("gmtoffset", 0)
            qt = res["indicators"]["quote"][0]
            out = {"d": [], "o": [], "h": [], "l": [], "c": [], "v": []}
            for i, ts in enumerate(res.get("timestamp") or []):
                o, h, l, c, v = (qt[k][i] for k in ("open", "high", "low", "close", "volume"))
                if None in (o, h, l, c):
                    continue
                out["d"].append(datetime.fromtimestamp(ts + off, timezone.utc).strftime("%Y-%m-%d"))
                out["o"].append(o); out["h"].append(h); out["l"].append(l); out["c"].append(c); out["v"].append(v or 0)
            if len(out["c"]) >= 30:
                return out
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sym} ({host}): {e}", file=sys.stderr)
        time.sleep(0.5)
    return None


def fetch_rss(url: str, source: str) -> list[dict]:
    try:
        root = ET.fromstring(http_get(url))
    except Exception as e:  # noqa: BLE001
        print(f"  ! RSS {source}: {e}", file=sys.stderr)
        return []
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate") or ""
        src = source
        s_el = it.find("source")
        if s_el is not None and (s_el.text or "").strip():
            src = s_el.text.strip()
            title = re.sub(r"\s+-\s+" + re.escape(src) + r"\s*$", "", title)
        try:
            dt = email.utils.parsedate_to_datetime(pub).astimezone(JST)
        except Exception:  # noqa: BLE001
            dt = datetime.now(JST)
        if title:
            items.append({"title": title, "link": link, "source": src, "dt": dt})
    return items


# ---- 指標 -----------------------------------------------------------------
def sma(xs, n):
    out = [None] * len(xs)
    s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(xs, n):
    k = 2 / (n + 1)
    out, e = [], None
    for x in xs:
        e = x if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def rsi(xs, n=14):
    out = [None] * len(xs)
    if len(xs) <= n:
        return out
    gains = [max(xs[i] - xs[i - 1], 0) for i in range(1, len(xs))]
    losses = [max(xs[i - 1] - xs[i], 0) for i in range(1, len(xs))]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for i in range(n, len(xs)):
        if i > n:
            ag = (ag * (n - 1) + gains[i - 1]) / n
            al = (al * (n - 1) + losses[i - 1]) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def atr(h, l, c, n=14):
    tr = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])) for i in range(1, len(c))]
    out, a = [None] * len(c), None
    for i, t in enumerate(tr):
        if i == n - 1:
            a = sum(tr[:n]) / n
        elif i >= n:
            a = (a * (n - 1) + t) / n
        out[i] = a
    return out


def pct(a, b):
    return (a / b - 1) * 100 if b else 0.0


def px_round(x):
    if x is None:
        return None
    return round(x) if x >= 1000 else round(x, 1)


def tick_round(p: float) -> float:
    """東証の呼値っぽく丸める（ざっくり）。"""
    if p < 1000:
        return round(p, 1)
    if p < 5000:
        return round(p)
    if p < 30000:
        return round(p / 5) * 5
    return round(p / 10) * 10


# ---- 銘柄の分析 -------------------------------------------------------------
def analyze(stock: dict, px: dict, bench_ret20: float | None) -> dict:
    c, h, l, v = px["c"], px["h"], px["l"], px["v"]
    n = len(c)
    ma5, ma25, ma75 = sma(c, 5), sma(c, 25), sma(c, 75)
    r = rsi(c)
    a = atr(h, l, c)
    m_fast, m_slow = ema(c, 12), ema(c, 26)
    macd = [f - s for f, s in zip(m_fast, m_slow)]
    sig = ema(macd, 9)
    hist = [m - s for m, s in zip(macd, sig)]
    vma20 = sma(v, 20)

    last = c[-1]
    prev = c[-2]
    i = n - 1
    m25, m75 = ma25[i], ma75[i] if n >= 75 else None
    m25_prev5 = ma25[i - 5] if i >= 29 else None
    rsi_now = r[i] or 50
    atr_now = a[i] or (last * 0.02)
    vol_ratio = (v[i] / vma20[i]) if vma20[i] else 1.0
    hi20_prev = max(h[-21:-1]) if n > 21 else max(h)
    lo20 = min(l[-20:])
    hi52 = max(h[-250:])
    dev25 = pct(last, m25) if m25 else 0.0
    ret5 = pct(last, c[-6]) if n > 6 else 0.0
    ret20 = pct(last, c[-21]) if n > 21 else 0.0
    turnover = sum(c[k] * v[k] for k in range(max(0, n - 20), n)) / min(20, n) / 1e8  # 億円/日
    macd_gc = any(hist[k] > 0 and hist[k - 1] <= 0 for k in range(max(1, n - 3), n))
    macd_dc = any(hist[k] < 0 and hist[k - 1] >= 0 for k in range(max(1, n - 3), n))

    up_trend = bool(m25 and m75 and last > m75 and m25 > m75 and m25_prev5 and m25 > m25_prev5)
    down_trend = bool(m25 and m75 and last < m75 and m25 < m75)

    reasons, cautions = [], []
    score = 50.0

    # --- 型の判定 ---
    setup = "none"
    if up_trend and -3.0 <= dev25 <= 2.5 and 35 <= rsi_now <= 58:
        setup = "pullback"
        score += 18
        reasons.append(f"上昇トレンド中に25日線（{m25:,.0f}円）付近まで押している（乖離 {dev25:+.1f}%）")
        if last > prev:
            score += 4
            reasons.append("前日比プラスで、押し目から切り返しの動き")
    elif last > hi20_prev and vol_ratio >= 1.3 and rsi_now < 80:
        setup = "breakout"
        score += 16 + min(6, (vol_ratio - 1.3) * 4)
        reasons.append(f"20日高値（{hi20_prev:,.0f}円）を出来高 {vol_ratio:.1f} 倍で上抜け")
        if last >= hi52 * 0.98:
            score += 4
            reasons.append("52週高値圏。上値のしこりが少ない")
    elif rsi_now < 32 and dev25 < -7 and last > prev:
        setup = "rebound"
        score += 10
        reasons.append(f"RSI {rsi_now:.0f}・25日線から {dev25:.1f}% と売られすぎから反発の兆し")
        cautions.append("逆張りなので損切りを必ず置く。トレンドは下向き")
    elif up_trend:
        setup = "trend"
        score += 8
        reasons.append("25日線・75日線とも上向きの上昇トレンド")

    # --- 加点・減点 ---
    if up_trend and setup != "trend":
        score += 6
    if down_trend and setup != "rebound":
        score -= 12
        cautions.append("75日線の下で下降トレンド")
    if macd_gc:
        score += 6
        reasons.append("MACD がシグナルを上抜け（直近3日）")
    if macd_dc:
        score -= 6
        cautions.append("MACD がシグナルを下抜け（直近3日）")
    if bench_ret20 is not None:
        rs = ret20 - bench_ret20
        score += max(-6, min(6, rs * 0.6))
        if rs > 5:
            reasons.append(f"直近20日で日経平均より {rs:.1f}% 強い")
    if rsi_now > 75:
        score -= 10
        cautions.append(f"RSI {rsi_now:.0f} と過熱。高値づかみに注意")
    if dev25 > 12:
        score -= 8
        cautions.append(f"25日線から {dev25:+.1f}% と離れすぎ")
    if turnover < 10:
        score -= 6
        cautions.append(f"売買代金が少なめ（1日約 {turnover:.0f} 億円）")
    if 1.2 <= vol_ratio and last > prev and setup != "breakout":
        score += 3

    # --- 売買の目安（ATR ベース） ---
    entry = last
    if setup == "pullback":
        stop = min(last - 1.5 * atr_now, (m25 or last) - 1.0 * atr_now)
    elif setup == "breakout":
        stop = max(hi20_prev - 1.0 * atr_now, last - 2.0 * atr_now)
    elif setup == "rebound":
        stop = min(lo20, last - 1.5 * atr_now) - 0.3 * atr_now
    else:
        stop = last - 2.0 * atr_now
    risk = max(entry - stop, last * 0.01)
    target = entry + 2.0 * risk
    if setup == "pullback" and hi20_prev > entry + risk:
        target = max(target, hi20_prev)
    if setup == "rebound" and m25:
        target = min(target, m25) if m25 > entry + risk else target

    k0 = max(0, n - CHART_DAYS)
    return {
        "code": stock["code"],
        "name": stock["name"],
        "sector": stock.get("sector", ""),
        "setup": setup,
        "setup_label": SETUP_LABEL[setup],
        "tech_score": round(score, 1),
        "close": round(last, 1),
        "chg_pct": round(pct(last, prev), 2),
        "ret5": round(ret5, 2),
        "ret20": round(ret20, 2),
        "rsi": round(rsi_now, 1),
        "dev25": round(dev25, 2),
        "vol_ratio": round(vol_ratio, 2),
        "atr_pct": round(atr_now / last * 100, 2),
        "turnover_oku": round(turnover, 1),
        "hi52_gap": round(pct(last, hi52), 2),
        "entry": tick_round(entry),
        "stop": tick_round(stop),
        "target": tick_round(target),
        "rr": round((target - entry) / risk, 2),
        "reasons": reasons,
        "cautions": cautions,
        "date": px["d"][-1],
        "chart": {
            "d": [d[2:].replace("-", "") for d in px["d"][k0:]],  # YYMMDD
            "o": [px_round(x) for x in px["o"][k0:]],
            "h": [px_round(x) for x in h[k0:]],
            "l": [px_round(x) for x in l[k0:]],
            "c": [px_round(x) for x in c[k0:]],
            "v": [round(x / 1000) for x in v[k0:]],  # 千株
            "ma25": [px_round(x) for x in ma25[k0:]],
            "ma75": [px_round(x) for x in ma75[k0:]],
        },
    }


def index_summary(ix: dict, px: dict) -> dict:
    c = px["c"]
    m25, m75 = sma(c, 25)[-1], (sma(c, 75)[-1] if len(c) >= 75 else None)
    return {
        "sym": ix["sym"], "name": ix["name"], "kind": ix["kind"],
        "close": round(c[-1], 3 if ix["kind"] in ("fx", "rate") else 2),
        "chg_pct": round(pct(c[-1], c[-2]), 2),
        "ret20": round(pct(c[-1], c[-21]), 2) if len(c) > 21 else 0,
        "above25": bool(m25 and c[-1] > m25),
        "above75": bool(m75 and c[-1] > m75),
        "spark": [round(x, 3) for x in c[-60:]],
        "date": px["d"][-1],
    }


def market_regime(idx: dict[str, dict]) -> dict:
    s, notes = 0, []
    nk = idx.get("^N225")
    if nk:
        if nk["above25"] and nk["above75"]:
            s += 2; notes.append("日経平均は25日線・75日線の上（上昇基調）")
        elif not nk["above25"] and not nk["above75"]:
            s -= 2; notes.append("日経平均は25日線・75日線の下（下落基調）")
        else:
            notes.append("日経平均は25日線と75日線の間（もみあい）")
    sp = idx.get("^GSPC")
    if sp:
        s += 1 if sp["above25"] else -1
        notes.append(f"S&P500 は25日線の{'上' if sp['above25'] else '下'}")
    vix = idx.get("^VIX")
    if vix:
        if vix["close"] >= 25:
            s -= 2; notes.append(f"VIX {vix['close']:.1f} と不安が強い")
        elif vix["close"] <= 16:
            s += 1; notes.append(f"VIX {vix['close']:.1f} と落ち着いている")
    if s >= 3:
        label, text = "追い風", "買いの戦略が機能しやすい地合い。押し目・ブレイクとも狙いやすい。"
    elif s >= 1:
        label, text = "やや追い風", "おおむね良好。強い銘柄に絞って入る。"
    elif s >= -1:
        label, text = "中立", "方向感が弱い。ポジションは小さめに、損切りは浅めに。"
    else:
        label, text = "向かい風", "全体が弱い。新規の買いは控えめに。反発狙いは短期で。"
    return {"label": label, "score": s, "text": text, "notes": notes}


# ---- ニュースの分析 ---------------------------------------------------------
def build_alias_table(stocks: list[dict]) -> list[tuple[str, str]]:
    table = []
    for s in stocks:
        for a in [s["name"]] + s.get("aliases", []):
            table.append((a, s["code"]))
    table.sort(key=lambda t: -len(t[0]))
    return table


def score_text(title: str) -> tuple[int, list[str]]:
    t = title.replace("売り上げ", "").replace("売上", "")
    sc = 0
    for w, p in {**POS_WORDS, **NEG_WORDS}.items():
        if w in t:
            sc += p
    # 「上方修正」を数えたときに「修正」系の重複は無いので単純合算でよい
    tags = [tag for tag, ws in TAGS.items() if any(w in title for w in ws)]
    return sc, tags


def analyze_news(raw: list[dict], stocks: list[dict]) -> tuple[list[dict], list[dict]]:
    alias = build_alias_table(stocks)
    sector_of = {s["code"]: s.get("sector", "") for s in stocks}
    now = datetime.now(JST)
    seen, out = set(), []
    for it in sorted(raw, key=lambda x: x["dt"], reverse=True):
        if now - it["dt"] > timedelta(days=NEWS_KEEP_DAYS):
            continue
        key = re.sub(r"\W", "", it["title"])[:40]
        if key in seen:
            continue
        seen.add(key)
        rest, codes = it["title"], []
        for a, code in alias:
            if a in rest:
                if code not in codes:
                    codes.append(code)
                rest = rest.replace(a, "　" * len(a))
        sc, tags = score_text(it["title"])
        themes, up, down = [], set(), set()
        for th in THEMES:
            if any(w in it["title"] for w in th["words"]):
                themes.append(th["theme"]); up.update(th["up"]); down.update(th["down"])
        sent = max(-1.0, min(1.0, sc / 4))
        weight = 1.0 + (0.5 if {"決算", "業績修正", "株主還元", "M&A"} & set(tags) else 0)
        out.append({
            "id": hashlib.md5((it["title"] + it["link"]).encode()).hexdigest()[:10],
            "title": it["title"], "link": it["link"], "source": it["source"],
            "published": it["dt"].isoformat(timespec="minutes"),
            "sentiment": round(sent, 2), "weight": weight, "tags": tags, "themes": themes,
            "codes": codes, "sectors_up": sorted(up), "sectors_down": sorted(down),
            "for_sectors": sorted({sector_of[c] for c in codes}),
        })
    # 話題のテーマ
    hot = []
    for th in THEMES:
        hits = [n for n in out if th["theme"] in n["themes"]]
        if hits:
            hot.append({"theme": th["theme"], "count": len(hits), "up": th["up"], "down": th["down"],
                        "headline": hits[0]["title"]})
    hot.sort(key=lambda x: -x["count"])
    return out, hot


def news_boost(stock: dict, news: list[dict], hot: list[dict]) -> tuple[float, list[str], list[str]]:
    """個別ニュース・テーマから点数の上乗せを計算する。"""
    now = datetime.now(JST)
    b, ids, notes = 0.0, [], []
    for n in news:
        if stock["code"] in n["codes"]:
            age_d = (now - datetime.fromisoformat(n["published"])).total_seconds() / 86400
            decay = 1.0 if age_d < 1 else 0.6 if age_d < 2 else 0.35
            b += n["sentiment"] * 6 * n["weight"] * decay
            ids.append(n["id"])
    b = max(-12.0, min(12.0, b))
    sec = stock.get("sector", "")
    for th in hot[:5]:
        w = min(3, th["count"]) * 0.8
        if sec in th["up"]:
            b += w; notes.append(f"テーマ「{th['theme']}」が追い風の業種（{sec}）")
        elif sec in th["down"]:
            b -= w; notes.append(f"テーマ「{th['theme']}」が向かい風の業種（{sec}）")
    return round(b, 1), ids, notes


# ---- サンプル（--demo） -----------------------------------------------------
def demo_prices(seed: str, start: float, days: int = 260, drift: float = 0.0004, vol: float = 0.018,
                shape: str = "") -> dict:
    rnd = random.Random(seed)
    d0 = datetime.now(JST).date()
    dates = []
    k = 0
    while len(dates) < days:
        day = d0 - timedelta(days=k)
        if day.weekday() < 5:
            dates.append(day.strftime("%Y-%m-%d"))
        k += 1
    dates.reverse()
    o, h, l, c, v = [], [], [], [], []
    p = start
    base_v = rnd.uniform(2e6, 2e7)
    for i in range(days):
        dr = drift
        left = days - i
        if shape == "pullback" and left <= 12:
            dr = -0.006 if left > 1 else 0.012
        elif shape == "breakout" and left <= 3:
            dr = 0.02
        elif shape == "rebound":
            dr = -0.003 if left > 25 else (-0.012 if left > 1 else 0.025)
        elif shape == "hot" and left <= 15:
            dr = 0.012
        ret = dr + rnd.gauss(0, vol)
        op = p * (1 + rnd.gauss(0, vol / 3))
        p = max(1, p * (1 + ret))
        hi = max(op, p) * (1 + abs(rnd.gauss(0, vol / 2)))
        lo = min(op, p) * (1 - abs(rnd.gauss(0, vol / 2)))
        vv = base_v * rnd.uniform(0.6, 1.4) * (2.4 if shape == "breakout" and left <= 1 else 1)
        o.append(op); h.append(hi); l.append(lo); c.append(p); v.append(vv)
    return {"d": dates, "o": o, "h": h, "l": l, "c": c, "v": v}


def demo_news(stocks: list[dict]) -> list[dict]:
    now = datetime.now(JST)
    pick = {s["code"]: s for s in stocks}
    lines = [
        ("7203", "{n}、通期の営業利益を上方修正　円安が追い風（サンプル）", 2),
        ("8035", "{n}が続伸　生成AI向け半導体の需要が好調（サンプル）", 3),
        ("8306", "{n}、自社株買いを発表　株主還元を強化（サンプル）", 5),
        ("4502", "{n}、主力薬の承認が延期　株価は反落（サンプル）", 6),
        ("9101", "{n}が下方修正　運賃の下落が響く（サンプル）", 8),
        (None, "日経平均が反発、半導体株に買い（サンプル）", 1),
        (None, "円安が進行、1ドル＝150円台に（サンプル）", 4),
        (None, "米長期金利上昇で国内銀行株が上昇（サンプル）", 7),
        (None, "訪日客が過去最高を更新、インバウンド関連に注目（サンプル）", 10),
    ]
    out = []
    for code, t, hrs in lines:
        title = t.format(n=pick[code]["name"]) if code else t
        out.append({"title": title, "link": "", "source": "サンプル", "dt": now - timedelta(hours=hrs)})
    return out


# ---- 本体 -----------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="ネットを使わずサンプルデータを作る")
    ap.add_argument("--out", default=str(ROOT / "data" / "latest.json"))
    args = ap.parse_args()

    stocks = json.loads((ROOT / "scripts" / "universe.json").read_text(encoding="utf-8"))["stocks"]
    print(f"対象 {len(stocks)} 銘柄 / demo={args.demo}")

    # 指数
    idx_px, idx_sum = {}, {}
    for ix in INDICES:
        if args.demo:
            base = {"^N225": 38000, "1306.T": 2800, "^GSPC": 5900, "^IXIC": 19000, "^SOX": 5200,
                    "JPY=X": 150, "^VIX": 16, "^TNX": 4.3}[ix["sym"]]
            px = demo_prices(ix["sym"], base, drift=0.0003 if ix["kind"] != "vol" else 0.0,
                             vol=0.009 if ix["kind"] != "vol" else 0.03)
        else:
            px = fetch_daily(ix["sym"])
            time.sleep(0.4)
        if px:
            idx_px[ix["sym"]] = px
            idx_sum[ix["sym"]] = index_summary(ix, px)
    nk = idx_px.get("^N225")
    bench_ret20 = pct(nk["c"][-1], nk["c"][-21]) if nk and len(nk["c"]) > 21 else None

    # 個別株
    shapes = ["pullback", "breakout", "rebound", "hot", "", "", "", ""]
    analyzed, failed = [], []
    for k, s in enumerate(stocks):
        if args.demo:
            rnd = random.Random(s["code"])
            px = demo_prices(s["code"], rnd.uniform(800, 9000), drift=rnd.uniform(-0.0006, 0.0015),
                             vol=rnd.uniform(0.012, 0.028), shape=shapes[k % len(shapes)])
        else:
            px = fetch_daily(s["code"] + ".T")
            time.sleep(0.35)
        if not px:
            failed.append(s["code"])
            continue
        try:
            analyzed.append(analyze(s, px, bench_ret20))
        except Exception as e:  # noqa: BLE001
            print(f"  ! analyze {s['code']}: {e}", file=sys.stderr)
            failed.append(s["code"])
    print(f"株価 OK {len(analyzed)} / 失敗 {len(failed)}")
    if not analyzed:
        print("株価が1件も取れなかったので書き出しを中止します", file=sys.stderr)
        return 1

    # ニュース
    raw = []
    if args.demo:
        raw = demo_news(stocks)
    else:
        for src, url in MARKET_FEEDS:
            raw += fetch_rss(url, src)
            time.sleep(0.5)
        top = sorted(analyzed, key=lambda a: -a["tech_score"])[:PER_STOCK_NEWS]
        for a in top:
            q = f"\"{a['name']}\" 株 when:3d"
            url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + "&hl=ja&gl=JP&ceid=JP:ja"
            raw += fetch_rss(url, "Google ニュース")[:8]
            time.sleep(0.8)
    news, hot = analyze_news(raw, stocks)
    print(f"ニュース {len(news)} 件 / テーマ {[h['theme'] for h in hot]}")

    # 総合点
    by_code = {s["code"]: s for s in stocks}
    for a in analyzed:
        b, ids, notes = news_boost(by_code[a["code"]], news, hot)
        a["news_score"] = b
        a["news_ids"] = ids
        a["theme_notes"] = notes
        a["score"] = round(max(0, min(100, a["tech_score"] + b)), 1)
        if any(n["sentiment"] > 0.3 for n in news if n["id"] in ids):
            a["reasons"].append("プラスの材料ニュースあり")
        if any(n["sentiment"] < -0.3 for n in news if n["id"] in ids):
            a["cautions"].append("マイナスの材料ニュースあり")
        if any("決算" in n["tags"] for n in news if n["id"] in ids):
            a["cautions"].append("決算関連のニュースあり。発表日の前後は値動きが荒くなりやすい")
    analyzed.sort(key=lambda a: -a["score"])
    picks = [a["code"] for a in analyzed if a["setup"] != "none" and a["score"] >= 60][:10]

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "demo": args.demo,
        "market": {"regime": market_regime(idx_sum), "indices": [idx_sum[i["sym"]] for i in INDICES if i["sym"] in idx_sum]},
        "themes": hot,
        "picks": picks,
        "stocks": analyzed,
        "news": [{k: v for k, v in n.items() if k != "weight"} for n in news[:150]],
        "failed": failed,
    }
    # チャートは別ファイル（銘柄を開いたときに読む）
    charts = {a["code"]: a.pop("chart") for a in analyzed}
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cpath = path.with_name("charts.json")
    cpath.write_text(json.dumps(charts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"書き出し: {path} ({path.stat().st_size // 1024} KB) / {cpath.name} ({cpath.stat().st_size // 1024} KB)"
          f" おすすめ {len(picks)} 銘柄")
    return 0


if __name__ == "__main__":
    sys.exit(main())
