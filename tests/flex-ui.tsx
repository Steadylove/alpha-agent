// UI fixture only: no real credentials, network calls, accounts or persisted data.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FlexDialog} from '../web/FlexDialog';
import '../web/style.css';
function Fixture(){const [open,setOpen]=useState(true);const api=async<T,>():Promise<T>=>({account:'TEST-ONLY',configured:false,query_id:'',timezone:'America/New_York',count:0,first:null,last:null,revision:null,last_import:null,job:{state:'idle'}} as T);return <main style={{padding:40}}><h1>历史成交组件测试</h1><p>仅验证页面，不连接真实账户，不保存凭据。</p><button onClick={()=>setOpen(true)}>打开测试窗口</button>{open&&<FlexDialog api={api} onClose={()=>setOpen(false)} onUpdated={async()=>{}} onError={e=>String(e)}/>}</main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
