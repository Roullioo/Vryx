#!/usr/bin/env python3
"""Sert VRYX_SHARD_BASE_DIR sous le préfixe /api/internal/shard-serve/ (même layout que l'API Express)."""
from __future__ import annotations

import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def main() -> None:
    root = os.path.abspath(os.environ.get("VRYX_SHARD_BASE_DIR", "/var/tmp/vryx-shards"))
    port = int(os.environ.get("VRYX_SHARD_SERVE_PORT", "18765"))
    prefix = "/api/internal/shard-serve/"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:
            sys.stderr.write(f"[shard-serve] {fmt % args}\n")

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if not path.startswith(prefix):
                self.send_error(404, "prefix")
                return
            rel = path[len(prefix) :].lstrip("/")
            if not rel or ".." in rel.split("/"):
                self.send_error(400, "path")
                return
            fp = os.path.normpath(os.path.join(root, rel))
            if not fp.startswith(root + os.sep) and fp != root:
                self.send_error(403, "escape")
                return
            if not os.path.isfile(fp):
                self.send_error(404, "missing")
                return
            with open(fp, "rb") as f:
                data = f.read()
            ct = "application/json" if fp.endswith(".json") else "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    httpd = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[shard-serve] root={root} http://127.0.0.1:{port}{prefix}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
