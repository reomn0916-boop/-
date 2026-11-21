"""update.py の計算のテスト:  python3 -m unittest discover -s swing/tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import update as u  # noqa: E402


def ind_from(o, h, l, c):
    return {"o": o, "h": h, "l": l, "c": c, "n": len(c), "d": [f"2026-01-{i + 1:02d}" for i in range(len(c))]}


class Indicators(unittest.TestCase):
    def test_sma(self):
        self.assertEqual(u.sma([1, 2, 3, 4], 2), [None, 1.5, 2.5, 3.5])

    def test_rsi_all_up_is_100(self):
        self.assertEqual(u.rsi(list(range(1, 30)))[-1], 100.0)

    def test_rsi_range(self):
        xs = [100 + ((-1) ** i) * i for i in range(60)]
        self.assertTrue(all(0 <= r <= 100 for r in u.rsi(xs) if r is not None))


class SimulateTrade(unittest.TestCase):
    def test_target_hit(self):
        ind = ind_from(o=[100, 101, 103, 106], h=[101, 102, 104, 111], l=[99, 100, 102, 105], c=[100, 101, 103, 110])
        t = u.simulate_trade(ind, 0, stop=95, target=110)
        self.assertEqual(t["result"], "win")
        self.assertAlmostEqual(t["ret"], (110 / 101 - 1) * 100)
        self.assertEqual(t["days"], 3)

    def test_stop_hit_and_gap_down(self):
        # 2日目に損切りより下で寄り付いたら、寄り値で負けとして数える
        ind = ind_from(o=[100, 101, 90], h=[101, 102, 91], l=[99, 99, 88], c=[100, 100, 89])
        t = u.simulate_trade(ind, 0, stop=95, target=120)
        self.assertEqual(t["result"], "loss")
        self.assertAlmostEqual(t["ret"], (90 / 101 - 1) * 100)

    def test_same_day_both_counts_as_loss(self):
        ind = ind_from(o=[100, 100, 100], h=[101, 101, 130], l=[99, 99, 80], c=[100, 100, 100])
        self.assertEqual(u.simulate_trade(ind, 0, stop=95, target=120)["result"], "loss")

    def test_gap_beyond_plan_is_skipped(self):
        ind = ind_from(o=[100, 125], h=[101, 126], l=[99, 124], c=[100, 125])
        self.assertIsNone(u.simulate_trade(ind, 0, stop=95, target=120))

    def test_timeout(self):
        n = u.HOLD_DAYS + 3
        ind = ind_from(o=[100] * n, h=[101] * n, l=[99] * n, c=[100] * n)
        self.assertEqual(u.simulate_trade(ind, 0, stop=90, target=120)["result"], "timeout")


class Stats(unittest.TestCase):
    def test_stats(self):
        st = u.trade_stats([{"ret": 10, "days": 5, "result": "win"}, {"ret": -5, "days": 3, "result": "loss"}])
        self.assertEqual(st["win_rate"], 50.0)
        self.assertEqual(st["pf"], 2.0)
        self.assertEqual(st["avg_ret"], 2.5)


class News(unittest.TestCase):
    STOCKS = [{"code": "9984", "name": "ソフトバンクグループ", "aliases": ["ソフトバンクG"], "sector": "情報・サービス"},
              {"code": "9434", "name": "ソフトバンク", "sector": "通信"}]

    def test_longest_alias_wins(self):
        from datetime import datetime
        raw = [{"title": "ソフトバンクグループが上方修正", "link": "", "source": "x", "dt": datetime.now(u.JST)}]
        news, _ = u.analyze_news(raw, self.STOCKS)
        self.assertEqual(news[0]["codes"], ["9984"])
        self.assertGreater(news[0]["sentiment"], 0)

    def test_uriage_is_not_sell(self):
        self.assertEqual(u.score_text("売上高が伸びる")[0], 0)


if __name__ == "__main__":
    unittest.main()


class Rules(unittest.TestCase):
    def test_levels_cluster(self):
        lv = u.levels([100, 101, 100.5, 120, 121, 150], tol=2)
        self.assertEqual([n for _, n in lv], [3, 2, 1])
        self.assertAlmostEqual(lv[0][0], 100.5)

    def _demo_ind(self):
        px = u.demo_prices("b", 1000, days=500, drift=0.0012, vol=0.015, shape="")
        return u.indicators(px)

    def test_market_down_never_ok(self):
        ind = self._demo_ind()
        for i in range(100, ind["n"]):
            self.assertFalse(u.evaluate(ind, i, 0, mkt_up=False)["rule_ok"])

    def test_earnings_soon_never_ok(self):
        ind = self._demo_ind()
        for i in range(100, ind["n"]):
            ev = u.evaluate(ind, i, 0, mkt_up=True, earn_days=5)
            self.assertFalse(ev["rule_ok"])

    def test_rule_ok_plan_is_consistent(self):
        """ルールに合った日は、損切り < 終値 < 利確 で、利確幅が損切り幅の2倍以上。未来のデータを使わない。"""
        ind = self._demo_ind()
        hits = 0
        for i in range(100, ind["n"]):
            ev = u.evaluate(ind, i, 0, mkt_up=True)
            if ev["setup"] == "pullback":  # ルールに合う日が少なくても、判定の一致は確かめる
                cut = u.indicators({k: ind[k][:i + 1] for k in ("d", "o", "h", "l", "c", "v")})
                self.assertEqual(ev["fails"], u.evaluate(cut, i, 0, mkt_up=True)["fails"])
            if ev["rule_ok"]:
                hits += 1
                self.assertLess(ev["stop"], ev["close"])
                self.assertGreater(ev["target"], ev["close"])
                self.assertGreaterEqual((ev["target"] - ev["entry"]) / ev["risk"], u.MIN_RR - 1e-9)
                cut = u.indicators({k: ind[k][:i + 1] for k in ("d", "o", "h", "l", "c", "v")})
                ev2 = u.evaluate(cut, i, 0, mkt_up=True)
                self.assertEqual(round(ev["stop"], 6), round(ev2["stop"], 6))
                self.assertEqual(ev["rule_ok"], ev2["rule_ok"])
        self.assertGreater(hits, 0)


class LooseRules(unittest.TestCase):
    def test_loose_finds_more_and_keeps_min_rr(self):
        ind = u.indicators(u.demo_prices("b", 1000, days=500, drift=0.0012, vol=0.015))
        strict = loose = 0
        for i in range(100, ind["n"]):
            es = u.evaluate(ind, i, 0, mkt_up=True)
            el = u.evaluate(ind, i, 0, mkt_up=True, rules=u.RULESETS["loose"])
            strict += es["rule_ok"]
            loose += el["rule_ok"]
            if el["rule_ok"]:
                self.assertLess(el["stop"], el["close"])
                self.assertGreaterEqual((el["target"] - el["entry"]) / el["risk"], 1.5 - 1e-9)
        self.assertGreater(loose, strict)

    def test_loose_market_rule(self):
        ind = u.indicators(u.demo_prices("b", 1000, days=500, drift=0.0012, vol=0.015))
        for i in range(100, ind["n"]):
            # 25日線が下向きでも、日経平均が25日線の上なら市場の条件は通る／両方だめなら通らない
            el = u.evaluate(ind, i, 0, mkt_up={"up": False, "above": True}, rules=u.RULESETS["loose"])
            self.assertTrue(el["checks"][0]["ok"])
            el2 = u.evaluate(ind, i, 0, mkt_up={"up": False, "above": False}, rules=u.RULESETS["loose"])
            self.assertFalse(el2["rule_ok"])
