"""All published Balder sessions: fixed-rule 0DTE butterfly/iron-condor replay."""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import threading

import polars as pl

from provider import ROOT, client, safe_error
from replay import index_rows, legs_for_band, open_cost, settlement_pnl

OUT = ROOT / 'data/thetadata/balder-multiday'
LEDGER = ROOT / 'research/options/balder-ledger-2026-09-16.json'
PLAN = ROOT / 'research/options/balder-multiday-rules.json'
TIMES = ['10:00', '10:30', '11:00']
_local = threading.local()


def prepare():
    source = json.loads((ROOT/'data/thetadata/balder-source/ledger-tables.json').read_text())
    if len(source['tables']) != 1:
        raise ValueError('Expected exactly one published forecast ledger')
    records = []
    for row in source['tables'][0][1:]:
        day, b68, b95, close, move, result = row
        bands = {name: [float(x.replace(',', '')) for x in re.findall(r'[\d,]+(?:\.\d+)?', value)]
                 for name, value in [('68', b68), ('95', b95)]}
        if any(len(v) != 2 or not 0 < v[0] < v[1] for v in bands.values()):
            raise ValueError(f'Invalid forecast range: {row}')
        records.append({'date': date.fromisoformat(day).isoformat(), 'bands': bands,
                        'settlement_price': float(close.replace(',', '')), 'published_result': result})
    records.sort(key=lambda v: v['date'])
    if len({r['date'] for r in records}) != len(records):
        raise ValueError('Duplicate forecast dates')
    ledger = {**{k: source[k] for k in ['source_url', 'retrieved_at', 'sha256']},
              'publication_note': 'Historical ledger retrieved after the fact; original publication timestamps unverified.',
              'settlement_note': 'Closing levels from blogger ledger; 2026-09-14 and 2026-09-15 independently checked against AP News; other dates not independently verified.',
              'sessions': records}
    independent_path = ROOT/'data/thetadata/balder-source/spx-closes-independent.json'
    if independent_path.exists():
        independent = json.loads(independent_path.read_text())
        closes = {r['date']:r['close'] for r in independent['rows']}
        if any(closes.get(r['date']) != r['settlement_price'] for r in records):
            raise ValueError('Independent closing prices differ or are missing; resolve before replay')
        ledger['settlement_note'] = f"全部 {len(records)} 个收盘点位与独立获取的 Yahoo ^GSPC 日线一致（核对至 0.01 点）；未取得券商结算记录。"
        ledger['settlement_verification'] = {'source_url':independent['source_url'],'matched_sessions':len(records),
            'sha256':hashlib.sha256(independent_path.read_bytes()).hexdigest()}
    LEDGER.write_text(json.dumps(ledger, ensure_ascii=False, indent=2)+'\n')
    rules = {'fixed_at': datetime.now(timezone.utc).isoformat(), 'entry_times_et': TIMES,
             'expiry': 'same-day SPXW PM', 'exit': 'hold to expiry, no adjustment or stop',
             'band_labels': ['68', '95'], 'butterfly_widths': ['band', 35, 50, 100],
             'butterfly_center': 'band midpoint rounded to nearest 5; half ties upward',
             'band_butterfly_width': 'smallest 5-point symmetric wing covering both band endpoints',
             'condor_widths': [5, 10, 20, 50], 'fee_per_contract': 1.5,
             'pricing': ['natural', 'mid'], 'size': 'one group per day per independent parameter series',
             'filter_comparison': 'condor only: each side credit must exceed its two-contract opening fees',
             'baseline': '10:00; natural; band-width long-call butterfly or 10-point iron condor',
             'notes': 'No choosing the best entry/width for each date after observing the close. Days/variants are not independent samples.'}
    if not PLAN.exists():
        PLAN.write_text(json.dumps(rules, ensure_ascii=False, indent=2)+'\n')
    OUT.mkdir(parents=True, exist_ok=True)
    return ledger


def validate_snapshot(frame, day):
    index = index_rows(frame.to_dicts(), day)
    if set(index) != {'10:00:00', '10:30:00', '11:00:00'}:
        raise ValueError(f'{day}: entry timestamps incomplete: {list(index)}')
    return index


