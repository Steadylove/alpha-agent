"""Plot predeclared exit comparisons; no selecting a best historical curve."""
import json
import os
from datetime import datetime

from intraday import OUT
os.environ.setdefault('MPLCONFIGDIR', str(OUT/'matplotlib-cache'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.ticker import StrMethodFormatter

from optimize import EXIT_NAMES


def main():
    data = json.loads((OUT/'results.json').read_text())
    plt.rcParams.update({'font.family':'sans-serif', 'font.sans-serif':['STHeiti','Arial Unicode MS','DejaVu Sans'],
                         'axes.unicode_minus':False, 'font.size':11})
    fig, axes = plt.subplots(2,1,figsize=(12,9),sharex=True,sharey=True)
    colors = {'expiry':'#626a73','time_1530':'#0b6fb3','tp50':'#18885d','tp50_sl25':'#c84c43'}
    for ax, filter_name, title in zip(axes,['baseline','both_sides'],['原入场规则：31 个交易日','双侧权利金覆盖费用：13 个交易日']):
        for exit_name in colors:
            s=next(s for s in data['summaries'] if s['band']=='68' and s['width']==10 and s['filter']==filter_name
                   and s['exit']==exit_name and s['initial_equity'] is None and s['extra_slippage_points']==0)
            x=[datetime.fromisoformat('2026-07-22')]+[datetime.fromisoformat(p['date']) for p in s['curve']]
            y=[0]+[p['cumulative_pnl_usd'] for p in s['curve']]
            ax.plot(x,y,color=colors[exit_name],linewidth=2,label=f"{EXIT_NAMES[exit_name]}  ${s['net_pnl_usd']:,.0f}")
        ax.set_title(title,loc='left',fontweight='bold',pad=12)
        ax.axhline(0,color='#999999',linewidth=.8)
        ax.grid(axis='y',alpha=.15)
        ax.set_ylabel('逐日累计净损益（美元）')
        ax.yaxis.set_major_formatter(StrMethodFormatter('{x:,.0f}'))
        ax.spines[['top','right']].set_visible(False)
        ax.legend(loc='upper left',ncol=2,fontsize=9,frameon=False)
    axes[-1].xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO,interval=1))
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    fig.suptitle('提前退出能否改善结果？',x=.085,ha='left',fontsize=21,fontweight='bold',y=.975)
    fig.text(.085,.915,'68% 预测区间 · 10 点翼宽 · 美东 10:00 入场 · 每次一组 · 含开平仓费用',fontsize=11,color='#555555')
    fig.text(.085,.035,'2026/07/23–09/15，38 个已查看过的历史日；跳过日期保持空仓。\n图中为逐日结算曲线，盘中回撤另见报告。报价模拟成交；预测事前发布时间未独立核验。',fontsize=10,color='#555555')
    fig.subplots_adjust(top=.845,bottom=.12,left=.085,right=.97,hspace=.3)
    path=OUT/'comparison.png'
    fig.savefig(path,dpi=170,facecolor='white')
    print(path)


if __name__=='__main__':
    main()
