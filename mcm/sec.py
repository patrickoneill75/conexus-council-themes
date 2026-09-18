"""SEC EDGAR access: rate-limited HTTP, filing discovery, and company location lookup."""
from __future__ import annotations
import json
import os
import re
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

import pandas as pd
import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config
from .periods import quarter_dates, reporting_date_for_filing, label

EFTS_URL = "https://efts.sec.gov/LATEST/search-index"

_contact = os.environ.get("SEC_CONTACT_EMAIL", "").strip()
if not _contact:
    raise SystemExit(
        "SEC_CONTACT_EMAIL is not set. SEC's fair-access policy requires a contact "
        "address in the User-Agent header. Add it as a repository secret."
    )
HEADERS = {
    "User-Agent": f"ConexusIndiana-ManufacturingConditions/3.0 {_contact}",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "application/json,text/html,application/xhtml+xml,*/*",
}

_lock = threading.Lock()
_last_call = 0.0


class SecRequestError(RuntimeError):
    pass


def _rate_limit():
    global _last_call
    with _lock:
        min_interval = 1.0 / config.SEC_RPS
        elapsed = time.time() - _last_call
        if elapsed < min_interval:
            time.sleep(min_interval - elapsed)
        _last_call = time.time()


@retry(
    retry=retry_if_exception_type((requests.RequestException, SecRequestError)),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(5),
    reraise=True,
)
def get(url, params=None, expect_json=False):
    _rate_limit()
    response = requests.get(url, headers=HEADERS, params=params, timeout=60)
    if response.status_code in (403, 429) or response.status_code >= 500:
        raise SecRequestError(f"SEC returned HTTP {response.status_code} for {url}")
    response.raise_for_status()
    return response.json() if expect_json else response


# ------------------------------------------------------------- ticker universe
def load_public_tickers():
    cache = config.CACHE_DIR / "company_tickers.json"
    stale = (not cache.exists()) or (
        date.fromtimestamp(cache.stat().st_mtime) < date.today()
    )
    data = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else None
    if stale:
        try:
            data = get("https://www.sec.gov/files/company_tickers.json", expect_json=True)
            cache.write_text(json.dumps(data), encoding="utf-8")
        except Exception:
            if data is None:
                raise
    by_cik = {}
    for _, record in (data or {}).items():
        cik = str(record.get("cik_str", "")).zfill(10)
        if cik.strip("0"):
            by_cik.setdefault(cik, {"ticker": record.get("ticker", ""), "name": record.get("title", "")})
    return by_cik


# ------------------------------------------------------------- full-text search
def _parse_sics(source):
    values = source.get("sics") or []
    values = values if isinstance(values, list) else [values]
    out = []
    for value in values:
        try:
            out.append(int(str(value).strip()))
        except Exception:
            pass
    return out


def _parse_items(source):
    values = source.get("items") or []
    values = values if isinstance(values, list) else [values]
    return {i for v in values for i in re.split(r"[,;\s]+", str(v).strip()) if i}


def _form(source):
    return str(source.get("form") or source.get("form_type") or "").strip()


def _page(start_dt, end_dt, offset=0, forms="10-K,10-Q", items=None):
    params = {
        "q": "", "category": "custom", "forms": forms, "dateRange": "custom",
        "startdt": start_dt.isoformat(), "enddt": end_dt.isoformat(),
        "from": int(offset), "size": 100,
    }
    if items:
        params["items"] = items
    return get(EFTS_URL, params=params, expect_json=True)


