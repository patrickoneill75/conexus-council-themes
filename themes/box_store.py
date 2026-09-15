"""Reading the survey and tracker files out of Box, and writing the tracker back.

This module never talks to Box's OAuth directly. Box login happens once, interactively,
in the control panel (see public/admin.html and src/worker.js): the admin clicks "Log in
with Box", Box's standard OAuth 2.0 flow runs, and the resulting access/refresh tokens
are kept by the Cloudflare Worker in Workers KV — the right place for them, since the
refresh token rotates every time it's used and a GitHub Actions run has no durable place
of its own to keep something that changes underneath it. The admin also picks the upload
folder and the tracker file there, once, and can change either any time.

Instead, this module calls the Worker's own relay endpoint — GET /api/box/pipeline-token,
authenticated by a shared secret (BOX_RELAY_SECRET) rather than a login — which hands
back a short-lived access token plus the currently-selected upload folder ID and tracker
file ID.

This Box app has read AND write scope (it's shared with conexus-mcm, whose app already
has "Read and write all files and folders" — see SETUP.md), so this run re-uploads the
tracker's new version after appending to it.
"""
from __future__ import annotations

import json
import threading
import time

import requests
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from . import config

API = "https://api.box.com/2.0"
UPLOAD_API = "https://upload.box.com/api/2.0"

_lock = threading.Lock()
_cache = {"access_token": None, "upload_folder_id": None, "tracker_file_id": None,
          "quant_folder_id": None, "expires_at": 0.0}

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
        _cache["upload_folder_id"] = body["upload_folder_id"]
        _cache["tracker_file_id"] = body["tracker_file_id"]
        # Nullable: not every run needs quant setup to exist yet (see worker.js).
        _cache["quant_folder_id"] = body.get("quant_folder_id")
        # The relay reports the token's true remaining lifetime, not Box's original
        # expires_in. Trusting the latter is how an expired token gets sent mid-run.
        _cache["expires_at"] = time.time() + float(body.get("expires_in", 3300))


def _ensure_fresh():
    if not _cache["access_token"] or time.time() >= _cache["expires_at"] - 60:
        _refresh()


def _headers():
    _ensure_fresh()
    return {"authorization": f"Bearer {_cache['access_token']}"}


def upload_folder_id() -> str:
    _ensure_fresh()
    return _cache["upload_folder_id"]


def tracker_file_id() -> str:
    _ensure_fresh()
    return _cache["tracker_file_id"]


def quant_folder_id() -> str | None:
    _ensure_fresh()
    return _cache["quant_folder_id"]


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
