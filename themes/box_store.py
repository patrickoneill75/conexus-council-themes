"""Reading the Data Folder's files out of Box, and writing new versions back.

This module never talks to Box's OAuth directly. Box login happens once, interactively,
in the control panel (see public/council-data/control-panel/index.html and
src/worker.js/src/council_data.js): the admin clicks "Log in with Box", Box's standard
OAuth 2.0 flow runs, and the resulting access/refresh tokens
are kept by the Cloudflare Worker in Workers KV — the right place for them, since the
refresh token rotates every time it's used and a GitHub Actions run has no durable place
of its own to keep something that changes underneath it. The admin also picks the Data
Folder there, once, and can change it any time.

Instead, this module calls the Worker's own relay endpoint for this mini app --
GET /api/council-data/relay/pipeline-token, authenticated by a shared secret
(BOX_RELAY_SECRET) rather than a login — which hands back a short-lived access token
plus the currently-selected Data Folder ID. BOX_RELAY_URL is set to the repo's own
GET /api/box/pipeline-token URL (a historical name kept for backward compatibility with
existing secret values -- see src/worker.js); this module derives the Worker's origin
from it and calls its own sibling path instead, the same pattern every other mini
app's own relay client already uses (see pcn/relay.py, consensus/relay.py).

`tracker_file_id()` is a leftover, kept only for the one-time migration that reads the
old tracker.xlsx out of Box (see scripts/migrate_feedback_log.py) — everything else in
this module works off the single Data Folder now.

This Box app has read AND write scope (it's shared with conexus-mcm, whose app already
has "Read and write all files and folders" — see SETUP.md), so this run re-uploads the
tracker's new version after appending to it.
"""
from __future__ import annotations

import json
import threading
import time
from urllib.parse import urlsplit

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config

API = "https://api.box.com/2.0"
UPLOAD_API = "https://upload.box.com/api/2.0"

_lock = threading.Lock()
_cache = {"access_token": None, "data_folder_id": None, "tracker_file_id": None,
          "expires_at": 0.0}

_retry = retry(
    retry=retry_if_exception_type(requests.RequestException),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(4),
    reraise=True,
)


class BoxError(RuntimeError):
    pass


class NotConnected(RuntimeError):
    """Box isn't logged in yet — a normal state before the admin has finished the control
    panel's setup, not a bug. A Data Folder not having been picked yet is a separate,
    equally normal state, but isn't this: it's reported by data_folder_id() returning
    None rather than by an exception, since only some callers (e.g. Update Dashboard,
    which cannot do anything without one) should treat that as fatal — others (e.g.
    Refresh Dashboard) no-op instead. See themes/quant_publish.py's refresh()."""


def enabled() -> bool:
    return bool(config.BOX_RELAY_URL and config.BOX_RELAY_SECRET)


def _pipeline_token_url() -> str:
    parts = urlsplit(config.BOX_RELAY_URL)
    origin = f"{parts.scheme}://{parts.netloc}"
    return f"{origin}/api/council-data/relay/pipeline-token"


@_retry
def _refresh():
    with _lock:
        response = requests.get(
            _pipeline_token_url(),
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
        _cache["data_folder_id"] = body.get("data_folder_id")
        _cache["tracker_file_id"] = body.get("tracker_file_id")
        # The relay reports the token's true remaining lifetime, not Box's original
        # expires_in. Trusting the latter is how an expired token gets sent mid-run.
        _cache["expires_at"] = time.time() + float(body.get("expires_in", 3300))


def _ensure_fresh():
    if not _cache["access_token"] or time.time() >= _cache["expires_at"] - 60:
        _refresh()


def _headers():
    _ensure_fresh()
    return {"authorization": f"Bearer {_cache['access_token']}"}


def data_folder_id() -> str | None:
    _ensure_fresh()
    return _cache["data_folder_id"]


def tracker_file_id() -> str | None:
    _ensure_fresh()
    return _cache["tracker_file_id"]


@_retry
def download(file_id: str) -> bytes:
    response = requests.get(f"{API}/files/{file_id}/content", headers=_headers(), timeout=120)
    response.raise_for_status()
    return response.content


@_retry
def upload_new(folder_id: str, filename: str, content: bytes) -> str:
    """Upload a new file into `folder_id`. Returns the new file's Box id."""
    attributes = json.dumps({"name": filename, "parent": {"id": folder_id}})
    response = requests.post(
        f"{UPLOAD_API}/files/content", headers=_headers(),
        data={"attributes": attributes}, files={"file": (filename, content)}, timeout=180,
    )
    response.raise_for_status()
    return response.json()["entries"][0]["id"]


@_retry
def upload_new_version(file_id: str, filename: str, content: bytes) -> None:
    """Upload a new version of an existing file — how the tracker gets updated in place."""
    response = requests.post(
        f"{UPLOAD_API}/files/{file_id}/content", headers=_headers(),
        files={"file": (filename, content)}, timeout=180,
    )
    response.raise_for_status()


@_retry
def list_folder(folder_id: str) -> list[dict]:
    """Every file sitting directly in `folder_id` — {id, name} — following Box's paging.

    Subfolders are not walked or returned. Used by the quant dashboard pipeline, which
    treats the whole folder as its source: every run relists it rather than remembering
    what was there last time.
    """
    files, offset = [], 0
    while True:
        response = requests.get(
            f"{API}/folders/{folder_id}/items",
            headers=_headers(),
            params={"fields": "id,name,type", "limit": 1000, "offset": offset},
            timeout=30,
        )
        if response.status_code == 404:
            raise BoxError(
                f"Box cannot find folder {folder_id}. Open the control panel and choose "
                "the folder again — it may have been moved or deleted."
            )
        response.raise_for_status()
        body = response.json()
        entries = body.get("entries", [])
        files.extend({"id": e["id"], "name": e["name"]}
                     for e in entries if e.get("type") == "file")
        offset += len(entries)
        if not entries or offset >= body.get("total_count", offset):
            return files
