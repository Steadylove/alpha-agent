from dataclasses import dataclass
from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')

@dataclass(frozen=True)
class Settings:
    password: str = ''
    host: str = '127.0.0.1'
    port: int = 4002
    client_id: int = 71
    account: str = ''
    data_mode: str = 'real'
    db: str = str(ROOT / '.data/desk.sqlite3')

    @classmethod
    def from_env(cls):
        result = cls(
            password=os.getenv('DESK_PASSWORD', ''), host=os.getenv('IB_HOST', '127.0.0.1'),
            port=int(os.getenv('IB_PORT', '4002')), client_id=int(os.getenv('IB_CLIENT_ID', '71')),
            account=os.getenv('IB_ACCOUNT', ''), data_mode=os.getenv('IB_DATA_MODE', 'real'),
            db=os.getenv('DESK_DB', str(ROOT / '.data/desk.sqlite3')),
        )
        if result.password and len(result.password) < 6:
            raise ValueError('DESK_PASSWORD must contain at least 6 characters')
        if result.data_mode not in ('real', 'delayed'):
            raise ValueError('Invalid data mode')
        return result
