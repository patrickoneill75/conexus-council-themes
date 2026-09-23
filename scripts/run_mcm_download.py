#!/usr/bin/env python3
"""MCM download step: discover -> fetch -> extract to CSV. No Claude calls, no cost.

Only targets mcm.periods.required_quarters() — the latest complete quarter plus its QoQ
and YoY comparison quarters — rather than every complete quarter back to MIN_YEAR. That
keeps a routine run to at most three quarters of filings, and the very first run to
exactly three: this quarter, last quarter, and the same quarter last year, the bare
minimum needed for the dashboard's comparisons.

Resumable by design. A quarter already in filings.csv is skipped. GitHub cancels any job
at 6 hours, so a large backfill may need the button pressed more than once — each run
picks up where the last one stopped, because progress is pushed to Box as it goes.
"""
import sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from mcm import box_store, config, sec, store
from mcm.extract import assert_manufacturing_only, extract_filing
from mcm.periods import label, quarter_dates, required_quarters

START = time.time()
BUDGET_SECONDS = int(__import__("os").environ.get("TIME_BUDGET_SECONDS", 4 * 3600))


def log(msg):
    print(msg, flush=True)


def out_of_time():
    return (time.time() - START) > BUDGET_SECONDS


def main():
    log("Pulling the current store from Box…")
    box_store.pull(log)

    filings = store.read_filings()
    paragraphs = store.read_paragraphs()
    companies = store.read_companies()
    known_periods = set(filings["period"]) if not filings.empty else set()

    targets = [(y, q) for (y, q) in required_quarters() if label(y, q) not in known_periods]
    if not targets:
        log("Every complete quarter already has data. Nothing to download.")
    else:
        log(f"Quarters needing data: {', '.join(label(y, q) for y, q in targets)}")

    tickers = sec.load_public_tickers() if targets else {}
    new_rows = []
    for (year, quarter) in targets:
        if out_of_time():
            log("Time budget reached — stopping cleanly. Run the button again to continue.")
            break
        period = label(year, quarter)
        # Filings for a quarter arrive over the following ~105 days, so search a window
        # that starts at the quarter end rather than the quarter itself.
        _, quarter_end = quarter_dates(year, quarter)
        window_start = quarter_end
        window_end = min(pd.Timestamp.today().date(),
                         quarter_end + pd.Timedelta(days=config.ANNUAL_COMPLETENESS_DAYS).to_pytimedelta())
        log(f"\n{period}: searching filings dated {window_start} .. {window_end}")
        rows, _stats = sec.discover(window_start, window_end, tickers, log=log)
        rows = [r for r in rows if r["period"] == period]
        log(f"  {len(rows)} filings map to reporting period {period}")
        new_rows.extend(rows)

    if new_rows:
        filings = pd.concat([filings, pd.DataFrame(new_rows)], ignore_index=True)
        filings = filings.drop_duplicates("accession", keep="first")

    if filings.empty:
        log("No filings on record; nothing further to do.")
        store.write_status()
        box_store.push(log)
        return

    # Gate #1: before spending any bandwidth, prove every row is manufacturing.
    assert_manufacturing_only(filings, "after discovery", log=log)

    # Company locations (once per company, ever).
    known_ciks = set(companies["cik"]) if not companies.empty else set()
    fetched = sec.fetch_company_locations(set(filings["cik"]) - known_ciks, known_ciks, log=log)
    if fetched:
        companies = pd.concat([companies, pd.DataFrame(fetched)], ignore_index=True)
        companies = companies.drop_duplicates("cik", keep="last")
    # strict=True is safe and meaningful here: both are columns of the same
    # DataFrame, so a length mismatch would be a real bug, not input variation.
    state_by_cik = (dict(zip(companies["cik"], companies["state"], strict=True))
                    if not companies.empty else {})
    filings["state"] = filings["cik"].map(state_by_cik).fillna("")

    pending = filings[(filings["downloaded"] != "1") | (filings["extracted"] != "1")]
    log(f"\n{len(pending)} filings need downloading/extraction")

    # Run downloads and parsing concurrently. Downloads are I/O-bound and globally capped
    # at SEC_RPS by the rate limiter in mcm.sec, so the workers spend most of their time
    # waiting; overlapping the parsing with that wait is close to free. Done one at a time
    # the two costs add up instead, which roughly doubles the wall clock.
    #
    # Row bookkeeping is done AFTER the pool finishes, by row position rather than a
    # boolean mask. A masked write scans the whole table, four times per filing — about
    # six minutes of pure pandas overhead across 40,000 filings, and it grows with the
    # size of the dataset.
    pending_records = pending.to_dict("records")

    def fetch_and_extract(filing):
        # Download and extraction are reported separately so a filing that downloaded
        # fine but failed to extract still keeps its "downloaded" status — matching the
        # sequential version's behavior, where "downloaded" was set the moment the fetch
        # succeeded, independent of whatever happened next.
        destination = (config.RAW_FILING_DIR / filing["period"]
                       / f"{filing['accession'].replace('-', '')}.html")
        try:
            sec.download_filing(filing["url"], destination)
        except Exception as exc:
            return {"downloaded": False, "extracted": False, "rows": [], "error": str(exc)[:300]}
        try:
            rows = extract_filing(filing, destination.read_bytes())
        except Exception as exc:
            return {"downloaded": True, "extracted": False, "rows": [], "error": str(exc)[:300]}
        return {"downloaded": True, "extracted": True, "rows": rows, "error": None}

    extracted_rows = []
    results = {}          # accession -> outcome dict
    done = 0
    with ThreadPoolExecutor(max_workers=config.DOWNLOAD_WORKERS) as pool:
        futures = {pool.submit(fetch_and_extract, f): f["accession"] for f in pending_records}
        for future in as_completed(futures):
            accession = futures[future]
            try:
                outcome = future.result()
            except Exception as exc:
                outcome = {"downloaded": False, "extracted": False, "rows": [], "error": str(exc)[:300]}
            results[accession] = outcome
            extracted_rows.extend(outcome["rows"])
            done += 1
            if done % 100 == 0:
                log(f"  {done}/{len(pending_records)} processed")
            if out_of_time():
                log("Time budget reached — cancelling remaining work and saving progress.")
                for pending_future in futures:
                    pending_future.cancel()
                break

    # Apply every status change in one indexed pass.
    position = {accession: i for i, accession in enumerate(filings["accession"])}
    col = {name: filings.columns.get_loc(name) for name in ("downloaded", "extracted", "error")}
    for accession, outcome in results.items():
        i = position.get(accession)
        if i is None:
            continue
        if outcome["downloaded"]:
            filings.iat[i, col["downloaded"]] = "1"
        if outcome["extracted"]:
            filings.iat[i, col["extracted"]] = "1"
        filings.iat[i, col["error"]] = outcome["error"] or ""

    if extracted_rows:
        paragraphs = pd.concat([paragraphs, pd.DataFrame(extracted_rows)], ignore_index=True)
        paragraphs = paragraphs.drop_duplicates("paragraph_id", keep="last")

    store.write_filings(filings)
    store.write_paragraphs(paragraphs)
    store.write_companies(companies)
    status = store.write_status()
    log("\nPushing the updated store to Box…")
    box_store.push(log)
    log(f"\nDone. {status['totals']['filings']} filings, "
        f"{status['totals']['paragraphs']} paragraphs on record.")
    log(f"Quarters still needing analysis: {status['quarters_pending_analysis'] or 'none'}")


if __name__ == "__main__":
    main()
