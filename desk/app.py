import json
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .config import Settings, ROOT
from .store import Store
from .history import HistoryService
from .auth import Authentication
from .executions import MAX_REPORT, ZONES, parse_report
from .flex import FlexService
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError


def create_app(settings=None, broker_factory=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        from .broker import Broker
        store = Store(settings.db)
        broker = (broker_factory or Broker)(settings, store)
        app.state.store, app.state.broker = store, broker
        app.state.history = HistoryService(broker, store)
        app.state.auth = Authentication(settings.password, store)
        app.state.flex = FlexService(store.archive)
        yield
        await app.state.flex.close()
        await broker.close()
        store.db.close()

    app = FastAPI(title='IBKR Desk', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def private_access(request: Request, call_next):
        path = request.url.path
        if path.startswith('/api/'):
            if request.method not in ('GET', 'HEAD', 'OPTIONS'):
                origin = request.headers.get('origin')
                if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
                    return Response(status_code=403)
                length = request.headers.get('content-length', '0')
                limit = MAX_REPORT if path == '/api/executions/import' else 16384
                if not length.isdigit() or int(length) > limit:
                    return Response(status_code=413)
            if path not in ('/api/health', '/api/session', '/api/password'):
                token = request.cookies.get('desk_session', '')
                if not app.state.auth.valid_session(token):
                    return Response(content='{"detail":"请先登录工作台。"}', status_code=401, media_type='application/json')
            # Only authentication, connection and local report configuration/import use write methods.
            # Removed trading URLs, arbitrary RPCs and future accidental write routes fail closed.
            allowed_local_actions = {('POST', '/api/session'), ('DELETE', '/api/session'), ('POST', '/api/connect'), ('POST', '/api/password'), ('POST', '/api/executions/import'), ('POST', '/api/flex/config'), ('POST', '/api/flex/sync')}
            if request.method not in ('GET', 'HEAD', 'OPTIONS') and (request.method, path) not in allowed_local_actions:
                return Response(content='{"detail":"本工作台固定为只读，不支持下单、改单、撤单、行权、提现或转账。"}',
                                status_code=403, media_type='application/json')
        result = await call_next(request)
        result.headers['Cache-Control'] = 'no-store' if path.startswith('/api/') else 'no-cache'
        result.headers['X-Content-Type-Options'] = 'nosniff'
        result.headers['Referrer-Policy'] = 'no-referrer'
        result.headers['X-Frame-Options'] = 'DENY'
        return result

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        # Pydantic's default errors echo the submitted value, including tokens/passwords.
        return Response(content='{' + '"detail":"输入格式无效，请检查字段及长度。"' + '}', status_code=422, media_type='application/json')

    @app.exception_handler(ValueError)
    async def value_error(request, exc):
        return Response(json.dumps({'detail': str(exc)}, ensure_ascii=False), status_code=400, media_type='application/json')

    @app.get('/api/health')
    def health():
        return {'ok': True, 'configured': app.state.auth.configured, 'version': '0.1.0', 'read_only': True}

    class Login(BaseModel):
        password: str = Field(max_length=512)

    @app.post('/api/session')
    def login(body: Login, request: Request, response: Response):
        ip = request.client.host if request.client else 'unknown'
        token = app.state.auth.login(body.password, ip)
        response.set_cookie('desk_session', token, max_age=12 * 3600, httponly=True, samesite='strict', secure=request.url.scheme == 'https')
        return {'ok': True}

    @app.delete('/api/session')
    def logout(request: Request, response: Response):
        token = request.cookies.get('desk_session', '')
        app.state.auth.logout(token)
        response.delete_cookie('desk_session')
        return {'ok': True}

    class PasswordChange(BaseModel):
        current_password: str = Field(min_length=1, max_length=512)
        new_password: str = Field(min_length=6, max_length=512)
        confirm_password: str = Field(min_length=1, max_length=512)

    @app.post('/api/password')
    def change_password(body: PasswordChange, request: Request, response: Response):
        ip = request.client.host if request.client else 'unknown'
        app.state.auth.change_password(body.current_password, body.new_password, body.confirm_password, ip)
        response.delete_cookie('desk_session')
        return {'ok': True, 'requires_login': True}

    def state_snapshot():
        snapshot = app.state.broker.snapshot()
        account = app.state.broker.account
        if account:
            archive = app.state.store.archive
            rows = snapshot.get('executions', [])
            if rows:
                archive.upsert(account, rows, 'gateway')
            snapshot['executions'] = archive.page(account, limit=200)['executions']
            snapshot['execution_archive'] = archive.status(account)
        return snapshot

    @app.get('/api/state')
    async def state():
        return state_snapshot()

    @app.post('/api/connect')
    async def connect():
        await app.state.broker.connect()
        return state_snapshot()

    @app.get('/api/executions')
    async def executions():
        result = await app.state.broker.refresh_executions()
        state_snapshot()
        return result

    def execution_account():
        account = app.state.broker.account
        if not account:
            raise ValueError('请先连接 IB Gateway，确认当前账户后再读取或导入历史成交。')
        return account

    @app.get('/api/executions/archive')
    async def execution_archive(symbol: str = '', offset: int = Query(default=0, ge=0)):
        account = execution_account()
        archive = app.state.store.archive
        return {**archive.page(account, symbol.upper(), offset), 'account':account}

    @app.get('/api/flex')
    async def flex_status():
        account = execution_account()
        return {**app.state.store.archive.status(account), 'account':account, 'job':app.state.flex.status(account)}

    class FlexConfig(BaseModel):
        token: str = Field(default='', max_length=512, pattern=r'^[a-zA-Z0-9]*$')
        query_id: str = Field(min_length=1, max_length=30, pattern=r'^\d+$')
        timezone: str = 'America/New_York'

    @app.post('/api/flex/config')
    async def flex_config(body: FlexConfig):
        account = execution_account()
        if body.timezone not in ZONES:
            raise ValueError('请选择有效报表时区。')
        token = body.token or app.state.store.archive.config(account).get('token', '')
        if not token:
            raise ValueError('首次配置需要填写 Flex Token。')
        app.state.store.archive.save_config(account, {'token':token,'query_id':body.query_id,'timezone':body.timezone})
        return {'ok':True}

    class FlexSync(BaseModel):
        days: int = Field(default=365, ge=1, le=365)

    @app.post('/api/flex/sync')
    async def flex_sync(body: FlexSync):
        return app.state.flex.start(execution_account(), body.days)

    @app.post('/api/executions/import')
    async def import_executions(request: Request, timezone: str = 'America/New_York'):
        account = execution_account()
        if app.state.flex.task and not app.state.flex.task.done():
            raise ValueError('Flex 正在同步，请等待完成再导入文件。')
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > MAX_REPORT:
                raise HTTPException(413, '报表不能超过 10 MB。')
        try:
            decoded = content.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('请使用 UTF-8 编码的 XML / CSV 文件。') from None
        rows, skipped = parse_report(decoded, account, timezone)
        result = app.state.store.archive.upsert(account, rows, 'file', {'source':'file','skipped':skipped})
        return {**result, 'skipped':skipped, 'account':account}

    @app.get('/api/quote')
    async def quote(symbol: str = Query(pattern=r'^[A-Z][A-Z0-9. -]{0,11}$')):
        return await app.state.broker.quote(symbol)

    @app.get('/api/history')
    async def history(symbol: str = Query(pattern=r'^[A-Z][A-Z0-9. -]{0,11}$'), period: str = '1d',
                      end: str = '', rth: bool = True, before: str = ''):
        return await app.state.history.page(symbol, period, end, rth, before)

    static = ROOT / 'dist'
    if static.exists():
        app.mount('/', StaticFiles(directory=static, html=True), name='web')
    else:
        @app.get('/')
        def build_missing():
            return {'message': '请先执行 npm ci && npm run build，或启动 npm run dev。'}
    return app

app = create_app()
