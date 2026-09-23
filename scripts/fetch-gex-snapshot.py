#!/usr/bin/env python3
"""从 CBOE 延时期权链拉收盘快照。

Flip = GEX(S) 过零点（现货走到 S 时重算 γ），不是按行权价累加。
墙 = 现价附近 3% 内的主 Call / Put 档。
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
YAHOO_TNX = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d"

SYMBOLS = (
    ("SPX", "_SPX", 0.013),
    ("SPY", "SPY", 0.012),
    ("QQQ", "QQQ", 0.007),
    ("IWM", "IWM", 0.012),
)

OCC = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
MULTIPLIER = 100
NEAR_DTE_MAX = 45
WALL_BAND = 0.03
RATE = 0.04
OUT_DIR = Path(os.environ.get("GEX_OUTPUT_DIR") or Path(__file__).resolve().parents[1] / ".cache" / "gex")


def fetch_json(url: str, timeout: int = 90) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "alpha-agent-gex/0.2"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def parse_occ(symbol: str) -> tuple[date, str, float] | None:
    match = OCC.match(symbol.replace(" ", ""))
    if match is None:
        return None
    yymmdd, kind, raw_strike = match.group(2), match.group(3), match.group(4)
    expiry = date(2000 + int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6]))
    return expiry, kind, int(raw_strike) / 1000


def parse_snapshot_date(value: object) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def option_gex(gamma: float, oi: float, spot: float) -> float:
    if not all(math.isfinite(v) and v > 0 for v in (gamma, oi, spot)):
        return 0.0
    return gamma * oi * MULTIPLIER * spot * spot * 0.01


def bs_gamma(spot: float, strike: float, time_years: float, iv: float, dividend: float) -> float:
    if not all(math.isfinite(v) and v > 0 for v in (spot, strike, time_years, iv)) or iv <= 0.005:
        return 0.0
    vol_term = iv * math.sqrt(time_years)
    if vol_term <= 0:
        return 0.0
    d1 = (math.log(spot / strike) + (RATE - dividend + 0.5 * iv * iv) * time_years) / vol_term
    density = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    return density / (spot * vol_term)


def net_gex_at(
    contracts: list[tuple[float, str, float, float, float, float]],
    spot: float,
    dividend: float,
    use_exchange_gamma: bool = False,
) -> float:
    total = 0.0
    for strike, kind, oi, iv, time_years, exchange_gamma in contracts:
        gamma = exchange_gamma if use_exchange_gamma else bs_gamma(spot, strike, time_years, iv, dividend)
        gex = option_gex(gamma, oi, spot)
        if gex == 0:
            continue
        total += gex if kind == "C" else -gex
    return total


def zero_gamma_level(
    contracts: list[tuple[float, str, float, float, float, float]],
    spot: float,
    dividend: float,
) -> float | None:
    step = 5.0 if spot >= 1000 else 0.5 if spot >= 200 else 0.25
    lo = spot * 0.94
    hi = spot * 1.04
    levels = []
    price = lo
    while price <= hi + 1e-9:
        levels.append(round(price, 4))
        price += step
    values = [net_gex_at(contracts, level, dividend) for level in levels]
    if not any(math.isfinite(value) and value != 0 for value in values):
        return None  # An empty/zero model curve has no identifiable crossing.
    crosses: list[float] = []
    for left, right, gex_left, gex_right in zip(levels, levels[1:], values, values[1:]):
        if gex_left == 0:
            crosses.append(left)
            continue
        if gex_left < 0 <= gex_right or gex_left > 0 >= gex_right:
            if gex_right == gex_left:
                crosses.append(left)
            else:
                crosses.append(left + (right - left) * (-gex_left) / (gex_right - gex_left))
    if not crosses:
        return None
    return min(crosses, key=lambda level: abs(level - spot))


def pick_walls(rows: list[dict], spot: float) -> tuple[float | None, float | None]:
    def in_band(row: dict, low: float, high: float) -> bool:
        return low <= row["strike"] <= high

    calls = [row for row in rows if math.isfinite(row["call_gex"]) and row["call_gex"] > 0]
    puts = [row for row in rows if math.isfinite(row["put_gex"]) and row["put_gex"] > 0]
    call_pool = [row for row in calls if in_band(row, spot, spot * (1 + WALL_BAND))]
    put_pool = [row for row in puts if in_band(row, spot * (1 - WALL_BAND), spot)]
    if not call_pool:
        call_pool = [row for row in calls if row["strike"] >= spot]
    if not put_pool:
        put_pool = [row for row in puts if row["strike"] <= spot]
    call = max(call_pool, key=lambda row: row["call_gex"]) if call_pool else None
    put = max(put_pool, key=lambda row: row["put_gex"]) if put_pool else None
    if call and put and call["strike"] == put["strike"]:
        next_calls = [row for row in call_pool if row["strike"] != call["strike"]]
        if next_calls:
            call = max(next_calls, key=lambda row: row["call_gex"])
    return call["strike"] if call else None, put["strike"] if put else None


def net_status(gex_at_spot: float, spot: float, flip: float | None) -> str:
    if flip is not None and abs(spot - flip) / spot <= 0.002:
        return "临界"
    if gex_at_spot > 0:
        return "偏正" if flip is None or spot > flip else "临界/偏正"
    if gex_at_spot < 0:
        return "偏负" if flip is None or spot < flip else "临界/偏负"
    return "临界"


def collect_contracts(payload: dict, snapshot: date | None, dividend: float) -> tuple[list, list[dict], int, int]:
    data = payload["data"]
    spot = float(data.get("close") or data["current_price"])
    contracts = []
    by_strike: dict[float, dict[str, float]] = defaultdict(lambda: {"call": 0.0, "put": 0.0})
    used = 0
    skipped_far = 0
    for row in data.get("options") or []:
        parsed = parse_occ(str(row.get("option") or ""))
        if parsed is None:
            continue
        expiry, kind, strike = parsed
        if snapshot is not None:
            dte = (expiry - snapshot).days
            if dte < 0 or dte > NEAR_DTE_MAX:
                skipped_far += 1
                continue
            time_years = max(dte, 0.3) / 365
        else:
            time_years = 7 / 365
        oi = float(row.get("open_interest") or 0)
        iv = float(row.get("iv") or 0)
        exchange_gamma = float(row.get("gamma") or 0)
        if not math.isfinite(oi) or oi <= 0:
            continue
        contracts.append((strike, kind, oi, iv, time_years, exchange_gamma))
        gex = option_gex(exchange_gamma, oi, spot)
        if gex == 0:
            continue
        used += 1
        if kind == "C":
            by_strike[strike]["call"] += gex
        else:
            by_strike[strike]["put"] += gex
    rows = [
        {
            "strike": strike,
            "call_gex": bucket["call"],
            "put_gex": bucket["put"],
            "net_gex": bucket["call"] - bucket["put"],
        }
        for strike, bucket in sorted(by_strike.items())
    ]
    return contracts, rows, used, skipped_far


def summarize(label: str, payload: dict, dividend: float, profiles: dict | None = None) -> dict:
    data = payload["data"]
    spot = float(data.get("close") or data["current_price"])
    as_of = data.get("last_trade_time") or payload.get("timestamp")
    snapshot = parse_snapshot_date(as_of)
    if snapshot is None or not math.isfinite(spot) or spot <= 0:
        raise ValueError("invalid quote date or spot")
    contracts, rows, used, skipped_far = collect_contracts(payload, snapshot, dividend)
    gex_spot = net_gex_at(contracts, spot, dividend, use_exchange_gamma=True)
    flip = zero_gamma_level(contracts, spot, dividend)
    gex_flip = None if flip is None else net_gex_at(contracts, flip, dividend)
    call_wall, put_wall = pick_walls(rows, spot)
    abs_gex = sum(abs(item["net_gex"]) for item in rows) or 1.0
    result = {
        "symbol": label,
        "spot": spot,
        "as_of": as_of,
        "dte": f"0-{NEAR_DTE_MAX}d",
        "net_gex": gex_spot,
        "balance": gex_spot / abs_gex,
        "gross_gex": sum(item["call_gex"] + item["put_gex"] for item in rows),
        "flip_search": {"low": spot * 0.94, "high": spot * 1.04, "found": flip is not None},
        "status": net_status(gex_spot, spot, flip),
        "gamma_flip": flip,
        "gex_at_flip": gex_flip,
        "call_wall": call_wall,
        "put_wall": put_wall,
        "contracts_used": used,
        "contracts_skipped_far": skipped_far,
        "iv30": data.get("iv30"),
    }
    result["quality"] = validate_row(result)
    if profiles is not None:
        profiles[label] = {
            "date": snapshot.isoformat(), "asOf": as_of, "spot": spot,
            "netGex": gex_spot, "source": "cboe-delayed", "method": "cboe-gex-v2",
            "dte": f"0-{NEAR_DTE_MAX}d", "rows": rows,
        }
    return result


def review_row(row: dict) -> list[str]:
    problems = []
    spot = row["spot"]
    flip = row["gamma_flip"]
    gex = row["net_gex"]
    if flip is not None:
        flip_gex = row.get("gex_at_flip")
        if flip_gex is not None and abs(flip_gex) > abs(gex) * 0.15 and abs(flip_gex) > 1e8:
            problems.append(f"{row['symbol']} Flip 处 GEX 仍很大 ({flip_gex:.3e})")
    if row["call_wall"] is not None and row["call_wall"] < spot * 0.999:
        problems.append(f"{row['symbol']} Call Wall 低于现价")
    if row["put_wall"] is not None and row["put_wall"] > spot * 1.001:
        problems.append(f"{row['symbol']} Put Wall 高于现价")
    if row["call_wall"] is not None and row["call_wall"] == row["put_wall"]:
        problems.append(f"{row['symbol']} Call/Put 墙重合")
    if row["call_wall"] is not None and row["call_wall"] > spot * (1 + WALL_BAND + 0.002):
        problems.append(f"{row['symbol']} Call Wall 超出近端 {WALL_BAND:.0%} 带")
    return problems


def validate_row(row: dict) -> dict:
    fields = ("spot", "gamma_flip", "put_wall", "call_wall", "net_gex")
    invalid = [key for key in fields if row.get(key) is not None and
               (not isinstance(row[key], (int, float)) or not math.isfinite(row[key]) or
                (key != "net_gex" and row[key] <= 0))]
    warnings = []
    if row.get("contracts_used") == 0:
        invalid.extend(fields[1:])
        warnings.append("无有效期权合约")
    residual = row.get("gex_at_flip")
    if residual is not None and abs(residual) > max(abs(row.get("net_gex") or 0) * 0.15, 1e8):
        invalid.append("gamma_flip")
        warnings.append("Flip 过零残差偏大")
    # A positive spot GEX with a flip above spot is possible: independent calculations,
    # multiple crossings and opposite crossing directions. It is not a validation failure.
    return {"invalid_fields": sorted(set(invalid)), "warnings": warnings}


def impact(row: dict) -> str:
    # Markdown is a raw data report; all web/DC derived labels use the shared TS rules.
    return f"Flip {fmt_level(row['gamma_flip'])} · Put {fmt_level(row['put_wall'])} · Call {fmt_level(row['call_wall'])}"


def fmt_level(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "—"
    if value >= 1000:
        return f"{value:.0f}"
    if value >= 100:
        return f"{value:.1f}".rstrip("0").rstrip(".")
    return f"{value:.2f}".rstrip("0").rstrip(".")


def fetch_tnx() -> dict | None:
    try:
        payload = fetch_json(YAHOO_TNX)
        result = payload["chart"]["result"][0]
        closes = result["indicators"]["quote"][0]["close"]
        last = next((x for x in reversed(closes) if x is not None), None)
        prev = next((x for x in reversed(closes[:-1]) if x is not None), None)
        if last is None:
            return None
        return {"last": last, "prev": prev, "change": None if prev is None else last - prev}
    except Exception:
        return None


def render_markdown(rows: list[dict], tnx: dict | None, fetched_at: str, problems: list[str]) -> str:
    lines = [
        "# 4. GEX与Gamma关键点",
        "",
        f"数据：CBOE 延时期权链。近月 0–{NEAR_DTE_MAX} 天。计算时间 {fetched_at}。",
        "口径：Flip = 现货价格 S 上重算后的 GEX(S) 过零点。墙取现价 ±3% 主档。Call 正、Put 负。",
        "",
        "| 标的 | 现价 | 净GEX状态 | Gamma Flip | Call Wall | Put Wall | 影响 |",
        "| --- | ---: | --- | ---: | ---: | ---: | --- |",
    ]
    for row in rows:
        lines.append(
            "| {symbol} | {spot} | {status} | {flip} | {call} | {put} | {impact} |".format(
                symbol=row["symbol"],
                spot=fmt_level(row["spot"]),
                status=row["status"],
                flip=fmt_level(row["gamma_flip"]),
                call=fmt_level(row["call_wall"]),
                put=fmt_level(row["put_wall"]),
                impact=impact(row),
            ),
        )
    lines.append("")
    lines.append(closing_note(rows, tnx))
    lines.append("")
    lines.append("## 计算明细")
    lines.append("")
    for row in rows:
        flip_gex = row.get("gex_at_flip")
        flip_gex_txt = "—" if flip_gex is None else f"{flip_gex:.3e}"
        lines.append(
            f"- {row['symbol']}: 快照 {row['as_of']}，近月 {row['contracts_used']} 张，"
            f"丢掉远月 {row['contracts_skipped_far']} 张，现价GEX {row['net_gex']:.3e}，"
            f"Flip处GEX {flip_gex_txt}",
        )
    if problems:
        lines.append("")
        lines.append("## Review")
        lines.append("")
        for item in problems:
            lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def closing_note(rows: list[dict], tnx: dict | None) -> str:
    return "Call 正、Put 负的 Gamma 暴露估算；Flip 位置与现价 GEX 符号分别判断，不据此预测涨跌。"


def self_test() -> None:
    levels = [7680.0, 7720.0]
    values = [-20.0, 20.0]
    left, right = levels
    gex_left, gex_right = values
    flip = left + (right - left) * (-gex_left) / (gex_right - gex_left)
    assert abs(flip - 7700) < 1e-9

    walls = [
        {"strike": 7700, "call_gex": 5, "put_gex": 8, "net_gex": -3},
        {"strike": 7750, "call_gex": 4, "put_gex": 1, "net_gex": 3},
        {"strike": 7800, "call_gex": 9, "put_gex": 1, "net_gex": 8},
        {"strike": 8000, "call_gex": 20, "put_gex": 2, "net_gex": 18},
        {"strike": 7500, "call_gex": 1, "put_gex": 6, "net_gex": -5},
    ]
    assert pick_walls(walls, 7719) == (7800, 7700)
    assert net_status(1.2e10, 7719, 7702) == "偏正"
    assert net_status(-1e9, 719, None) == "偏负"
    test_row = {"symbol": "TEST", "spot": 100, "net_gex": 10, "gamma_flip": 105,
                "put_wall": 90, "call_wall": 110, "contracts_used": 2, "gex_at_flip": 0}
    assert validate_row(test_row)["invalid_fields"] == []
    assert not any("现价上方" in item for item in review_row(test_row))
    assert "net_gex" in validate_row({**test_row, "contracts_used": 0})["invalid_fields"]
    assert "gamma_flip" in validate_row({**test_row, "gex_at_flip": 1e10})["invalid_fields"]
    assert option_gex(float("nan"), 100, 100) == 0
    assert zero_gamma_level([], 100, 0) is None
    assert zero_gamma_level([(100, "C", 10, 0, 1, .1)], 100, 0) is None
    assert pick_walls([{"strike": 105, "call_gex": 1, "put_gex": 0}], 100) == (105, None)
    assert pick_walls([{"strike": 95, "call_gex": 0, "put_gex": 1}], 100) == (None, 95)
    print("self-test ok")


def main() -> None:
    if "--self-test" in sys.argv:
        self_test()
        return
    rows = []
    profiles: dict = {}
    for label, cboe_symbol, dividend in SYMBOLS:
        payload = fetch_json(CBOE.format(symbol=cboe_symbol))
        row = summarize(label, payload, dividend, profiles)
        rows.append(row)
        print(f"fetched {label}: {row['contracts_used']} near-month @ {row['spot']}")

    problems = [item for row in rows for item in review_row(row)]
    tnx = fetch_tnx()
    # Machine-readable availability time, after every fetch has completed.
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    markdown = render_markdown(rows, tnx, fetched_at, problems)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    md_path = OUT_DIR / f"gex-{stamp}.md"
    latest_md = OUT_DIR / "latest.md"
    payload = {
        "fetched_at": fetched_at,
        "source": "cboe-delayed",
        "dte": f"0-{NEAR_DTE_MAX}d",
        "method": "gex(S) zero-gamma + near-spot walls",
        "method_version": "cboe-gex-v2",
        "tnx": tnx,
        "items": rows,
        "review": problems,
    }
    md_path.write_text(markdown, encoding="utf-8")
    (OUT_DIR / f"gex-{stamp}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if all(row["contracts_used"] == 0 for row in rows):
        raise SystemExit("No valid option chains; latest snapshot was not replaced")
    # Profile and totals come from the exact same fetched option chain.
    # Keep this sidecar out of the review JSON to avoid inflating every page response.
    for label, profile in profiles.items():
        directory = OUT_DIR / "profiles" / profile["date"]
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{label}.json"
        temp = target.with_suffix(".tmp")
        temp.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
        temp.replace(target)
    latest_md.write_text(markdown, encoding="utf-8")
    (OUT_DIR / "latest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(markdown)
    if problems:
        print("REVIEW WARNINGS (field validity is recorded in each row):")
        for item in problems:
            print(f"  - {item}")
    print("REVIEW COMPLETE")
    print(f"wrote {latest_md}")


if __name__ == "__main__":
    main()
