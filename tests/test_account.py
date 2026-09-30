import asyncio
import math
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock

import pytest
from ib_async import AccountValue, Contract, Position, PortfolioItem, PnL, PnLSingle, Execution, CommissionReport, Fill
from desk.account import AccountData, number, position_rows
from desk.broker import Broker
from desk.config import Settings
from desk.store import Store


def value(tag, amount, currency='USD', account='U1', model=''):
    return AccountValue(account, tag, str(amount), currency, model)


@pytest.mark.parametrize('prefix', ['', '$LEDGER-'])
def test_prefixed_and_legacy_ledgers_use_base_totals(prefix):
    data=AccountData('U1', [value('NetLiquidation', 12000, 'EUR'),
        value(prefix+'Currency','EUR','BASE'), value(prefix+'UnrealizedPnL',75,'BASE'),
        value(prefix+'UnrealizedPnL',99,'USD'), value(prefix+'RealizedPnL',0,'BASE'),
        value(prefix+'CashBalance',1100,'USD'),value(prefix+'CashBalance',500,'EUR'),
        value(prefix+'CashBalance',1490,'BASE')])
    b=data.balances(PnL(account='U1',dailyPnL=-7,unrealizedPnL=76,realizedPnL=5))
    assert b['currency']=='EUR' and b['net_liquidation']==12000
    assert b['unrealized']==75 and b['realized']==0 and b['daily']==-7
    assert b['pnl_source']=='account-ledger' and b['portfolio_unrealized']==76
    assert {r['currency']:r['cash'] for r in data.currencies()}=={'EUR':500,'USD':1100}


def test_mixed_currencies_never_use_usd_ledger_as_base_pnl():
    data=AccountData('U1',[value('NetLiquidation',1000,'HKD'),value('$LEDGER-UnrealizedPnL',30,'USD')])
    assert data.currency=='HKD' and data.balances()['unrealized'] is None
    assert data.balances(PnL(unrealizedPnL=235))['unrealized']==235


def test_current_values_override_summary_and_isolate_account_and_model():
    data=AccountData('U1',[value('TotalCashValue',0),value('InitMarginReq',20),
         value('NetLiquidation',999,'USD','U2'),value('NetLiquidation',500,'USD','U1','MODEL'),
         value('$LEDGER-RealCurrency','USD','BASE')],
         [value('NetLiquidation',100),value('TotalCashValue',50),value('UnrealizedPnL',8,'BASE')])
    b=data.balances()
    assert b['cash']==0 and b['net_liquidation']==100 and b['initial_margin']==20
    assert b['unrealized']==8
    fields={f['tag']:f for f in data.fields()}
    assert fields['TotalCashValue']['source']=='AccountUpdates'
    assert fields['NetLiquidation']['value']=='100'


@pytest.mark.parametrize('invalid',[None,'', 'bad',float('nan'),float('inf'),-float('inf'),1.7976931348623157e308,2147483647])
def test_ib_unset_values_are_not_money(invalid):
    assert number(invalid) is None


def test_zero_negative_and_unlimited_are_preserved():
    assert number('0')==0 and number('-1')==-1
    data=AccountData('U1',[value('DayTradesRemaining',-1),value('NetLiquidation',100)])
    assert data.balances()['day_trades_remaining']==-1
    assert data.balances()['daily'] is None


def test_portfolio_keeps_options_and_uses_contract_multiplier_and_signed_basis():
    stock=Contract(conId=1,symbol='ABC',secType='STK',currency='USD')
    option=Contract(conId=2,symbol='ABC',localSymbol='ABC C100',secType='OPT',currency='USD',multiplier='100',strike=100,right='C',lastTradeDateOrContractMonth='20261016')
    foreign=Contract(conId=3,symbol='DEF',secType='STK',currency='EUR')
    positions=[Position('U1',stock,10,100),Position('U1',option,-2,250),Position('U1',foreign,5,20),Position('U2',stock,1000,100)]
    portfolio=[PortfolioItem(stock,10,110,1100,100,100,0,'U1'),PortfolioItem(option,-2,1.5,-300,250,200,0,'U1'),PortfolioItem(stock,1000,900,900000,100,12345,0,'U2')]
    pnl={2:PnLSingle(account='U1',conId=2,dailyPnL=-10),3:PnLSingle(account='U1',conId=3,dailyPnL=50)}
    rows={r['con_id']:r for r in position_rows(positions,portfolio,'U1','USD',pnl,{1:1000})}
    assert len(rows)==3 and rows[1]['unrealized']==100 and rows[1]['updated']==1000
    assert rows[1]['can_chart'] and not rows[2]['can_chart']
    assert rows[2]['average_cost']==2.5 and rows[2]['cost_basis']==-500
    assert rows[2]['market_value']==-300 and rows[2]['unrealized_pct']==40
    assert rows[2]['daily']==-10 and rows[2]['expiry']=='20261016'
    assert rows[3]['market_value'] is None and rows[3]['daily'] is None


