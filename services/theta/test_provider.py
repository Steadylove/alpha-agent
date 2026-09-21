"""Check the provider's date-specific maintenance hint, including DST."""
import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from provider import midnight_retry_at


class MaintenanceTests(unittest.TestCase):
    def test_only_yesterday_inside_window(self):
        now = datetime.fromisoformat("2026-09-16T12:50:00+08:00")
        retry = midnight_retry_at(date(2026, 9, 15), now)
        self.assertEqual(retry.astimezone(ZoneInfo("Asia/Shanghai")).isoformat(),
                         "2026-09-16T13:45:00+08:00")
        self.assertIsNone(midnight_retry_at(date(2026, 9, 14), now))
        self.assertIsNone(midnight_retry_at(date(2026, 9, 16), now))
        self.assertIsNone(midnight_retry_at(date(2026, 9, 15), retry))

    def test_winter_uses_est(self):
        now = datetime.fromisoformat("2026-12-16T13:50:00+08:00")
        retry = midnight_retry_at(date(2026, 12, 15), now)
        self.assertEqual(retry.astimezone(ZoneInfo("Asia/Shanghai")).hour, 14)


if __name__ == "__main__":
    unittest.main()
