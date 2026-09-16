"""Talking to this Worker's /api/consensus/relay/* routes -- reading a survey's
definition and marking it analyzed, from GitHub Actions rather than a browser. Same
shared-secret mechanism (x-pipeline-key: BOX_RELAY_SECRET) themes/box_store.py already
uses for GET /api/box/pipeline-token; this just targets a sibling path on the same
Worker rather than a new one, so no new secret is needed for this leg either.
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
    # BOX_RELAY_URL is the full .../api/box/pipeline-token endpoint -- this Worker's
    # other relay routes live at the same origin, just a different path.
    parts = urlsplit(config.BOX_RELAY_URL)
    return f"{parts.scheme}://{parts.netloc}"


def _headers() -> dict:
    return {"x-pipeline-key": config.BOX_RELAY_SECRET}


@_retry
def get_survey(survey_id: str) -> dict:
    response = requests.get(
        f"{_worker_origin()}/api/consensus/relay/survey/{survey_id}",
        headers=_headers(), timeout=30,
    )
    if response.status_code == 404:
        raise ValueError(f"Survey {survey_id!r} not found.")
    response.raise_for_status()
    return response.json()


@_retry
def mark_analyzed(survey_id: str) -> None:
    response = requests.post(
        f"{_worker_origin()}/api/consensus/relay/survey/{survey_id}/mark-analyzed",
        headers=_headers(), timeout=30,
    )
    response.raise_for_status()
