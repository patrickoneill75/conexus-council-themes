"""Talking to this Worker's /api/pcn/relay/* routes from GitHub Actions -- same
shared-secret mechanism (x-pipeline-key: BOX_RELAY_SECRET) themes/box_store.py and
consensus/relay.py already use, targeting src/pcn.js's own relay/network route rather
than either of those (see pcn/config.py's docstring for why this app needs its own).
"""
from __future__ import annotations

from urllib.parse import urlsplit

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config

_retry = retry(
    retry=retry_if_exception_type(requests.RequestException),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(4),
    reraise=True,
)


def _worker_origin() -> str:
    parts = urlsplit(config.BOX_RELAY_URL)
    return f"{parts.scheme}://{parts.netloc}"


def _headers() -> dict:
    return {"x-pipeline-key": config.BOX_RELAY_SECRET}


@_retry
def publish_network(network: dict) -> None:
    response = requests.post(
        f"{_worker_origin()}/api/pcn/relay/network",
        headers=_headers(), timeout=30, json=network,
    )
    response.raise_for_status()


@_retry
def publish_timeline(timeline: dict) -> None:
    response = requests.post(
        f"{_worker_origin()}/api/pcn/relay/timeline",
        headers=_headers(), timeout=30, json=timeline,
    )
    response.raise_for_status()


@_retry
def fetch_state() -> dict:
    """The durable ledger/issues/resolutions as they stand in Box right now --
    {ledger: [...], issues: [...], resolutions: {...}}, each empty if this is the
    very first run."""
    response = requests.get(f"{_worker_origin()}/api/pcn/relay/state", headers=_headers(), timeout=30)
    response.raise_for_status()
    return response.json()


@_retry
def push_state(ledger: list[dict], issues: list[dict], resolutions: dict) -> None:
    response = requests.post(
        f"{_worker_origin()}/api/pcn/relay/state",
        headers=_headers(), timeout=60,
        json={"ledger": ledger, "issues": issues, "resolutions": resolutions},
    )
    response.raise_for_status()


@_retry
def fetch_pending_meetings() -> list[dict]:
    """Every meeting an admin has uploaded but this pipeline hasn't ingested yet --
    each entry carries its raw file content as base64 (contentBase64) alongside its
    metadata (id, inputType, inputFormat, meetingDate, notetaker, sourceFilename)."""
    response = requests.get(f"{_worker_origin()}/api/pcn/relay/meetings/pending", headers=_headers(), timeout=60)
    response.raise_for_status()
    return response.json().get("meetings", [])


@_retry
def mark_meetings_processed(results: list[dict]) -> None:
    """results: [{id, status: "processed"|"failed", error?}, ...]."""
    response = requests.post(
        f"{_worker_origin()}/api/pcn/relay/meetings/mark-processed",
        headers=_headers(), timeout=30, json={"results": results},
    )
    response.raise_for_status()
