import asyncio
import csv
import io
import json
from unittest.mock import Mock
import pytest
from desk.executions import parse_report, timestamp, ExecutionArchive, MAX_REPORT
from desk.flex import FlexService, envelope, download
from test_desk import client, login


def report(*rows, account='DU123456'):
    from xml.sax.saxutils import quoteattr
    attributes={'accountId':account,'ibExecID':'0001.2222.3333.01','symbol':'SPY','conid':'123',
                'assetCategory':'STK','currency':'USD','dateTime':'20250929;103012','buySell':'BUY',
                'quantity':'10','tradePrice':'600.25','levelOfDetail':'EXECUTION','ibCommission':'-1','ibCommissionCurrency':'USD'}
    trades=''.join('<Trade '+ ' '.join(k+'='+quoteattr(str(v)) for k,v in {**attributes,**r}.items()) + '/>' for r in (rows or ({},)))
    return '<FlexQueryResponse><FlexStatements><FlexStatement accountId="'+account+'"><Trades>'+trades+'</Trades></FlexStatement></FlexStatements></FlexQueryResponse>'


def parsed(content=None):
    return parse_report(content or report(), 'DU123456', 'America/New_York')[0]


def test_xml_utc_commission_and_cross_account():
    rows,skips=parse_report(report({}, {'accountId':'UOTHER'}, {'levelOfDetail':'ORDER'}),'DU123456','America/New_York')
    assert len(rows)==1 and rows[0]['time']=='2025-09-29T14:30:12+00:00'
    assert rows[0]['commission']==1 and rows[0]['side']=='BOT'
    assert skips=={'other_accounts':1,'summaries':1}


def test_csv_same_execution_matches_xml():
    out=io.StringIO()
    writer=csv.writer(out)
    writer.writerow(['ClientAccountID','IBExecutionID','Symbol','Conid','AssetClass','CurrencyPrimary','Date/Time','Buy/Sell','Quantity','Price','IBCommission','IBCommissionCurrency'])
    writer.writerow(['DU123456','0001.2222.3333.01','SPY','123','STK','USD','20250929;103012','BUY','10','600.25','-1','USD'])
    assert parsed(out.getvalue())==parsed()


@pytest.mark.parametrize('when,zone,expected',[
    ('20250115;103012','America/New_York','2025-01-15T15:30:12+00:00'),
    ('20250929;103012','America/New_York','2025-09-29T14:30:12+00:00'),
    ('20250929;223012','Asia/Hong_Kong','2025-09-29T14:30:12+00:00'),
    ('2025-09-29T10:30:12-04:00','UTC','2025-09-29T14:30:12+00:00'),
])
def test_time_normalization(when,zone,expected):
    assert timestamp(when,zone)==expected


@pytest.mark.parametrize('when',['20251102;013012','20250309;023012','20250929','nonsense'])
def test_time_ambiguity_is_rejected(when):
    with pytest.raises(ValueError):timestamp(when,'America/New_York')


@pytest.mark.parametrize('changes',[{'ibExecID':''},{'conid':''},{'dateTime':'20250929'},{'quantity':'NaN'},
    {'tradePrice':'Infinity'},{'accountId':''},{'origTradeID':'789'},{'notes':'Ca'},{'buySell':'UNKNOWN'}])
def test_bad_rows_never_generate_fake_markers(changes):
    with pytest.raises(ValueError):parsed(report(changes))


def test_xml_entity_and_size_limits():
    with pytest.raises(ValueError):parsed('<!DOCTYPE foo [<!ENTITY x "test">]><FlexQueryResponse>&x;</FlexQueryResponse>')
    with pytest.raises(ValueError):parsed('x'*(MAX_REPORT+1))


def test_persistent_dedupe_gateway_and_report_correction(tmp_path):
    path=str(tmp_path/'trades.db');a=ExecutionArchive(path)
    rows=parsed()
    assert a.upsert('DU123456',rows,'gateway')['added']==1
    assert a.upsert('DU123456',rows,'file')['updated']==1
    assert a.upsert('DU123456',rows,'file')['unchanged']==1
    assert a.upsert('DU123456',[{**rows[0],'price':999}],'gateway')['unchanged']==1
    corrected=parsed(report({'ibExecID':'0001.2222.3333.02','tradePrice':'599'}))
    a.upsert('DU123456',corrected,'flex')
    a.upsert('DU123456',rows,'gateway')
    restored=ExecutionArchive(path)
    saved=restored.page('DU123456')['executions']
    assert len(saved)==1 and saved[0]['price']==599 and saved[0]['id'].endswith('.02')
    assert restored.page('UOTHER')['total']==0


def test_archive_pagination_no_200_trade_limit(tmp_path):
    a=ExecutionArchive(str(tmp_path/'trades.db'));base=parsed()[0]
    a.upsert('DU123456',[{**base,'id':str(i)} for i in range(1203)],'file')
    first=a.page('DU123456','SPY');second=a.page('DU123456','SPY',offset=first['next_offset'])
    assert first['total']==1203 and len(first['executions'])==1000 and len(second['executions'])==203
    assert len({r['id'] for r in first['executions']+second['executions']})==1203
    assert a.page('DU123456','QQQ')['total']==0


