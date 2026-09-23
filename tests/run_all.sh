#!/usr/bin/env bash
# Runs both suites. Exits non-zero if either fails.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0
echo "=== Python pipelines ==="
python3 -m unittest discover -s tests -p 'test_*.py' -t . || status=1
echo
echo "=== Cloudflare Worker (src/) ==="
node tests/worker_test.mjs || status=1
exit $status
