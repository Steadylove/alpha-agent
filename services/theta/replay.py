"""One-session, rule-based iron-condor replay; no price/model fabrication."""
from __future__ import annotations

import json
import math
from datetime import datetime, time, timedelta
from pathlib import Path

from provider import ET, ROOT, folder, metadata, quotes, session_date

MULTIPLIER = 100


def legs_for_band(low: float, high: float, width: float, step: float = 5) -> list[dict]:
    if not (0 < low < high and width > 0 and step > 0):
        raise ValueError("区间、翼宽和行权价步长必须有效")
    put = math.floor(low / step) * step
    call = math.ceil(high / step) * step
    return [
        {"strike": put - width, "right": "put", "qty": 1},
        {"strike": put, "right": "put", "qty": -1},
        {"strike": call, "right": "call", "qty": -1},
        {"strike": call + width, "right": "call", "qty": 1},
    ]


def intrinsic(spot: float, strike: float, right: str) -> float:
    return max(0, spot - strike) if right == "call" else max(0, strike - spot)


def quote_valid(q: dict | None, side: str, qty: int = 1) -> bool:
    if not q:
        return False
    try:
        bid, ask = float(q["bid"]), float(q["ask"])
        return (math.isfinite(bid) and math.isfinite(ask) and 0 <= bid <= ask
                and float(q[side]) > 0 and int(q[f"{side}_size"]) >= abs(qty))
    except (ValueError, TypeError, KeyError):
        return False


def open_cost(legs: list[dict], chain: dict, pricing: str) -> float | None:
    total = 0.0
    for leg in legs:
        q = chain.get((leg["strike"], leg["right"]))
        side = "ask" if leg["qty"] > 0 else "bid"
        if not quote_valid(q, side, leg["qty"]):
            return None
        price = float(q[side]) if pricing == "natural" else (float(q["bid"]) + float(q["ask"])) / 2
        total += leg["qty"] * price
    return total


def settlement_pnl(legs: list[dict], debit: float, spot: float, fee: float) -> float:
    value = sum(leg["qty"] * intrinsic(spot, leg["strike"], leg["right"]) for leg in legs)
    return (value - debit) * MULTIPLIER - sum(abs(leg["qty"]) for leg in legs) * fee


def liquidation_value(legs: list[dict], chain: dict) -> float | None:
    total = 0.0
    for leg in legs:
        q = chain.get((leg["strike"], leg["right"]))
        side = "bid" if leg["qty"] > 0 else "ask"
        if not quote_valid(q, side, leg["qty"]):
            # A long wing with zero bid is valued at zero, not assumed sold.
            if side == "bid" and q and q.get("bid") == 0 and q.get("ask", -1) >= 0:
                continue
            return None
        total += leg["qty"] * float(q[side])
    return total


def index_rows(rows: list[dict], day: str) -> dict:
    result: dict = {}
    for q in rows:
        ts = q["timestamp"]
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts)
        if ts.tzinfo:
            ts = ts.astimezone(ET).replace(tzinfo=None)
        if ts.date().isoformat() != day or q["symbol"] != "SPXW" or str(q["expiration"])[:10] != day:
            raise ValueError("行情日期、标的或到期日与复盘不一致")
        # Do not round forward or use a later quote to fill an earlier timestamp.
        stamp = ts.strftime("%H:%M:%S")
        right = {"C": "call", "P": "put"}.get(str(q["right"]).upper(), str(q["right"]).lower())
        key = (float(q["strike"]), right)
        chain = result.setdefault(stamp, {})
        if key in chain:
            raise ValueError(f"同一采样时刻重复合约: {stamp} {key}")
        chain[key] = q
    return result


def run_scenarios(config: dict, rows: list[dict]) -> dict:
    chains = index_rows(rows, config["date"])
    spot, fee = float(config["settlement_price"]), float(config["fee_per_contract"])
    if not math.isfinite(spot) or spot <= 0 or not math.isfinite(fee) or fee < 0:
        raise ValueError("结算点位或费用无效")
    results = []
    for band, bounds in config["bands"].items():
        for width in config["wing_widths"]:
            legs = legs_for_band(*bounds, width, config["strike_step"])
            for entry in config["entry_times"]:
                entry_stamp = time.fromisoformat(entry).strftime("%H:%M:%S")
                for pricing in ("natural", "mid"):
                    record = {"band": band, "width": width, "entry_time_et": entry,
                              "pricing": pricing, "legs": legs, "status": "skipped"}
                    debit = open_cost(legs, chains.get(entry_stamp, {}), pricing)
                    if debit is None:
                        record["reason"] = "入场时刻四腿报价/交易侧挂单量不完整或无效；不使用未来报价补齐"
                        results.append(record)
                        continue
                    record["entry_quotes"] = [
                        {**leg, "time_et": entry_stamp,
                         **{key: chains[entry_stamp][(leg["strike"], leg["right"])][key]
                            for key in ("bid", "ask", "bid_size", "ask_size")}}
                        for leg in legs
                    ]
                    credit = -debit
                    record["entry_credit_usd"] = round(credit * MULTIPLIER, 4)
                    if credit <= 0 or credit >= width:
                        record["reason"] = "无正净权利金，或报价违反价差上限"
                        results.append(record)
                        continue
                    if credit * MULTIPLIER <= 4 * fee:
                        record["reason"] = "最大毛利润不足以覆盖假设开仓费用"
                        results.append(record)
                        continue
                    pnl = settlement_pnl(legs, debit, spot, fee)
                    max_loss = (width - credit) * MULTIPLIER + 4 * fee
                    curve, missing = [], 0
                    cursor = datetime.fromisoformat(f"{config['date']}T{entry_stamp}")
                    while cursor.time() < time(16, 0):
                        stamp = cursor.strftime("%H:%M:%S")
                        chain = chains.get(stamp, {})
                        cursor += timedelta(minutes=1)
                        value = liquidation_value(legs, chain)
                        if value is None:
                            missing += 1
                            continue
                        # Includes an estimated exit fee; zero-bid long wings use a zero liquidation value.
                        mark = (value - debit) * MULTIPLIER - 8 * fee
                        curve.append({"time_et": stamp, "liquidation_pnl_usd": round(mark, 4)})
                    peak, drawdown = 0.0, 0.0
                    for point in curve:
                        value = point["liquidation_pnl_usd"]
                        peak = max(peak, value)
                        drawdown = max(drawdown, peak - value)
                    record.update({
                        "status": "priced", "net_settlement_pnl_usd": round(pnl, 4),
                        "max_profit_net_usd": round(credit * MULTIPLIER - 4 * fee, 4),
                        "max_loss_net_usd": round(max_loss, 4),
                        "return_on_max_loss_pct": round(pnl / max_loss * 100, 4),
                        "gross_breakevens": [legs[1]["strike"] - credit, legs[2]["strike"] + credit],
                        "fee_sensitivity_pnl": {str(f): round(settlement_pnl(legs, debit, spot, f), 4)
                                                for f in (0, 0.65, 1.5, 2.5)},
                        "worst_sampled_liquidation_pnl_usd": min((v["liquidation_pnl_usd"] for v in curve), default=None),
                        "sampled_peak_to_trough_usd": round(drawdown, 4) if curve else None,
                        "curve_valid_minutes": len(curve), "curve_invalid_minutes": missing,
                        "curve": curve,
                    })
                    results.append(record)
    return {"forecast": config, "scenarios": results}


