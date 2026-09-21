"""Render the fixed baseline paths; no best-parameter selection."""
import json
import os
from datetime import datetime

from batch import OUT, ROOT, baseline

os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.cache/matplotlib'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib import font_manager
from matplotlib.font_manager import FontProperties
from matplotlib.ticker import FuncFormatter

font=FontProperties(fname='/System/Library/Fonts/STHeiti Light.ttc')
font_manager.fontManager.addfont(font.get_file())
plt.rcParams.update({'font.family':font.get_name(),'axes.unicode_minus':False,'font.size':11})
report=json.loads((OUT/'results.json').read_text())
series=[s for s in report['summaries'] if baseline(s)]
fig,axes=plt.subplots(2,1,figsize=(11.5,8),sharex=True)
fig.subplots_adjust(top=.83,bottom=.17,left=.11,right=.94,hspace=.38)
fig.text(.11,.94,'38 个公开预测日：固定规则的累计净盈亏',fontsize=20)
fig.text(.11,.888,'SPXW 0DTE · 10:00 美东 · 每次一组 · 卖 bid / 买 ask · 每组成交费假设 $6',fontsize=11,color='#4b5563')
colors={'68':'#2353aa','95':'#c77615'}
for ax,strategy,title in zip(axes,['condor','butterfly'],['铁秃鹰：两侧保护翼均为 10 点','买入看涨蝶式：对称保护翼覆盖预测区间']):
    for s in series:
        if s['strategy']!=strategy:continue
        x=[datetime.fromisoformat(v['date']) for v in s['curve']]
        y=[v['cumulative_pnl_usd'] for v in s['curve']]
        ax.plot(x,y,color=colors[s['band']],linewidth=2,label=f"{s['band']}% 区间  |  最终 ${s['net_pnl_usd']:,.0f}",
                linestyle='-' if s['band']=='68' else '--')
        ax.scatter([x[-1]],[y[-1]],s=24,color=colors[s['band']])
    ax.set_title(title,loc='left',fontsize=13,pad=10)
    ax.set_ylabel('累计净损益（美元）')
    ax.axhline(0,color='#9ca3af',linewidth=.8)
    ax.grid(axis='y',color='#e5e7eb',linewidth=.7)
    ax.spines[['top','right']].set_visible(False)
    ax.legend(loc='upper left',frameon=False,fontsize=10)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v,p:f'{v:,.0f}'))
axes[-1].xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO,interval=1))
axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
axes[-1].set_xlabel('交易日期（2026 年）')
fig.text(.11,.08,'两图纵轴不同；每组风险资金不同。跳过日不交易。曲线是逐日结算结果，不包含盘中浮亏。',fontsize=10,color='#4b5563')
fig.text(.11,.035,'条件：预测在入场前可获得、四腿能按采样报价成交。历史发布时间尚未独立存证。',fontsize=10,color='#4b5563')
fig.savefig(OUT/'cumulative-pnl.png',dpi=180)
plt.close(fig)
print(OUT/'cumulative-pnl.png')