def fetch_snapshot(day, authorized):
    folder = ROOT/'data/thetadata'/day
    folder.mkdir(parents=True, exist_ok=True)
    path = folder/'entry-snapshots-1000-1030-1100.parquet'
    source = 'ThetaData option_history_quote 30m sampling'
    if path.exists():
        frame = pl.read_parquet(path)
    elif (folder/'quotes.parquet').exists():
        frame = pl.read_parquet(folder/'quotes.parquet').filter(
            pl.col('timestamp').dt.strftime('%H:%M:%S').is_in(['10:00:00','10:30:00','11:00:00']))
        source = 'existing full-day ThetaData 1m cache, exact entry timestamps'
    else:
        if not hasattr(_local, 'theta'):
            from thetadata import ThetaClient
            _local.theta = ThetaClient(existing_authorized_client=authorized)
        d = date.fromisoformat(day)
        frame = _local.theta.option_history_quote(symbol='SPXW', expiration=d, date=d,
                strike='*', right='both', interval='30m', start_time='10:00:00', end_time='11:00:00')
    validate_snapshot(frame, day)
    frame = frame.sort(['timestamp','strike','right'])
    tmp = path.with_suffix('.tmp')
    frame.write_parquet(tmp)
    tmp.replace(path)
    manifest = {'date': day, 'source': source, 'rows': frame.height,
                'contracts': frame.select('strike','right').unique().height,
                'timestamps_et': [str(t) for t in frame['timestamp'].unique().sort().to_list()],
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'file': str(path)}
    (folder/'entry-snapshots-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return manifest


def download_all(ledger):
    authorized = client()
    if authorized.options_subscription == 0:
        raise PermissionError('Options paid access required')
    completed, errors = {}, {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(fetch_snapshot, row['date'], authorized): row['date'] for row in ledger['sessions']}
        for future in as_completed(futures):
            day = futures[future]
            try:
                completed[day] = future.result()
                print(f"[{len(completed)}/{len(futures)}] {day}: {completed[day]['rows']} rows", flush=True)
            except Exception as exc:
                errors[day] = safe_error(exc)
                print(f'ERROR {day}: {errors[day]}', flush=True)
            (OUT/'download-status.json').write_text(json.dumps({'completed': completed,'errors':errors},indent=2))
    if errors:
        raise RuntimeError(f'{len(errors)} sessions unavailable; see download-status.json; cached days retained')
    return completed


def butterfly_legs(low, high, width_mode):
    center = math.floor(((low+high)/2)/5+.5)*5
    width = math.ceil(max(center-low, high-center)/5)*5 if width_mode == 'band' else width_mode
    return [{'strike':center-width,'right':'call','qty':1},
            {'strike':center,'right':'call','qty':-2},
            {'strike':center+width,'right':'call','qty':1}], width


def price_trade(record, strategy, band, width_mode, entry, pricing, chain):
    low, high = record['bands'][band]
    if strategy == 'butterfly':
        legs, width = butterfly_legs(low, high, width_mode)
    else:
        width = width_mode
        legs = legs_for_band(low, high, width)
    row = {'date':record['date'],'strategy':strategy,'band':band,'width_mode':str(width_mode),
           'width':width,'entry_time_et':entry,'pricing':pricing,'legs':legs,'status':'skipped'}
    debit = open_cost(legs, chain, pricing)
    if debit is None:
        row['reason'] = 'missing_invalid_quote_or_size'
        return row
    row['entry_quotes'] = [{**leg, **{k: chain[(leg['strike'],leg['right'])][k]
                                   for k in ['bid','ask','bid_size','ask_size']}} for leg in legs]
    fee = 6.0
    if strategy == 'butterfly':
        if not 0 < debit < width:
            row['reason'] = 'invalid_butterfly_debit'
            return row
        max_profit = (width-debit)*100-fee
        max_loss = debit*100+fee
        capital = max_loss
        center = legs[1]['strike']
        breakevens = [legs[0]['strike']+debit+fee/100,legs[2]['strike']-debit-fee/100]
    else:
        if not 0 < -debit < width:
            row['reason'] = 'nonpositive_credit_or_exceeds_width'
            return row
        max_profit = -debit*100-fee
        max_loss = (width+debit)*100+fee
        capital = width*100+fee
        breakevens = [legs[1]['strike']+debit+fee/100,legs[2]['strike']-debit-fee/100]
        side_credits = [-open_cost(legs[i:i+2],chain,pricing)*100 for i in (0,2)]
        row['side_credits_usd'] = side_credits
        row['both_sides_cover_fees'] = all(x > 3+1e-8 for x in side_credits)
    if max_profit <= 1e-8:
        row['reason'] = 'maximum_profit_does_not_cover_fees'
        return row
    pnl = settlement_pnl(legs, debit, record['settlement_price'], 1.5)
    if not -max_loss-1e-5 <= pnl <= max_profit+1e-5:
        raise ValueError('Payoff outside theoretical bounds')
    row.update({'status':'priced','net_pnl_usd':round(pnl,4), 'debit_usd':round(debit*100,4),
                'max_loss_usd':round(max_loss,4),'max_profit_usd':round(max_profit,4),
                'capital_reference_usd':round(capital,4), 'net_breakevens':breakevens,
                'fees_usd':fee,'settlement_price':record['settlement_price'],
                'fee_sensitivity':{str(f):round(settlement_pnl(legs,debit,record['settlement_price'],f),4)
                                   for f in [0,.65,1.5,2.5]}})
    return row


def summarize(rows, filtered=False):
    rows = sorted(rows, key=lambda r:r['date'])
    priced = [r for r in rows if r['status']=='priced' and (not filtered or r.get('both_sides_cover_fees',True))]
    pnl = [r['net_pnl_usd'] for r in priced]
    wins = [x for x in pnl if x > 1e-8]
    losses = [x for x in pnl if x < -1e-8]
    selected = {r['date']:r for r in priced}
    equity=peak=mdd=0.0
    starting_capital_needed = 0.0
    curve=[]
    losing_streak=max_streak=0
    for row in rows:
        trade = selected.get(row['date'])
        value = trade['net_pnl_usd'] if trade else 0
        if trade:
            starting_capital_needed = max(starting_capital_needed, trade['capital_reference_usd']-equity)
        equity += value
        peak = max(peak,equity)
        mdd = max(mdd,peak-equity)
        if trade:
            losing_streak = losing_streak+1 if value < -1e-8 else 0
            max_streak = max(max_streak,losing_streak)
        curve.append({'date':row['date'],'pnl_usd':round(value,4),'cumulative_pnl_usd':round(equity,4),'traded':bool(trade)})
    first = rows[0]
    return {**{k:first[k] for k in ['strategy','band','width_mode','entry_time_et','pricing']},
            'filter_both_condor_sides':filtered,'sessions':len(rows),'trades':len(priced),'skips':len(rows)-len(priced),
            'wins':len(wins),'losses':len(losses),'breakeven':len(priced)-len(wins)-len(losses),
            'win_rate':len(wins)/len(priced) if priced else None,'net_pnl_usd':round(sum(pnl),4),
            'mean_trade_pnl_usd':round(sum(pnl)/len(pnl),4) if pnl else None,
            'mean_win_usd':round(sum(wins)/len(wins),4) if wins else None,
            'mean_loss_usd':round(sum(losses)/len(losses),4) if losses else None,
            'best_day_usd':max(pnl,default=None),'worst_day_usd':min(pnl,default=None),
            'daily_equity_max_drawdown_usd':round(mdd,4),'max_consecutive_losing_trades':max_streak,
            'max_single_trade_loss_limit_usd':max((r['max_loss_usd'] for r in priced),default=None),
            'max_capital_reference_usd':max((r['capital_reference_usd'] for r in priced),default=None),
            'starting_capital_path_estimate_usd':round(starting_capital_needed,4),
            'total_fees_usd':6*len(priced),'curve':curve}


def run(ledger):
    details = []
    for record in ledger['sessions']:
        path = ROOT/'data/thetadata'/record['date']/'entry-snapshots-1000-1030-1100.parquet'
        chains = validate_snapshot(pl.read_parquet(path),record['date'])
        for strategy,widths in [('condor',[5,10,20,50]),('butterfly',['band',35,50,100])]:
            for band in ['68','95']:
                for width in widths:
                    for entry in TIMES:
                        for pricing in ['natural','mid']:
                            details.append(price_trade(record,strategy,band,width,entry,pricing,chains[entry+':00']))
    groups = defaultdict(list)
    for row in details:
        groups[tuple(row[k] for k in ['strategy','band','width_mode','entry_time_et','pricing'])].append(row)
    summaries = [summarize(rows) for rows in groups.values()]
    summaries += [summarize(rows,True) for key,rows in groups.items() if key[0]=='condor']
    result = {'ledger':ledger,'rules':json.loads(PLAN.read_text()),'summaries':summaries,'trades':details}
    (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    pl.DataFrame([{k:v for k,v in s.items() if k!='curve'} for s in summaries]).write_csv(OUT/'summary.csv')
    pl.DataFrame([{k:v for k,v in t.items() if k not in ['legs','entry_quotes','net_breakevens','side_credits_usd','fee_sensitivity']}
                  for t in details],infer_schema_length=None).write_csv(OUT/'daily-trades.csv')
    write_report(result)
    return result


def baseline(s):
    return s['pricing']=='natural' and s['entry_time_et']=='10:00' and not s['filter_both_condor_sides'] and (
        (s['strategy']=='condor' and s['width_mode']=='10') or (s['strategy']=='butterfly' and s['width_mode']=='band'))


def label(s):
    name = '铁秃鹰' if s['strategy']=='condor' else '买入看涨蝶式'
    return f"{name} / {s['band']}% / {s['width_mode']}"


def write_report(r):
    sessions = r['ledger']['sessions']
    main = [s for s in r['summaries'] if baseline(s)]
    lines = [f"# Balder 全部公开区间：蝶式与铁秃鹰多日复盘",'',
             f"范围：{sessions[0]['date']}–{sessions[-1]['date']}；共 {len(sessions)} 个公开预测交易日。",'',
             '## 口径', '',
             '- 使用 SPXW 当日到期；在固定入场时刻开一组，持有到 PM 到期，不止损、不调整、不加仓。每条参数序列独立计算，不把不同参数的盈亏相加。',
             '- 主表：10:00 美东，卖 bid / 买 ask；每张开仓费 $1.50。蝶式三腿共四张，铁秃鹰四腿四张，均扣 $6。',
             '- 铁秃鹰：卖出看跌向下取 5 点档、卖出看涨向上取 5 点档；主表保护翼 10 点。',
             '- 蝶式：买一低行权价 Call、卖两张区间中点 Call、买一高行权价 Call。中心取最近 5 点档；主表两翼向外覆盖区间。覆盖区间不等于整个预测区间都能盈利，净盈亏平衡范围见逐笔数据。',
             '- 固定宽度与三个时刻的全部结果均列出，不按当日收盘反选最佳交易。mid 是乐观的中间价成交假设。',
             '- 缺失/无效报价、卖方零 bid、挂单量不足、非正信用或费用后无盈利空间均跳过；不拿未来报价补齐。',
             '- 行情只采集三个入场时刻；回撤是逐日已结算累计盈亏的峰谷回撤，不是盘中最大浮亏。',
             '- 网站历史预测的事前发布时间未独立存证。结算点位核验：'+r['ledger']['settlement_note'],
             '- 不同策略的风险资金不同，美元利润不能直接当作同本金收益率；这是事后条件复盘，不是独立样本外策略验证。','',
             '## 主表：固定 10:00、每个交易日一组','',
             '| 策略 / 区间 / 翼宽 | 成交/跳过 | 胜率 | 累计净损益 | 最差一天 | 逐日最大回撤 | 最高单笔风险 | 资金基准峰值 |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for s in main:
        lines.append(f"| {label(s)} | {s['trades']}/{s['skips']} | {s['win_rate']:.1%} | ${s['net_pnl_usd']:,.2f} | ${s['worst_day_usd']:,.2f} | ${s['daily_equity_max_drawdown_usd']:,.2f} | ${s['max_single_trade_loss_limit_usd']:,.2f} | ${s['max_capital_reference_usd']:,.2f} |")
    lines += ['', '资金基准：蝶式净支出加费用；铁秃鹰翼宽×100加费用，实际券商占用须看订单预览。最高单笔风险是该期内所开仓组合的最大到期损失上限。资金基准峰值不等于撑过整段亏损所需的初始本金。', '',
              '按这段已知收益路径和上述资金基准，始终能开下一笔且不追加资金的起始现金测算：'+
              '；'.join(f"{label(s)} ${s['starting_capital_path_estimate_usd']:,.2f}" for s in main)+'。这是事后资金测算，未包括安全缓冲和券商最低资产要求。', '',
              '## 主表逐日净损益（美元）','', '| 日期 | 68% 蝶式 | 95% 蝶式 | 68% 铁秃鹰 | 95% 铁秃鹰 |', '|---|---:|---:|---:|---:|']
    for day in sessions:
        values=[]
        for strategy,band in [('butterfly','68'),('butterfly','95'),('condor','68'),('condor','95')]:
            s=next(s for s in main if s['strategy']==strategy and s['band']==band)
            v=next(v for v in s['curve'] if v['date']==day['date'])
            values.append(f"{v['pnl_usd']:,.2f}" if v['traded'] else '跳过')
        lines.append('| '+day['date']+' | '+' | '.join(values)+' |')
    lines += ['', '## 按月份拆分主表净损益', '',
              '7 月仅包含 7/23 起的记录，9 月仅到 9/15；两者不是完整月份。8 月包含全部 21 个交易日。', '',
              '| 月份 | 68% 蝶式 | 95% 蝶式 | 68% 铁秃鹰 | 95% 铁秃鹰 |', '|---|---:|---:|---:|---:|']
    for month in sorted({v['date'][:7] for v in sessions}):
        values=[]
        for strategy,band in [('butterfly','68'),('butterfly','95'),('condor','68'),('condor','95')]:
            s=next(s for s in main if s['strategy']==strategy and s['band']==band)
            values.append(f"{sum(v['pnl_usd'] for v in s['curve'] if v['date'].startswith(month)):,.2f}")
        lines.append('| '+month+' | '+' | '.join(values)+' |')
    lines += ['', '## 全部固定参数对照（卖 bid / 买 ask）','',
              '| 策略 / 区间 / 翼宽 | 入场 ET | 双侧均覆盖费用过滤 | 成交 | 跳过 | 累计净损益 | 胜率 | 逐日最大回撤 |',
              '|---|---|---|---:|---:|---:|---:|---:|']
    for s in r['summaries']:
        if s['pricing']!='natural': continue
        win=f"{s['win_rate']:.1%}" if s['win_rate'] is not None else '—'
        lines.append(f"| {label(s)} | {s['entry_time_et']} | {'是' if s['filter_both_condor_sides'] else '否'} | {s['trades']} | {s['skips']} | {s['net_pnl_usd']:,.2f} | {win} | {s['daily_equity_max_drawdown_usd']:,.2f} |")
    lines += ['', '过滤对照仅对铁秃鹰生效：开仓前看跌侧、看涨侧各自的净收入都必须超过 $3 两张合约的费用。过滤规则参考了已查看的 9/14 案例，因此其结果同样属于探索性分析。', '',
              '## 数据与复现','',
              '- results.json：全部逐腿报价、费用敏感性、参数汇总、累计损益曲线。',
              '- summary.csv：包括 natural / mid、机械规则 / 双侧费用过滤的全部参数汇总。',
              '- daily-trades.csv：每个日期及参数组合的成交/跳过状态与到期损益。',
              '- 各日期目录 entry-snapshots-manifest.json 记录原始报价条数、时间戳与 SHA256。',
              '- 预测源：https://balder-ai.com/spx；原始快照位于 ../balder-source/。',
              '- audit.json：独立 Decimal 现金流核算、汇总曲线校验、原始文件哈希与收盘价交叉核验。',
              '- cumulative-pnl.png：四条主表策略的累计盈亏曲线。','']
    (OUT/'report.md').write_text('\n'.join(lines))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['prepare','download','replay'])
    args=parser.parse_args()
    ledger=prepare() if args.command=='prepare' else json.loads(LEDGER.read_text())
    if args.command=='download': download_all(ledger)
    if args.command=='replay':
        result=run(ledger)
        print(json.dumps([{k:v for k,v in s.items() if k!='curve'} for s in result['summaries'] if baseline(s)],ensure_ascii=False,indent=2))
    if args.command=='prepare': print(f"Prepared {len(ledger['sessions'])} sessions and fixed rules")
