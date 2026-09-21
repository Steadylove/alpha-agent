"""Local-only ThetaData adapter. Credentials never enter responses or manifests."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "thetadata"
ET = ZoneInfo("America/New_York")
LOCK = threading.Lock()
_client = None
_authenticated_at = None


class DataTemporarilyUnavailable(RuntimeError):
    def __init__(self, day: date, retry_at: datetime):
        self.retry_at = retry_at
        local = retry_at.astimezone(ZoneInfo("Asia/Shanghai"))
        super().__init__(
            f"{day} 报价暂未返回。当前处于 ThetaData 文档所述的昨日数据维护窗口 "
            f"00:00–01:45 美东；建议北京时间 {local:%Y-%m-%d %H:%M} 后重试。"
            "这不是套餐权限错误；维护结束时间不保证数据一定恢复。"
        )


def midnight_retry_at(day: date, now: datetime | None = None) -> datetime | None:
    now = (now or datetime.now(ET)).astimezone(ET)
    end = now.replace(hour=1, minute=45, second=0, microsecond=0)
    if day == now.date() - timedelta(days=1) and now < end:
        return end
    return None


def api_key() -> str | None:
    if os.environ.get("THETADATA_API_KEY"):
        return os.environ["THETADATA_API_KEY"].strip()
    # Read only the required variable, never execute/source an environment file.
    for path in (ROOT / ".env.local", ROOT / ".env"):
        if path.exists():
            for line in path.read_text().splitlines():
                name, sep, value = line.strip().removeprefix("export ").partition("=")
                if sep and name.strip() == "THETADATA_API_KEY":
                    value = value.strip().strip('"\'')
                    if value:
                        return value
    return None


def session_date(value: str) -> date:
    day = date.fromisoformat(value)
    if day > datetime.now(ET).date():
        raise ValueError("不能请求未来交易日")
    return day


def client(refresh: bool = False):
    global _client, _authenticated_at
    if refresh:
        _client = None
        _authenticated_at = None
    if _client is None:
        key = api_key()
        if not key:
            raise ValueError("请在 .env.local 设置 THETADATA_API_KEY")
        from thetadata import ThetaClient
        logging.getLogger("thetadata").setLevel(logging.WARNING)
        _client = ThetaClient(api_key=key)
        _authenticated_at = datetime.now(timezone.utc).isoformat()
    return _client


def auth_status(refresh: bool = False) -> dict:
    if refresh:
        with LOCK:
            client(refresh=True)
    code = getattr(_client, "options_subscription", None)
    return {
        "key_configured": bool(api_key()), "authenticated": _client is not None,
        "authenticated_at": _authenticated_at,
        "options_subscription_code": code,
        "options_subscription": "NOT_AUTHENTICATED" if code is None else "FREE" if code == 0 else "PAID",
    }


def folder(day: date) -> Path:
    return DATA / day.isoformat()


def metadata(day: date) -> dict:
    path = folder(day) / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"尚未下载 {day} 行情")
    return json.loads(path.read_text())


def safe_error(exc: Exception) -> str:
    message = str(exc)
    key = api_key()
    if key:
        message = message.replace(key, "[REDACTED]")
    return message[:1500]


def download(day: date) -> dict:
    """Download the full SPXW 0DTE chain, in hourly chunks, resuming valid chunks."""
    import polars as pl
    from thetadata.errors import NoDataFoundError

    with LOCK:  # One shared SDK session and at most one in-flight data request.
        out = folder(day)
        out.mkdir(parents=True, exist_ok=True)
        if (out / "manifest.json").exists():
            return metadata(day)
        # Refresh a previously FREE session, so a newly activated subscription takes effect.
        theta = client(refresh=_client is not None and _client.options_subscription == 0)
        if theta.options_subscription == 0:
            raise PermissionError("密钥验证成功，但 ThetaData 将期权权限识别为 FREE；分钟报价需要 Options Value 或更高套餐。请确认付款、套餐生效及密钥所属账号。")
        contracts = theta.option_list_contracts(request_type="quote", symbol="SPXW", date=day, max_dte=0)
        contracts = contracts.filter(pl.col("expiration").cast(pl.String) == day.isoformat())
        if contracts.is_empty():
            raise ValueError(f"{day} 未返回 SPXW 当日到期合约；请检查日期和账户权限")
        contracts.write_csv(out / "contracts.csv")
        parts = []
        start = datetime.combine(day, datetime.min.time()).replace(hour=9, minute=30)
        close = start.replace(hour=16, minute=0)
        while start <= close:
            end = min(start + timedelta(minutes=59), close)
            path = out / f"quotes-{start:%H%M}-{end:%H%M}.parquet"
            if path.exists():
                frame = pl.read_parquet(path)
            else:
                print(f"Downloading SPXW {day} {start:%H:%M}-{end:%H:%M} ET", flush=True)
                try:
                    frame = theta.option_history_quote(
                        symbol="SPXW", expiration=day, date=day, strike="*", right="both",
                        interval="1m", start_time=start.strftime("%H:%M:%S"),
                        end_time=end.strftime("%H:%M:%S"),
                    )
                except NoDataFoundError as exc:
                    retry_at = midnight_retry_at(day)
                    if retry_at:
                        raise DataTemporarilyUnavailable(day, retry_at) from exc
                    raise
                if frame.is_empty():
                    raise ValueError(f"报价分片 {start:%H:%M}-{end:%H:%M} 为空，未将下载标记为成功")
                tmp = path.with_suffix(".tmp")
                frame.write_parquet(tmp)
                tmp.replace(path)
            parts.append(frame)
            start = end + timedelta(minutes=1)
        frame = pl.concat(parts, how="vertical_relaxed").unique(
            subset=["symbol", "expiration", "strike", "right", "timestamp"]
        ).sort(["timestamp", "strike", "right"])
        frame.write_parquet(out / "quotes.parquet")
        info = {
            "source": "ThetaData Python SDK", "symbol": "SPXW", "date": day.isoformat(),
            "expiration": day.isoformat(), "interval": "1m", "timezone": "America/New_York",
            "downloaded_at": datetime.now(timezone.utc).isoformat(),
            "rows": frame.height, "listed_contracts": contracts.height,
            "quoted_contracts": frame.select(["expiration", "strike", "right"]).unique().height,
            "first_timestamp": str(frame["timestamp"].min()),
            "last_timestamp": str(frame["timestamp"].max()),
            "sha256": hashlib.sha256((out / "quotes.parquet").read_bytes()).hexdigest(),
            "file": str(out / "quotes.parquet"),
        }
        (out / "manifest.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
        return info


def quotes(day: date):
    import polars as pl
    metadata(day)
    return pl.read_parquet(folder(day) / "quotes.parquet")