def _search_window(start_dt, end_dt, forms="10-K,10-Q", items=None):
    first = _page(start_dt, end_dt, 0, forms, items)
    hits_obj = first.get("hits", {})
    total_obj = hits_obj.get("total", {})
    total = int(total_obj.get("value", 0) if isinstance(total_obj, dict) else total_obj or 0)
    relation = total_obj.get("relation", "eq") if isinstance(total_obj, dict) else "eq"
    # Stay under Elasticsearch's deep-pagination ceiling by splitting the date range.
    if (relation != "eq" or total >= 9500) and start_dt < end_dt:
        midpoint = start_dt + timedelta(days=(end_dt - start_dt).days // 2)
        return (_search_window(start_dt, midpoint, forms, items)
                + _search_window(midpoint + timedelta(days=1), end_dt, forms, items))
    if (relation != "eq" or total >= 9500) and start_dt == end_dt and "," in forms:
        out = []
        for form in forms.split(","):
            out.extend(_search_window(start_dt, end_dt, form.strip(), items))
        return out
    hits = list(hits_obj.get("hits", []))
    offset = len(hits)
    while offset < total:
        batch = _page(start_dt, end_dt, offset, forms, items).get("hits", {}).get("hits", [])
        if not batch:
            break
        hits.extend(batch)
        offset += len(batch)
    return hits


def _filing_url(hit):
    source = hit.get("_source", {})
    adsh = source.get("adsh")
    hit_id = str(hit.get("_id", ""))
    filename = None
    if ":" in hit_id:
        accession_from_id, filename = hit_id.split(":", 1)
        adsh = adsh or accession_from_id
    ciks = source.get("ciks") or []
    ciks = ciks if isinstance(ciks, list) else [ciks]
    if not (adsh and filename and ciks):
        return None
    return (f"https://www.sec.gov/Archives/edgar/data/{int(str(ciks[0]))}/"
            f"{str(adsh).replace('-', '')}/{filename}")


def _clean_name(display_name, fallback=""):
    if not display_name:
        return fallback
    value = re.sub(r"\s*\(CIK\s+\d+\)\s*$", "", str(display_name), flags=re.I)
    value = re.sub(r"\s+\([^()]{1,24}\)\s*$", "", value)
    return value.strip() or fallback


def _pick_document(group, root_form):
    if root_form == "8-K":
        def rank(hit):
            source = hit.get("_source", {})
            file_type = str(source.get("file_type", "")).upper()
            description = str(source.get("file_description", "")).lower()
            sequence = int(source.get("sequence", 999) or 999)
            score = 100 if file_type.startswith("EX-99") else 0
            if any(w in description for w in ["earnings", "press release", "results"]):
                score += 50
            if file_type == "8-K":
                score += 10
            return score, -sequence
        return max(group, key=rank)

    def rank(hit):
        source = hit.get("_source", {})
        file_type = str(source.get("file_type", "")).upper()
        sequence = int(source.get("sequence", 999) or 999)
        score = 100 if file_type == root_form else 0
        if sequence == 1:
            score += 30
        if file_type.endswith(("XML", "XSD")):
            score -= 100
        return score, -sequence
    return max(group, key=rank)


def discover(start_dt: date, end_dt: date, tickers: dict, log=print):
    """Find manufacturing filings in a date window.

    Returns (rows, stats). `stats` records how many filings were seen and how many
    were dropped by the manufacturing gate, so the workflow log always shows the
    filter doing its job rather than leaving it implicit.
    """
    hits = []
    for forms, items in [("10-K,10-Q", None), ("8-K", "2.02")]:
        hits.extend(_search_window(start_dt, end_dt, forms, items))

    unique = {}
    for hit in hits:
        source = hit.get("_source", {})
        accession = source.get("adsh") or (
            str(hit.get("_id", "")).split(":", 1)[0] if ":" in str(hit.get("_id", "")) else None
        )
        if accession:
            unique[(accession, str(hit.get("_id", "")))] = hit

    groups = defaultdict(list)
    for (accession, _), hit in unique.items():
        groups[accession].append(hit)

    stats = {"seen": len(groups), "not_public": 0, "no_sic": 0,
             "non_manufacturing": 0, "wrong_form": 0, "kept": 0}
    rows = []
    for accession, group in groups.items():
        sources = [h.get("_source", {}) for h in group]
        ciks = [str(v).zfill(10) for s in sources
                for v in (s.get("ciks") if isinstance(s.get("ciks"), list) else [s.get("ciks")])
                if v is not None and str(v).strip()]
        if not ciks or ciks[0] not in tickers:
            stats["not_public"] += 1
            continue
        sics = [s for src in sources for s in _parse_sics(src)]
        if not sics:
            stats["no_sic"] += 1
            continue
        # ---- THE MANUFACTURING GATE ----
        manufacturing = [s for s in sics
                         if config.MANUFACTURING_SIC_MIN <= s <= config.MANUFACTURING_SIC_MAX]
        if not manufacturing:
            stats["non_manufacturing"] += 1
            continue
        forms = {_form(s) for s in sources}
        root_form = next((f for f in ["10-Q", "10-K", "8-K"] if f in forms), None)
        if root_form is None:
            stats["wrong_form"] += 1
            continue
        filing_items = set().union(*(_parse_items(s) for s in sources))
        if root_form == "8-K" and "2.02" not in filing_items:
            stats["wrong_form"] += 1
            continue

        chosen = _pick_document(group, root_form)
        chosen_source = chosen.get("_source", {})
        url = _filing_url(chosen)
        filed_raw = chosen_source.get("file_date") or chosen_source.get("display_date_filed")
        if not url or not filed_raw:
            stats["wrong_form"] += 1
            continue
        filed = pd.Timestamp(filed_raw).date()
        report_date = reporting_date_for_filing(root_form, chosen_source.get("period_ending"), filed)
        sic = manufacturing[0]
        sic2 = f"{sic // 100:02d}"
        if sic2 not in config.SIC2_TITLES:
            stats["non_manufacturing"] += 1
            continue
        names = [n for s in sources
                 for n in (s.get("display_names") if isinstance(s.get("display_names"), list)
                           else [s.get("display_names")]) if n]
        record = tickers[ciks[0]]
        report_quarter = (report_date.month - 1) // 3 + 1
        rows.append({
            "accession": accession, "cik": ciks[0], "ticker": record["ticker"],
            "company": _clean_name(names[0] if names else record["name"], record["name"]),
            "sic": str(sic), "sic2": sic2, "sic2_title": config.SIC2_TITLES[sic2], "state": "",
            "form": root_form, "filed_date": filed.isoformat(),
            "report_date": report_date.isoformat(), "report_year": str(report_date.year),
            "report_quarter": str(report_quarter),
            "period": label(report_date.year, report_quarter),
            "url": url, "document_type": chosen_source.get("file_type", root_form),
            "downloaded": "0", "extracted": "0", "analyzed": "0", "error": "",
        })
        stats["kept"] += 1

    deduped = list({r["accession"]: r for r in rows}.values())
    log(f"  SEC returned {stats['seen']} filings; kept {len(deduped)} manufacturing "
        f"(dropped {stats['non_manufacturing']} non-manufacturing SIC, "
        f"{stats['not_public']} not in the public-company list, "
        f"{stats['no_sic']} with no SIC, {stats['wrong_form']} wrong form/doc)")
    return deduped, stats


# ------------------------------------------------------------- company location
def fetch_company_location(cik10: str):
    data = get(f"https://data.sec.gov/submissions/CIK{cik10}.json", expect_json=True)
    business = (data.get("addresses") or {}).get("business") or {}
    state = str(business.get("stateOrCountry") or "").strip().upper()
    return {
        "cik": cik10,
        "company": data.get("name", ""),
        "state": state if state in config.STATE_TITLES else "",
        "state_title": config.STATE_TITLES.get(state, ""),
        "city": business.get("city", ""),
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
    }


def fetch_company_locations(ciks, known, log=print):
    """Business-address state per company, fetched once ever and cached in companies.csv."""
    pending = sorted(set(ciks) - set(known))
    if not pending:
        return []
    out = []
    with ThreadPoolExecutor(max_workers=config.DOWNLOAD_WORKERS) as pool:
        futures = {pool.submit(fetch_company_location, c): c for c in pending}
        for i, future in enumerate(as_completed(futures), start=1):
            try:
                out.append(future.result())
            except Exception as exc:
                log(f"  warning: location lookup failed for CIK {futures[future]}: {exc}")
            if i % 50 == 0:
                log(f"  company locations: {i}/{len(pending)}")
    log(f"  looked up {len(out)} new company locations")
    return out


def download_filing(url: str, destination):
    if destination.exists() and destination.stat().st_size > 200:
        return True
    response = get(url)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(response.content)
    return True
