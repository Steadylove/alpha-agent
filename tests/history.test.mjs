import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOlder, preservedRange, chartDate } from '../web/history.ts';
const bar=(time,close=100)=>({time,open:100,high:102,low:98,close,volume:10});
const page=(times,extra={})=>({symbol:'SPY',period:'1d',rth:true,source:'IBKR',cached:false,stale:false,warning:null,updated:0,bars:times.map(t=>bar(t)),next_before:String(times[0]),...extra});

test('overlapping older pages preserve current prices and propagate stale cache status',()=>{
  const current=page(['2025-01-02','2025-01-03']);
  const older=page(['2025-01-02','2024-12-31'],{stale:true,cached:true});
  older.bars[0].close=99;
  const merged=mergeOlder(current,older);
  assert.deepEqual(merged.bars.map(b=>b.time),['2024-12-31','2025-01-02','2025-01-03']);
  assert.equal(merged.bars[1].close,100);
  assert.equal(merged.stale,true);
  assert.equal(merged.next_before,'2024-12-31');
});
test('rejects stalled cursors and mismatched symbol, period or session',()=>{
  const current=page(['2025-01-02']);
  assert.throws(()=>mergeOlder(current,page(['2025-01-02'])));
  for(const mismatch of [{symbol:'QQQ'},{period:'1h'},{rth:false}])assert.throws(()=>mergeOlder(current,page(['2024-12-31'],mismatch)));
});
test('prepended candles keep the same visible dates and zoom',()=>{
  const previous=page([200,300,400],{period:'1m'});
  const next=mergeOlder(previous,page([100,150],{period:'1m'}));
  const range=preservedRange({from:.25,to:2.5},previous,next);
  assert.deepEqual(range,{from:2.25,to:4.5});
  assert.equal(range.to-range.from,2.25);
  assert.equal(next.bars[Math.floor(range.from)].time,previous.bars[0].time);
  assert.equal(preservedRange(null,previous,next),null);
});
test('axis and crosshair use New York time including daylight saving and daily objects',()=>{
  assert.equal(chartDate(Date.parse('2025-03-10T13:30:00Z')/1000,{hour:'2-digit',minute:'2-digit',hour12:false}),'09:30');
  assert.equal(chartDate(Date.parse('2025-01-10T14:30:00Z')/1000,{hour:'2-digit',minute:'2-digit',hour12:false}),'09:30');
  assert.equal(chartDate({year:2025,month:3,day:10},{year:'numeric',month:'2-digit',day:'2-digit'}),'10/03/2025');
});

import { alignExecutions, tradeMarkers } from '../web/executions.ts';
const execution=(id,time,extra={})=>({id,time,symbol:'SPY',local_symbol:'SPY',con_id:123,type:'STK',currency:'USD',side:'BOT',quantity:10,price:100,exchange:'NYSE',commission:null,commission_currency:null,...extra});
const seconds=value=>Date.parse(value)/1000;

