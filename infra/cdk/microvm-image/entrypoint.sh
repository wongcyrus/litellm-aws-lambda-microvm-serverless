#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  python3 -c '
import os, time, urllib.parse, socket
db_url = os.environ.get("DATABASE_URL", "")
try:
    parsed = urllib.parse.urlsplit(db_url)
    host = parsed.hostname
    port = parsed.port or 5432
    if host:
        print(f"Waiting for database {host}:{port} to be reachable...", flush=True)
        for i in range(45):
            try:
                s = socket.create_connection((host, port), timeout=2)
                s.close()
                print(f"Database reachable after {i}s", flush=True)
                break
            except Exception:
                time.sleep(1)
        else:
            print("Warning: Database connection timed out after 45s", flush=True)
except Exception as e:
    print(f"Database check error: {e}", flush=True)
'
fi

exec litellm "$@"
