"""Local workbench authentication. Never handles IBKR credentials."""
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from fastapi import HTTPException

ITERATIONS = 600_000
PREFIX = f'pbkdf2_sha256${ITERATIONS}'


def encode_password(password):
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, ITERATIONS)
    return f'{PREFIX}${salt.hex()}${digest.hex()}'


def check_password(password, encoded):
    algorithm, iterations, salt, digest = encoded.split('$')
    # Accept only the format we create; corrupt credentials fail closed.
    if algorithm != 'pbkdf2_sha256' or iterations != str(ITERATIONS) or len(salt) != 64 or len(digest) != 64:
        raise ValueError('Invalid stored workbench credential')
    actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), ITERATIONS)
    return hmac.compare_digest(actual, bytes.fromhex(digest))


class Authentication:
    def __init__(self, bootstrap_password, store):
        self.store = store
        saved = store.password_hash()
        self.encoded = saved if saved is not None else encode_password(bootstrap_password) if bootstrap_password else None
        if self.encoded is not None:
            check_password('', self.encoded)
        self.sessions = {}
        self.attempts = {}
        self.lock = threading.Lock()

    @property
    def configured(self):
        return self.encoded is not None

    def _verify(self, password, ip):
        if not self.configured:
            raise HTTPException(503, '请先在私有 .env 中设置 DESK_PASSWORD（至少 6 字符）。')
        now = time.time()
        self.attempts = {key: [stamp for stamp in stamps if stamp > now - 300]
                         for key, stamps in self.attempts.items() if any(stamp > now - 300 for stamp in stamps)}
        if len(self.attempts.get(ip, [])) >= 8:
            raise HTTPException(429, '尝试次数过多，请 5 分钟后重试。')
        if not check_password(password, self.encoded):
            self.attempts.setdefault(ip, []).append(now)
            raise HTTPException(401, '工作台密码不正确。')
        self.attempts.pop(ip, None)

    def login(self, password, ip):
        # Serialize verification/session issuance with password changes so an old
        # password cannot create a session after all old sessions are revoked.
        with self.lock:
            self._verify(password, ip)
            now = time.time()
            self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
            token = secrets.token_urlsafe(32)
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = now + 12 * 3600
            return token

    def valid_session(self, token):
        return self.sessions.get(hashlib.sha256(token.encode()).hexdigest(), 0) > time.time()

    def logout(self, token):
        with self.lock:
            self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)

    def change_password(self, current, new, confirmation, ip):
        with self.lock:
            self._verify(current, ip)
            if not 6 <= len(new) <= 512:
                raise ValueError('新密码需要 6–512 个字符。')
            if new != confirmation:
                raise ValueError('两次输入的新密码不一致。')
            if hmac.compare_digest(current.encode(), new.encode()):
                raise ValueError('新密码不能与当前密码相同。')
            encoded = encode_password(new)
            try:
                self.store.save_password_hash(encoded)
            except sqlite3.Error:
                raise HTTPException(503, '新密码未能保存，请稍后重试。当前密码仍然有效。') from None
            # Revoke only after the database transaction succeeds.
            self.encoded = encoded
            self.sessions.clear()
