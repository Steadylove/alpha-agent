// Isolated visual regression fixture. Not served or built by the workbench.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chart } from '../web/Chart';
import { TradeRecords } from '../web/TradeRecords';
import { alignExecutions, type Execution } from '../web/executions';
import type { History } from '../web/history';
import '../web/style.css';
const start=Date.parse('2025-03-10T13:30:00Z')/1000;
const history:History={symbol:'TEST',con_id:1,period:'1m',rth:true,source:'TEST ONLY',cached:false,stale:false,warning:null,updated:0,next_before:String(start),bars:Array.from({length:40},(_,i)=>{const value=100+Math.sin(i/4)*.8+i*.06;return {time:start+i*60,open:value,close:value+Math.sin(i)*.2,high:value+.35,low:value-.35,volume:100+i*3};})};
const fill=(id:string,index:number,side:string,quantity:number,price:number):Execution=>({id,symbol:'TEST',con_id:1,local_symbol:'TEST',type:'STK',currency:'USD',time:new Date((start+index*60+20)*1000).toISOString(),side,quantity,price,exchange:'TEST',commission:null,commission_currency:null});
const records=[fill('buy-1',5,'BOT',2,100.85),fill('buy-2',5,'BOT',3,100.95),fill('sell-1',24,'SLD',4,101.3)];
const mapped=alignExecutions(history,records);
function Fixture(){const [focus,setFocus]=useState(0);const [shown,setShown]=useState(true),[selected,setSelected]=useState<string|null>(null);return <main style={{maxWidth:1000,margin:'30px auto',padding:'0 14px'}}><h2>图表回归测试</h2><p>合成数据 · 仅验证买卖标记，不代表真实账户交易。</p><div className="chart-stage"><Chart history={history} period="1m" onOlder={()=>{}} canLoadOlder={false} trades={mapped.groups} showTrades={shown} selectedTrade={selected} focusRequest={focus}/></div><TradeRecords trades={mapped} symbol="TEST" shown={shown} onToggle={()=>setShown(v=>!v)} connected={false} onSync={async()=>{}} selected={selected} onLocate={id=>{setShown(true);setSelected(id);setFocus(n=>n+1);}}/></main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
