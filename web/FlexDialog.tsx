import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { X, Download, Upload, LoaderCircle, ChevronDown, Check } from 'lucide-react';

export type ArchiveStatus={configured:boolean;query_id:string;timezone:string;count:number;first:string|null;last:string|null;revision:number|null;last_import:{time:number;added:number;updated:number;unchanged:number;skipped?:Record<string,number>}|null};
type Status=ArchiveStatus&{account:string;job:{state:string;message?:string;result?:{added:number;updated:number;unchanged:number};skipped?:Record<string,number>}};
type Props={api:<T>(path:string,options?:RequestInit)=>Promise<T>;onClose:()=>void;onUpdated:()=>Promise<void>;onError:(error:unknown)=>string};
const zones=[['America/New_York','美东 · America/New_York'],['UTC','UTC'],['Asia/Hong_Kong','香港 · Asia/Hong_Kong'],['Asia/Shanghai','上海 · Asia/Shanghai'],['Europe/London','伦敦 · Europe/London']];
const day=(value:string|null)=>value?new Date(value).toLocaleDateString('en-CA',{timeZone:'America/New_York'}):'—';
export function FlexDialog({api,onClose,onUpdated,onError}:Props){
  const [status,setStatus]=useState<Status|null>(null),[token,setToken]=useState(''),[query,setQuery]=useState(''),[zone,setZone]=useState('America/New_York');
  const [days,setDays]=useState('365'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const file=useRef<HTMLInputElement>(null),done=useRef(false);
  async function load(initial=false){const next=await api<Status>('/flex');setStatus(next);if(initial){setQuery(next.query_id);setZone(next.timezone);}return next;}
  useEffect(()=>{void load(true).catch(e=>setError(onError(e)));},[]);
  useEffect(()=>{
    if(status?.job.state!=='running')return;
    const timer=setInterval(()=>{void load().then(async next=>{if(next.job.state==='done'&&!done.current){done.current=true;await onUpdated();}}).catch(e=>setError(onError(e)));},3000);
    return ()=>clearInterval(timer);
  },[status?.job.state]);
  const running=status?.job.state==='running';
  async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setMessage('');try{await api('/flex/config',{method:'POST',body:JSON.stringify({token,query_id:query,timezone:zone})});setToken('');await load(true);setMessage('Flex 配置已保存。点击「同步历史」获取成交。');}catch(e){setError(onError(e));}finally{setBusy(false);}}
  async function sync(){setBusy(true);setError('');setMessage('');done.current=false;try{await api('/flex/sync',{method:'POST',body:JSON.stringify({days:Number(days)})});await load();}catch(e){setError(onError(e));}finally{setBusy(false);}}
  async function upload(selected:File){setBusy(true);setError('');setMessage('');try{if(selected.size>10*1024*1024)throw new Error('文件不能超过 10 MB，请分段导出。');const result=await api<{added:number;updated:number;unchanged:number;skipped:Record<string,number>}>('/executions/import?timezone='+encodeURIComponent(zone),{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body:await selected.text()});setMessage(`导入完成：新增 ${result.added} 笔，更新 ${result.updated} 笔，重复 ${result.unchanged} 笔。跳过其他账户 ${result.skipped.other_accounts||0} 条、汇总 ${result.skipped.summaries||0} 条。`);await load();await onUpdated();}catch(e){setError(onError(e));}finally{setBusy(false);if(file.current)file.current.value='';}}
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog flex-dialog">
    <div className="auth-eyebrow"><Download size={14}/>EXECUTION ARCHIVE</div><Dialog.Title>补齐历史买卖点</Dialog.Title><Dialog.Description>从 IBKR Flex 读取逐笔成交，保存到本工作台并映射到 K 线。仅读取报表。</Dialog.Description>
    <div className="archive-overview"><div><small>已归档成交</small><strong>{status?.count.toLocaleString()??'—'}<em> 笔</em></strong></div><div><small>成交日期范围 · 美东</small><b>{day(status?.first??null)} — {day(status?.last??null)}</b><span>{status?.account||'需先连接 Gateway 确认账户'}</span></div></div>
    <p className="auth-hint">日期范围表示已保存成交的最早与最晚时间，不保证期间记录完整。</p>
    <fieldset disabled={busy||running||!status} className="flex-fields">
      <label className="field-label">报表时区 <span>必须与 IBKR 导出设置一致</span></label>
      <Select.Root value={zone} onValueChange={setZone}><Select.Trigger className="select" aria-label="报表时区"><Select.Value/><ChevronDown size={14}/></Select.Trigger><Select.Portal><Select.Content position="popper" className="select-menu"><Select.Viewport>{zones.map(([value,label])=><Select.Item key={value} value={value} className="select-item"><Select.ItemText>{label}</Select.ItemText><Select.ItemIndicator><Check size={12}/></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root>
      <section className="flex-step"><div className="flex-step-head"><b>01 / 报表文件导入</b><span>无需 Token</span></div><p>导入 Flex XML 或 CSV，最多 10 MB。重复导入自动去重。</p><input ref={file} hidden type="file" accept=".xml,.csv,text/csv,text/xml" aria-label="选择 Flex 报表" onChange={e=>{if(e.target.files?.[0])void upload(e.target.files[0]);}}/><button className="history-more" onClick={()=>file.current?.click()}><Upload size={14}/>选择成交报表</button></section>
      <section className="flex-step"><div className="flex-step-head"><b>02 / Flex 在线同步</b><span>{status?.configured?'已配置':'待配置'}</span></div><form onSubmit={save}><label className="field-label" htmlFor="flex-token">Flex Token <span>{status?.configured?'留空保留已保存的 Token':'不是 IBKR 登录密码'}</span></label><input id="flex-token" type="password" autoComplete="off" className="price-field" value={token} onChange={e=>setToken(e.target.value.trim())} maxLength={512} required={!status?.configured}/><label className="field-label" htmlFor="flex-query">Query ID</label><input id="flex-query" inputMode="numeric" pattern="[0-9]+" required maxLength={30} className="price-field" value={query} onChange={e=>setQuery(e.target.value.trim())}/><button className="history-more" type="submit">保存配置</button></form><div className="flex-sync"><label htmlFor="flex-days">最近天数</label><input id="flex-days" className="price-field" type="number" min={1} max={365} value={days} onChange={e=>setDays(e.target.value)}/><button className="primary" disabled={!status?.configured||!Number.isInteger(Number(days))||Number(days)<1||Number(days)>365} onClick={()=>void sync()}><Download size={14}/>同步历史</button></div><p className="auth-hint">在线请求最多 365 天；实际可取范围由 IBKR 和查询模板决定。更早成交可分段导出文件导入。报表不是实时数据。</p></section>
    </fieldset>
    {(busy||running)&&<p className="flex-progress" role="status"><LoaderCircle size={14} className="spin"/>{running?status?.job.message:'正在处理…'}</p>}
    {status?.job.state==='done'&&<p className="auth-success" role="status">同步完成：新增 {status.job.result?.added} 笔，更新 {status.job.result?.updated} 笔，重复 {status.job.result?.unchanged} 笔。跳过其他账户 {status.job.skipped?.other_accounts||0} 条、汇总 {status.job.skipped?.summaries||0} 条。</p>}
    {(error||status?.job.state==='error')&&<p className="inline-warning" role="alert">{error||status?.job.message}</p>}{message&&<p className="auth-success" role="status">{message}</p>}
    <details className="flex-guide"><summary>如何在 IBKR 创建报表？</summary><ol><li>Client Portal → Performance & Reports → Flex Queries，创建 Activity Flex Query。</li><li>添加 Trades，明细级别选 Executions，不选 Orders / Closed Lots。</li><li>包含 Account ID、IB Execution ID、Symbol、Conid、Asset Category、Currency、Date/Time、Buy/Sell、Quantity、Trade Price、Exchange；建议加入 IB Commission、佣金币种、Notes/Codes 和 Original Trade ID。</li><li>日期选 YYYYMMDD、时间 HHMMSS，并确认上方报表时区。导出 XML 或 CSV 即可导入。</li><li>在线同步还需启用 Flex Web Service，复制 Token 和 Query ID 到这里；Token 仅保存于服务端私有数据库，不返回浏览器。</li></ol><a href="https://www.ibkrguides.com/clientportal/performanceandstatements/tradeflex.htm" target="_blank" rel="noreferrer">IBKR 官方 Flex 设置说明 ↗</a></details>
    <Dialog.Close className="dialog-close" disabled={busy} aria-label="关闭"><X size={17}/></Dialog.Close>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
