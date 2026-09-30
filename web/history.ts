import { useCallback, useEffect, useRef, useState } from 'react';

export type Bar = { time: number|string; open: number; high: number; low: number; close: number; volume: number|null };
export type History = { con_id?:number|null; bars: Bar[]; source: string; cached: boolean; stale: boolean; warning: string|null; updated: number; symbol: string; period: string; rth: boolean; next_before: string };
type FetchPage = (query:string, signal:AbortSignal) => Promise<History>;

export function mergeOlder(current:History, older:History):History {
  if (current.symbol!==older.symbol || current.period!==older.period || current.rth!==older.rth) throw new Error('历史分页与当前标的不一致。');
  const bars = [...new Map([...older.bars,...current.bars].map(b=>[String(b.time),b])).values()]
    .sort((a,b)=>String(a.time).localeCompare(String(b.time),undefined,{numeric:true}));
  if (!bars.length || String(bars[0].time)===String(current.bars[0]?.time)) throw new Error('本次没有取得更早的 K 线，可重试或更换截止日期。');
  return {...current,bars,next_before:String(bars[0].time),cached:current.cached && older.cached,
    stale:current.stale || older.stale,warning:older.warning || current.warning};
}

export function preservedRange(range:{from:number;to:number}|null, previous:History|null, next:History) {
  if(!range || !previous?.bars.length)return null;
  const offset=next.bars.findIndex(b=>b.time===previous.bars[0].time);
  return offset<0?null:{from:range.from+offset,to:range.to+offset};
}

export function chartDate(value:number|string|{year:number;month:number;day:number}, options:Intl.DateTimeFormatOptions) {
  const date=typeof value==='number'?new Date(value*1000):new Date((typeof value==='string'?value:`${value.year}-${String(value.month).padStart(2,'0')}-${String(value.day).padStart(2,'0')}`)+'T12:00:00Z');
  return new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',...options}).format(date);
}

export function useHistory(queryKey:string, enabled:boolean, query:Record<string,string>, fetchPage:FetchPage, onError:(e:unknown)=>string) {
  const [result,setResult] = useState<{key:string;data:History}|null>(null);
  const [loading,setLoading] = useState(false), [error,setError] = useState('');
  const [loadingOlder,setLoadingOlder] = useState(false), [olderError,setOlderError] = useState('');
  const generation = useRef(0), current = useRef<History|null>(null), activeKey = useRef('');
  const pending = useRef<AbortController|null>(null), errorHandler = useRef(onError), parameters = useRef(query);
  errorHandler.current=onError;parameters.current=query;
  useEffect(()=>{
    const seq=++generation.current, controller=new AbortController();
    activeKey.current=queryKey;current.current=null;pending.current?.abort();pending.current=null;
    setResult(null);setError('');setOlderError('');setLoadingOlder(false);setLoading(enabled);
    if (enabled) {
      fetchPage(new URLSearchParams(parameters.current).toString(),controller.signal)
        .then(data=>{if(seq===generation.current){current.current=data;setResult({key:queryKey,data});setError(data.warning||'');}})
        .catch(e=>{if(seq===generation.current&&!controller.signal.aborted)setError(errorHandler.current(e));})
        .finally(()=>{if(seq===generation.current)setLoading(false);});
    }
    return ()=>{++generation.current;controller.abort();pending.current?.abort();pending.current=null;};
  },[queryKey,enabled,fetchPage]);
  const loadOlder=useCallback(async()=>{
    const page=current.current;
    if(!enabled || activeKey.current!==queryKey || !page?.next_before || pending.current)return;
    const seq=generation.current, controller=new AbortController();
    pending.current=controller;setLoadingOlder(true);setOlderError('');
    const {end:_,...base}=parameters.current;
    try {
      const older=await fetchPage(new URLSearchParams({...base,before:page.next_before}).toString(),controller.signal);
      if(seq!==generation.current)return;
      const data=mergeOlder(page,older);current.current=data;setResult({key:queryKey,data});
    } catch(e) {
      if(seq===generation.current&&!controller.signal.aborted)setOlderError(errorHandler.current(e));
    } finally {
      if(seq===generation.current){pending.current=null;setLoadingOlder(false);}
    }
  },[queryKey,enabled,fetchPage]);
  return {history:result?.key===queryKey?result.data:null,loading,chartError:error,loadingOlder,olderError,loadOlder};
}
