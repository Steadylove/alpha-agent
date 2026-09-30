import asyncio
import time
from contextlib import suppress
from datetime import datetime, timezone
from ib_async import IB, Stock, ExecutionFilter


from .account import AccountData, number, position_rows


class Broker:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.ib = IB()
        self.ib.RaiseRequestErrors = True
        self.ready = False
        self.want_connection = False
        self.error = ''
        self.market_error = ''
        self.contracts = {}
        self.ticker = None
        self.quote_symbol = ''
        self.account_pnl = None
        self.position_pnls = {}
        self.summary_values = {}
        self.portfolio_timestamps = {}
        self.account_updated = None
        self.pnl_updated = None
        self.executions_updated = None
        self.pnl_error = ''
        self.executions_lock = asyncio.Lock()
        self.connect_lock = asyncio.Lock()
        self.history_lock = asyncio.Lock()
        self.quote_lock = asyncio.Lock()
        self.ib.disconnectedEvent += self.disconnected
        self.ib.errorEvent += self.on_error
        self.ib.orderStatusEvent += self.on_trade
        self.ib.execDetailsEvent += self.on_execution
        self.ib.commissionReportEvent += self.on_commission
        self.ib.accountValueEvent += self.on_account_value
        self.ib.accountSummaryEvent += self.on_account_summary
        self.ib.updatePortfolioEvent += self.on_portfolio
        self.ib.positionEvent += self.on_position
        self.ib.pnlEvent += self.on_pnl
        self.worker = asyncio.create_task(self.reconnect_loop())

    @property
    def account(self):
        accounts = self.ib.managedAccounts() if self.ib.isConnected() else []
        if self.settings.account:
            return self.settings.account if self.settings.account in accounts else ''
        return accounts[0] if len(accounts) == 1 else ''

    @property
    def can_order(self):
        # Read-only is a product invariant, independent of account type or environment.
        return False

    def disconnected(self):
        self.ready = False
        self.ticker = None
        self.quote_symbol = ''
        self.contracts.clear()
        self.account_pnl = None
        self.position_pnls.clear()
        self.summary_values.clear()
        self.portfolio_timestamps.clear()
        self.account_updated = self.pnl_updated = self.executions_updated = None
        self.pnl_error = ''

    def on_account_value(self, value):
        if value.account == self.account:
            self.account_updated = time.time()

    def on_account_summary(self, value):
        self.summary_values[(value.account, value.tag, value.currency, value.modelCode)] = value

    def on_portfolio(self, item):
        if item.account == self.account:
            self.portfolio_timestamps[item.contract.conId] = time.time()

    def on_position(self, position):
        if self.ready and position.account == self.account:
            self.sync_position_pnls()

    def on_pnl(self, pnl):
        if pnl.account == self.account:
            self.pnl_updated = time.time()

    def sync_position_pnls(self):
        wanted = {p.contract.conId for p in self.ib.positions(self.account) if p.account == self.account and p.position}
        for con_id in set(self.position_pnls) - wanted:
            self.ib.cancelPnLSingle(self.account, '', con_id)
            self.position_pnls.pop(con_id, None)
        for con_id in wanted - set(self.position_pnls):
            self.position_pnls[con_id] = self.ib.reqPnLSingle(self.account, '', con_id)

    def on_error(self, req_id, code, message, contract=None):
        if req_id in self.ib.wrapper.reqId2PnL or req_id in self.ib.wrapper.reqId2PnlSingle:
            self.pnl_error = f'盈亏订阅暂不可用（IBKR {code}），可用账户账本数据仍会显示。'
        if code in (1100, 1300):
            self.ready = False
            self.error = '券商连接中断，恢复后将重新核对账户与订单。'
            self.ib.disconnect()
        elif code in (354, 10167, 10168, 10089, 10090):
            self.market_error = f'行情权限或订阅不可用（IBKR {code}），请检查账户行情权限。'

    def on_execution(self, trade, fill):
        self.executions_updated = time.time()
        self.on_trade(trade)
        self.archive_executions()

    def on_commission(self, trade, fill, report):
        self.archive_executions()

    def archive_executions(self):
        if self.ready and self.account:
            self.store.archive.upsert(self.account, self.execution_rows(limit=None), 'gateway')

    def on_trade(self, trade):
        ref = trade.order.orderRef or ''
        if not ref.startswith('desk-'):
            return
        key = ref[5:]
        row = self.store.order(key)
        if not row or row['payload']['account'] != trade.order.account:
            return
        status = trade.orderStatus
        self.store.record(key, status.status or 'UNKNOWN', {
            'order_id': trade.order.orderId, 'perm_id': trade.order.permId,
            'state': status.status, 'filled': number(status.filled), 'remaining': number(status.remaining),
            'average_price': number(status.avgFillPrice),
        })

    async def reconnect_loop(self):
        try:
            while True:
                await asyncio.sleep(10)
                if self.want_connection and not self.ready:
                    try:
                        await self.connect()
                    except Exception:
                        pass
        except asyncio.CancelledError:
            pass

    async def close(self):
        self.want_connection = False
        self.worker.cancel()
        with suppress(asyncio.CancelledError):
            await self.worker
        self.ib.disconnect()

    async def connect(self):
        self.want_connection = True
        async with self.connect_lock:
            if self.ready and self.ib.isConnected():
                return
            self.ready = False
            self.error = ''
            try:
                if self.ib.isConnected():
                    self.ib.disconnect()
                if self.settings.client_id <= 0:
                    raise ValueError('IB_CLIENT_ID 必须大于 0，避免自动绑定其他客户端的委托。')
                # Skip order-binding/synchronization requests that require write access on the Gateway.
                await self.ib.connectAsync(self.settings.host, self.settings.port, clientId=self.settings.client_id,
                    timeout=8, readonly=True, account=self.settings.account)
                if not self.account:
                    raise ValueError('账户未明确：请在 IB_ACCOUNT 中填写要查看的账户。')
                await asyncio.wait_for(self.ib.reqAccountSummaryAsync(), timeout=12)
                self.ib.reqMarketDataType(1 if self.settings.data_mode == 'real' else 3)
                self.market_error = ''
                self.ready = True
                self.archive_executions()
                self.executions_updated = time.time()
                try:
                    self.account_pnl = self.ib.reqPnL(self.account)
                    self.sync_position_pnls()
                except Exception:
                    self.pnl_error = '盈亏订阅尚未就绪，暂显示账户账本中可用的盈亏。'
            except Exception as error:
                self.error = str(error) if isinstance(error, ValueError) else '未能连接 IB Gateway。请完成登录、启用 Socket API，并检查端口与客户端编号。'
                self.ib.disconnect()
                raise ValueError(self.error) from error

    async def contract(self, symbol):
        if not self.ready or not self.ib.isConnected():
            raise ValueError('IB Gateway 尚未连接。')
        if symbol not in self.contracts:
            result = await asyncio.wait_for(self.ib.qualifyContractsAsync(Stock(symbol, 'SMART', 'USD')), timeout=12)
            if len(result) != 1 or result[0].secType != 'STK' or result[0].currency != 'USD':
                raise ValueError('没有找到唯一的美元股票或 ETF 合约。')
            self.contracts[symbol] = result[0]
        return self.contracts[symbol]

    async def history(self, symbol, bar, duration, end, rth):
        contract = await self.contract(symbol)
        async with self.history_lock:
            bars = await self.ib.reqHistoricalDataAsync(contract, endDateTime=end or '', durationStr=duration,
                barSizeSetting=bar, whatToShow='TRADES', useRTH=rth, formatDate=2, timeout=25)
            await asyncio.sleep(0.3)
        output = []
        for item in bars:
            stamp = int(item.date.timestamp()) if isinstance(item.date, datetime) else item.date.isoformat()
            prices = [number(getattr(item, field)) for field in ('open', 'high', 'low', 'close')]
            if any(value is None for value in prices):
                continue
            output.append(dict(time=stamp, open=prices[0], high=prices[1], low=prices[2], close=prices[3], volume=number(item.volume)))
        return output

    async def quote(self, symbol):
        async with self.quote_lock:
            contract = await self.contract(symbol)
            if self.quote_symbol != symbol:
                if self.ticker is not None:
                    self.ib.cancelMktData(self.ticker.contract)
                self.market_error = ''
                self.ticker = self.ib.reqMktData(contract, '', False, False)
                self.quote_symbol = symbol
        return self.current_quote()

    def current_quote(self):
        if not self.ticker or not self.ready:
            return None
        ticker = self.ticker
        def price(value):
            result = number(value)
            return result if result is not None and result > 0 else None
        def size(value):
            result = number(value)
            return result if result is not None and result >= 0 else None
        return {
            'symbol': self.quote_symbol, 'bid': price(ticker.bid), 'ask': price(ticker.ask),
            'last': price(ticker.last), 'close': price(ticker.close), 'volume': size(ticker.volume),
            'open':price(ticker.open),'high':price(ticker.high),'low':price(ticker.low),
            'bid_size':size(ticker.bidSize),'ask_size':size(ticker.askSize),'last_size':size(ticker.lastSize),
            'vwap':price(ticker.vwap),
            'time': ticker.time.isoformat() if ticker.time else None,
            'kind': {1: 'real', 2: 'frozen', 3: 'delayed', 4: 'delayed-frozen'}.get(ticker.marketDataType, 'unknown') if ticker.time else 'unknown',
            'error': self.market_error or None,
        }

    def execution_rows(self, limit=200):
        if not self.ready:return []
        rows=[]
        for fill in self.ib.fills():
            e=fill.execution;c=fill.contract;fee=fill.commissionReport
            if e.acctNumber!=self.account:continue
            fee_ready=bool(fee.execId and fee.execId==e.execId)
            rows.append({'id':e.execId,'symbol':c.symbol,'local_symbol':c.localSymbol or c.symbol,
                         'con_id':c.conId,'type':c.secType,'side':e.side,'quantity':number(e.shares),'price':number(e.price),
                         'currency':c.currency,'exchange':e.exchange,'time':e.time.isoformat(),
                         'commission':number(fee.commission) if fee_ready else None,
                         'commission_currency':fee.currency if fee_ready else None})
        return sorted(rows,key=lambda row:row['time'],reverse=True)[:limit]

    async def refresh_executions(self):
        if not self.ready:raise ValueError('请先连接 IB Gateway。')
        async with self.executions_lock:
            if not self.executions_updated or time.time()-self.executions_updated>15:
                try:
                    await asyncio.wait_for(self.ib.reqExecutionsAsync(ExecutionFilter(acctCode=self.account)),timeout=15)
                except Exception as exc:
                    raise ValueError('券商成交同步未完成，请稍后重试；已有数据保持不变。') from exc
                self.executions_updated=time.time()
        self.archive_executions()
        return {'executions':self.execution_rows(),'updated':self.executions_updated}

    def snapshot(self):
        account=self.account
        connected=bool(self.ready and self.ib.isConnected())
        data=AccountData(account,self.ib.accountValues(account) if connected else [],self.summary_values.values() if connected else [])
        balances=data.balances(self.account_pnl if connected else None)
        positions=position_rows(self.ib.positions(account),self.ib.portfolio(account),account,data.currency,self.position_pnls,self.portfolio_timestamps) if connected else []
        return {
            'connected':connected,'connecting':self.connect_lock.locked(),
            'account':account if connected else None,
            'mode':('paper' if account.startswith('DU') else 'live-readonly') if account else 'disconnected',
            'can_order':self.can_order,'error':self.error or None,
            'data_mode':self.settings.data_mode,'read_only':True,
            'permissions':{'place_orders':False,'modify_orders':False,'cancel_orders':False,'exercise_options':False,'withdraw':False,'transfer':False},
            'balances':balances,'currencies':data.currencies(),'account_fields':data.fields(),
            'account_updated':self.account_updated,'pnl_updated':self.pnl_updated,'pnl_error':self.pnl_error or None,
            'working_orders':[{'symbol':t.contract.symbol,'con_id':t.contract.conId,'side':t.order.action,'remaining':number(t.orderStatus.remaining) if number(t.orderStatus.remaining) is not None else number(t.order.totalQuantity),'ref':t.order.orderRef} for t in self.ib.openTrades() if t.order.account==account and t.contract.secType=='STK'],
            'positions':positions,'quote':self.current_quote(),'orders':self.store.orders(),
            'executions':self.execution_rows(),'executions_updated':self.executions_updated,
            'as_of':datetime.now(timezone.utc).isoformat(),
        }
