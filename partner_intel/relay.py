"""Talking to this Worker's /api/partner-intel/relay/* routes from GitHub Actions.

Same shared-secret mechanism every Box-backed pipeline here uses (x-pipeline-key:
BOX_RELAY_SECRET). The Worker holds the Box credential and does every Box call; the pipeline
only ever sees folder listings and file bytes.
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
        r = requests.post(self._url(path), headers=self._headers(), json=body, timeout=timeout)
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
        return self._get("state", timeout=120).json()

    def put_state(self, registry: dict, cache: dict) -> None:
        self._post("state", {"registry": registry, "cache": cache}, timeout=300)

    def publish(self, dataset: dict) -> None:
        self._post("publish", dataset, timeout=300)

    def report(self, report: dict) -> None:
        self._post("report", report)
