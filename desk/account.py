"""Currency-aware account read models. BASE totals and currency ledgers stay separate."""
import math


def number(value):
    try:
        value=float(value)
        # IB uses max double/int as unset sentinels, in addition to NaN.
        return value if math.isfinite(value) and abs(value)<1e100 and value!=2147483647 else None
    except (TypeError,ValueError,OverflowError):
        return None


class AccountData:
    def __init__(self, account, values, summary=()):
        self.values={(v.tag,v.currency):v.value for v in values if v.account==account and not v.modelCode}
        self.summary={(v.tag,v.currency):v.value for v in summary if v.account==account and not v.modelCode}
        self.currency='BASE'
        for tag in ('$LEDGER-RealCurrency','$LEDGER-Currency','RealCurrency','Currency'):
            value=self.values.get((tag,'BASE'))
            if value and len(value)==3 and value!='BASE':
                self.currency=value
                break
        if self.currency=='BASE':
            for source in (self.values,self.summary):
                codes={ccy for tag,ccy in source if tag=='NetLiquidation' and ccy and ccy!='BASE'}
                if len(codes)==1:
                    self.currency=codes.pop()
                    break

    def aggregate(self, tag):
        for source in (self.values,self.summary):
            for ccy in ('BASE',self.currency,''):
                value=number(source.get((tag,ccy)))
                if value is not None:return value
        return None

    def text(self, tag):
        for source in (self.values,self.summary):
            for ccy in ('',self.currency,'BASE'):
                value=source.get((tag,ccy))
                if value is not None:return value
        return None

    def ledger(self, tag, ccy):
        for source in (self.values,self.summary):
            for key in ('$LEDGER-'+tag,tag):
                value=number(source.get((key,ccy)))
                if value is not None:return value
        return None

    def balances(self, pnl=None):
        unrealized=self.ledger('UnrealizedPnL','BASE')
        realized=self.ledger('RealizedPnL','BASE')
        live_unrealized=number(getattr(pnl,'unrealizedPnL',None))
        live_realized=number(getattr(pnl,'realizedPnL',None))
        fields={'net_liquidation':'NetLiquidation','cash':'TotalCashValue','available':'AvailableFunds',
                'buying_power':'BuyingPower','settled_cash':'SettledCash','gross_position_value':'GrossPositionValue',
                'equity_with_loan':'EquityWithLoanValue','initial_margin':'InitMarginReq','maintenance_margin':'MaintMarginReq',
                'excess_liquidity':'ExcessLiquidity','cushion':'Cushion','sma':'SMA',
                'accrued_interest':'AccruedCash','accrued_dividend':'AccruedDividend',
                'lookahead_available':'LookAheadAvailableFunds','lookahead_excess':'LookAheadExcessLiquidity',
                'lookahead_initial_margin':'LookAheadInitMarginReq','lookahead_maintenance_margin':'LookAheadMaintMarginReq',
                'lookahead_change':'LookAheadNextChange','day_trades_remaining':'DayTradesRemaining'}
        result={name:self.aggregate(tag) for name,tag in fields.items()}
        result.update(currency=self.currency,account_type=self.text('AccountType'),
                      account_ready=self.text('AccountReady'),
                      unrealized=unrealized if unrealized is not None else live_unrealized,
                      realized=realized if realized is not None else live_realized,
                      daily=number(getattr(pnl,'dailyPnL',None)),
                      pnl_source='account-ledger' if unrealized is not None else 'portfolio-stream',
                      portfolio_unrealized=live_unrealized,portfolio_realized=live_realized,
                      leverage=self.aggregate('Leverage') if self.aggregate('Leverage') is not None else self.aggregate('Leverage-S'))
        return result

    def currencies(self):
        tags={'CashBalance','TotalCashBalance','NetLiquidationByCurrency','ExchangeRate'}
        currencies=sorted({ccy for source in (self.values,self.summary) for tag,ccy in source
                           if tag.removeprefix('$LEDGER-') in tags and ccy and ccy!='BASE'})
        rows=[]
        for ccy in currencies:
            row={'currency':ccy}
            for name,tag in {'cash':'CashBalance','total_cash':'TotalCashBalance','net_liquidation':'NetLiquidationByCurrency',
                             'exchange_rate':'ExchangeRate','stock_value':'StockMarketValue','option_value':'OptionMarketValue',
                             'unrealized':'UnrealizedPnL','realized':'RealizedPnL','accrued_interest':'AccruedCash'}.items():
                row[name]=self.ledger(tag,ccy)
            rows.append(row)
        return rows

    def fields(self):
        # Keep prefix, source and currency visible so aggregates cannot be mistaken for ledgers.
        combined={(tag,ccy):{'tag':tag,'currency':ccy,'value':value,'source':'AccountSummary'} for (tag,ccy),value in self.summary.items()}
        combined.update({(tag,ccy):{'tag':tag,'currency':ccy,'value':value,'source':'AccountUpdates'} for (tag,ccy),value in self.values.items()})
        return [combined[key] for key in sorted(combined)]


def position_rows(positions, portfolio, account, currency, pnl_singles, timestamps):
    marks={p.contract.conId:p for p in portfolio if p.account==account}
    output=[]
    for p in positions:
        if p.account!=account or not p.position:continue
        c=p.contract;mark=marks.get(c.conId);single=pnl_singles.get(c.conId)
        qty=number(p.position);cost=number(p.avgCost)
        multiplier=number(c.multiplier) if c.multiplier else (1 if c.secType in ('STK','CASH','CRYPTO') else None)
        unit_cost=cost/multiplier if cost is not None and multiplier and multiplier>0 else None
        # Portfolio valuation is in the contract currency; never substitute a live quote.
        unrealized=number(getattr(mark,'unrealizedPNL',None))
        basis=abs(qty*cost) if qty is not None and cost is not None else None
        output.append({'symbol':c.symbol,'local_symbol':c.localSymbol or c.symbol,'con_id':c.conId,'type':c.secType,
                       'currency':c.currency,'quantity':qty,'average_cost':unit_cost,'cost_basis':qty*cost if qty is not None and cost is not None else None,
                       'multiplier':multiplier,'market_price':number(getattr(mark,'marketPrice',None)),
                       'market_value':number(getattr(mark,'marketValue',None)),'unrealized':unrealized,
                       'unrealized_pct':100*unrealized/basis if unrealized is not None and basis else None,
                       'realized':number(getattr(mark,'realizedPNL',None)),
                       # Without an explicit currency in pnlSingle, show this only for base-currency instruments.
                       'daily':number(getattr(single,'dailyPnL',None)) if c.currency==currency else None,
                       'expiry':c.lastTradeDateOrContractMonth or None,'strike':number(c.strike) if c.secType in ('OPT','FOP') else None,
                       'right':c.right or None,'updated':timestamps.get(c.conId),
                       'can_chart':c.secType=='STK' and c.currency=='USD'})
    return sorted(output,key=lambda row:(row['type']!='STK',row['symbol'],row['local_symbol']))