def test_unknown_multiplier_is_not_guessed_and_closed_positions_are_removed():
    future=Contract(conId=1,symbol='ES',secType='FUT',currency='USD')
    positions=[Position('U1',future,1,1000),Position('U1',Contract(conId=2),0,0)]
    rows=position_rows(positions,[],'U1','USD',{}, {})
    assert len(rows)==1 and rows[0]['average_cost'] is None
    assert rows[0]['unrealized_pct'] is None


def test_pnl_subscriptions_follow_positions_and_clear_on_disconnect(tmp_path):
    async def run():
        store=Store(str(tmp_path/'test.db'))
        broker=Broker(Settings(client_id=72),store)
        broker.ib.isConnected=Mock(return_value=True)
        broker.ib.managedAccounts=Mock(return_value=['U1'])
        broker.ib.disconnect=Mock()
        positions=[Position('U1',Contract(conId=1),1,10),Position('U2',Contract(conId=9),1,10)]
        broker.ib.positions=Mock(side_effect=lambda _:positions)
        broker.ib.reqPnLSingle=Mock(side_effect=lambda account,model,con_id:PnLSingle(account=account,conId=con_id))
        broker.ib.cancelPnLSingle=Mock()
        try:
            broker.ready=True
            broker.sync_position_pnls();broker.sync_position_pnls()
            broker.ib.reqPnLSingle.assert_called_once_with('U1','',1)
            positions[:]=[Position('U1',Contract(conId=2),1,10)]
            broker.sync_position_pnls()
            broker.ib.cancelPnLSingle.assert_called_once_with('U1','',1)
            assert set(broker.position_pnls)=={2}
            broker.account_pnl=PnL(account='U1');broker.account_updated=123;broker.pnl_updated=124
            broker.on_account_summary(value('NetLiquidation',100))
            broker.disconnected()
            assert not broker.position_pnls and not broker.summary_values
            assert broker.account_pnl is None and broker.pnl_updated is None and broker.account_updated is None
        finally:await broker.close()
    asyncio.run(run())


def test_execution_fees_account_scope_and_refresh_throttle(tmp_path):
    async def run():
        store=Store(str(tmp_path/'test.db'))
        broker=Broker(Settings(client_id=72),store)
        broker.ib.isConnected=Mock(return_value=True)
        broker.ib.managedAccounts=Mock(return_value=['U1'])
        broker.ib.disconnect=Mock()
        when=datetime.now(timezone.utc)
        contract=Contract(conId=1,symbol='ABC',currency='USD',secType='STK')
        def fill(exec_id,account,commission):
            e=Execution(execId=exec_id,time=when,acctNumber=account,side='BOT',shares=1,price=10)
            return Fill(contract,e,commission,when)
        broker.ib.fills=Mock(return_value=[fill('a','U1',CommissionReport()),fill('b','U1',CommissionReport(execId='b',commission=0,currency='USD')),fill('c','U2',CommissionReport())])
        broker.ib.reqExecutionsAsync=AsyncMock(return_value=[])
        try:
            broker.ready=True
            rows={r['id']:r for r in broker.execution_rows()}
            assert set(rows)=={'a','b'} and rows['a']['commission'] is None and rows['b']['commission']==0
            assert rows['a']['con_id']==1 and rows['a']['type']=='STK'
            await broker.refresh_executions();await broker.refresh_executions()
            assert broker.ib.reqExecutionsAsync.await_count==1
            assert broker.ib.reqExecutionsAsync.call_args.args[0].acctCode=='U1'
            broker.ready=False
            assert broker.execution_rows()==[]
            with pytest.raises(ValueError):await broker.refresh_executions()
        finally:await broker.close()
    asyncio.run(run())
