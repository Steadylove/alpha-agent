"""Own SPX closing-range baselines with explicit information cutoffs."""
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timezone
import hashlib
import json
import math
from pathlib import Path
import urllib.request

import polars as pl

from provider import ROOT, ET, client
from replay import index_rows
from range_model import (black_straddle, calibrated_prediction, calibration_score,
                         interval_metrics, option_prediction, preopen_prediction)
from method_lock import verify_method

OUT = ROOT/'data/thetadata/self-forecast-v1'
PLAN = ROOT/'research/options/self-forecast-v1.json'
NAMES = {'preopen_history':'盘前历史波动基准', 'option_implied':'10:00期权隐含基准',
         'option_calibrated':'10:00历史误差校准', 'blogger':'博主公开历史区间'}


def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')


def plan():
    return json.loads(PLAN.read_text())


def register():
    verify_method()
    registration = OUT/'registered-plan.json'
    digest = hashlib.sha256(PLAN.read_bytes()).hexdigest()
    if registration.exists():
        if json.loads(registration.read_text())['sha256'] != digest:
            raise ValueError('Model specification changed; use a new version')
    else:
        write_json(registration,{'registered_at':datetime.now(timezone.utc).isoformat(),'sha256':digest,
            'plan':plan(),'note':'Before this model evaluation, after earlier exploration of the same historical period.'})


def fetch_daily():
    today = datetime.now(ET).date()
    start = date(today.year-2,1,1)
    p1 = int(datetime.combine(start,time(),timezone.utc).timestamp())
    p2 = int(datetime.combine(today,time(),timezone.utc).timestamp())
    url=f'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1={p1}&period2={p2}&interval=1d'
    raw=urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=30).read()
    item=json.loads(raw)['chart']['result'][0]
    quotes=item['indicators']['quote'][0]
    rows=[{'date':datetime.fromtimestamp(ts,ET).date().isoformat(),'close':round(quotes['close'][i],2)}
          for i,ts in enumerate(item['timestamp']) if quotes['close'][i] is not None
          and datetime.fromtimestamp(ts,ET).date()<today]
    if not rows:
        raise ValueError('No complete historical daily closes returned')
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'spx-daily-raw.json').write_bytes(raw)
    write_json(OUT/'spx-daily.json',{'source_url':url,'retrieved_at':datetime.now(timezone.utc).isoformat(),
        'raw_sha256':hashlib.sha256(raw).hexdigest(),'rows':rows})
    print(f"Daily closes: {len(rows)}; latest {rows[-1]['date']}")


def daily_data():
    data=json.loads((OUT/'spx-daily.json').read_text())
    rows=data['rows']
    if rows != sorted(rows,key=lambda r:r['date']) or len({r['date'] for r in rows}) != len(rows):
        raise ValueError('Daily prices must be unique and chronological')
    if any(not math.isfinite(r['close']) or r['close']<=0 for r in rows):
        raise ValueError('Invalid daily close')
    return data


