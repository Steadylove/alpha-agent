import { useState } from 'react';
import { ChevronDown, Crosshair, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { tradeNumber, tradeTime, type TradeMap } from './executions';

type Props={trades:TradeMap;symbol:string;shown:boolean;onToggle:()=>void;connected:boolean;onSync:()=>Promise<void>;onImport?:()=>void;onJump?:()=>void;onLocate:(id:string)=>void;selected:string|null};
export function TradeRecords({trades,symbol,shown,onToggle,connected,onSync,onLocate,selected,onImport,onJump}:Props) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
  async function sync(){setBusy(true);setError('');try{await onSync();}catch(e){setError(e instanceof Error?e.message:'成交同步失败，请重试。');}finally{setBusy(false);}}
  const rows=trades.groups.flatMap(group=>group.entries.map(execution=>({group,execution}))).sort((a,b)=>Date.parse(b.execution.time)-Date.parse(a.execution.time));
  return <section className="chart-trades" aria-label="K 线买卖记录">
    <div className="trade-toolbar"><button className={'trade-toggle '+(shown?'active':'')} onClick={onToggle} aria-pressed={shown}>{shown?<Eye size={13}/>:<EyeOff size={13}/>}买卖标记</button>{onImport&&<button className="trade-sync" onClick={onImport}>导入历史成交</button>}<span className="trade-legend"><b className="buy">↑ B 买入</b><b className="sell">↓ S 卖出</b></span><button className="trade-sync" onClick={()=>void sync()} disabled={!connected||busy}><RefreshCw size={12} className={busy?'spin':''}/>{busy?'同步中…':'同步成交'}</button></div>
    <div className="trade-summary"><span>{trades.matched?`${symbol} · 当前 K 线区间 ${trades.matched} 笔成交`:`${symbol} · 当前 K 线区间暂无可标记成交`}{trades.unmapped>0&&` · 另 ${trades.unmapped} 笔在区间或时段外`}</span>{trades.unmapped>0&&onJump&&<button onClick={onJump}>查看最近成交日期</button>}{rows.length>0&&<button aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'收起明细':'查看明细'}<ChevronDown size={12} className={expanded?'expanded':''}/></button>}</div>
    {error&&<p className="inline-warning" role="alert">{error}</p>}
    {expanded&&rows.length>0&&<div className="table-wrap trade-table"><table><thead><tr><th>方向 / 数量</th><th>成交价</th><th>成交时间（美东）</th><th>定位</th></tr></thead><tbody>{rows.map(({group,execution:e})=><tr key={e.id} className={selected===group.id?'trade-selected':''}><td><b className={group.side==='buy'?'positive':'negative'}>{group.side==='buy'?'B 买入':'S 卖出'}</b> · {tradeNumber(e.quantity!)}</td><td>{tradeNumber(e.price!)} USD</td><td>{tradeTime(e.time)}</td><td><button className="text-button" aria-label={`定位 ${symbol} ${e.side==='BOT'||e.side==='BUY'?'买入':'卖出'} ${tradeTime(e.time)}`} onClick={()=>onLocate(group.id)}><Crosshair size={13}/>定位 K 线</button></td></tr>)}</tbody></table></div>}
    <p className="trade-scope">标记来自已归档的真实成交；旧持仓需导入历史报表，不以持仓均价推测买点。{trades.matched>0?'同根 K 线同向成交合并标记，位置取数量加权均价；明细保留每笔原价。':'可切换日期或交易时段后查看。'}</p>
  </section>;
}
