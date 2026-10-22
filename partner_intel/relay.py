"""Talking to this Worker's /api/partner-intel/relay/* routes from GitHub Actions.

Same shared-secret mechanism every Box-backed pipeline here uses (x-pipeline-key:
BOX_RELAY_SECRET). The Worker holds the Box credential and does every Box call; the pipeline
only ever sees folder listings and file bytes.

The saved state (which files were read, and every Claude result) travels in pages of about
STATE_PAGE_BYTES, never as one body: begin, each page, then commit. The Worker switches to
the new state only at the commit, so a scan that stops half-way through a write leaves the
previous state whole, and a reader never sees half of one. Why pages: at about 10 KB a
section, one body for a few thousand sections outgrows what a Worker can parse in its 128 MB.
"""
from __future__ import annotations

import json
import uuid
from urllib.parse import quote, urlsplit

import requests
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from . import config

# A page of state is at most this many bytes of JSON: far under the Worker's request-body
# limit (100 MB on the Free and Pro plans), a Workers KV value (25 MiB) and the 128 MB a
# Worker may use while it checks the page.
STATE_PAGE_BYTES = 4_000_000


def _worth_retrying(e: BaseException) -> bool:
    """Network faults and server errors are retried; a 4xx answer (other than a timeout or
    rate limit) is the same every time, so it is not."""
    if not isinstance(e, requests.RequestException):
        return False
    status = getattr(getattr(e, "response", None), "status_code", None)
    return not (isinstance(e, requests.HTTPError) and status is not None and 400 <= status < 500 and status not in (408, 429))


_retry = retry(
    retry=retry_if_exception(_worth_retrying),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(4),
    reraise=True,
)


def _status(e: requests.HTTPError) -> int | None:
    return e.response.status_code if e.response is not None else None


def state_pages(items: dict, limit: int | None = None):
    """The [key, value] pairs of a dict in pages of at most limit (STATE_PAGE_BYTES) bytes of
    JSON each. An entry bigger than limit on its own is a page of its own."""
    limit = limit or STATE_PAGE_BYTES
    page, size = [], 0
    for key, value in items.items():
        n = len(json.dumps([key, value], ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if page and size + n > limit:
            yield page
            page, size = [], 0
        page.append([key, value])
        size += n
    if page:
        yield page


class Api:
    """The whole surface run.py needs. Tests substitute an in-memory fake with these methods."""

    def __init__(self, base_url: str | None = None, secret: str | None = None):
        parts = urlsplit(base_url or config.BOX_RELAY_URL)
        self.origin = f"{parts.scheme}://{parts.netloc}"
        self.secret = secret or config.BOX_RELAY_SECRET

    def _url(self, path: str) -> str:
        return f"{self.origin}/api/partner-intel/relay/{path}"

    def _headers(self) -> dict:
        return {"x-pipeline-key": self.secret}

    @_retry
    def _get(self, path: str, **kw):
        r = requests.get(self._url(path), headers=self._headers(), timeout=kw.pop("timeout", 60), **kw)
        r.raise_for_status()
        return r

    @_retry
    def _post(self, path: str, body: dict, timeout: int = 120):
        # Compact UTF-8, so a page's size on the wire is the size state_pages measured.
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        r = requests.post(self._url(path), headers={**self._headers(), "content-type": "application/json"},
                          data=data, timeout=timeout)
        r.raise_for_status()
        return r

    def config(self) -> dict:
        return self._get("config").json()

    def roster(self) -> dict:
        return self._get("roster").json()

    def list_folder(self, folder_id: str) -> list[dict]:
        return self._get(f"box/folder?id={quote(folder_id, safe='')}").json().get("entries", [])

    def download(self, file_id: str) -> bytes:
        return self._get(f"box/file?id={quote(file_id, safe='')}", timeout=180).content

    def sync_roster(self) -> dict:
        """Ask the Worker to refresh the partner list from the member-list folder in Box."""
        return self._post("roster-sync", {}).json()

    def save_to_box(self, name: str, text: str) -> dict:
        return self._post("box/save", {"name": name, "text": text}, timeout=600).json()

    def load_from_box(self, name: str) -> str | None:
        """A file from the database folder, or None when it is not there."""
        try:
            return self._get(f"box/load?name={quote(name, safe='')}", timeout=300).text
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code in (404, 409):
                return None
            raise

    def get_state(self) -> dict:
        """The saved state, read a page at a time from the version the Worker last committed. A
        page missing, or a commit landing while the pages are read, is an error, never a
        partial state: a scan that went on from half its state would write the half back."""
        try:
            meta = self._get("state/meta", timeout=60).json()
        except requests.HTTPError as e:
            if _status(e) == 404:  # a Worker from before paging
                return self._get("state", timeout=120).json()
            raise
        out: dict = {"registry": {}, "cache": {}}
        write = quote(str(meta.get("write") or ""), safe="")
        for kind in ("registry", "cache"):
            for index in range(int((meta.get("pages") or {}).get(kind) or 0)):
                page = self._get(f"state/page?kind={kind}&index={index}&write={write}", timeout=120).json()
                for key, value in page.get("items") or []:
                    out[kind][key] = value
        return out

    def put_state(self, registry: dict, cache: dict) -> None:
        """Save the state in pages, then commit. Until the commit the Worker serves the previous
        state, whole; if this stops part-way, the next save starts over and clears the pages."""
        write = uuid.uuid4().hex
        try:
            self._post("state/begin", {"write": write}, timeout=60)
        except requests.HTTPError as e:
            if _status(e) == 404:  # a Worker from before paging
                self._post("state", {"registry": registry, "cache": cache}, timeout=300)
                return
            raise
        pages = {"registry": 0, "cache": 0}
        for kind, items in (("registry", registry), ("cache", cache)):
            for page in state_pages(items):
                self._post("state/page", {"write": write, "kind": kind, "index": pages[kind], "items": page}, timeout=300)
                pages[kind] += 1
        self._post("state/commit", {"write": write, "pages": pages, "files": len(registry), "units": len(cache)},
                   timeout=120)

    def publish(self, dataset: dict) -> None:
        """Publish the dataset the way the state is saved: begin, the insights in pages, then a
        commit carrying the rest. The Worker swaps the new dataset in only at the commit. At
        about 1.3 KB an insight, one body would outgrow the Worker sooner than the state does."""
        upload = uuid.uuid4().hex
        try:
            self._post("publish/begin", {"upload": upload}, timeout=60)
        except requests.HTTPError as e:
            if _status(e) == 404:  # a Worker from before paging
                self._post("publish", dataset, timeout=300)
                return
            raise
        insights = dataset.get("insights") or []
        chunks = 0
        for page in state_pages(dict(enumerate(insights))):
            self._post("publish/page", {"upload": upload, "index": chunks, "insights": [i for _, i in page]}, timeout=300)
            chunks += 1
        self._post("publish/commit", {"upload": upload, "chunks": chunks, "insights": len(insights),
                                      "dataset": {k: v for k, v in dataset.items() if k != "insights"}}, timeout=300)

    def report(self, report: dict) -> None:
        self._post("report", report)