def snapshot(target_date, allow_download=False):
    cfg=plan()
    stamp=datetime.combine(date.fromisoformat(target_date),time.fromisoformat(cfg['option_snapshot_et']),ET)
    if stamp>datetime.now(ET):
        raise ValueError('尚未到预测时点，不能用昨天报价替代今天 10:00 报价')
    folder=ROOT/'data/thetadata'/target_date
    full=folder/'entry-snapshots-1000-1030-1100.parquet'
    own=folder/'forecast-snapshot-1000.parquet'
    if full.exists():
        path=full
    elif own.exists():
        path=own
    elif allow_download:
        d=date.fromisoformat(target_date)
        frame=client().option_history_quote(symbol='SPXW',expiration=d,date=d,strike='*',right='both',
            interval='1m',start_time=cfg['option_snapshot_et'],end_time=cfg['option_snapshot_et'])
        folder.mkdir(parents=True,exist_ok=True)
        frame.write_parquet(own)
        path=own
    else:
        raise FileNotFoundError(f'No snapshot for {target_date}; use forecast --download')
    chains=index_rows(pl.read_parquet(path).to_dicts(),target_date)
    if cfg['option_snapshot_et'] not in chains:
        raise ValueError('Exact input timestamp missing')
    return chains[cfg['option_snapshot_et']],{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def evaluate():
    register()
    cfg=plan()
    daily=daily_data()
    closes={r['date']:r['close'] for r in daily['rows']}
    ledger=json.loads((ROOT/'research/options/balder-ledger-2026-09-16.json').read_text())
    predictions=[]
    scores=[]
    failures=[]
    for record in ledger['sessions']:
        day=record['date']
        if closes[day]!=record['settlement_price']:
            raise ValueError('Independent close disagrees with original ledger')
        predictions.append(preopen_prediction(day,daily['rows'],cfg))
        predictions.append({'model':'blogger','target_date':day,'bands':record['bands']})
        try:
            chain,source=snapshot(day)
            implied=option_prediction(day,chain,cfg)
            implied['source']=source
            predictions.append(implied)
            calibrated=calibrated_prediction(implied,scores,cfg)
            if calibrated:
                predictions.append(calibrated)
            # Append today's outcome ONLY AFTER every prediction for today is fixed.
            scores.append({'date':day,'score':calibration_score(implied,closes[day])})
        except (ValueError,FileNotFoundError) as exc:
            failures.append({'date':day,'error':str(exc)})
    shared=sorted(set.intersection(*[{p['target_date'] for p in predictions if p['model']==m} for m in NAMES]))
    summaries=[]
    for scope in ('available','common_dates'):
        for model in NAMES:
            subset=[p for p in predictions if p['model']==model and (scope=='available' or p['target_date'] in shared)]
            for coverage in cfg['coverage_levels']:
                summaries.append({'scope':scope,'model':model,'nominal_coverage':coverage,
                                  **interval_metrics(subset,closes,coverage)})
    result={'created_at':datetime.now(timezone.utc).isoformat(),'method':verify_method(),'plan':cfg,
        'plan_sha256':hashlib.sha256(PLAN.read_bytes()).hexdigest(),'daily_source':{k:v for k,v in daily.items() if k!='rows'},
        'implementation_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'predictions':predictions,'scores':scores,'closes':{r['date']:closes[r['date']] for r in ledger['sessions']},
        'summaries':summaries,'common_dates':shared,'failures':failures,
        'interpretation':'Retrospective reconstruction with chronological calibration; model choice was made after inspecting this period. Not an untouched holdout.'}
    write_json(OUT/'evaluation.json',result)
    report(result)
    print(json.dumps({'days':len(ledger['sessions']),'common_dates':len(shared),'failures':failures,'summaries':summaries},ensure_ascii=False,indent=2))
    return result


def issue(target_date, mode, allow_download=False):
    register()
    cfg=plan()
    day=date.fromisoformat(target_date)
    if day.weekday()>4:
        raise ValueError('Weekend is not a regular SPX session')
    daily=daily_data()
    outputs=[]
    if mode=='preopen':
        p=preopen_prediction(target_date,daily['rows'],cfg)
        if (day-date.fromisoformat(p['input_end_date'])).days>4:
            raise ValueError('Daily cache is stale; refresh before issuing a forecast')
        outputs.append(p)
    else:
        chain,source=snapshot(target_date,allow_download)
        p=option_prediction(target_date,chain,cfg)
        p['source']=source
        outputs.append(p)
        previous=json.loads((OUT/'evaluation.json').read_text())
        calibrated=calibrated_prediction(p,previous['scores'],cfg)
        if calibrated:
            outputs.append(calibrated)
    now=datetime.now(timezone.utc)
    et=now.astimezone(ET)
    prospective=et.date()<=day and (mode!='preopen' or et.date()<day or et.time()<time(9,30))
    if mode!='preopen':
        prospective=et.date()==day and et.time()<time(16)
    result={'recorded_at':now.isoformat(),'method':verify_method(),'target_date':target_date,'mode':mode,
        'timing_status':'locally_recorded_before_outcome' if prospective else 'historical_or_late_reconstruction',
        'calendar_note':'Historical dates are observed sessions; caller must confirm exchange holidays for new dates. No automatic scheduling.',
        'plan_sha256':hashlib.sha256(PLAN.read_bytes()).hexdigest(),
        'daily_source_sha256':hashlib.sha256((OUT/'spx-daily.json').read_bytes()).hexdigest(),
        'predictions':outputs,'caveat':'Closing-price research intervals, not intraday high/low bounds or guaranteed physical probabilities.'}
    result['implementation_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    source_file=OUT/'sources'/f"daily-{result['daily_source_sha256']}.json"
    source_file.parent.mkdir(parents=True,exist_ok=True)
    if not source_file.exists():
        with source_file.open('xb') as f:
            f.write((OUT/'spx-daily.json').read_bytes())
    result['archived_daily_source']=str(source_file)
    payload=json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+'\n'
    folder=OUT/'issued'/target_date
    folder.mkdir(parents=True,exist_ok=True)
    file=folder/f'{mode}-{now:%Y%m%dT%H%M%S%fZ}.json'
    with file.open('x') as f:
        f.write(payload)
    print(payload)
    print('Saved:',file)
    return result


def report(result):
    lines=['# 自建 SPX 每日收盘区间：v1', '',
        '**可以独立生成每日区间；本版是可复现的基准与滚动校准研究，不是博主私有动力方程的复刻。**', '',
        '## 首轮结果怎样理解', '',
        '- 简单盘前日线模型的 95% 区间命中 37/38 天，平均全宽约 250 点；博主也是 37/38 天、平均全宽约 244 点。因此，高覆盖率本身并不能证明复杂动力学有增量价值。',
        '- 对相同的 36 个有合格期权报价的日期，期权隐含 95% 区间与博主均命中 35 天；前者平均全宽约 131 点，后者约 251 点。但博主原始发布时间未知，不能据此宣称同一信息条件下胜出。',
        '- 68% 区间在这 36 天里，期权隐含模型命中 28 天、博主命中 33 天；平均全宽分别约 66 和 134 点，体现覆盖率与宽度的取舍。',
        '- 历史误差校准只有 16 个评估日；95% 区间虽然全部覆盖，但比未校准期权基准更宽，尚未证明校准有稳定增益。没有继续调参去追求更漂亮的历史成绩。', '',
        '## 三个模型', '',
        '1. 盘前历史波动基准：取预测日前最后 60 个完整日收益，估计对数收益均值和标准差，以前收盘为锚点，给出正态假设下的 68% / 95% 收盘区间。',
        '2. 10:00 期权隐含基准：只取当天 10:00 SPXW 同日到期期权链，从最多 7 对平值附近 Call/Put 的中间价通过平价关系估计远期中心；反解 Black 模型总波动率，给出到期对数正态区间。六小时折现因子近似取 1。',
        '3. 10:00 历史误差校准：至少积累此前 20 天、最多 60 天标准化绝对预测误差，使用 ceil((n+1)×覆盖率) 阶统计量调整区间宽度。今天实际收盘只在今天预测完成后加入训练。', '',
        '期权隐含分布是定价分布，不能直接当作实际胜率；平值波动率模型未反映偏斜和跳跃。误差校准借鉴分位数/共形思路，但金融时间序列不满足一般独立可交换假设，因此不宣称严格的 68% / 95% 覆盖保证。', '',
        '## 数据够做什么', '',
        '- 已有 38 天完整的 10:00 期权链；268 个合约的盘中路径服务于交易退出研究，不替代完整期权链。',
        '- 日线数据来自独立获取的 Yahoo ^GSPC；与博主全部 38 个收盘记录核对一致。输入按目标日期严格截断。',
        '- 尚未纳入 OI、真实做市商净持仓、Gamma 方向、盘中现货路径、经济事件变量；没有任意设定一个回归系数来制造收敛。',
        '- 开盘后的期权模型比盘前模型多看到隔夜和开盘半小时信息，不能把两者差异全归为模型能力。博主原始发布时间也未独立核验。', '',
        '报价质量检查未通过的日期：'+('；'.join(f"{x['date']}：{x['error']}" for x in result['failures']) or '无')+'。未输出这些日期的期权预测，也没有把缺失算成命中；盘前模型仍保留。', '',
        '## 历史对照', '',
        '“可用日期”展示各模型样本；“共同日期”只比较全部模型都有输出的日期。区间评分＝宽度＋2/(1−目标覆盖率)×越界距离，越低越好。它同时惩罚过宽和漏报，不能只追求覆盖率。', '',
        '| 样本 | 模型 | 目标覆盖 | 天数 | 命中 | 实际覆盖 | 平均全宽（点） | 平均全宽% | 区间评分 |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for s in result['summaries']:
        if not s['sessions']:
            continue
        lines.append(f"| {'可用日期' if s['scope']=='available' else '共同日期'} | {NAMES[s['model']]} | {s['nominal_coverage']:.0%} | {s['sessions']} | {s['covered']} | {s['coverage']:.1%} | {s['mean_width_points']:.1f} | {s['mean_width_pct']:.2f}% | {s['mean_interval_score']:.1f} |")
    lines+=['', '## 每日输出与运行', '',
        '```bash', 'npm run theta:forecast -- daily', 'npm run theta:forecast -- evaluate',
        'npm run theta:forecast -- issue --date 2026-09-16 --mode preopen',
        '# 美东 10:00 数据实际可用后运行；尚未到时间会拒绝生成',
        'npm run theta:forecast -- issue --date 2026-09-16 --mode 10am --download', '```', '',
        '- issued/ 目录用实际生成时间保存独立文件；历史重建与结果发生前生成的记录分开标注。本地时间戳/哈希不是第三方防篡改证明。',
        '- 没有设置自动运行、通知或下单。新日期需调用方确认交易所假期及当日收盘时刻；当前样本都是常规交易日。',
        '- 区间针对最终收盘，不保证盘中不越界；不能据此直接给止损触发概率。',
        '- 38 天已经被查看过，时间顺序校准能避免将未来标签送入模型，但不能使它重新变成独立样本外验证。校准模型目前只有少量可评估日期。',
        '- 本轮尚未把自建区间接入交易盈亏对照；更高覆盖或更低区间评分不等于成本后盈利。', '',
        '## 文件与方法来源', '',
        '- evaluation.json：每日期权输入、输出区间、校准训练日期、独立收盘及全部指标。',
        '- registered-plan.json、spx-daily-raw.json、spx-daily.json：模型登记与日线源文件及哈希。',
        '- audit.json：无前视测试、报价拟合及指标核对。',
        '- [Cboe 平价关系与隐含信息](https://www.cboe.com/solutions/options-analytics/trading-indicators/)',
        '- [美联储：风险中性与实际概率](https://www.federalreserve.gov/econres/feds/the-pricing-kernel-in-options.htm)',
        '- [Angelopoulos 与 Bates：共形预测及适用条件](https://arxiv.org/abs/2107.07511)', '']
    (OUT/'report.md').write_text('\n'.join(lines))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['daily','evaluate','issue','method'])
    parser.add_argument('--date')
    parser.add_argument('--mode',choices=['preopen','10am'],default='10am')
    parser.add_argument('--download',action='store_true')
    args=parser.parse_args()
    if args.action=='method':
        print(json.dumps(verify_method(),ensure_ascii=False,indent=2))
    elif args.action=='daily':
        fetch_daily()
    elif args.action=='evaluate':
        evaluate()
    else:
        if not args.date:
            parser.error('--date is required for issue')
        issue(args.date,args.mode,args.download)
