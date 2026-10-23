"""Talks to the Argonite Worker and pulls release assets from GitHub."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "Argonite-Scanner"
DOWNLOAD_HOSTS = {"api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github.com"}
SIGNED_HOSTS = {"objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"}


def _signed_url_ok(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == "https" and (parsed.hostname or "") in SIGNED_HOSTS


class Missing(Exception):
    """The asset no longer exists on GitHub."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_opener = urllib.request.build_opener(_NoRedirect)


class WorkerClient:
    def __init__(self, base: str, secret: str) -> None:
        self.base = base.rstrip("/")
        self.secret = secret.encode()

    def call(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload, separators=(",", ":"))
        ts = str(int(time.time()))
        sig = hmac.new(self.secret, f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
        req = urllib.request.Request(
            self.base + path,
            data=body.encode(),
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": UA, "X-Argonite-Timestamp": ts, "X-Argonite-Signature": sig},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise RuntimeError(f"Worker {path} returned {exc.code}: {detail}") from None


def download_asset(repo_id: int, asset_id: int, expected_size: int, token: str | None) -> bytes:
    url = f"https://api.github.com/repositories/{int(repo_id)}/releases/assets/{int(asset_id)}"
    headers = {"Accept": "application/octet-stream", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for _ in range(5):
        host = urllib.parse.urlparse(url).hostname
        if host not in DOWNLOAD_HOSTS:
            raise RuntimeError(f"refusing to download from {host}")
        req = urllib.request.Request(url, headers=headers)
        try:
            res = _opener.open(req, timeout=120)
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308):
                url = urllib.parse.urljoin(url, exc.headers["Location"])
                # Signed storage URLs reject a second auth mechanism, so drop the token after the first hop.
                headers = {"User-Agent": UA}
                continue
            if exc.code == 404:
                raise Missing("the release asset no longer exists on GitHub") from None
            raise RuntimeError(f"GitHub returned {exc.code} for the asset") from None
        with res:
            chunks = []
            total = 0
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise RuntimeError("asset is larger than the uploaded size")
                chunks.append(chunk)
            return b"".join(chunks)
    raise RuntimeError("too many redirects")


def _read_capped(res, expected_size: int) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = res.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        if total > expected_size:
            raise RuntimeError("asset is larger than the uploaded size")
        chunks.append(chunk)
    return b"".join(chunks)


def download_signed(url: str, expected_size: int) -> bytes:
    """Fetch a short-lived signed link the Worker handed out (used for draft releases)."""
    for _ in range(3):
        if not _signed_url_ok(url):
            raise RuntimeError(f"refusing to download from {urllib.parse.urlparse(url).hostname}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            res = _opener.open(req, timeout=120)
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                url = urllib.parse.urljoin(url, exc.headers["Location"])
                continue
            if exc.code in (403, 404):
                raise Missing("the release asset is no longer available") from None
            raise RuntimeError(f"GitHub returned {exc.code} for the asset") from None
        with res:
            return _read_capped(res, expected_size)
    raise RuntimeError("too many redirects")
