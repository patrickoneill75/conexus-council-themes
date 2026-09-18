#!/usr/bin/env python3
"""MCM publish step: build the site payload into public/mcm/.

The calling workflow commits the result, and Cloudflare redeploys on the push. Data
itself lives in Box (see mcm.box_store), not in this repo, so this script pulls the
current store down first — unless BOX_* is unset, in which case it builds from whatever
is already in the local data directory (e.g. left there by a run_mcm_download.py /
run_mcm_analyze.py you just ran locally), which is what keeps local iteration on the
dashboard working with no Box calls.

Only generated files are written. public/mcm/index.html (the control panel) is
hand-maintained and is never touched here.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcm import box_store, config, site, store

TEMPLATE = config.REPO_ROOT / "mcm_site_template" / "dashboard.html"


def log(msg):
    print(msg, flush=True)


def main():
    if box_store.enabled():
        log("Pulling the current store from Box…")
        box_store.pull(log)
    store.write_status()
    site.build(config.SITE_PUBLIC_DIR, TEMPLATE.read_text(encoding="utf-8"), log=log)
    log(f"Wrote site payload to {config.SITE_PUBLIC_DIR}")


if __name__ == "__main__":
    main()
