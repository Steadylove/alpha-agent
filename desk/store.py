import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

class Store:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS credential (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), password_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
        ''')
        self.db.commit()
        from .executions import ExecutionArchive
        self.archive = ExecutionArchive(path)

    def password_hash(self):
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute('SELECT password_hash FROM credential WHERE singleton=1').fetchone()
            return row[0] if row else None

    def save_password_hash(self, encoded):
        # A separate transaction cannot accidentally commit another request's cache writes.
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('INSERT OR REPLACE INTO credential VALUES (1, ?)', (encoded,))

    def cache(self, key):
        row = self.db.execute('SELECT * FROM history WHERE cache_key=?', (key,)).fetchone()
        return (json.loads(row['payload']), row['updated']) if row else None

    def cache_put(self, key, value):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO history VALUES (?, ?, ?)', (key, json.dumps(value, allow_nan=False), time.time()))
            self.db.execute('DELETE FROM history WHERE cache_key IN (SELECT cache_key FROM history ORDER BY updated DESC LIMIT -1 OFFSET 500)')

    def reserve(self, order_id, payload):
        now = time.time()
        with self.db:
            self.db.execute('INSERT INTO orders VALUES (?, ?, ?, ?, ?)', (order_id, json.dumps(payload), 'SUBMITTING', now, now))

    def record(self, order_id, state, data):
        with self.db:
            self.db.execute('UPDATE orders SET state=?, updated=? WHERE id=?', (state, time.time(), order_id))
            self.db.execute('INSERT INTO events(order_id,payload,created) VALUES (?,?,?)', (order_id, json.dumps(data, allow_nan=False), time.time()))

    def order(self, order_id):
        row = self.db.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result['payload'] = json.loads(result['payload'])
        event = self.db.execute('SELECT payload FROM events WHERE order_id=? ORDER BY id DESC LIMIT 1', (order_id,)).fetchone()
        result['broker'] = json.loads(event['payload']) if event else None
        return result

    def orders(self):
        ids = self.db.execute('SELECT id FROM orders ORDER BY created DESC LIMIT 100').fetchall()
        return [self.order(row['id']) for row in ids]
