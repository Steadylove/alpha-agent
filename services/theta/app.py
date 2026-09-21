#!/usr/bin/env python3
"""SPXW historical data/replay CLI and a loopback HTTP service for alpha-agent."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from provider import ROOT, DataTemporarilyUnavailable, auth_status, download, metadata, quotes, safe_error, session_date
from replay import replay

DEFAULT_FORECAST = ROOT / "research/options/balder-2026-09-15.json"


class Handler(BaseHTTPRequestHandler):
    def respond(self, status: int, payload: dict):
        raw = json.dumps(payload, ensure_ascii=False, default=str, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def dispatch(self, action):
        try:
            action()
        except FileNotFoundError as exc:
            self.respond(404, {"error": safe_error(exc)})
        except PermissionError as exc:
            self.respond(403, {"error": safe_error(exc), "auth": auth_status()})
        except DataTemporarilyUnavailable as exc:
            self.respond(503, {"error": safe_error(exc), "type": type(exc).__name__,
                               "retry_at": exc.retry_at.isoformat()})
        except (ValueError, KeyError) as exc:
            self.respond(400, {"error": safe_error(exc)})
        except Exception as exc:
            self.respond(502, {"error": safe_error(exc), "type": type(exc).__name__})

    def do_GET(self):
        self.dispatch(self.get)

    def get(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/health":
            self.respond(200, {"service": "alpha-agent-theta", **auth_status(), "symbol": "SPXW"})
        elif url.path in ("/history", "/quotes"):
            day = session_date(query["date"][0])
            result = metadata(day)
            if url.path == "/quotes":
                # A paged local read; no paid network request is performed by GET.
                offset = max(0, int(query.get("offset", ["0"])[0]))
                limit = max(1, min(1000, int(query.get("limit", ["100"])[0])))
                result = {"metadata": result, "offset": offset,
                          "rows": quotes(day).slice(offset, limit).to_dicts()}
            self.respond(200, result)
        else:
            self.respond(404, {"error": "Use GET /health, /history?date=YYYY-MM-DD or /quotes?date=YYYY-MM-DD"})

    def do_POST(self):
        self.dispatch(self.post)

    def post(self):
        if self.headers.get("Origin"):
            self.respond(403, {"error": "Use a server-side client; browser cross-origin requests are disabled"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 4096:
            raise ValueError("JSON body must be 1..4096 bytes")
        body = json.loads(self.rfile.read(length))
        if self.path == "/auth/refresh":
            self.respond(200, auth_status(refresh=True))
        elif self.path == "/history/download":
            self.respond(200, download(session_date(body["date"])))
        elif self.path == "/replay":
            day = session_date(body["date"])
            config = ROOT / "research/options" / f"balder-{day}.json"
            report = replay(config)
            # Keep the HTTP result small; complete curves are written to disk.
            report["scenarios"] = [{k: v for k, v in r.items() if k != "curve"} for r in report["scenarios"]]
            self.respond(200, report)
        else:
            self.respond(404, {"error": "Use POST /history/download or /replay with a date field"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("auth")
    fetch = commands.add_parser("fetch")
    fetch.add_argument("--date", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    review = commands.add_parser("replay")
    review.add_argument("--forecast", type=Path, default=DEFAULT_FORECAST)
    args = parser.parse_args()
    try:
        if args.command == "auth":
            print(json.dumps(auth_status(refresh=True), ensure_ascii=False, indent=2))
        elif args.command == "fetch":
            print(json.dumps(download(session_date(args.date)), ensure_ascii=False, indent=2))
        elif args.command == "replay":
            result = replay(args.forecast)
            print(json.dumps({"date": result["forecast"]["date"], "scenarios": len(result["scenarios"]),
                              "report": str(ROOT / "data/thetadata" / result["forecast"]["date"] / "replay.md")}, ensure_ascii=False))
        else:
            server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
            print(f"Theta service listening on http://127.0.0.1:{args.port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        parser.exit(1, f"{type(exc).__name__}: {safe_error(exc)}\n")


if __name__ == "__main__":
    main()
