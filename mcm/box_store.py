"""Box storage for the durable data store (see mcm.store).

This module never talks to Box directly. Box login happens once, interactively, in this
repo's shared control panel -- the same "Log in with Box" connection Council Themes,
Quant, PCN and Consensus already use (see src/worker.js's box/authorize-url,
box/callback, box/status). MCM has its own destination folder, picked once in its own
control panel (public/mcm/index.html) and kept in Workers KV under a key of its own --
separate from every other mini app's folder.

Instead, this module calls the Worker's relay endpoint for MCM specifically --
GET /api/mcm/relay/pipeline-token, authenticated by a shared secret (BOX_RELAY_SECRET)
rather than a login -- which hands back a short-lived access token plus MCM's currently-
selected folder ID. BOX_RELAY_URL is set to that repo's own GET /api/box/pipeline-token
URL (the convention every mini app's pipeline here shares); this module derives the
Worker's origin from it and calls its own sibling path instead, exactly the way
pcn/relay.py and consensus/relay.py already do. All six data files live flat in that
folder, addressed by name; no ID mapping is kept anywhere, so a run always resolves the
current file for a name by listing the folder once and reusing that lookup for every
pull or push in the same run.
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
    """Box isn't logged in yet, or no folder has been picked -- a normal state before the
    admin has finished the control panel's setup, not a failure to raise the run over."""


def enabled() -> bool:
    return bool(config.BOX_RELAY_URL and config.BOX_RELAY_SECRET)


def _pipeline_token_url() -> str:
    # BOX_RELAY_URL is the repo's own .../api/box/pipeline-token endpoint -- this derives
    # the Worker's origin from it and targets MCM's own sibling relay route instead.
    parts = urlsplit(config.BOX_RELAY_URL)
    origin = f"{parts.scheme}://{parts.netloc}"
    return f"{origin}/api/mcm/relay/pipeline-token"


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
            raise BoxError("BOX_RELAY_SECRET does not match the Worker's -- check both are "
                            "set from the same value.")
        response.raise_for_status()
        body = response.json()
        _cache["access_token"] = body["access_token"]
        _cache["folder_id"] = body["folder_id"]
        _cache["expires_at"] = time.time() + float(body.get("expires_in", 3300))


def _access_token_and_folder():
    if not _cache["access_token"] or time.time() >= _cache["expires_at"] - 60:
        _refresh()
    return _cache["access_token"], _cache["folder_id"]


def _headers():
    token, _ = _access_token_and_folder()
    return {"authorization": f"Bearer {token}"}


@_retry
def _folder_items() -> dict:
    """name -> file_id for everything currently in the selected folder."""
    _, folder_id = _access_token_and_folder()
    items, offset = {}, 0
    while True:
        response = requests.get(
            f"{API}/folders/{folder_id}/items",
            headers=_headers(),
            params={"fields": "name,type", "limit": 1000, "offset": offset},
            timeout=30,
        )
        response.raise_for_status()
        body = response.json()
        entries = body.get("entries", [])
        for entry in entries:
            if entry.get("type") == "file":
                items[entry["name"]] = entry["id"]
        offset += len(entries)
        if not entries or offset >= body.get("total_count", offset):
            break
    return items


@_retry
def _download(file_id: str, destination):
    response = requests.get(f"{API}/files/{file_id}/content", headers=_headers(), timeout=120)
    response.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(response.content)


@_retry
def _upload_new(name: str, local_path):
    _, folder_id = _access_token_and_folder()
    attributes = json.dumps({"name": name, "parent": {"id": folder_id}})
    with open(local_path, "rb") as fh:
        response = requests.post(
            f"{UPLOAD_API}/files/content", headers=_headers(),
            data={"attributes": attributes}, files={"file": (name, fh)}, timeout=180,
        )
    if response.status_code == 409:
        return  # created by a concurrent run between the folder listing and this upload
    response.raise_for_status()


@_retry
def _upload_version(file_id: str, name: str, local_path):
    with open(local_path, "rb") as fh:
        response = requests.post(
            f"{UPLOAD_API}/files/{file_id}/content", headers=_headers(),
            files={"file": (name, fh)}, timeout=180,
        )
    response.raise_for_status()


def pull(log=print):
    """Download the durable store from Box into config.DATA_DIR.

    A file missing from Box is simply skipped -- that is the normal state for the very
    first run, or for a file that has never had anything written to it. When Box is not
    configured (no relay secrets set) or not yet connected (no login, or no folder
    picked in the control panel), this is a no-op that logs why and moves on: whatever
    is already on disk locally (or nothing, on a fresh checkout) is what the run works
    from, and download/analyze can still do useful work without Box.
    """
    if not enabled():
        log("  BOX_RELAY_URL/BOX_RELAY_SECRET are not set; using whatever is already "
            "in the local data directory.")
        return
    try:
        items = _folder_items()
    except NotConnected as exc:
        log(f"  {exc} Using whatever is already in the local data directory.")
        return
    fetched = 0
    for path in config.BOX_DATA_FILES:
        file_id = items.get(path.name)
        if not file_id:
            continue
        _download(file_id, path)
        fetched += 1
    log(f"  Pulled {fetched}/{len(config.BOX_DATA_FILES)} data files from Box.")


def push(log=print, files=None):
    """Upload data files that exist locally back to Box, creating each on first use.

    `files` limits the push to a subset (e.g. just the couple of files that actually
    change during a long per-filing analysis loop) instead of the full six -- a frequent
    checkpoint has no reason to re-upload paragraphs.csv or companies.csv every time just
    because they happen to sit in the same folder. Omit it to push everything, which is
    what the normal end-of-run and post-download checkpoints still do.
    """
    if not enabled():
        log("  BOX_RELAY_URL/BOX_RELAY_SECRET are not set; leaving results in the local "
            "data directory only.")
        return
    targets = files if files is not None else config.BOX_DATA_FILES
    try:
        items = _folder_items()
    except NotConnected as exc:
        log(f"  {exc} Leaving results in the local data directory only.")
        return
    pushed = 0
    for path in targets:
        if not path.exists():
            continue
        file_id = items.get(path.name)
        if file_id:
            _upload_version(file_id, path.name, path)
        else:
            _upload_new(path.name, path)
        pushed += 1
    log(f"  Pushed {pushed}/{len(targets)} data files to Box.")
