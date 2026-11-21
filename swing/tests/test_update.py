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
