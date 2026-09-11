"""Reading the council meeting documents out of Box.

This module never talks to Box's OAuth directly. Box login happens once, interactively,
in the control panel (see public/admin.html and src/worker.js): the admin clicks "Log in
with Box", Box's standard OAuth 2.0 flow runs, and the resulting access/refresh tokens
are kept by the Cloudflare Worker in Workers KV — the right place for them, since the
refresh token rotates every time it's used and a GitHub Actions run has no durable place
of its own to keep something that changes underneath it. The admin also picks the source
folder there, once, and can change it any time.

Instead, this module calls the Worker's own relay endpoint — GET /api/box/pipeline-token,
authenticated by a shared secret (BOX_RELAY_SECRET) rather than a login — which hands
back a short-lived access token plus the currently-selected folder ID.

Access is read-only: this never uploads, moves or deletes anything in Box.
"""
from __future__ import annotations

import threading
import time

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config

API = "https://api.box.com/2.0"

_lock = threading.Lock()
_cache = {"access_token": None, "folder_id": None, "expires_at": 0.0}

_retry = retry(
    retry=retry_if_exception_type(requests.RequestException),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(4),
    reraise=True,
)


class BoxError(RuntimeError):
    pass


class NotConnected(RuntimeError):
    """Box isn't logged in yet, or no folder has been picked — a normal state before the
    admin has finished the control panel's setup, not a bug."""


def enabled() -> bool:
    return bool(config.BOX_RELAY_URL and config.BOX_RELAY_SECRET)


@_retry
def _refresh():
    with _lock:
        response = requests.get(
            config.BOX_RELAY_URL,
            headers={"x-pipeline-key": config.BOX_RELAY_SECRET},
            timeout=30,
        )
        if response.status_code == 409:
            raise NotConnected(response.json().get("error", "Box is not connected."))
        if response.status_code == 401:
            raise BoxError("BOX_RELAY_SECRET does not match the Worker's — check both are "
                           "set from the same value.")
        response.raise_for_status()
        body = response.json()
        _cache["access_token"] = body["access_token"]
        _cache["folder_id"] = body["folder_id"]
        # The relay reports the token's true remaining lifetime, not Box's original
        # expires_in. Trusting the latter is how an expired token gets sent mid-run.
        _cache["expires_at"] = time.time() + float(body.get("expires_in", 3300))


def _token_and_folder():
    if not _cache["access_token"] or time.time() >= _cache["expires_at"] - 60:
        _refresh()
    return _cache["access_token"], _cache["folder_id"]


def _headers():
    token, _ = _token_and_folder()
    return {"authorization": f"Bearer {token}"}


def folder_id() -> str:
    _, fid = _token_and_folder()
    return fid


@_retry
def list_documents() -> list[dict]:
    """Every file sitting directly in the selected folder, following Box's paging.

    Subfolders are deliberately not walked: the folder the admin picked is the folder,
    which keeps "why did that document not appear" a question with one answer.
    """
    _, fid = _token_and_folder()
    files, offset = [], 0
    while True:
        response = requests.get(
            f"{API}/folders/{fid}/items",
            headers=_headers(),
            params={"fields": "id,name,type,modified_at,size", "limit": 1000, "offset": offset},
            timeout=30,
        )
        if response.status_code == 404:
            raise BoxError(
                f"Box cannot find folder {fid}. Open the control panel and choose the "
                "folder again — it may have been moved or deleted."
            )
        response.raise_for_status()
        body = response.json()
        entries = body.get("entries", [])
        files.extend(e for e in entries if e.get("type") == "file")
        offset += len(entries)
        if not entries or offset >= body.get("total_count", offset):
            return files


@_retry
def download(file_id: str) -> bytes:
    response = requests.get(f"{API}/files/{file_id}/content", headers=_headers(), timeout=120)
    response.raise_for_status()
    return response.content