def markdown(report: dict) -> str:
    config = report["forecast"]
    data = report["data"]
    lines = [f"# SPXW 铁秃鹰条件复盘：{config['date']}", "",
             "## 行情数据", "",
             f"ThetaData 实际历史报价：{data['rows']:,} 行、{data['quoted_contracts']} 个当日到期合约，一分钟采样。",
             f"时间范围：{data['first_timestamp']} 至 {data['last_timestamp']}。",
             "数据下载清单、文件校验值见同目录 manifest.json；所有结果为报价假设下的计算，不是实际成交。", "",
             "## 预测与规则", "",
             f"预测来源：[Balder SPX]({config['source_url']})；读取日期 {config['retrieved_on']}。",
             f"68% 区间 {config['bands'].get('68')}；95% 区间 {config['bands'].get('95')}。",
             config["publication_note"], "",
             "- 卖出看跌行权价向下取整、卖出看涨行权价向上取整到 5 点；两侧买入等宽保护翼。",
             f"- 预先固定入场时刻 {config['entry_times']}（美东），翼宽 {config['wing_widths']} 点；逐项列出，不事后择优。",
             "- 一组四张合约，持有到当日 PM 到期，不止损、不调整、不加仓。",
             "- natural：卖单按 bid、买单按 ask；mid：中间价假设，成交未验证。",
             f"- 每张开仓费用假设 ${config['fee_per_contract']:.2f}；到期净损益扣四张开仓费。",
             f"- 到期点位 {config['settlement_price']}；{config['settlement_note']} [收盘来源]({config['settlement_source_url']})", "",
             "## 按买卖价开仓的结果（每组，美元）", "",
             "| 区间 | 入场 ET | 翼宽 | 收权利金 | 到期净损益 | 最大亏损含开仓费 | 最差采样平仓损益 | 状态 |",
             "|---|---|---:|---:|---:|---:|---:|---|"]
    for row in report["scenarios"]:
        if row["pricing"] != "natural":
            continue
        base = f"| {row['band']}% | {row['entry_time_et']} | {row['width']} |"
        if row["status"] == "priced":
            worst = row["worst_sampled_liquidation_pnl_usd"]
            lines.append(base + f" {row['entry_credit_usd']:.2f} | {row['net_settlement_pnl_usd']:.2f} | {row['max_loss_net_usd']:.2f} | {worst if worst is not None else '无有效采样'} | 可计价 |")
        else:
            lines.append(base + f" {row.get('entry_credit_usd', '—')} | — | — | — | {row['reason']} |")
    lines += ["", "## 解释边界", "",
              "- 这是一个交易日的条件复盘，不是对长期胜率或月收益的验证。",
              "- 区间是收盘分布；不能把收盘落在区间内当成盘中从不越界。",
              "- 入场使用准确采样时刻的四腿报价；不存在的合约、无买价或缺少交易侧挂单量会跳过。",
              "- 分钟快照无法验证分钟内触价、报价原始年龄或四腿同时成交；盘口估值不是实际成交记录。",
              "- 盘中损益使用可见买卖价估算平仓，并计入额外四张平仓费；零买价的多头翼按零价值计，不假设卖出成功。",
              "- 盘中浮亏和峰谷回撤只覆盖有效分钟采样；缺失时刻和分钟内波动可能更差。",
              "- 最大亏损指完整组合持有到期的数学上限，未假设分腿交易或中途拆除保护。",
              "- 完整逐腿、mid 对照、费用敏感性和分钟估值曲线见同目录 replay.json。", ""]
    return "\n".join(lines)


def replay(config_path: Path) -> dict:
    config = json.loads(config_path.read_text())
    day = session_date(config["date"])
    report = run_scenarios(config, quotes(day).to_dicts())
    report["data"] = metadata(day)
    out = folder(day)
    (out / "replay.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (out / "replay.md").write_text(markdown(report))
    return report
