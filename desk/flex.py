"""Read-only IBKR Flex report download. Fixed hosts; never follow response URLs."""
import asyncio
import re
import time
import urllib.parse
import urllib.request
from contextlib import suppress
from .executions import MAX_REPORT, parse_report, xml_root

BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(endpoint, params):
    if endpoint not in ('SendRequest', 'GetStatement'):
        raise ValueError('不支持的报表接口。')
    url = BASE + endpoint + '?' + urllib.parse.urlencode(params)
    try:
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(urllib.request.Request(url, headers={'User-Agent':'IBKR-Desk/0.1'}),timeout=20) as response:
            raw = response.read(MAX_REPORT+1)
        if len(raw) > MAX_REPORT:
            raise ValueError('报表超过 10 MB，请缩小日期范围。')
        return raw.decode('utf-8-sig')
    except Exception:
        # Transport errors can embed the URL containing the token. Never expose them.
        raise ValueError('无法下载 Flex 报表，请检查网络、Token 有效期和 IP 限制。') from None


def envelope(content):
    root = xml_root(content)
    if root.tag != 'FlexStatementResponse':
        return None
    if root.findtext('Status') == 'Success':
        ref = root.findtext('ReferenceCode', '')
        if not re.fullmatch(r'\d+', ref):
            raise ValueError('Flex 未返回有效的报表引用编号。')
        return ref
    code = root.findtext('ErrorCode', '')
    if code in ('1019', '1003'):
        return 'pending'
    safe_code = code if re.fullmatch(r'\d{1,6}', code) else 'unknown'
    raise ValueError(f'Flex 报表服务返回错误 {safe_code}，请检查 Token、Query ID 和查询权限。')


class FlexService:
    def __init__(self, archive):
        self.archive = archive
        self.task = None
        self.job = {'state':'idle'}
        self.last_start = 0

    def status(self, account):
        return self.job if self.job.get('account') == account else {'state':'idle'}

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    def start(self, account, days):
        if self.task and not self.task.done():
            raise ValueError('已有报表同步进行中，请等待完成。')
        if time.monotonic() - self.last_start < 60:
            raise ValueError('请间隔至少一分钟再请求新的报表。')
        config = self.archive.config(account)
        if not config.get('token') or not config.get('query_id'):
            raise ValueError('请先保存 Flex Token 和 Query ID。')
        self.last_start = time.monotonic()
        self.job = {'state':'running','account':account,'message':'正在请求 IBKR 生成报表…'}
        self.task = asyncio.create_task(self.run(account, days, config))
        return self.status(account)

    async def run(self, account, days, config):
        try:
            params = {'t':config['token'],'q':config['query_id'],'v':'3','p':str(days)}
            content = await asyncio.to_thread(download, 'SendRequest', params)
            reference = envelope(content)
            if not reference or reference == 'pending':
                raise ValueError('IBKR 尚未受理报表生成，请一分钟后重试。')
            for attempt in range(18):
                self.job['message'] = f'等待 IBKR 生成报表（{attempt+1}/18）…'
                await asyncio.sleep(10)
                content = await asyncio.to_thread(download, 'GetStatement', {'t':config['token'],'q':reference,'v':'3'})
                if content.lstrip().startswith('<FlexStatementResponse') or content.lstrip().startswith('<?xml') and 'FlexStatementResponse' in content[:300]:
                    if envelope(content) == 'pending':
                        continue
                    raise ValueError('IBKR 返回了非报表响应，请稍后重试。')
                rows, skipped = parse_report(content, account, config['timezone'])
                result = self.archive.upsert(account, rows, 'flex', {'source':'flex','requested_days':days,'skipped':skipped})
                self.job = {'state':'done','account':account,'message':'历史成交同步完成。','result':result,'skipped':skipped}
                return
            raise ValueError('报表生成超时，请稍后重试或导出 XML / CSV 导入。')
        except ValueError as exc:
            self.job = {'state':'error','account':account,'message':str(exc)}
        except Exception:
            self.job = {'state':'error','account':account,'message':'报表同步未完成，已有成交保留；请重试。'}
