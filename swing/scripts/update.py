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
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0 (compatible; swing-board/1.0)"
CHART_DAYS = 120          # アプリのチャートに載せる日数
PER_STOCK_NEWS = 25       # 個別にニュースを検索する銘柄の数（点数の上位から）
NEWS_KEEP_DAYS = 4        # これより古いニュースは捨てる
WORKERS = 6               # 株価を同時に取りにいく数（多すぎると断られる）
EARNINGS_RECHECK_DAYS = 3 # 決算発表日はこの日数ごとに取り直す（それまでは前回の結果を使う）
HOLD_DAYS = 15            # 検証で最長何営業日持つか
TRACK_DAYS = 60           # 注目銘柄の成績を何日分追うか
# ---- 自分の売買ルール（ルール一覧.xlsx）から決めた数値 ----
MIN_TURNOVER_OKU = 3      # 売買代金が少なすぎる銘柄は避ける（1日 数億円以上）
MIN_RR = 2.0              # 利確幅は損切り幅の2倍以上
SR_LOOKBACK = 120         # 支持線・抵抗線を探す日数（日足の3〜6か月）
PIVOT_W = 3               # 前後この日数でいちばん安い（高い）日を「反発した日」とみなす
MIN_TOUCHES = 2           # 支持線・抵抗線とみなす反発の回数
EARNINGS_WINDOW_DAYS = 21 # 決算をまたがない：この日数（約15営業日）以内に決算があれば買わない

# きびしめ＝ルール一覧どおり／ゆるめ＝買える銘柄が出やすいように数値をゆるめたもの
RULESETS = {
    "strict": {
        "label": "きびしめ", "mkt": "up", "trend_loose": False, "weekly_req": True,
        "look": 3, "touch_ma": 1.012, "touch_sup_atr": 0.6, "dev_max": 4, "bull": "both", "rsi_max": 65,
        "chase": (10, 5, 8), "min_touches": MIN_TOUCHES, "support_req": True, "min_rr": MIN_RR,
        "earn_days": EARNINGS_WINDOW_DAYS, "turnover": MIN_TURNOVER_OKU,
    },
    "loose": {
        "label": "ゆるめ", "mkt": "up_or_above", "trend_loose": True, "weekly_req": False,
        "look": 5, "touch_ma": 1.03, "touch_sup_atr": 1.0, "dev_max": 6, "bull": "either", "rsi_max": 70,
        "chase": (15, 7, 10), "min_touches": 1, "support_req": False, "min_rr": 1.5,
        "earn_days": 7, "turnover": MIN_TURNOVER_OKU,
    },
}
STRICT = RULESETS["strict"]

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

# 適時開示（決算短信・業績修正・自社株買いなど）。やのしん TDnet WEB-API の RSS
TDNET_FEED = ("適時開示", "https://webapi.yanoshin.jp/webapi/tdnet/list/recent.rss?limit=300")

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
    "業績修正": ["上方修正", "下方修正", "上振れ", "下振れ", "業績予想の修正", "業績予想修正"],
    "株主還元": ["自社株買い", "自己株式取得", "増配", "減配", "復配", "株主還元", "株式分割", "配当予想の修正"],
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
def http_get(url: str, timeout: int = 20, tries: int = 3) -> bytes:
    """混雑（429）やサーバーの一時的な失敗は、少し待ってやり直す。"""
    for k in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and k < tries - 1:
                time.sleep(2 * (k + 1) ** 2)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if k < tries - 1:
                time.sleep(2 * (k + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def fetch_daily(sym: str) -> dict | None:
    """Yahoo Finance の日足（約2年：検証にも使う）。取れなければ None。"""
    q = urllib.parse.quote(sym)
    for host in ("query1", "query2"):
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?range=2y&interval=1d&includePrePost=false"
        try:
            data = json.loads(http_get(url, tries=2 if host == "query1" else 3))
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


class YahooCal:
    """決算発表日を Yahoo Finance から取る（取れない銘柄は None。アプリでは「要確認」）。"""

    def __init__(self):
        import http.cookiejar
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.op.addheaders = [("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")]
        self.crumb = None
        try:
            try:
                self.op.open("https://fc.yahoo.com", timeout=15)
            except Exception:  # noqa: BLE001  404 でもクッキーは付く
                pass
            self.crumb = self.op.open("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=15).read().decode().strip()
        except Exception as e:  # noqa: BLE001
            print(f"  ! 決算日の準備に失敗: {e}", file=sys.stderr)

    def earnings(self, sym: str) -> str | None:
        if not self.crumb:
            return None
        url = (f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(sym)}"
               f"?modules=calendarEvents&crumb={urllib.parse.quote(self.crumb)}")
        try:
            data = json.loads(self.op.open(url, timeout=15).read())
            dates = data["quoteSummary"]["result"][0]["calendarEvents"]["earnings"]["earningsDate"]
            today = datetime.now(JST).date()
            ds = sorted(datetime.fromtimestamp(d["raw"], JST).date() for d in dates if d.get("raw"))
            ds = [d for d in ds if d >= today - timedelta(days=1)]
            return ds[0].isoformat() if ds else None
        except Exception:  # noqa: BLE001
            return None


def pmap(fn, items, workers: int = WORKERS) -> list:
    """items を同時にいくつか処理する（ネットの待ち時間を重ねて短くする）。順番は保つ。"""
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))


class Timer:
    """どこで何秒かかったかをログに出す。"""

    def __init__(self):
        self.t = time.time()

    def lap(self, label: str):
        now = time.time()
        print(f"  ⏱ {label}: {now - self.t:.0f} 秒")
        self.t = now