test('daily fills match New York dates and extended session never shifts into the next UTC day',()=>{
  const history=page(['2025-03-10','2025-03-11'],{rth:false});
  const map=alignExecutions(history,[execution('a','2025-03-11T00:15:00Z')]);
  assert.equal(map.matched,1);assert.equal(map.groups[0].time,'2025-03-10');
  assert.equal(alignExecutions({...history,rth:true},[execution('a','2025-03-11T00:15:00Z')]).matched,0);
});
test('regular-session eligibility follows both winter and summer UTC offsets',()=>{
  const winter=page(['2025-01-10']);const summer=page(['2025-03-10']);
  assert.equal(alignExecutions(winter,[execution('a','2025-01-10T14:30:00Z')]).matched,1);
  assert.equal(alignExecutions(winter,[execution('a','2025-01-10T14:29:59Z')]).matched,0);
  assert.equal(alignExecutions(summer,[execution('a','2025-03-10T13:30:00Z')]).matched,1);
  assert.equal(alignExecutions(summer,[execution('a','2025-03-10T13:29:59Z')]).matched,0);
});
test('intraday fills use actual IBKR opening bar boundaries and separate buy/sell',()=>{
  const start=seconds('2025-03-10T13:30:00Z');
  const map=alignExecutions(page([start,start+1800,start+5400],{period:'1h'}),[
    execution('a','2025-03-10T13:45:00Z'),execution('b','2025-03-10T14:00:00Z',{side:'SLD'}),execution('c','2025-03-10T14:10:00Z'),
  ]);
  assert.equal(map.matched,3);
  assert.deepEqual(map.groups.map(g=>[g.time,g.side]),[[start,'buy'],[start+1800,'buy'],[start+1800,'sell']]);
});
test('missing bars, missing days and interval boundaries never snap to an unrelated candle',()=>{
  const start=seconds('2025-03-10T13:30:00Z');
  const history=page([start,start+600],{period:'5m'});
  const result=alignExecutions(history,[execution('a','2025-03-10T13:34:59Z'),execution('gap','2025-03-10T13:35:00Z'),execution('early','2025-03-10T13:29:59Z'),execution('late','2025-03-10T13:45:00Z'),execution('other-day','2025-03-11T13:30:00Z')]);
  assert.equal(result.matched,1);assert.equal(result.unmapped,4);
  assert.equal(alignExecutions(page(['2025-03-10']),[execution('a','2025-03-11T13:30:00Z')]).matched,0);
});
test('closing auction may map to the last regular bar but later trades do not',()=>{
  const history=page([seconds('2025-03-10T19:30:00Z')],{period:'1h'});
  const result=alignExecutions(history,[execution('close','2025-03-10T20:00:00Z'),execution('after','2025-03-10T20:01:00Z')]);
  assert.equal(result.matched,1);assert.equal(result.groups[0].entries[0].id,'close');
});
test('only the displayed USD stock contract is eligible; options and missing price are excluded',()=>{
  const history=page(['2025-03-10'],{con_id:123});
  const time='2025-03-10T15:00:00Z';
  const rows=[execution('ok',time),execution('option',time,{type:'OPT'}),execution('foreign',time,{currency:'CAD'}),execution('other',time,{symbol:'QQQ'}),execution('other-contract',time,{con_id:456}),execution('price',time,{price:null}),execution('qty',time,{quantity:0}),execution('naive','2025-03-10T15:00:00'),execution('bad-time','brokenZ')];
  const map=alignExecutions(history,rows);
  assert.equal(map.eligible,1);assert.equal(map.matched,1);
});
test('fills deduplicate by execution ID and combine same-side quantities at weighted prices',()=>{
  const a=execution('a','2025-03-10T15:00:00Z',{quantity:2,price:100});
  const b=execution('b','2025-03-10T16:00:00Z',{quantity:3,price:110});
  const sell=execution('s','2025-03-10T17:00:00Z',{side:'SLD',quantity:1,price:120});
  const result=alignExecutions(page(['2025-03-10']),[b,a,a,sell]);
  assert.equal(result.matched,3);assert.equal(result.groups.length,2);
  const buy=result.groups.find(g=>g.side==='buy');assert.equal(buy.quantity,5);assert.equal(buy.price,106);
  assert.deepEqual(buy.entries.map(e=>e.id),['a','b']);assert.equal(buy.entries[0].price,100);
  const markers=tradeMarkers(result.groups);
  assert.deepEqual(markers.map(m=>[m.position,m.shape,m.price]),[['atPriceBottom','arrowUp',106],['atPriceTop','arrowDown',120]]);
  assert.equal(markers[0].text,'B 5');
});
test('loading older candles reveals earlier fills without inventing missing history',()=>{
  const fills=[execution('old','2025-03-07T15:00:00Z'),execution('new','2025-03-10T15:00:00Z')];
  const current=page(['2025-03-10']);
  assert.equal(alignExecutions(current,fills).matched,1);
  assert.equal(alignExecutions(mergeOlder(current,page(['2025-03-07'])),fills).matched,2);
  assert.deepEqual(alignExecutions(null,fills),{groups:[],matched:0,eligible:0,unmapped:0});
  assert.equal(alignExecutions(current,[]).groups.length,0);
});
