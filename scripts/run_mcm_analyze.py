#!/usr/bin/env python3
"""MCM analyze step: per-filing signals (Haiku) + the four-section narratives (Sonnet).

This is the only script that spends Claude tokens, and it never spends them twice on the
same thing: a filing already marked analyzed is skipped, and a narrative section already
written is left alone. A narrative missing one or more of its four sections — a prior run
hit a rate limit or an out-of-schema response partway through — is retried, but only for
the sections it's actually missing; sections it already has aren't regenerated.

The narrative — the expensive part, eight Sonnet calls per quarter across both cuts — is
written for the latest complete quarter only. Its quarter-over-quarter and year-over-year
sections already pull in the comparison quarters' signals as context; there is no need to
also generate top-level narratives for those comparison quarters themselves, since the
dashboard never shows them on their own (see mcm.site).
"""
import os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from mcm import box_store, config, store
from mcm.claude_client import usage_summary
from mcm.extract import assert_manufacturing_only
from mcm.narrative import build_narrative
from mcm.periods import label, latest_complete_quarter, previous_quarter
from mcm.signals import analyze_filing

START = time.time()
BUDGET_SECONDS = int(os.environ.get("TIME_BUDGET_SECONDS", 4 * 3600))


def log(msg):
    print(msg, flush=True)


def out_of_time():
    return (time.time() - START) > BUDGET_SECONDS


