"""Talking to this Worker's /api/pcn/relay/* routes from GitHub Actions -- same
shared-secret mechanism (x-pipeline-key: BOX_RELAY_SECRET) themes/box_store.py and
consensus/relay.py already use, targeting src/pcn.js's own relay/projects/<id>/*
routes rather than either of those (see pcn/config.py's docstring for why this app
needs its own).

Every function takes a project_id first: PCN Issue Map supports multiple walled-off
projects (its own Box folder, ledger, issues, network, timeline -- see src/pcn.js's
module docstring), and every relay call has to say which one it means.
"""
from __future__ import annotations

from urllib.parse import quote, urlsplit

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


def _project_url(project_id: str, path: str) -> str:
    return f"{_worker_origin()}/api/pcn/relay/projects/{quote(project_id, safe='')}/{path}"


@_retry
def publish_network(project_id: str, network: dict) -> None:
    response = requests.post(_project_url(project_id, "network"), headers=_headers(), timeout=30, json=network)
    response.raise_for_status()


@_retry
def publish_timeline(project_id: str, timeline: dict) -> None:
    response = requests.post(_project_url(project_id, "timeline"), headers=_headers(), timeout=30, json=timeline)
    response.raise_for_status()


@_retry
def fetch_state(project_id: str) -> dict:
    """The durable ledger/issues/resolutions as they stand in Box right now --
    {ledger: [...], issues: [...], resolutions: {...}}, each empty if this is the
    very first run."""
    response = requests.get(_project_url(project_id, "state"), headers=_headers(), timeout=30)
    response.raise_for_status()
    return response.json()


@_retry
def push_state(project_id: str, ledger: list[dict], issues: list[dict], resolutions: dict) -> None:
    response = requests.post(
        _project_url(project_id, "state"), headers=_headers(), timeout=60,
        json={"ledger": ledger, "issues": issues, "resolutions": resolutions},
    )
    response.raise_for_status()


@_retry
def fetch_pending_meetings(project_id: str) -> list[dict]:
    """Every meeting an admin has uploaded to this project but this pipeline hasn't
    ingested yet -- each entry carries its raw file content as base64
    (contentBase64) alongside its metadata (id, inputType, inputFormat, meetingDate,
    year, quarter, cohort, notetaker, sourceFilename)."""
    response = requests.get(_project_url(project_id, "meetings/pending"), headers=_headers(), timeout=60)
    response.raise_for_status()
    return response.json().get("meetings", [])


@_retry
def mark_meetings_processed(project_id: str, results: list[dict]) -> None:
    """results: [{id, status: "processed"|"failed", error?}, ...]."""
    response = requests.post(
        _project_url(project_id, "meetings/mark-processed"),
        headers=_headers(), timeout=30, json={"results": results},
    )
    response.raise_for_status()