def load_earnings_cache(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def earnings_cached(code: str, cache: dict, cal) -> str | None:
    """決算発表日。最近調べていて、まだ過ぎていなければ前回の結果を使う。"""
    today = datetime.now(JST).date()
    c = cache.get(code)
    if c:
        checked = datetime.fromisoformat(c["checked"]).date()
        fresh = (today - checked).days < EARNINGS_RECHECK_DAYS
        if fresh and (c.get("date") is None or datetime.fromisoformat(c["date"]).date() >= today):
            return c.get("date")
    if not cal or not cal.crumb:
        return c.get("date") if c else None
    d = cal.earnings(code + ".T")
    cache[code] = {"date": d, "checked": today.isoformat()}
    return d


def days_until(date_s: str | None) -> int | None:
    if not date_s:
        return None
    return (datetime.fromisoformat(date_s).date() - datetime.now(JST).date()).days


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
        pub = it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date") or ""
        src = source
        s_el = it.find("source")
        if s_el is not None and (s_el.text or "").strip():
            src = s_el.text.strip()
            title = re.sub(r"\s+-\s+" + re.escape(src) + r"\s*$", "", title)
        dt = None
        try:
            dt = email.utils.parsedate_to_datetime(pub).astimezone(JST)
        except Exception:  # noqa: BLE001
            try:
                dt = datetime.fromisoformat(pub.strip().replace("Z", "+00:00")).astimezone(JST)
            except Exception:  # noqa: BLE001
                dt = datetime.now(JST)
        if title:
            item = {"title": title, "link": link, "source": src, "dt": dt}
            if source == "適時開示":
                # 見出しやリンクに入っている証券コード（4桁。2024年からの英字入りも）
                item["codes"] = sorted(set(re.findall(r"(?<![0-9A-Za-z])(\d{3}[0-9A-Z])(?![0-9A-Za-z])", title + " " + link)))
                item["official"] = True
            items.append(item)
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
def indicators(px: dict) -> dict:
    """日足から指標の配列をまとめて計算する（どの日でも判定できるように）。"""
    c, h, l, v = px["c"], px["h"], px["l"], px["v"]
    m_fast, m_slow = ema(c, 12), ema(c, 26)
    macd = [f - s for f, s in zip(m_fast, m_slow)]
    sig = ema(macd, 9)
    return {
        **px,
        "n": len(c),
        "ma25": sma(c, 25), "ma75": sma(c, 75),
        "rsi": rsi(c), "atr": atr(h, l, c),
        "hist": [m - s for m, s in zip(macd, sig)],
        "vma20": sma(v, 20),
        "ma65": sma(c, 65),  # 13週線のかわり（週足の大きな流れ）
        "tv": [ci * vi for ci, vi in zip(c, v)],
        "piv_lo": [k for k in range(PIVOT_W, len(c) - PIVOT_W) if l[k] == min(l[k - PIVOT_W:k + PIVOT_W + 1])],
        "piv_hi": [k for k in range(PIVOT_W, len(c) - PIVOT_W) if h[k] == max(h[k - PIVOT_W:k + PIVOT_W + 1])],
    }


def levels(prices: list[float], tol: float) -> list[tuple[float, int]]:
    """近い値段どうしをまとめて (水準, 反発の回数) にする。"""
    out, grp = [], []
    for p in sorted(prices):
        if grp and p - grp[0] > tol:
            out.append((sum(grp) / len(grp), len(grp)))
            grp = []
        grp.append(p)
    if grp:
        out.append((sum(grp) / len(grp), len(grp)))
    return out


def support_resistance(ind: dict, i: int, atr_now: float, min_touches: int = MIN_TOUCHES) -> tuple[list, list]:
    """i 日目の時点で確定している（未来を見ない）反発の安値・高値から、支持線と抵抗線を出す。"""
    lo_k = [k for k in ind["piv_lo"] if i - SR_LOOKBACK <= k <= i - PIVOT_W]
    hi_k = [k for k in ind["piv_hi"] if i - SR_LOOKBACK <= k <= i - PIVOT_W]
    tol = max(0.5 * atr_now, ind["c"][i] * 0.012)
    sup = [(lv, n) for lv, n in levels([ind["l"][k] for k in lo_k], tol) if n >= min_touches]
    res = [(lv, n) for lv, n in levels([ind["h"][k] for k in hi_k], tol) if n >= max(MIN_TOUCHES, min_touches)]
    return sup, res


def evaluate(ind: dict, i: int, bench_ret20: float | None, mkt_up=None,
             earn_days: int | None = None, rules: dict = STRICT) -> dict:
    """i 日目の終値の時点で、型・点数・売買の目安と、自分のルールに合うかを判定する。
    mkt_up: 日経平均の状態 {"up": 25日線が上向きか, "above": 25日線の上か}（True/False だけでも可）
    earn_days: 次の決算まであと何日か（不明なら None） / rules: ルールの組（RULESETS）"""
    if isinstance(mkt_up, dict):
        mkt = mkt_up
    else:
        mkt = {"up": mkt_up, "above": mkt_up}
    c, h, l, v = ind["c"], ind["h"], ind["l"], ind["v"]
    ma25, ma75, hist = ind["ma25"], ind["ma75"], ind["hist"]
    last, prev = c[i], c[i - 1]
    m25, m75 = ma25[i], ma75[i]
    m25_prev5 = ma25[i - 5] if i >= 5 else None
    rsi_now = ind["rsi"][i] or 50
    atr_now = ind["atr"][i] or (last * 0.02)
    vol_ratio = (v[i] / ind["vma20"][i]) if ind["vma20"][i] else 1.0
    hi20_prev = max(h[max(0, i - 20):i]) if i > 0 else h[i]
    lo20 = min(l[max(0, i - 19):i + 1])
    hi52 = max(h[max(0, i - 249):i + 1])
    dev25 = pct(last, m25) if m25 else 0.0
    ret5 = pct(last, c[i - 5]) if i >= 5 else 0.0
    ret20 = pct(last, c[i - 20]) if i >= 20 else 0.0
    k0 = max(0, i - 19)
    turnover = sum(ind["tv"][k0:i + 1]) / (i + 1 - k0) / 1e8  # 億円/日
    macd_gc = any(hist[k] > 0 and hist[k - 1] <= 0 for k in range(max(1, i - 2), i + 1))
    macd_dc = any(hist[k] < 0 and hist[k - 1] >= 0 for k in range(max(1, i - 2), i + 1))
    up_trend = bool(m25 and m75 and last > m75 and m25 > m75 and m25_prev5 and m25 > m25_prev5)
    down_trend = bool(m25 and m75 and last < m75 and m25 < m75)
    body_top = max(ind["o"][i], last)
    lower_wick = (min(ind["o"][i], last) - l[i]) / atr_now if atr_now else 0

    reasons, cautions = [], []
    score = 50.0

    # --- 型の判定 ---
    setup = "none"
    # ルール：上昇トレンド中の押し目（支持線・25日線付近）で、陽線で反発したのを確認してから買う
    ma_up = bool(m25 and m25_prev5 and m25 > m25_prev5)
    trend_ok = bool(ma_up and m25 and last > m25)
    if rules["trend_loose"] and not trend_ok:
        # ゆるめ：25日線＞75日線で株価が75日線の上なら、25日線の少し下（−2%）まで許す
        trend_ok = bool(m25 and m75 and m25 > m75 and last > m75 and last >= m25 * 0.98)
    recent_low = min(l[max(0, i - rules["look"] + 1):i + 1])
    sup, res = support_resistance(ind, i, atr_now, rules["min_touches"])
    near_sup = next((lv for lv, n in sorted(sup, reverse=True) if lv <= last and recent_low <= lv + rules["touch_sup_atr"] * atr_now), None)
    touched_ma = bool(m25 and recent_low <= m25 * rules["touch_ma"])
    touched = touched_ma or near_sup is not None
    bull = (last > ind["o"][i] and last > prev) if rules["bull"] == "both" else (last > ind["o"][i] or last > prev)
    if trend_ok and m25 and dev25 <= rules["dev_max"] and touched and bull and rsi_now < rules["rsi_max"]:
        setup = "pullback"
        score += 22
        where = "支持線" if near_sup is not None and not touched_ma else "25日線"
        reasons.append(f"上昇トレンド中に{where}付近まで押し、陽線で反発（25日線から {dev25:+.1f}%）")
        if lower_wick > 0.5:
            score += 2
            reasons.append("下ヒゲが出て、下値で買いが入っている")
        if vol_ratio >= 1.0 and v[i] > v[i - 1]:
            score += 4
            reasons.append(f"反発の日に出来高が増えた（{vol_ratio:.1f}倍）。信頼度アップ")
    elif last > hi20_prev and vol_ratio >= 1.3 and rsi_now < 80:
        setup = "breakout"
        score += 16 + min(6, (vol_ratio - 1.3) * 4)
        reasons.append(f"20日高値（{hi20_prev:,.0f}円）を出来高 {vol_ratio:.1f} 倍で上抜け")
        if last >= hi52 * 0.98:
            score += 4
            reasons.append("52週高値圏。上値のしこりが少ない")
        if (h[i] - body_top) / atr_now > 0.6:
            score -= 4
            cautions.append("上ヒゲが長く、上値で売りが出ている")
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
    rs = None
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

    # --- 売買の目安 ---
    # ルール：損切りは支持線の少し下、利確の目安は抵抗線、利確幅は損切り幅の2倍以上
    entry = last
    sup_used = next(((lv, n) for lv, n in sorted(sup, reverse=True) if lv <= last and lv >= last - 2.5 * atr_now), None)
    min_rr = rules["min_rr"]
    res_used = next(((lv, n) for lv, n in sorted(res) if lv > last + 0.3 * atr_now), None)
    if setup == "pullback" and sup_used:
        stop = sup_used[0] - max(0.25 * atr_now, sup_used[0] * 0.01)
    elif setup == "pullback" and not rules["support_req"] and m25 and m25 < last:
        stop = m25 - max(0.5 * atr_now, m25 * 0.01)  # ゆるめ：支持線がなければ25日線の少し下
    elif setup == "pullback":
        stop = min(last - 1.5 * atr_now, (m25 or last) - 1.0 * atr_now)
    elif setup == "breakout":
        stop = max(hi20_prev - 1.0 * atr_now, last - 2.0 * atr_now)
    elif setup == "rebound":
        stop = min(lo20, last - 1.5 * atr_now) - 0.3 * atr_now
    else:
        stop = last - 2.0 * atr_now
    risk = max(entry - stop, last * 0.01)
    target = entry + 2.0 * risk
    if setup == "pullback":
        # 抵抗線の少し手前で売る。上に抵抗線がなければ損切り幅の2倍
        target = res_used[0] * 0.995 if res_used else entry + max(2.0, min_rr) * risk
    if setup == "rebound" and m25 and m25 > entry + risk:
        target = min(target, m25)
    # 翌日これより高く寄ったら追いかけない（損切りまでの幅が広がり、リスク:リワードが崩れる）
    chase = entry + 0.5 * atr_now
    # 押し目は少し下で指値を置く案も出す
    limit = max(stop + 0.5 * risk, min(entry, (m25 or entry) + 0.2 * atr_now)) if setup == "pullback" else None

    rr = (target - entry) / risk
    gap3 = max(pct(ind["o"][k], c[k - 1]) for k in range(max(1, i - 2), i + 1))
    up_w = bool(ind["ma65"][i] and i >= 5 and ind["ma65"][i - 5] and ind["ma65"][i] > ind["ma65"][i - 5] and last > ind["ma65"][i])
    ch_max5, ch_gap, ch_dev = rules["chase"]
    mkt_ok = mkt["up"] if rules["mkt"] == "up" else (None if mkt["up"] is None and mkt["above"] is None
                                                   else bool(mkt["up"] or mkt["above"]))
    checks = [
        {"id": "market", "label": "日経平均が上向き（25日線が上向き）" if rules["mkt"] == "up"
         else "日経平均が上向き（25日線が上向き か 25日線の上）", "ok": mkt_ok},
        {"id": "trend", "label": "25日線が上向きで、株価がその上" if not rules["trend_loose"]
         else "上昇トレンド（25日線が上向きで株価がその上、または株価が75日線の上）", "ok": trend_ok,
         "detail": f"25日線 {m25:,.0f}円・乖離 {dev25:+.1f}%" if m25 else ""},
        {"id": "weekly", "label": "週足でも上向き（13週線）" + ("" if rules["weekly_req"] else "（参考）"), "ok": up_w,
         "req": rules["weekly_req"]},
        {"id": "liquidity", "label": f"売買代金が {rules['turnover']}億円/日 以上", "ok": turnover >= rules["turnover"],
         "detail": f"約 {turnover:,.0f}億円"},
        {"id": "nochase", "label": "急に上がった株を高値で追いかけていない",
         "ok": ret5 < ch_max5 and gap3 < ch_gap and dev25 < ch_dev, "detail": f"5日で {ret5:+.1f}%・窓 {gap3:+.1f}%"},
        {"id": "pullback", "label": "押し目（支持線・25日線付近）で陽線の反発" if rules["bull"] == "both"
         else "押し目（支持線・25日線付近）で反発（陽線か前日比プラス）", "ok": setup == "pullback"},
        {"id": "support", "label": f"{rules['min_touches']}回以上跳ね返った支持線がある" + ("" if rules["support_req"] else "（なければ25日線で代用）"),
         "ok": sup_used is not None, "req": rules["support_req"],
         "detail": f"{sup_used[0]:,.0f}円で{sup_used[1]}回" if sup_used else "見つからない"},
        {"id": "rr", "label": f"利確幅が損切り幅の{min_rr:g}倍以上", "ok": setup == "pullback" and rr >= min_rr - 1e-9,
         "detail": f"1:{rr:.2f}"},
        {"id": "earnings", "label": "持っている間（約3週間）に決算がない" if rules["earn_days"] >= 21
         else f"{rules['earn_days']}日以内に決算がない（決算の前に売る）",
         "ok": None if earn_days is None else not (0 <= earn_days <= rules["earn_days"]),
         "detail": "決算日が不明。自分で確認" if earn_days is None else f"決算まで {earn_days}日"},
    ]
    for ch in checks:
        ch.setdefault("req", True)
    # 決算日が不明（None）は「要確認」として通す。参考（req=False）の項目は判定に使わない
    rule_ok = all(ch["ok"] for ch in checks if ch["req"] and ch["id"] != "earnings") and checks[-1]["ok"] is not False
    fails = [ch["id"] for ch in checks if ch["req"] and ch["ok"] is False]

    return {
        "setup": setup, "score": score, "reasons": reasons, "cautions": cautions,
        "checks": checks, "rule_ok": rule_ok, "fails": fails,
        "support": sup_used, "resistance": res_used,
        "close": last, "prev": prev, "entry": entry, "stop": stop, "target": target, "risk": risk,
        "chase": chase, "limit": limit, "rsi": rsi_now, "atr": atr_now, "vol_ratio": vol_ratio,
        "dev25": dev25, "ret5": ret5, "ret20": ret20, "rs": rs, "turnover": turnover, "hi52": hi52,
        "above25": bool(m25 and last > m25), "up_trend": up_trend, "down_trend": down_trend,
        "macd_dc": macd_dc,
    }


def simulate_trade(ind: dict, i: int, stop: float, target: float, hold: int = HOLD_DAYS) -> dict | None:
    """i 日目のシグナルで、翌日の寄り付きに買ったとしたらどうなったか。
    損切り・利確に同じ日に両方届いたときは損切りが先とみなす（厳しめ）。"""
    o, h, l, c = ind["o"], ind["h"], ind["l"], ind["c"]
    if i + 1 >= ind["n"]:
        return None
    entry = o[i + 1]
    if entry <= stop or entry >= target:
        return None  # 寄り付きで計画が崩れたら見送り
    last_j = min(i + hold, ind["n"] - 1)
    for j in range(i + 1, last_j + 1):
        if l[j] <= stop:
            px = min(o[j], stop) if j > i + 1 else stop
            return {"ret": pct(px, entry), "days": j - i, "result": "loss", "exit_i": j}
        if h[j] >= target:
            px = max(o[j], target) if j > i + 1 else target
            return {"ret": pct(px, entry), "days": j - i, "result": "win", "exit_i": j}
    done = last_j == i + hold
    return {"ret": pct(c[last_j], entry), "days": last_j - i, "result": "timeout" if done else "open", "exit_i": last_j}


def backtest(ind: dict, bench_by_date: dict, mkt_by_date: dict | None, rules: dict = STRICT) -> list[dict]:
    """過去に自分のルールに合った日をすべて試す（同じ銘柄で取引中は次を取らない）。
    mkt_by_date=None のときは「日経平均が上向き」の条件を外して試す（ルールの効き目を比べる用）。
    決算日は過去の分が取れないので、検証では決算のルールは使わない。"""
    trades, busy_until = [], -1
    start = 80
    for i in range(start, ind["n"] - 1):
        if i <= busy_until:
            continue
        d = ind["d"][i]
        ev = evaluate(ind, i, bench_by_date.get(d), True if mkt_by_date is None else mkt_by_date.get(d), rules=rules)
        if not ev["rule_ok"]:
            continue
        t = simulate_trade(ind, i, ev["stop"], ev["target"])
        if not t or t["result"] == "open":
            continue
        t.update({"setup": ev["setup"], "date": ind["d"][i], "score": ev["score"]})
        trades.append(t)
        busy_until = t["exit_i"]
    return trades


def trade_stats(trades: list[dict]) -> dict:
    n = len(trades)
    if not n:
        return {"n": 0}
    wins = [t["ret"] for t in trades if t["ret"] > 0]
    losses = [t["ret"] for t in trades if t["ret"] <= 0]
    gross_loss = -sum(losses)
    return {
        "n": n,
        "win_rate": round(len(wins) / n * 100, 1),
        "avg_ret": round(sum(t["ret"] for t in trades) / n, 2),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else 0,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0,
        "pf": round(sum(wins) / gross_loss, 2) if gross_loss > 0 else None,
        "avg_days": round(sum(t["days"] for t in trades) / n, 1),
        "hit_target": round(sum(t["result"] == "win" for t in trades) / n * 100, 1),
        "hit_stop": round(sum(t["result"] == "loss" for t in trades) / n * 100, 1),
    }


def stock_record(stock: dict, ind: dict, ev: dict) -> dict:
    i = ind["n"] - 1
    k0 = max(0, ind["n"] - CHART_DAYS)
    return {
        "code": stock["code"],
        "name": stock["name"],
        "aliases": stock.get("aliases", []),
        "sector": stock.get("sector", ""),
        "setup": ev["setup"],
        "setup_label": SETUP_LABEL[ev["setup"]],
        "tech_score": round(ev["score"], 1),
        "close": round(ev["close"], 1),
        "chg_pct": round(pct(ev["close"], ev["prev"]), 2),
        "ret5": round(ev["ret5"], 2),
        "ret20": round(ev["ret20"], 2),
        "rs20": None if ev["rs"] is None else round(ev["rs"], 2),
        "rsi": round(ev["rsi"], 1),
        "dev25": round(ev["dev25"], 2),
        "above25": ev["above25"],
        "vol_ratio": round(ev["vol_ratio"], 2),
        "atr_pct": round(ev["atr"] / ev["close"] * 100, 2),
        "turnover_oku": round(ev["turnover"], 1),
        "hi52_gap": round(pct(ev["close"], ev["hi52"]), 2),
        "entry": tick_round(ev["entry"]),
        "stop": tick_round(ev["stop"]),
        "target": tick_round(ev["target"]),
        "chase": tick_round(ev["chase"]),
        "limit": tick_round(ev["limit"]) if ev["limit"] else None,
        "rr": round((ev["target"] - ev["entry"]) / ev["risk"], 2),
        "exit_warn": exit_warnings(ind, i, ev),
        "checks": ev["checks"],
        "rule_ok": ev["rule_ok"],
        "fails": ev["fails"],
        "support": [px_round(ev["support"][0]), ev["support"][1]] if ev["support"] else None,
        "resistance": [px_round(ev["resistance"][0]), ev["resistance"][1]] if ev["resistance"] else None,
        "trail_stop": trail_stop(ind, i, ev["atr"]),
        "reasons": ev["reasons"],
        "cautions": ev["cautions"],
        "date": ind["d"][i],
        "chart": {
            "d": [d[2:].replace("-", "") for d in ind["d"][k0:]],  # YYMMDD
            "o": [px_round(x) for x in ind["o"][k0:]],
            "h": [px_round(x) for x in ind["h"][k0:]],
            "l": [px_round(x) for x in ind["l"][k0:]],
            "c": [px_round(x) for x in ind["c"][k0:]],
            "v": [round(x / 1000) for x in ind["v"][k0:]],  # 千株
            "ma25": [px_round(x) for x in ind["ma25"][k0:]],
            "ma75": [px_round(x) for x in ind["ma75"][k0:]],
        },
    }


def trail_stop(ind: dict, i: int, atr_now: float) -> float | None:
    """トレーリングストップの案：いちばん新しい「反発した安値」の少し下。"""
    ks = [k for k in ind["piv_lo"] if i - 30 <= k <= i - PIVOT_W]
    if not ks:
        return None
    lv = ind["l"][ks[-1]]
    return tick_round(lv - max(0.25 * atr_now, lv * 0.01))


def exit_warnings(ind: dict, i: int, ev: dict) -> list[str]:
    """保有している人向けの「売りどき」のサイン。"""
    w = []
    c, ma25 = ind["c"], ind["ma25"]
    if ma25[i] and ma25[i - 1] and c[i] < ma25[i] and c[i - 1] >= ma25[i - 1]:
        w.append("終値で25日線を割り込んだ")
    if ev["macd_dc"]:
        w.append("MACD がシグナルを下抜けた")
    if ev["rsi"] > 78:
        w.append(f"RSI {ev['rsi']:.0f} で過熱。一部利確を検討")
    if ev["dev25"] > 15:
        w.append(f"25日線から {ev['dev25']:+.1f}% 離れ、急騰の反動に注意")
    if ev["vol_ratio"] > 2 and c[i] < ind["o"][i] and c[i] < c[i - 1]:
        w.append("大商いで陰線（売り圧力）")
    return w


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


def market_regime(idx: dict[str, dict], breadth: float | None = None) -> dict:
    s, notes = 0, []
    if breadth is not None:
        if breadth >= 65:
            s += 1; notes.append(f"対象銘柄の {breadth:.0f}% が25日線の上（買いが広がっている）")
        elif breadth <= 35:
            s -= 1; notes.append(f"25日線の上にある銘柄は {breadth:.0f}% だけ（全体に弱い）")
        else:
            notes.append(f"25日線の上にある銘柄は {breadth:.0f}%")
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
    # 地合いが悪いほど、注目銘柄に出す基準を厳しくし、数を絞る
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
        rest = it["title"]
        codes = [c for c in it.get("codes", []) if c in sector_of]
        if it.get("official") and not codes:
            continue  # 対象外の銘柄の適時開示は捨てる
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
        if it.get("official"):
            tags = ["適時開示"] + tags
            weight += 0.5
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
        elif shape == "uptrend" and left <= 30:
            dr = 0.006
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
        ("6758", "{n}、業績予想の修正　通期の純利益を上方修正（サンプル）", 2),
        ("4502", "{n}、主力薬の承認が延期　株価は反落（サンプル）", 6),
        ("9101", "{n}が下方修正　運賃の下落が響く（サンプル）", 8),
        (None, "日経平均が反発、半導体株に買い（サンプル）", 1),
        (None, "円安が進行、1ドル＝150円台に（サンプル）", 4),
        (None, "米長期金利上昇で国内銀行株が上昇（サンプル）", 7),
        (None, "訪日客が過去最高を更新、インバウンド関連に注目（サンプル）", 10),
    ]
    out = [{"title": f"{pick['8058']['name']} 自己株式取得に係る事項の決定に関するお知らせ（サンプル）", "link": "",
            "source": "適時開示", "dt": now - timedelta(hours=3), "codes": ["8058"], "official": True}]
    for code, t, hrs in lines:
        title = t.format(n=pick[code]["name"]) if code else t
        out.append({"title": title, "link": "", "source": "サンプル", "dt": now - timedelta(hours=hrs)})
    return out


