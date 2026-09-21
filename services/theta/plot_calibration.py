"""Standalone research figure; uses only completed PDE-E02 results."""
import json
import os
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.cache/matplotlib'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np

OUT = ROOT/'data/thetadata/pde-e02'
data = json.loads((OUT/'results.json').read_text())
models = data['experiment']['models']
colors = {'Q0':'#6b7280','P_normal':'#167d9a','P_kernel':'#c5662b'}
dates = [datetime.fromisoformat(r['date']) for r in data['forecasts']]
coverage_minima = []
fig,axes = plt.subplots(3,1,figsize=(12,11),sharex=True,layout='constrained')
fig.suptitle('PDE-E02 | Chronological retrospective evaluation',fontsize=18,weight='bold')
for name in models:
    policies = [r for r in data['policy_records'] if r['probability_model']==name]
    cumulative = np.cumsum([r['observed_stressed_pnl_usd'] for r in policies])
    axes[0].plot(dates,cumulative,color=colors[name],label=name,lw=2)
    if name!='Q0':
        differences = [r['models'][name]['scores']['standardized_crps']-
                       r['models']['Q0']['scores']['standardized_crps'] for r in data['forecasts']]
        axes[1].plot(dates,np.cumsum(differences),color=colors[name],label=name+' minus Q0',lw=2)
    covered = np.array([r['models'][name]['scores']['bands']['95']['covered'] for r in data['forecasts']],dtype=float)
    rolling = np.convolve(covered,np.ones(20)/20,mode='valid')
    coverage_minima.append(float(rolling.min())*100)
    axes[2].plot(dates[19:],rolling*100,color=colors[name],label=name,lw=1.8)
axes[0].set_title('One group at most per day; bid/ask + opening fees + extra slippage',loc='left',fontsize=11)
axes[0].set_ylabel('Cumulative P&L (USD)')
axes[1].set_title('Cumulative CRPS difference: below zero favors calibration',loc='left',fontsize=11)
axes[1].set_ylabel('Standardized score difference')
axes[2].set_title('95% closing interval: trailing 20 scored sessions',loc='left',fontsize=11)
axes[2].set_ylabel('Observed coverage (%)')
axes[2].axhline(95,color='#374151',ls='--',lw=1,label='Nominal 95%')
axes[2].set_ylim(max(0,min(coverage_minima)-5),102)
for ax in axes:
    ax.grid(alpha=.18)
    ax.spines[['top','right']].set_visible(False)
    ax.legend(loc='best',frameon=False,ncol=3,fontsize=9)
    ax.axvspan(datetime(2026,7,23),dates[-1],color='#d7dce2',alpha=.28)
for ax in axes[:2]:
    ax.axhline(0,color='#374151',lw=.8)
axes[-1].xaxis.set_major_locator(mdates.MonthLocator())
axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
fig.text(.01,-.012,'Shading: previously inspected E01 period. All data are retrospective. P candidates remain unvalidated. No annualized or account returns.',fontsize=9,color='#4b5563')
path = OUT/'comparison.png'
fig.savefig(path,dpi=160,bbox_inches='tight')
plt.close(fig)
print(path)
