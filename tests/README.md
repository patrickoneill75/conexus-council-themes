# Tests

Two suites, both dependency-free beyond what the app already needs:

- `test_pipelines.py` — the Python pipelines (`themes/`, `pcn/`, `mcm/`, `consensus/`).
  Run with `python3 -m unittest discover -s tests -p 'test_*.py' -t .` from the repo root,
  or `python3 tests/test_pipelines.py`.
- `worker_test.mjs` — the Cloudflare Worker modules in `src/`, exercised as real route
  handlers against an in-memory KV stub and a stubbed `fetch`. Run with
  `node tests/worker_test.mjs`.

`run_all.sh` runs both.

Every test here is a regression test for a specific defect found during a QA pass —
each one names the bug it pins down, so a future change that reintroduces it fails
loudly rather than silently.