def main():
    log("Pulling the current store from Box…")
    box_store.pull(log)

    filings = store.read_filings()
    paragraphs = store.read_paragraphs()
    signals = store.read_signals()
    if filings.empty:
        log("No filings on record. Run the download step first.")
        return

    # Gate #2: the important one. Nothing reaches a paid Claude call without passing.
    ready = filings[(filings["extracted"] == "1") & (filings["analyzed"] != "1")]
    assert_manufacturing_only(filings, "before Claude analysis", log=log)

    # filings.csv is sorted by period, so left to itself this queue would burn through
    # the oldest quarter first and the current quarter -- the only one the dashboard
    # actually shows -- last. If Claude credits run out partway through a run, that's
    # backwards: reorder so the current quarter goes first, then its QoQ comparison,
    # then YoY, so a partial run leaves the most useful subset analyzed rather than the
    # least. Ties (same priority) keep their existing relative order.
    #
    # The YoY period gets its own explicit tier rather than falling into the same
    # catch-all bucket as everything else: filings.csv can carry unanalyzed backlog left
    # over from an earlier interrupted run (a prior quarter's required set that never
    # finished), and that backlog is chronologically older than -- so would otherwise
    # sort ahead of -- this run's actual YoY target, starving the year_over_year
    # narrative section of the one period it actually needs.
    latest_year, latest_q = latest_complete_quarter()
    current_period = label(latest_year, latest_q)
    qoq_period = label(*previous_quarter(latest_year, latest_q))
    yoy_period = label(latest_year - 1, latest_q)
    priority = {current_period: 0, qoq_period: 1, yoy_period: 2}
    if not ready.empty:
        ready = ready.assign(_priority=ready["period"].map(priority).fillna(3).astype(int))
        ready = ready.sort_values("_priority", kind="stable").drop(columns="_priority")

    log(f"{len(ready)} filings queued for signal extraction "
        f"(current quarter {current_period} first, then QoQ, then YoY)")
    paragraphs_by_accession = {
        accession: group.to_dict("records")
        for accession, group in paragraphs.groupby("accession")
    } if not paragraphs.empty else {}

    filing_by_accession = {r["accession"]: r for r in filings.to_dict("records")}

    # Checkpointed every 25 filings rather than once at the end. filings.csv's own
    # "analyzed" column already IS the waypoint — a filing not yet marked analyzed just
    # gets retried on the next run — so there's no separate progress-tracking mechanism
    # to build here; the only gap was that a multi-hour run could accumulate thousands
    # of results in memory on a disposable GitHub Actions runner without that column
    # ever reaching Box. Checkpointing this often closes that gap: an interruption loses
    # at most ~25 filings' worth of work instead of everything since the last narrative
    # or the end of the run.
    pending_signals, pending_analyzed = [], []
    new_signal_total, analyzed_total, failures = 0, 0, 0
    distinct_errors_logged = set()

    def checkpoint():
        nonlocal filings, signals, pending_signals, pending_analyzed
        if pending_signals:
            signals = pd.concat([signals, pd.DataFrame(pending_signals)], ignore_index=True)
            signals = signals.drop_duplicates("signal_id", keep="last")
        if pending_analyzed:
            mask = filings["accession"].isin(pending_analyzed)
            filings.loc[mask, "analyzed"] = "1"
            filings.loc[mask, "error"] = ""  # a successful retry clears an earlier failure
        store.write_filings(filings)
        store.write_signals(signals)
        store.write_status()
        # Only the two files this loop actually touches -- paragraphs.csv, companies.csv
        # etc. haven't changed, so re-uploading them on every 25-filing checkpoint would
        # be pure overhead across the ~250 checkpoints a full run makes.
        try:
            box_store.push(log, files=[config.FILINGS_CSV, config.SIGNALS_CSV, config.STATUS_JSON])
        except Exception as exc:
            # A transient Box hiccup on any one of ~250 checkpoints shouldn't take down
            # the rest of the run and abandon everything still queued -- the results are
            # already safe on the local runner disk and will reach Box at the next
            # successful checkpoint (or the final one, at worst).
            log(f"  ! Box push failed at this checkpoint, continuing locally: {str(exc)[:200]}")
        pending_signals, pending_analyzed = [], []

    if len(ready):
        with ThreadPoolExecutor(max_workers=config.ANALYSIS_WORKERS) as pool:
            futures = {}
            for row in ready.itertuples():
                rows = paragraphs_by_accession.get(row.accession)
                if not rows:
                    # Extraction found nothing to analyze — that's a completed state, not
                    # a pending one. Leaving it out of pending_analyzed would make this
                    # filing (and its quarter) show as "needs analysis" forever, since it
                    # can never be submitted for a Claude call.
                    pending_analyzed.append(row.accession)
                    continue
                filing = filing_by_accession[row.accession]
                futures[pool.submit(analyze_filing, filing, rows)] = row.accession
            for index, future in enumerate(as_completed(futures), start=1):
                accession = futures[future]
                try:
                    result = future.result()
                    pending_signals.extend(result)
                    pending_analyzed.append(accession)
                    new_signal_total += len(result)
                    analyzed_total += 1
                except Exception as exc:
                    failures += 1
                    message = str(exc)[:300]
                    filings.loc[filings["accession"] == accession, "error"] = message
                    key = (type(exc).__name__, message)
                    if key not in distinct_errors_logged and len(distinct_errors_logged) < 5:
                        distinct_errors_logged.add(key)
                        log(f"  ! {type(exc).__name__}: {message}")
                if index % 25 == 0:
                    checkpoint()
                    log(f"  signals: {index}/{len(futures)} filings ({analyzed_total} "
                        f"analyzed, {failures} failed) — checkpointed to Box")
                if out_of_time():
                    log("Time budget reached during signal extraction — saving progress.")
                    # All of `ready` was submitted to the pool up front, so `break` alone
                    # only stops *consuming* results -- exiting the `with` block still
                    # calls shutdown(wait=True), which blocks until every already-queued
                    # future finishes anyway, and none of those results would even be
                    # collected (the loop that would apply them has already exited). That
                    # defeats the point of a time budget: it would keep calling Claude
                    # (spending real money and time) for everything still queued, and
                    # then throw the results away. cancel_futures=True drops everything
                    # not yet started immediately, bounding the remaining wait to roughly
                    # the handful of calls already in flight (ANALYSIS_WORKERS of them).
                    pool.shutdown(cancel_futures=True)
                    break
    if len(ready):
        checkpoint()  # flush whatever's left over from the last full batch of 25
    if failures and failures == len(ready):
        log(f"  All {failures} filings failed the same way — see the distinct error(s) "
            f"logged above. This is almost always a systemic problem (an invalid or "
            f"out-of-credit ANTHROPIC_API_KEY, or a sustained rate limit), not something "
            f"wrong with these specific filings.")

    log(f"Signal extraction complete: {new_signal_total} new signals, {failures} failures")

    # ---- the four-section narratives, latest complete quarter only ----
    narratives = store.read_narratives()
    period = current_period
    for cut in config.NARRATIVE_CUTS:
        key = store.narrative_key(period, cut["key"])
        existing = narratives.get(key)
        # A narrative "exists" only once it has every expected section. A prior run can
        # leave one behind with a section or two missing (a rate limit, an out-of-schema
        # response) — that's not done, it's retryable, so don't let its mere presence
        # block the retry forever.
        if existing and set(existing.get("sections") or {}) >= set(config.NARRATIVE_SECTIONS):
            continue
        if out_of_time():
            log("Time budget reached before finishing narratives — saving progress.")
            store.write_narratives(narratives)
            store.write_status()
            box_store.push(log)
            return
        note = " (filling in missing sections)" if existing else ""
        log(f"\nNarrative {period} · {cut['label']}{note}")
        built = build_narrative(period, cut, signals, existing=existing, log=log)
        if built:
            narratives[key] = built
            store.write_narratives(narratives)  # checkpoint after each
            box_store.push(log)               # and push, so a later timeout loses nothing

    store.write_narratives(narratives)
    status = store.write_status()
    log("\nPushing the updated store to Box…")
    box_store.push(log)
    log(f"\nDone. {status['totals']['signals']} signals, {status['totals']['narratives']} narratives.")
    log(usage_summary())


if __name__ == "__main__":
    main()
