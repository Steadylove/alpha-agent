import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, ColorType, TickMarkType, type IChartApi, type ISeriesApi, type Time, type MouseEventParams, type ISeriesMarkersPluginApi } from 'lightweight-charts';
import { preservedRange, chartDate, type History } from './history';
import { tradeMarkers, tradeNumber, tradeTime, type TradeGroup } from './executions';

export function Chart({history,period,onOlder,canLoadOlder,trades,showTrades,selectedTrade,focusRequest=0}:{history:History|null;period:string;onOlder:()=>void;canLoadOlder:boolean;trades:TradeGroup[];showTrades:boolean;selectedTrade:string|null;focusRequest?:number}) {
  const box=useRef<HTMLDivElement>(null), chart=useRef<IChartApi|null>(null);
  const candles=useRef<ISeriesApi<'Candlestick'>|null>(null), volume=useRef<ISeriesApi<'Histogram'>|null>(null);
  const markers=useRef<ISeriesMarkersPluginApi<Time>|null>(null);
  const tradeRef=useRef(trades),showRef=useRef(showTrades);
  tradeRef.current=trades;showRef.current=showTrades;
  const [hoverTime,setHoverTime]=useState<string|null>(null);
  const hoverGroups=showTrades?trades.filter(g=>String(g.time)===hoverTime):[];
  const prior=useRef<History|null>(null), updating=useRef(false), userIntent=useRef(false);
  const loader=useRef(onOlder), allowed=useRef(canLoadOlder);
  loader.current=onOlder;allowed.current=canLoadOlder;
  useLayoutEffect(()=>{
    if(!box.current)return;
    const instance=createChart(box.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#fcfcf9'},textColor:'#737971',fontFamily:'Avenir Next, sans-serif',fontSize:11,attributionLogo:true},grid:{vertLines:{color:'#eceee7'},horzLines:{color:'#eceee7'}},rightPriceScale:{borderColor:'#e2e5da'},timeScale:{borderColor:'#e2e5da',timeVisible:period!=='1d',secondsVisible:false,tickMarkFormatter:(stamp:Time,kind:TickMarkType)=>chartDate(stamp,kind===TickMarkType.Year?{year:'numeric'}:kind===TickMarkType.Month?{month:'short'}:kind===TickMarkType.DayOfMonth?{day:'numeric',month:'short'}:{hour:'2-digit',minute:'2-digit',hour12:false})},localization:{timeFormatter:(stamp:Time)=>chartDate(stamp,typeof stamp==='number'?{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}:{year:'numeric',month:'2-digit',day:'2-digit'})+' ET'},crosshair:{vertLine:{color:'#6a8a6b'},horzLine:{color:'#6a8a6b'}}});
    chart.current=instance;
    candles.current=instance.addSeries(CandlestickSeries,{upColor:'#326b56',downColor:'#b36650',borderVisible:false,wickUpColor:'#326b56',wickDownColor:'#b36650'});
    markers.current=createSeriesMarkers(candles.current,[],{autoScale:true,zOrder:'top'});
    candles.current.priceScale().applyOptions({scaleMargins:{top:.1,bottom:.23}});
    volume.current=instance.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume'});
    volume.current.priceScale().applyOptions({scaleMargins:{top:.84,bottom:0}});
    const changed=()=>{
      const range=instance.timeScale().getVisibleLogicalRange();
      if(range && range.from<15 && !updating.current && userIntent.current && allowed.current){
        // Loading and programmatic range restoration must not cascade through all history.
        userIntent.current=false;loader.current();
      }
    };
    const hover=(event:MouseEventParams<Time>)=>{
      if(!showRef.current || !event.point || event.time===undefined){setHoverTime(null);return;}
      const stamp=typeof event.time==='object'?`${event.time.year}-${String(event.time.month).padStart(2,'0')}-${String(event.time.day).padStart(2,'0')}`:String(event.time);
      setHoverTime(tradeRef.current.some(g=>String(g.time)===stamp)?stamp:null);
    };
    instance.subscribeCrosshairMove(hover);
    instance.timeScale().subscribeVisibleLogicalRangeChange(changed);
    return ()=>{instance.unsubscribeCrosshairMove(hover);instance.timeScale().unsubscribeVisibleLogicalRangeChange(changed);markers.current?.detach();markers.current=null;instance.remove();chart.current=null;candles.current=null;volume.current=null;prior.current=null;};
  },[period]);
  useLayoutEffect(()=>{
    const instance=chart.current;
    if(!instance || !candles.current || !volume.current || !history?.bars.length)return;
    const range=instance.timeScale().getVisibleLogicalRange();
    const restored=preservedRange(range,prior.current,history);
    updating.current=true;userIntent.current=false;
    candles.current.setData(history.bars.map(b=>({...b,time:b.time as Time})));
    volume.current.setData(history.bars.filter(b=>b.volume!=null&&b.volume>=0).map(b=>({time:b.time as Time,value:b.volume!,color:b.close>=b.open?'#326b5638':'#b3665038'})));
    if(restored)instance.timeScale().setVisibleLogicalRange(restored);
    else instance.timeScale().fitContent();
    prior.current=history;updating.current=false;
  },[history]);
  useLayoutEffect(()=>{markers.current?.setMarkers(showTrades?tradeMarkers(trades):[]);},[history,trades,showTrades,period]);
  useEffect(()=>{
    if(!selectedTrade || !chart.current || !history)return;
    const group=tradeRef.current.find(g=>g.id===selectedTrade);
    if(!group)return;
    const index=history.bars.findIndex(b=>b.time===group.time);
    if(index<0)return;
    updating.current=true;userIntent.current=false;
    chart.current.timeScale().setVisibleLogicalRange({from:Math.max(-1,index-15),to:index+15});
    updating.current=false;setHoverTime(String(group.time));
  },[selectedTrade,focusRequest]);
  useEffect(()=>{if(!canLoadOlder)userIntent.current=false;},[canLoadOlder]);
  const intent=()=>{if(allowed.current)userIntent.current=true;};
  return <div className="chart-surface" onPointerDown={intent} onPointerMove={e=>{if(e.buttons)intent();}} onWheelCapture={intent}>
    <div className="chart-canvas" ref={box} aria-label="历史 K 线图，可拖动向前浏览；绿色 B 为买入，橙色 S 为卖出"/>
    {hoverGroups.length>0&&<div className="trade-tooltip" role="status"><strong>成交记录 · {history?.symbol}</strong>{hoverGroups.map(g=><div key={g.id}><b className={g.side==='buy'?'positive':'negative'}>{g.side==='buy'?'B 买入':'S 卖出'} {tradeNumber(g.quantity)} 股</b><span>{g.entries.length>1?'加权均价':'成交价'} {tradeNumber(g.price)} USD · {g.entries.length} 笔</span><small>{tradeTime(g.entries[0].time)}{g.entries.length>1?' 起':''}</small></div>)}</div>}
  </div>;
}