def test_private_import_atomic_and_account_bound(client):
    assert client.post('/api/executions/import',content=report()).status_code==401
    login(client)
    assert client.post('/api/executions/import',content=report(),headers={'origin':'https://evil.invalid'}).status_code==403
    response=client.post('/api/executions/import',content=report())
    assert response.status_code==200 and response.json()['added']==1
    assert client.post('/api/executions/import',content=report()).json()['unchanged']==1
    assert client.post('/api/executions/import',content=report({'ibExecID':'new'}, {'quantity':'bad'})).status_code==400
    assert client.get('/api/executions/archive?symbol=SPY').json()['total']==1
    assert client.get('/api/executions/archive?symbol=QQQ').json()['total']==0
    assert client.get('/api/state').json()['execution_archive']['count']==1
    client.broker.account='UOTHER'
    assert client.get('/api/executions/archive').json()['total']==0
    client.broker.account=''
    assert client.post('/api/executions/import',content=report()).status_code==400


def test_large_report_route_body_limit(client):
    login(client)
    assert client.post('/api/executions/import',content=report()+(' '*17000)).status_code==200
    assert client.post('/api/executions/import',content='x'*(MAX_REPORT+1)).status_code==413
    assert client.post('/api/flex/config',content='x'*17000).status_code==413


def test_flex_token_never_returned_and_config_account_scope(client):
    login(client)
    assert client.post('/api/flex/config',json={'token':'sensitiveKey','query_id':'123','timezone':'America/New_York'}).status_code==200
    status=client.get('/api/flex')
    assert status.json()['configured'] and 'sensitiveKey' not in status.text and 'token' not in status.text
    assert client.post('/api/flex/config',json={'token':'','query_id':'456'}).status_code==200
    assert client.desk.state.store.archive.config('DU123456')['token']=='sensitiveKey'
    invalid=client.post('/api/flex/config',json={'token':'SECRET?bad','query_id':'123'})
    assert invalid.status_code==422 and 'SECRET' not in invalid.text
    client.broker.account='UOTHER'
    assert not client.get('/api/flex').json()['configured']
    assert client.post('/api/flex/sync',json={'days':365}).status_code==400


def test_error_responses_never_echo_vendor_secrets():
    with pytest.raises(ValueError) as error:envelope('<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>secretToken</ErrorMessage></FlexStatementResponse>')
    assert 'secretToken' not in str(error.value)
    assert envelope('<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>')=='pending'


def test_download_fixed_host_redirect_disabled_and_secret_safe(monkeypatch):
    from urllib.error import HTTPError
    opener=Mock();opener.open.side_effect=HTTPError('https://example/?t=secret',302,'redirect',{},None)
    builder=Mock(return_value=opener);monkeypatch.setattr('urllib.request.build_opener',builder)
    with pytest.raises(ValueError) as error:download('SendRequest',{'t':'secret','q':'123','v':3})
    assert 'secret' not in str(error.value)
    assert builder.call_args.args[0].redirect_request(None,None,None,None,None,'https://evil.invalid') is None
    assert opener.open.call_args.args[0].full_url.startswith('https://ndcdyn.interactivebrokers.com/')
    with pytest.raises(ValueError):download('https://evil.invalid',{})


def test_flex_background_download_and_restart_persistence(tmp_path,monkeypatch):
    a=ExecutionArchive(str(tmp_path/'trades.db'));a.save_config('DU123456',{'token':'secret','query_id':'123','timezone':'America/New_York'})
    async def sleep(seconds):pass
    monkeypatch.setattr('desk.flex.asyncio.sleep',sleep)
    calls=[]
    def fake(endpoint,params):
        calls.append((endpoint,params))
        if endpoint=='SendRequest':return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>456</ReferenceCode><url>https://evil.invalid</url></FlexStatementResponse>'
        if len(calls)==2:return '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>'
        return report()
    monkeypatch.setattr('desk.flex.download',fake)
    async def run():
        service=FlexService(a)
        service.start('DU123456',365)
        with pytest.raises(ValueError):service.start('DU123456',365)
        await service.task
        assert service.status('DU123456')['state']=='done'
        assert service.status('UOTHER')['state']=='idle'
        assert a.page('DU123456')['total']==1
        assert calls[-1][0]=='GetStatement' and calls[-1][1]['q']=='456' and calls[0][1]['p']=='365'
        with pytest.raises(ValueError):service.start('DU123456',365)
        await service.close()
    asyncio.run(run())
    assert ExecutionArchive(a.path).page('DU123456')['total']==1


@pytest.mark.parametrize('code',['C','C;P','O','O;P','Cx'])
def test_ibkr_closing_code_is_not_cancellation(code):
    rows=parsed(report({'notes':code,'buySell':'SELL','quantity':'-10'}))
    assert rows[0]['side']=='SLD' and rows[0]['quantity']==10


@pytest.mark.parametrize('field,code',[('notes','Ca'),('notes','Co'),('notes','C;Ca'),('Notes/Codes','Co')])
def test_explicit_cancelled_or_corrected_codes_fail_closed(field,code):
    with pytest.raises(ValueError):parsed(report({field:code}))