PICKABLE = ("pullback",)
# きびしめ・ゆるめで値が変わる項目（ゆるめの分は record["loose"] に入れる）
MODE_KEYS = ("setup", "setup_label", "tech_score", "entry", "stop", "target", "chase", "limit", "rr",
             "checks", "rule_ok", "fails", "support", "resistance", "reasons", "cautions")


def select_picks(records: list[dict], max_picks: int = 10) -> list[str]:
    """自分のルールにすべて合う銘柄だけを、点数の高い順に。"""
    ok = [r for r in records if r["rule_ok"]]
    ok.sort(key=lambda r: -r["score"])
    return [r["code"] for r in ok[:max_picks]]


def sector_strength(records: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for r in records:
        groups.setdefault(r["sector"], []).append(r)
    out = []
    for sec, rs in groups.items():
        n = len(rs)
        r5 = sum(r["ret5"] for r in rs) / n
        r20 = sum(r["ret20"] for r in rs) / n
        best = max(rs, key=lambda r: r["score"])
        out.append({"sector": sec, "n": n, "ret5": round(r5, 2), "ret20": round(r20, 2),
                    "breadth": round(sum(r["above25"] for r in rs) / n * 100),
                    "strength": round(r20 + 0.5 * r5, 2), "best": best["code"]})
    out.sort(key=lambda x: -x["strength"])
    return out


def load_history(path: Path) -> list[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("picks", [])
    except Exception:  # noqa: BLE001
        return []


def bootstrap_history(inds: dict, stocks_by_code: dict, bench_by_date: dict, mkt_by_date: dict,
                      days: int = 20, mode: str = "strict") -> list[dict]:
    """記録がまだ無いとき、直近の営業日にこのアプリが選んだはずの銘柄を再現して記録の種にする。"""
    any_ind = max(inds.values(), key=lambda x: x["n"])
    dates = any_ind["d"][-(days + 1):-1]
    hist = []
    for d in dates:
        recs = []
        for code, ind in inds.items():
            try:
                i = ind["d"].index(d)
            except ValueError:
                continue
            if i < 80:
                continue
            ev = evaluate(ind, i, bench_by_date.get(d), mkt_by_date.get(d), rules=RULESETS[mode])
            recs.append({"code": code, "setup": ev["setup"], "score": ev["score"], "rule_ok": ev["rule_ok"], "ev": ev})
        for code in select_picks(recs):
            ev = next(r["ev"] for r in recs if r["code"] == code)
            hist.append({"date": d, "code": code, "name": stocks_by_code[code]["name"], "setup": ev["setup"],
                         "score": round(ev["score"], 1), "entry": tick_round(ev["entry"]),
                         "stop": tick_round(ev["stop"]), "target": tick_round(ev["target"]), "src": "sim", "mode": mode})
    return hist


def evaluate_history(hist: list[dict], inds: dict) -> tuple[list[dict], dict]:
    """過去の注目銘柄を、翌日の寄り付きで買ったとして今どうなっているかを調べる。"""
    rows = []
    for h in hist:
        ind = inds.get(h["code"])
        if not ind or h["date"] not in ind["d"]:
            continue
        i = ind["d"].index(h["date"])
        t = simulate_trade(ind, i, h["stop"], h["target"])
        if t is None:
            if i + 1 >= ind["n"]:
                status, ret, days = "wait", None, 0
            else:
                status, ret, days = "skip", None, 0  # 寄り付きで計画が崩れて見送り
        else:
            status, ret, days = t["result"], round(t["ret"], 2), t["days"]
        rows.append({**h, "status": status, "ret": ret, "days": days,
                     "now": px_round(ind["c"][-1]), "buy": px_round(ind["o"][i + 1]) if i + 1 < ind["n"] else None})
    rows.sort(key=lambda r: (r["date"], r["score"]), reverse=True)
    closed = [r for r in rows if r["status"] in ("win", "loss", "timeout")]
    stats = trade_stats([{"ret": r["ret"], "days": r["days"], "result": r["status"]} for r in closed])
    stats["open"] = sum(r["status"] == "open" for r in rows)
    stats["live_since"] = min((r["date"] for r in rows if r.get("src") == "live"), default=None)
    return rows, stats


# ---- 本体 -----------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="ネットを使わずサンプルデータを作る")
    ap.add_argument("--out", default=str(ROOT / "data" / "latest.json"))
    args = ap.parse_args()
    t0 = time.time()

    stocks = json.loads((ROOT / "scripts" / "universe.json").read_text(encoding="utf-8"))["stocks"]
    by_code = {s["code"]: s for s in stocks}
    print(f"対象 {len(stocks)} 銘柄 / demo={args.demo}")
    out_path = Path(args.out)
    hist_path = out_path.with_name("history.json")

    tm = Timer()
    # 指数
    idx_px, idx_sum = {}, {}
    idx_fetched = {} if args.demo else dict(zip([ix["sym"] for ix in INDICES], pmap(lambda ix: fetch_daily(ix["sym"]), INDICES)))
    for ix in INDICES:
        if args.demo:
            base = {"^N225": 38000, "1306.T": 2800, "^GSPC": 5900, "^IXIC": 19000, "^SOX": 5200,
                    "JPY=X": 150, "^VIX": 16, "^TNX": 4.3}[ix["sym"]]
            px = demo_prices(ix["sym"], base, days=500, drift=(0.0015 if ix["sym"] == "^N225" else 0.0006) if ix["kind"] != "vol" else 0.0,
                             vol=0.009 if ix["kind"] != "vol" else 0.03, shape="uptrend" if ix["sym"] == "^N225" else "")
        else:
            px = idx_fetched.get(ix["sym"])
        if px:
            idx_px[ix["sym"]] = px
            idx_sum[ix["sym"]] = index_summary(ix, px)
    nk = idx_px.get("^N225")
    bench_by_date = {}
    if nk:
        for k in range(20, len(nk["c"])):
            bench_by_date[nk["d"][k]] = pct(nk["c"][k], nk["c"][k - 20])
    bench_ret20 = pct(nk["c"][-1], nk["c"][-21]) if nk and len(nk["c"]) > 21 else None
    # ルール：日経平均が下向きの時は買わない（25日線が5営業日前より上がっているかで判断）
    mkt_by_date = {}
    if nk:
        nm25 = sma(nk["c"], 25)
        for k in range(30, len(nk["c"])):
            mkt_by_date[nk["d"][k]] = {"up": bool(nm25[k] and nm25[k - 5] and nm25[k] > nm25[k - 5]),
                                       "above": bool(nm25[k] and nk["c"][k] > nm25[k])}
    mkt_now = mkt_by_date.get(nk["d"][-1]) if nk else None
    mkt_now = mkt_now or {"up": None, "above": None}
    mkt_up = mkt_now["up"]
    print(f"日経平均の25日線: {'上向き' if mkt_up else '下向き' if mkt_up is False else '不明'}"
          f"・日経平均は25日線の{'上' if mkt_now['above'] else '下'}")
    tm.lap("指数")
    cal = None if args.demo else YahooCal()
    earn_path = out_path.with_name("earnings.json")
    earn_cache = {} if args.demo else load_earnings_cache(earn_path)

    # 株価と決算日を、まとめて同時に取りにいく
    fetched = {}
    if not args.demo:
        def fetch_one(s):
            return fetch_daily(s["code"] + ".T")
        fetched = dict(zip([s["code"] for s in stocks], pmap(fetch_one, stocks)))
        tm.lap(f"株価 {len(stocks)} 銘柄")
        n_before = sum(1 for c in earn_cache.values() if c)
        earns = dict(zip([s["code"] for s in stocks], pmap(lambda s: earnings_cached(s["code"], earn_cache, cal), stocks)))
        tm.lap(f"決算発表日（前回の結果を使った {n_before} 銘柄を含む）")

    # 個別株
    shapes = ["pullback", "breakout", "rebound", "hot", "", "", "", ""]
    inds, records, failed = {}, [], []
    for k, s in enumerate(stocks):
        if args.demo:
            rnd = random.Random(s["code"])
            px = demo_prices(s["code"], rnd.uniform(800, 9000), days=500, drift=rnd.uniform(-0.0006, 0.0015),
                             vol=rnd.uniform(0.012, 0.028), shape=shapes[k % len(shapes)])
        else:
            px = fetched.get(s["code"])
        if not px or len(px["c"]) < 80:
            failed.append(s["code"])
            continue
        if args.demo:
            earn = (datetime.now(JST).date() + timedelta(days=random.Random(s["code"] + "e").randint(-20, 90))).isoformat() \
                if k % 3 else None
        else:
            earn = earns.get(s["code"])
        try:
            ind = indicators(px)
            ev = evaluate(ind, ind["n"] - 1, bench_ret20, mkt_now, days_until(earn))
            inds[s["code"]] = ind
            rec = stock_record(s, ind, ev)
            ev_l = evaluate(ind, ind["n"] - 1, bench_ret20, mkt_now, days_until(earn), rules=RULESETS["loose"])
            rl = stock_record(s, ind, ev_l)
            rec["loose"] = {k: rl[k] for k in MODE_KEYS}
            rec["earnings"] = earn
            rec["earnings_days"] = days_until(earn)
            records.append(rec)
        except Exception as e:  # noqa: BLE001
            print(f"  ! analyze {s['code']}: {e}", file=sys.stderr)
            failed.append(s["code"])
    print(f"株価 OK {len(records)} / 失敗 {len(failed)}")
    if len(records) < len(stocks) * 0.5:
        # 半分も取れないときは、前回のデータを残したまま失敗にする（アプリが空にならないように）
        print("株価の取得に失敗した銘柄が多いので、書き出しを中止します", file=sys.stderr)
        return 1

    tm.lap("指標・ルールの判定")
    # 検証（過去2年で、同じルールで売買していたらどうだったか）
    all_trades, per_stock, nomkt, loose_trades, per_stock_l = [], {}, [], [], {}
    base_rets = []
    for code, ind in inds.items():
        nomkt += backtest(ind, bench_by_date, None)
        trl = backtest(ind, bench_by_date, mkt_by_date, RULESETS["loose"])
        loose_trades += trl
        per_stock_l[code] = trl
        tr = backtest(ind, bench_by_date, mkt_by_date)
        for t in tr:
            t["code"] = code
        all_trades += tr
        per_stock[code] = tr
        for i in range(80, ind["n"] - HOLD_DAYS - 1, 5):  # 比較用：いつ買っても同じ日数持った場合
            base_rets.append(pct(ind["c"][i + HOLD_DAYS], ind["o"][i + 1]))
    bt = {
        "hold_days": HOLD_DAYS,
        "period": [min((t["date"] for t in all_trades), default=None), max((t["date"] for t in all_trades), default=None)],
        "all": trade_stats(all_trades),
        "nomkt": trade_stats(nomkt),
        "loose": trade_stats(loose_trades),
        "loose_by_score": [{"label": lb, **trade_stats([t for t in loose_trades if lo <= t["score"] < hi])}
                           for lb, lo, hi in (("〜69点", 0, 70), ("70〜79点", 70, 80), ("80点以上", 80, 999))],
        "by_score": [{"label": lb, **trade_stats([t for t in all_trades if lo <= t["score"] < hi])}
                     for lb, lo, hi in (("〜69点", 0, 70), ("70〜79点", 70, 80), ("80点以上", 80, 999))],
        "baseline_avg_ret": round(sum(base_rets) / len(base_rets), 2) if base_rets else None,
    }
    print(f"検証 きびしめ: {bt['all']}\n     ゆるめ: {bt['loose']}\n  比較（いつでも買う）平均 {bt['baseline_avg_ret']}%")

    tm.lap("過去2年の検証")
    # ニュース
    raw = []
    if args.demo:
        raw = demo_news(stocks)
    else:
        feeds = [(TDNET_FEED[0], TDNET_FEED[1])] + [(src, url) for src, url in MARKET_FEEDS]
        top = sorted(records, key=lambda a: -a["tech_score"])[:PER_STOCK_NEWS]
        for a in top:
            q = f"\"{a['name']}\" 株 when:3d"
            feeds.append(("Google ニュース*", "https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + "&hl=ja&gl=JP&ceid=JP:ja"))
        for (src, _), items in zip(feeds, pmap(lambda f: fetch_rss(f[1], f[0].rstrip("*")), feeds, workers=4)):
            if src == TDNET_FEED[0]:
                items = [it for it in items if it.get("codes")]
            elif src.endswith("*"):
                items = items[:8]  # 銘柄ごとの検索は新しい8件まで
            raw += items
    news, hot = analyze_news(raw, stocks)
    print(f"ニュース {len(news)} 件 / テーマ {[h['theme'] for h in hot]}")
    tm.lap("ニュース")

    # 総合点
    for a in records:
        b, ids, notes = news_boost(by_code[a["code"]], news, hot)
        a["news_score"] = b
        a["news_ids"] = ids
        a["theme_notes"] = notes
        a["score"] = round(max(0, min(100, a["tech_score"] + b)), 1)
        a["loose"]["score"] = round(max(0, min(100, a["loose"]["tech_score"] + b)), 1)
        mine = [n for n in news if n["id"] in ids]
        if any(n["sentiment"] > 0.3 for n in mine):
            a["reasons"].append("プラスの材料ニュースあり")
        if any(n["sentiment"] < -0.3 for n in mine):
            a["cautions"].append("マイナスの材料ニュースあり")
        if any(("決算" in n["tags"] or "業績修正" in n["tags"]) for n in mine):
            a["cautions"].append("決算・業績の発表あり。内容と翌日の反応を確認してから入る")
        tr = per_stock.get(a["code"], [])
        a["bt"] = {"all": trade_stats(tr), "same": trade_stats([t for t in tr if t["setup"] == a["setup"]])}
        a["loose"]["bt"] = {"all": trade_stats(per_stock_l.get(a["code"], []))}
        a["loose"]["bt"]["same"] = a["loose"]["bt"]["all"]
    records.sort(key=lambda a: -a["score"])

    breadth = sum(r["above25"] for r in records) / len(records) * 100
    regime = market_regime(idx_sum, breadth)
    regime["breadth"] = round(breadth)
    regime["nikkei_up"] = mkt_up
    if mkt_up is False:
        regime["notes"].insert(0, "日経平均の25日線が下向き")
        regime["label"] = "買わない日"
        regime["text"] = "ルール「日経平均が下向きの時は買わない」により、今日は新しく買いません。保有中の銘柄の管理だけ行います。"
    def near_miss(view):
        # あと1つだけ条件が足りない銘柄（日経平均の条件で外れた銘柄も含む）
        return [r["code"] for r in view if not r["rule_ok"] and len(r["fails"]) == 1
                and (r["setup"] == "pullback" or r["fails"] == ["market"])][:8]

    loose_view = sorted(({**r, **r["loose"]} for r in records), key=lambda r: -r["score"])
    picks, almost = select_picks(records), near_miss(records)
    picks_l, almost_l = select_picks(loose_view), near_miss(loose_view)
    print(f"注目 きびしめ {len(picks)} 銘柄 / ゆるめ {len(picks_l)} 銘柄")

    # 注目銘柄の記録と成績（きびしめ・ゆるめ別）
    # サンプルのときは記録ファイルを読み書きしない（本物の記録に混ざらないように）
    hist = [] if args.demo else [h for h in load_history(hist_path) if h.get("src") != "demo"]
    for h in hist:
        h.setdefault("mode", "strict")
    any_ind = max(inds.values(), key=lambda x: x["n"])
    cutoff = any_ind["d"][-TRACK_DAYS] if any_ind["n"] > TRACK_DAYS else any_ind["d"][0]
    track = {}
    new_hist = []
    for mode, view, mp in (("strict", records, picks), ("loose", loose_view, picks_l)):
        hm = [h for h in hist if h["mode"] == mode]
        if not hm:
            hm = bootstrap_history(inds, by_code, bench_by_date, mkt_by_date, mode=mode)
        dates = sorted({h["date"] for h in hm})
        prev = {h["code"] for h in hm if dates and h["date"] == dates[-1]}
        have = {(h["date"], h["code"]) for h in hm}
        vb = {r["code"]: r for r in view}
        for code in mp:
            r = vb[code]
            if (r["date"], code) not in have:
                hm.append({"date": r["date"], "code": code, "name": r["name"], "setup": r["setup"], "score": r["score"],
                           "entry": r["entry"], "stop": r["stop"], "target": r["target"],
                           "src": "demo" if args.demo else "live", "mode": mode})
        target = {r["code"]: r for r in records}
        for code in mp:
            (target[code] if mode == "strict" else target[code]["loose"])["new_pick"] = code not in prev
        hm = [h for h in hm if h["date"] >= cutoff]
        rows, stats = evaluate_history(hm, inds)
        track[mode] = {"stats": stats, "rows": rows[:80]}
        new_hist += hm
    hist = new_hist

    out = {
        "generated_at": datetime.now(JST).isoformat(timespec="minutes"),
        "price_date": any_ind["d"][-1],
        "demo": args.demo,
        "market": {"regime": regime, "indices": [idx_sum[i["sym"]] for i in INDICES if i["sym"] in idx_sum]},
        "sectors": sector_strength(records),
        "themes": hot,
        "picks": picks,
        "almost": almost,
        "picks_loose": picks_l,
        "almost_loose": almost_l,
        "market_state": mkt_now,
        "stocks": records,
        "news": [{k: v for k, v in n.items() if k != "weight"} for n in news[:150]],
        "backtest": bt,
        "track": track,
        "failed": failed,
    }
    # チャートは別ファイル（銘柄を開いたときに読む）
    charts = {a["code"]: a.pop("chart") for a in records}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    out_path.write_text(dump(out), encoding="utf-8")
    out_path.with_name("charts.json").write_text(dump(charts), encoding="utf-8")
    if not args.demo:
        earn_path.write_text(json.dumps(earn_cache, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
        hist_path.write_text(json.dumps({"picks": hist}, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"書き出し: {out_path} ({out_path.stat().st_size // 1024} KB) 注目 {len(picks)}+{len(picks_l)} 銘柄 / "
          f"記録 {len(hist)} 件 / {time.time() - t0:.0f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
