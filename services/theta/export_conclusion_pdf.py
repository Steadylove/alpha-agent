"""Export the audited E03 results with a reproducible nine-page Chinese methodology.

Uses existing local results and quotes only; does not rerun or tune the experiment.
Run with the bundled PDF Python. The research venv renders the chart and reads Parquet.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from xml.sax.saxutils import escape

ROOT=Path(__file__).resolve().parents[2]
DATA=ROOT/'data/thetadata/pde-e03'
TMP=ROOT/'tmp/pdfs/pde-e03-conclusion'
OUTPUT=ROOT/'output/pdf/SPX期权概率密度策略-回测结论.pdf'
LIGHT='/System/Library/Fonts/STHeiti Light.ttc'
MEDIUM='/System/Library/Fonts/STHeiti Medium.ttc'
ARIAL='/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
POLICIES=['primary_quality_gated','ungated_research_ablation','neutral_only_quality_gated']
LABELS=['主方案','无质量门槛对照','仅区间组合对照']
COLORS=['#17627E','#929CA8','#926044']


def inputs():
    result=json.loads((DATA/'results.json').read_text())
    audit=json.loads((DATA/'audit.json').read_text())
    assert audit['all_passed']
    assert result['plan']==json.loads((ROOT/'research/options/pde-e03.json').read_text())
    return result,audit


def money(value,decimals=0):
    return ('-' if value<0 else '')+f'${abs(value):,.{decimals}f}'


def make_assets():
    os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.cache/matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib.font_manager import FontProperties
    from matplotlib.ticker import FuncFormatter
    import numpy as np
    import polars as pl
    from collections import defaultdict
    from datetime import date
    from zoneinfo import ZoneInfo

    result,_=inputs();font=FontProperties(fname=ARIAL,size=8)
    fig,ax=plt.subplots(figsize=(7.10,3.35))
    first=min(t['date'] for p in result['policies']['whole'].values() for t in p['trades'])
    for key,label,color in zip(POLICIES,LABELS,COLORS):
        values=defaultdict(float)
        for t in result['policies']['whole'][key]['trades']:
            values[t['expiration']]+=t['net_pnl_usd']
        dates=[date.fromisoformat(first),*[date.fromisoformat(d) for d in sorted(values)],date(2026,9,15)]
        pnl=np.r_[0,np.cumsum([values[d] for d in sorted(values)]),sum(values.values())]
        ax.step(dates,pnl,where='post',color=color,lw=1.7 if key==POLICIES[0] else 1.25,label=label)
    ax.axhline(0,color='#b4bec9',lw=.6)
    ax.axvline(date(2026,6,1),color='#9ba7b4',lw=.8,ls='--')
    ax.grid(axis='y',alpha=.14);ax.spines[['top','right']].set_visible(False)
    ax.spines[['bottom','left']].set_color('#cbd3da')
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m'))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x,pos:f'{x:,.0f}'))
    ax.tick_params(labelsize=8,color='#cbd3da',labelcolor='#526174')
    ax.set_ylabel('累计净盈亏（美元）',fontproperties=font,color='#526174')
    ax.set_xlabel('2026 年月份',fontproperties=font,color='#526174')
    ax.legend(loc='upper center',bbox_to_anchor=(.5,1.15),ncol=3,frameon=False,prop=font)
    fig.subplots_adjust(left=.115,right=.985,bottom=.16,top=.84)
    TMP.mkdir(parents=True,exist_ok=True)
    fig.savefig(TMP/'equity.png',dpi=220,facecolor='white');plt.close(fig)

    # Work examples are selected by a stated rule, not by largest gains/losses.
    trades=result['policies']['whole'][POLICIES[0]]['trades']
    examples=[]
    for trade in [trades[0],next(t for t in trades if t['net_pnl_usd']>0)]:
        raw=pl.read_parquet(DATA/'quotes'/f"{trade['date']}-expiry-{trade['expiration']}.parquet").to_dicts()
        legs=[]
        for leg in trade['legs']:
            rows=[r for r in raw if r['timestamp'].astimezone(ZoneInfo('America/New_York')).strftime('%H:%M:%S')==trade['time']
                  and r['strike']==leg['strike'] and r['right'].lower()==leg['right']]
            assert len(rows)==1
            q=rows[0];side='ask' if leg['qty']>0 else 'bid'
            legs.append({**leg,**{k:q[k] for k in ['bid','ask','bid_size','ask_size']},'side':side,'execution_price':q[side]})
        assert abs(sum(l['qty']*l['execution_price'] for l in legs)-trade['entry_debit_points'])<1e-8
        forecast=next(f for f in result['forecasts'] if all(f[k]==trade[k] for k in ['date','time','expiration']))
        examples.append({'trade':trade,'quotes':legs,'training_count':forecast['training']['count'],
                         'last_training_expiry':forecast['training']['last_matured_expiry']})
    peak=0.;cum=0.;maxdd=0.;peakday='start';drawdown={}
    for t in sorted(trades,key=lambda t:(t['expiration'],t['date'],t['time'])):
        cum+=t['net_pnl_usd']
        if cum>peak:peak=cum;peakday=t['expiration']
        if peak-cum>maxdd:
            maxdd=peak-cum;drawdown={'peak_date':peakday,'trough_date':t['expiration'],'peak':peak,'trough':cum,'drawdown':maxdd}
    assert abs(maxdd-result['policies']['whole'][POLICIES[0]]['summary']['settled_max_drawdown_usd'])<1e-6
    evidence={'examples':examples,'drawdown':drawdown}
    (TMP/'evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))


def make_pdf():
    from reportlab.pdfgen import canvas
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph, Table, TableStyle

    result,audit=inputs();whole=result['policies']['whole'];primary=whole[POLICIES[0]]['summary']
    stats=json.loads((DATA/'statistical-summary.json').read_text())
    edge=stats['edge_decomposition']['whole'][POLICIES[0]]
    assert [whole[k]['summary']['trades'] for k in POLICIES]==[104,115,71]
    subprocess.run([str(ROOT/'.cache/thetadata-venv/bin/python'),str(Path(__file__).resolve()),'--assets'],check=True)
    evidence=json.loads((TMP/'evidence.json').read_text())
    pdfmetrics.registerFont(TTFont('CN',LIGHT,subfontIndex=1))
    pdfmetrics.registerFont(TTFont('CN-Bold',MEDIUM,subfontIndex=1))
    pdfmetrics.registerFontFamily('CN',normal='CN',bold='CN-Bold',italic='CN',boldItalic='CN-Bold')
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    W,H=A4;M=42;CW=W-2*M;PAGES=9
    INK='#162B43';MUTED='#617184';TEAL='#17627E';PALE='#F0F5F8';RED='#9E4337'
    c=canvas.Canvas(str(OUTPUT),pagesize=A4,pageCompression=1)
    c.setTitle('SPX期权概率密度策略：回测结论与详细方法')
    c.setAuthor('Alpha Agent')
    c.setSubject('PDE-E03：数据、模型、交易规则、现金流、统计证据与复现边界')
    page=0;y=0;page_extents=[]

    def paragraph(text,width,size=10,leading=16,color=INK,bold=False):
        return Paragraph(text,ParagraphStyle('body',fontName='CN-Bold' if bold else 'CN',fontSize=size,
            leading=leading,textColor=colors.HexColor(color),wordWrap='CJK',spaceAfter=0))

    def drawp(text,x,top,width,size=10,leading=16,color=INK,bold=False):
        p=paragraph(text,width,size,leading,color,bold);_,ph=p.wrap(width,H)
        assert top+ph<=793,(page,text[:55],top,ph)
        p.drawOn(c,x,H-top-ph);return ph

    def p(text,size=10,leading=16,color=INK,bold=False,gap=8):
        nonlocal y
        y+=drawp(text,M,y,CW,size,leading,color,bold)+gap

    def heading(text):
        nonlocal y
        y+=5;p(text,12.2,19,TEAL,True,7)

    def callout(title,text,dark=False):
        nonlocal y
        inner=CW-28
        t=paragraph(title,inner,12,18,'#FFFFFF' if dark else TEAL,True)
        b=paragraph(text,inner,10,16,'#DCE8F0' if dark else INK)
        _,ht=t.wrap(inner,H);_,hb=b.wrap(inner,H);h=ht+hb+31
        assert y+h<=793,(page,'callout',y,h)
        c.setFillColor(colors.HexColor(INK if dark else PALE));c.roundRect(M,H-y-h,CW,h,6,fill=1,stroke=0)
        t.drawOn(c,M+14,H-y-12-ht);b.drawOn(c,M+14,H-y-ht-19-hb);y+=h+12

    def table(rows,widths,size=9.3,pad=7,vpad=6):
        nonlocal y
        cells=[[paragraph(str(v),w-2*pad,size,14,INK,i==0) for v,w in zip(row,widths)] for i,row in enumerate(rows)]
        t=Table(cells,colWidths=widths,hAlign='LEFT')
        t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),pad),
            ('RIGHTPADDING',(0,0),(-1,-1),pad),('TOPPADDING',(0,0),(-1,-1),vpad),('BOTTOMPADDING',(0,0),(-1,-1),vpad),
            ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#E9EFF4')),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F7F9FB')]),
            ('LINEBELOW',(0,0),(-1,-1),.4,colors.HexColor('#E1E7EC'))]))
        _,th=t.wrap(CW,H);assert y+th<=793,(page,'table',y,th)
        t.drawOn(c,M,H-y-th);y+=th+10

    def newpage(title,subtitle):
        nonlocal page,y
        if page:page_extents.append({'page':page,'bottom':round(y,1)});c.showPage()
        page+=1
        c.bookmarkPage(f'page-{page}');c.addOutlineEntry(title,f'page-{page}',0)
        drawp('ALPHA AGENT  /  PDE-E03',M,27,340,8,11,TEAL,True)
        drawp('方法增补版 · 2026-09-16',W-M-162,27,162,8,11,MUTED)
        c.setStrokeColor(colors.HexColor('#DCE4EB'));c.setLineWidth(.6);c.line(M,H-48,W-M,H-48)
        c.setFillColor(colors.HexColor(MUTED));c.setFont('CN',8)
        c.drawString(M,23,'历史模拟研究  |  固定规则、一组持仓、美元现金盈亏')
        c.drawRightString(W-M,23,f'{page} / {PAGES}')
        y=64;p(title,23,30,INK,True,8);p(subtitle,9.3,14,MUTED,gap=14)

    def source(text):
        p('证据：'+text,8,12,MUTED,gap=0)

    # 1. Executive summary, scoped to the actual tested implementation.
    newpage('SPX 期权回测：结论与方法','从原始报价、概率模型和选仓规则，逐步说明最终成绩如何计算。')
    callout('当前版本尚未证明存在持续盈利的优势。',
        '主方案 104 笔，扣除买卖价差、手续费和额外滑点后净亏 $586；结算最大回撤 $4,342。流程可以复核，但不能据此预期稳定月赚 5%。',True)
    heading('01  我们实际验证的是什么')
    p('利用当时可见的 SPXW 期权报价，以及此前已到期的历史样本，估计到期价格分布；比较模型与市场定价，在成本和单笔风险限制内选择组合，再按真实历史收盘价计算到期损益。')
    p('<b>这轮 E03 使用我们自己的模型，没有直接使用博主的预测区间。</b>它贯彻文档中“完整分布、定价差异、成本后优势、允许空仓”的思想。实际算法是统计分布估计和组合收益积分，未求解非线性动力方程，也不是 AI 直接猜价格。')
    heading('02  最终成绩')
    rows=[['方案','交易笔数','胜率','净盈亏','结算最大回撤']]
    for key,label in zip(POLICIES,LABELS):
        s=whole[key]['summary'];rows.append([label,s['trades'],f"{s['win_rate']:.1%}",money(s['net_pnl_usd']),money(s['settled_max_drawdown_usd'])])
    table(rows,[154,63,65,103,CW-385])
    p('全期输入：2025-09-16 至 2026-09-15；前段用于训练预热，模拟交易从 2026 年 1 月开始。三种方案分别独立回放，不能把它们当成同一个账户叠加。',9.3,15,MUTED)
    heading('03  为什么得出这个结论')
    p('<b>收益证据：</b>三种预先列出的方案全期均为负；主方案平均预计赚 $48.60，实际平均亏 $5.63。')
    p('<b>预测证据：</b>区间覆盖率不错，但整体分布评分没有显示我们的 P 模型可靠地优于市场 Q。覆盖率高不等于交易具有正期望。')
    p('<b>稳定性证据：</b>区间组合后段赚 $6,931，前段亏 $8,088；主方案最长连续亏损 24 笔。单笔损失有上限，累计损失仍会扩大。')
    callout('如何阅读本报告','第 2-5 页：数据、模型、规则与逐笔计算；第 6-8 页：成绩和统计依据；第 9 页：审计、复现入口与结论边界。')
    source('results.json、statistical-summary.json；仓库内完整路径见第 9 页。')

    # 2. Data and causal replay.
    newpage('数据与时间顺序','先明确当时能看到什么，再谈预测是否准确、交易是否赚钱。')
    heading('01  回测使用哪些数据')
    table([
        ['项目','实际口径'],
        ['标的与报价','Theta 历史 SPXW 期权链：行权价、看涨/看跌、到期日、bid/ask、对应数量与时间戳。每点乘数为 $100。'],
        ['观察日期','250 个决策日：2025-09-16 至 2026-09-14；最后到期日为 2026-09-15。'],
        ['时间与到期','每天美东 10:00、11:00、14:00；各检查当日及下一交易日到期。下一交易日可以跨周末，不等于 24 小时。'],
        ['结算与历史特征','冻结的 Yahoo Finance ^GSPC（SPX）日收盘序列：用于训练残差、此前 20 日波动和最终到期收益。日收盘是结算代理，未逐日核对官方结算值。'],
    ],[103,CW-103],9.4)
    p('全部时点按美东时区处理夏令时。2025-11-28、12-24 的现金市场提前至 13:00 收盘，因此拒绝对应 14:00 快照。预测目标是<b>到期收盘位置</b>，不是“盘中最高、最低都不越界”。',9.5,15)
    heading('02  数据如何进入回测')
    p('<b>500 组日期/到期日行情 → 1,500 个计划快照 → 1,418 个可用快照 → 1,055 次可评分预测 → 87,657 条成本与风险初筛合格的候选记录。</b>其中 82 个快照拒绝，363 个可用快照处于训练预热；候选记录不等于交易次数。')
    p('82 次拒绝中，78 次为流动性合格的近 ATM 看涨/看跌配对不足，4 次为计划时间晚于提前收盘。缺数据不使用未来报价补齐。报价需日期、到期日和标的一致；保留实际报价时间的 as-of 数据还校验不来自未来或前一交易日。',9.5,15)
    heading('03  每天如何避免使用未来结果')
    for text in [
        '① 按日期、时点向前推进，只读取该时点及以前形成的报价。',
        '② 按“入场时间 × 到期偏移”分成 6 组；只用到期日严格早于今天的样本训练。',
        '③ 用此前已成熟预测的评分选模型，随后生成候选、确定是否开仓。',
        '④ 选仓固定后，才附上本笔到期收盘价，计算实际损益和预测评分。',
        '⑤ 保留空仓、数据拒绝和亏损记录；跨日持仓连续运行，不在分段时重置。',
    ]:p(text,9.7,15,gap=5)
    callout('时间顺序正确，不等于完全没有过拟合','本轮参数与规则先登记，观察 E03 结果后未调参。但这段历史在早期研究中已被查看。6 月以后的结果只能称为按时间划分的后段评估，不能称为完全未接触的独立测试。当前前瞻验证为 0 个交易日。')
    source('registered-plan.json、prepared.json；pde_search_data.py、pde_search.py。')

    # 3. Distribution modeling.
    newpage('概率模型如何形成','Q 表示报价隐含的定价分布；P 表示用历史估计、仍待验证的发生概率分布。')
    heading('01  从当时的期权报价取得尺度')
    p('在同到期日、同行权价的看涨/看跌配对中，保留 bid &gt; 0、ask ≥ bid、两侧数量 ≥ 1、每腿价差 ≤ 1 点的报价。按看涨与看跌中间价差的绝对值选最接近 ATM 的 7 对，至少需要 3 对。')
    p('<b>远期参考 F = median(K + C_mid - P_mid)。</b>配对所得 F 的极差不得超过 2 点。用 Black 跨式定价反解各配对的总对数波动 w，取中位数；基准中位价格 m = F × exp(-w²/2)，价格尺度近似为 F × w。w 是剩余期限的总波动，不是年化 IV。',9.6,15)
    heading('02  市场 Q：用整段期权微笑反推分布')
    p('在 F 周围约 4 倍价格尺度的可见行权价上分配非负概率，并加入 ATM 对数正态分布的百万分之一及 0.999999 分位点作为尾端。要求总概率为 1、均值为 F。用约 ±3.5 倍尺度内的液态报价拟合，各腿价差上限 2 点，至少 12 条。',9.6,15)
    p('线性规划最小化“模型价格超出 bid/ask 区间的平均偏差”，另加系数 0.001 点的弱先验约束；最大单条偏差 ≤ 2 点，按价差标准化的平均偏差 ≤ 0.5。短期贴现系数取 1。<b>Q 不是实际胜率；有限报价可能对应多个 Q，尾部也作了截断近似。</b>',9.6,15)
    heading('03  历史 P：先把不同市场水平标准化')
    p('<b>历史残差 z = [ln(S_T / F) + w²/2] / w。</b>S_T 是那笔历史预测对应的到期收盘。每组只取过去 60-120 条已成熟样本，估计今天的 Z，再映射回 S_T = F × exp(-w²/2 + w × Z)。',9.6,15)
    table([
        ['模型','实际计算方式'],
        ['P_normal','对历史 z 拟合正态分布；均值为样本平均，标准差使用 n-1 分母。'],
        ['P_kernel','在每个历史 z 周围放一个等权高斯核；带宽 h = 1.06 × 样本标准差 × n^(-1/5)。'],
        ['P_state','50% 使用等权历史核，50% 偏重状态相似的样本；特征为 IV/RV 比与约一倍波动处的看跌/看涨 IV 比。'],
    ],[96,CW-96],9.3)
    p('状态特征具体为 ln[w/(RV20 × √(剩余日历小时/24))] 与 ln(w_put/w_call)。RV20 仅用昨日及以前的 21 个收盘价；特征距离按历史标准差缩放，高斯权重带宽 1.5。有效样本量不足 20 时退回等权历史核。',9.2,14)
    callout('模型选择依靠过去评分，不依靠当前交易输赢','每组用此前 20-40 条已成熟预测的 CRPS 选出最优 P；主方案还要求它的平均 CRPS 严格低于 Q。CRPS 越小表示整个概率分布误差越小。这个门槛没有要求统计显著，不能直接视为已证明的优势。')
    source('range_model.py；pde_search_math.py 的 fit_market、fit_probability、choose_probability。')

    # 4. Strategy search and exact entry rules.
    newpage('如何组合期权、何时开仓','所有候选都先规定搜索网格，再按模型估算筛选；没有事后选择当天最佳时点。')
    heading('01  搜索范围：9 类结构，固定参数')
    table([
        ['结构','行权价与宽度'],
        ['看涨/看跌买入价差、卖出价差（4 类）','位置为 m + [-1.5,-1,-0.5,0,0.5,1,1.5] × Fw；宽度 5、10、20 点。'],
        ['铁秃鹰','短腿使用 Q 的中央 68%、80%、90%、95% 区间，向外取整；保护翼宽 5、10、20 点。'],
        ['看涨蝶式、看跌蝶式、铁蝶（3 类）','中心为 m + [-0.5,0,0.5] × Fw；对称翼宽 10、25、50 点。'],
        ['看涨不等翼蝶式','相同中心；左右翼宽为 10/20、20/10、25/50、50/25 点。'],
    ],[156,CW-156],9.4)
    p('所有行权价按 5 点步长，所有腿同一到期日；同样的腿组合去重。Fw 为近似价格尺度，并非另一个校准后的精确标准差。',9.2,14,MUTED)
    heading('02  候选必须通过哪些条件')
    p('<b>报价与风险：</b>买入用 ask、卖出用 bid；成交方向显示数量至少覆盖该腿张数，卖出两张的蝶身需至少 2 张。每腿价差 ≤ 1 点，组合报价还需满足到期支付的上下界检查。计入成本后，最大亏损 &gt; 0 且 ≤ $1,000，最大盈利 &gt; 0。')
    p('<b>估算优势：</b>P 下净期望收益 EV ≥ $10，EV/最大亏损 ≥ 2%；P 的期望支付必须高于 Q，且 Q 下净 EV 不能为正（数值容差 1e-7）。这样尽量避免把 Q 拟合中的定价误差当成预测收益。')
    heading('03  真正执行的时间顺序')
    p('每天依次检查 10:00 → 11:00 → 14:00。到一个时点，就比较该时点所有合格结构和两个到期日，选 <b>EV/最大亏损最高</b>的一组；第一个有合格候选的时点即入场，并列时按固定候选顺序。没有合格候选就空仓。')
    p('每笔一组，每天最多一笔，同时最多一个持仓；下一交易日到期的持仓会占用到期当天，期间不开新仓。组合完整持有至到期，不设盘中止盈止损、不滚仓、不加仓、不复利。')
    heading('04  三种方案如何对照')
    p('<b>主方案：</b>质量门槛通过，允许全部 9 类。<br/><b>无质量门槛：</b>只取消“P 评分必须优于 Q”，仍用过去评分选模型，保留报价、成本和风险等条件。<br/><b>仅区间组合：</b>保留质量门槛，只允许蝶式、铁蝶、铁秃鹰和不等翼蝶式；不代表严格 Delta 中性。',9.7,15)
    callout('选仓目标会改变交易的形态','我们优化的是模型 EV 相对于单笔风险的比例，没有最大化胜率。主方案最终 100/104 笔为买入价差；铁秃鹰参与搜索，但没有被选中开仓。因此这轮成绩不是“每天卖一次铁秃鹰”的成绩。')
    source('pde-e03.json；pde_search_optimizer.py；pde_search.py 的 replay_policy。')

    # 5. Payoff formula and two exact examples.
    newpage('一笔交易的盈亏怎么算','示例固定为主方案的第一笔交易和第一笔盈利交易，报价来自原始历史文件。')
    heading('01  全部策略使用同一套现金流公式')
    p('令 q 为持仓数量（买入为正、卖出为负），n = Σ|q|；D 为按买 ask、卖 bid 加总的净权利金点数，收权利金时 D 为负。每张开仓手续费 $1.50，基础额外滑点 $2。')
    callout('净盈亏 = 到期组合支付 V(S_T) - 100 × D - 3.5 × n',
        '看涨单腿支付 = 100 × q × max(S_T - K, 0)；看跌单腿支付 = 100 × q × max(K - S_T, 0)。各腿相加得 V。最大亏损 = 100D + 3.5n - min V；最大盈利 = max V - 100D - 3.5n。')
    p('预计净收益 EV 使用 E_P[V] 替换实际 V(S_T)；盈利概率是 P 下“净盈亏 &gt; 0”的积分。当前正态/混合对数正态模型用解析积分，不依赖蒙特卡洛抽样。最大损益按分段线性支付在行权价节点及尾端计算。',9.5,15)
    for index,item in enumerate(evidence['examples']):
        t=item['trade'];leg1,leg2=item['quotes'];first=index==0
        heading(('02  亏损示例：' if first else '03  盈利示例：')+t['date']+' 14:00 ET，当日到期')
        rows=[['操作','历史 bid / ask（点）','计入开仓的价格']]
        for l in item['quotes']:
            rows.append([f"{'买入' if l['qty']>0 else '卖出'} 1 张 {l['strike']}P",f"{l['bid']:.2f} / {l['ask']:.2f}",f"{l['side']} {l['execution_price']:.2f}"])
        table(rows,[190,156,CW-346],9.3)
        if first:
            p('<b>开仓：</b>(1.90 - 0.55) × 100 + $3 手续费 + $4 滑点 = $142。<br/><b>到期：</b>SPX 收盘 6,940.01，两张 Put 内在价值均为 0，净亏 <b>$142</b>。<br/><b>边界：</b>最大亏 $142，最大赚 20 × 100 - 142 = $1,858，盈亏平衡点 6,938.58。',9.6,15)
            p('入场模型 P_kernel 用 80 条已到期样本，最新为 1 月 15 日；模型预计 EV +$58.54，盈利概率仅 17.3%。过去 CRPS 为 0.701087，略低于 Q 的 0.701117，刚好通过门槛。',9.2,14,MUTED)
        else:
            p('<b>开仓：</b>(3.10 - 0.85) × 100 + $3 手续费 + $4 滑点 = $232。<br/><b>到期：</b>收盘 6,950.23；6955P 支付 4.77 点，6935P 为 0。<br/><b>净利润：</b>4.77 × 100 - 232 = <b>$245</b>；最大亏 $232，最大赚 $1,768。',9.6,15)
            p('同样使用 P_kernel，85 条成熟样本；预计 EV +$89.76，盈利概率 30.2%。单笔盈利或亏损都不能验证其期望值，必须汇总完整连续样本。',9.2,14,MUTED)
    source('quotes/2026-01-16-expiry-2026-01-16.parquet、对应 01-26 文件；results.json 逐笔记录。')

    # 6. Complete numerical outcomes.
    newpage('完整成绩与成本敏感性','先看全部月份和全部预设方案，再看某一段表现，避免只挑盈利时期。')
    heading('01  相同交易记录，不同成本假设')
    rows=[['方案','价差＋手续费','再加 $2/张滑点','再加 $5/张滑点']]
    for key,label in zip(POLICIES,LABELS):
        s=whole[key]['summary'];rows.append([label,money(s['no_extra_slip_pnl_usd']),money(s['net_pnl_usd']),money(s['stress_pnl_usd'])])
    table(rows,[154,113,122,CW-389],9.4,vpad=4)
    p('三个情景都已按买 ask、卖 bid 计入买卖价差，并扣 $1.50/张手续费。$5 是替代 $2 的额外滑点，不是在 $2 之上再加 $5。压力情景仅重算原交易损益，不重新筛选交易。',9.2,14,MUTED)
    heading('02  逐月成绩（按开仓月份归属，美元）')
    rows=[['月份','主方案笔数','主方案','无门槛对照','区间对照']]
    maps={k:{m['month']:m for m in whole[k]['monthly']} for k in POLICIES}
    rows.append(['2025-09 至 12','0','$0','$0','$0'])
    for m in whole[POLICIES[0]]['monthly']:
        if m['month']<'2026-01':continue
        rows.append([m['month'],m['trades'],*[money(maps[k][m['month']]['net_pnl_usd']) for k in POLICIES]])
    rows.append(['合计',primary['trades'],*[money(whole[k]['summary']['net_pnl_usd']) for k in POLICIES]])
    table(rows,[121,79,99,105,CW-404],9.3,vpad=2.5)
    p('2025 年的 0 笔来自训练/验证预热，不代表已稳定运行却没有波动；9 月仅到 14 日开仓、15 日到期，并非完整月份。跨月交易归入开仓月。',9.2,14,MUTED)
    heading('03  前后段是否一致')
    rows=[['方案','截至 2026-05-29','2026-06-01 起','后段笔数']]
    for key,label in zip(POLICIES,LABELS):
        d=result['policies']['development'][key]['summary'];e=result['policies']['evaluation'][key]['summary']
        rows.append([label,money(d['net_pnl_usd']),money(e['net_pnl_usd']),e['trades']])
    table(rows,[154,130,137,CW-421],9.3,vpad=4)
    p('<b>解释：</b>主方案后段 +$216，压力成本后为 -$42；区间对照后段表现好，但前段亏损更大。仅凭后段挑选“赢家”，会引入新的选择偏差。',9.7,15)
    source('results.json 的 policies/whole、development、evaluation；statistical-summary.json。')

    # 7. Explain realized results and account risk.
    newpage('从这些记录怎样得出结论','将现金流、成本和模型估计拆开看，避免把“理论可能赚”当成“已经验证能赚”。')
    image_h=CW*3.35/7.10
    c.drawImage(str(TMP/'equity.png'),M,H-y-image_h,width=CW,height=image_h,mask='auto');y+=image_h+4
    p('曲线从实际交易期开始，按到期结算记录；虚线为 2026-06-01。它是累计利润，不是账户资产净值，也不包含盘中浮亏。',8.8,13,MUTED)
    heading('01  总利润和回撤可以直接复算')
    p('<b>主方案：</b>15 笔盈利合计 $12,268，89 笔亏损合计 $12,854；差额为 <b>-$586</b>，胜率 15/104 = 14.4%。平均盈利 $817.87、平均亏损 $144.43，大的盈利单没有覆盖全部亏损。',9.7,15)
    d=evidence['drawdown']
    p(f"<b>回撤：</b>按到期排序累加盈亏，每一步计算“此前累计利润最高点 - 当前累计利润”。最大值出现在 {d['peak_date']} 的 {money(d['peak'])} 到 {d['trough_date']} 的 {money(d['trough'])}，即 <b>{money(d['drawdown'])}</b>。起点也纳入最高点，值为 0。",9.7,15)
    p('主方案单笔实际最差 -$817、所选合约最大风险最高 $887，仍出现 24 笔连亏及 $4,342 回撤。原因是每笔亏损上限只限制那一笔，不限制后续继续开仓的累计损失。',9.4,15)
    heading('02  模型预计收益为何没有成为实际收益')
    table([
        ['平均每笔的预测净 EV 分解','美元'],
        ['P 相对 Q 的预计到期支付优势',money(edge['mean_predicted_p_minus_q_payoff'],2)],
        ['加：Q 相对中间价的拟合残差',money(edge['mean_q_mid_repricing_residual'],2)],
        ['减：买卖价差成本；再减手续费和额外滑点',f"{money(edge['mean_spread_cost'],2)}；{money(edge['mean_fees_and_extra_slippage'],2)}"],
        ['模型预计净 EV / 实际平均损益',f"{money(edge['mean_predicted_net_EV'],2)} / {money(edge['mean_realized_net_pnl'],2)}"],
    ],[347,CW-347],9.3)
    p('预计 EV 的正数依赖 P 的准确性；有限样本、尾部误差与候选中择优都可能使估算偏乐观。这份回测显示优势尚未兑现，不能单凭结果把原因唯一归结为某一个模型错误，也不能认定改一个参数就能盈利。',9.5,15)
    source('results.json 全部逐笔现金流；statistical-summary.json 的 edge_decomposition。')

    # 8. Distribution and uncertainty.
    newpage('预测准确性与统计证据','覆盖率检验“有没有落在区间”；完整分布评分检验“概率如何分配”。两者都不直接等于交易胜率。')
    heading('01  区间覆盖很好，是否意味着优于市场')
    rows=[['模型','全期 CRPS','68%覆盖率','68%宽度/点','95%覆盖率']]
    for model,s in result['distribution_scores']['whole'].items():
        fs=[f for f in result['forecasts'] if f['status']=='forecast']
        width=sum(f['scores'][model]['bands']['68']['high']-f['scores'][model]['bands']['68']['low'] for f in fs)/len(fs)
        rows.append([model,f"{s['mean_crps']:.4f}",f"{s['coverage']['68']:.1%}",f'{width:.2f}',f"{s['coverage']['95']:.1%}"])
    table(rows,[111,91,97,108,CW-407],9.3,vpad=3.5)
    p('共 1,055 次评分预测，不是 1,055 笔独立交易。P 的 68% 区间更宽，覆盖率也更高；Q 本身已接近目标覆盖。不能只凭覆盖率更高认定 P 更准确，更不能把 95% 覆盖直接当作 95% 的期权盈利概率。',9.5,15)
    p('<b>CRPS 的直觉：</b>预测把概率放到离实际结果更远的位置时，会被扣更多分；同时评价整个分布。按标准化残差计算：CRPS = E|X-z| - 0.5 × E|X-X′|，其中 X、X′ 是该预测分布的独立抽样，z 为已发生结果。',9.3,15)
    heading('02  P 相对 Q 的改善是否可靠')
    rows=[['P 模型','日均 CRPS 差（P-Q）','95% 分块重采样区间']]
    for k,v in stats['paired_distribution_bootstrap']['whole'].items():
        a,b=v['daily_mean_95_percentile_interval'];rows.append([k,f"{v['observed_daily_mean']:+.4f}",f'[{a:+.4f}, {b:+.4f}]'])
    table(rows,[112,172,CW-284],9.3,vpad=4)
    p('先按日期平均同一天的配对评分差，再做 5 个交易日循环分块、2,000 次重采样，随机种子 20260916。差值 &lt; 0 才有利于 P；三个区间都跨过 0，因此没有可靠证据说明 P 优于 Q，也不能据此断言 P 必然更差。',9.4,15)
    heading('03  历史盈利的统计不确定性')
    rows=[['方案','全期总利润的 95% 重采样区间']]
    for k,label in zip(POLICIES,LABELS):
        a,b=stats['bootstrap']['whole'][k]['sum_95_percentile_interval'];rows.append([label,f'[{money(a,2)}, {money(b,2)}]'])
    table(rows,[154,CW-154],9.3,vpad=4)
    p('盈利重采样使用完成选模预热后的 171 个交易日，按日计入到期损益，空仓日为 0；同样采用 5 日块和 2,000 次抽样。它保留部分短期相关性，但不能代表未出现的极端行情，也不能消除反复研究同一历史的偏差。',9.4,15)
    callout('证据支持的表述','当前实现没有证实持续正期望。它不等于证明“所有基于区间的期权策略都不能赚钱”；它也不支持“只要长期坚持，就大概率稳定盈利”。需要新的、规则固定的前瞻样本。')
    source('results.json 的 distribution_scores；report_search.py；statistical-summary.json。')

    # 9. Reproducibility and limitations.
    newpage('复核入口与结论边界','本次只补充报告方法，没有重新调参、重跑研究或改变回测结论。')
    heading('01  计算和时间顺序如何核对')
    p(f"既有研究验证记录为 53 项测试通过；独立审计核对 {audit['raw_quote_jobs']} 组原始行情、{audit['forecast_training_audits']:,} 次预测训练、{audit['independent_selected_EV_audits']:,} 次候选 EV、{audit['independent_CRPS_quadratures']} 次 CRPS 数值积分，以及三种方案共 {audit['policy_cashflows_checked']} 条现金流。方案之间会重叠，不能视为 290 笔独立交易。",9.5,15)
    p('as-of 与早期 10:00 数据在 156 天、89,132 条可比合约上，bid/ask/数量差异为 0。所选 as-of 腿核对 628 次，最老报价距时点 25.636 秒。审计还重算模型选择、到期支付、连续持仓、月度合计与回撤。<b>这些检查验证计算与时序，不证明赚钱，也不保证多腿同时成交。</b>',9.4,15)
    heading('02  哪些限制会影响解释')
    p('① <b>结算和成交近似：</b>用 SPX 日收盘代理现金结算；按历史买卖档位估算，并非真实组合成交回报。没有盘口队列、订单延迟、盘中退出或逐时盯市回撤。',9.4,15,gap=5)
    p('② <b>模型范围：</b>Q 有限尾部且解不唯一；P 仅用残差、IV/RV 和偏斜。未加入 GEX、资金流、深度学习，也未完整复刻原文所有设想。',9.4,15,gap=5)
    p('③ <b>账户范围：</b>未设账户初始本金、资金耗尽或券商保证金模型，默认能继续持有一组；未扣订阅、税费、融资等账户费用，也未计闲置现金利息。美元利润不能换称账户月收益率。',9.4,15,gap=5)
    p('④ <b>样本范围：</b>历史曾被查看，后段不是纯样本外；不能看完后换成表现最好的对照，再把它称作已验证策略。前瞻有效样本目前为 0。',9.4,15)
    heading('03  仓库内的完整证据链')
    table([
        ['文件（相对于 alpha-agent 仓库）','用于复核'],
        ['research/options/pde-e03.json','固定参数、结构网格、费用、门槛与分段'],
        ['data/thetadata/pde-e03/registered-plan.json','登记时间、数据路径、输入哈希与 500 个任务'],
        ['同目录 quotes/、prepared.json','原始报价、可用快照、Q 拟合和拒绝原因'],
        ['同目录 results.json、candidate-metrics.parquet','每次预测、历史训练范围、候选 EV、逐笔交易与空仓'],
        ['同目录 audit.json、statistical-summary.json','独立审计、分块重采样、成本/优势分解'],
        ['services/theta/pde_search_math.py、pde_search_optimizer.py、pde_search.py','分布估计、结构筛选、按时间回放及汇总'],
    ],[326,CW-326],8.7,vpad=2)
    p('<b>从已有本地数据复现：</b>在仓库根目录依次用 .cache/thetadata-venv/bin/python 运行 services/theta/pde_search.py run、services/theta/audit_search.py、services/theta/report_search.py；测试入口为 npm run theta:test。无需在本次报告增补中重复执行。',8.8,14)
    callout('下一阶段的判断标准','冻结模型、参数与交易规则，从新的交易日开始逐日前瞻纸上记录；保留信号时间、当时报价、空仓原因和全部损益。再同时检查预测质量、成本后收益与回撤，而不是继续在这段历史上搜索直到出现盈利版本。')
    source('代码与数据均为当前仓库的 PDE-E03 版本；未包含密钥或其他账户凭证。')
    assert page==PAGES
    page_extents.append({'page':page,'bottom':round(y,1)});c.showPage();c.save()
    print(json.dumps({'pdf':str(OUTPUT),'pages':PAGES,'content_extents':page_extents},ensure_ascii=False))


if __name__=='__main__':
    make_assets() if '--assets' in sys.argv or '--chart' in sys.argv else make_pdf()
