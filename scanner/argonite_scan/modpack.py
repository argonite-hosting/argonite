"""Checks every file a modpack downloads, not just the pack itself.

Each file listed in the index is matched against files already published (and scanned) on the site
first. Anything else is downloaded from its listed host, its size and hashes are checked against the
index, and it's scanned like an upload. Results are cached by SHA-512 so popular mods are only ever
scanned once per cache lifetime.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from . import api
from .metadata import CURSEFORGE_HOSTS, MODPACK_HOSTS
from .rules import Report

UA = "Argonite-Scanner"
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
REDIRECT_HOSTS = MODPACK_HOSTS | CURSEFORGE_HOSTS | {
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
    "gitlab.com",
}
SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}

ScanFn = Callable[[bytes, str], dict]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _download(url: str, limit: int, headers: dict | None = None) -> bytes:
    current = url
    for _ in range(6):
        parsed = urllib.parse.urlparse(current)
        if parsed.scheme != "https" or (parsed.hostname or "") not in REDIRECT_HOSTS:
            raise RuntimeError(f"refusing to download from {parsed.hostname}")
        req = urllib.request.Request(current, headers={"User-Agent": UA, **(headers or {})})
        try:
            res = _opener.open(req, timeout=120)
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308) and exc.headers.get("Location"):
                current = urllib.parse.urljoin(current, exc.headers["Location"])
                headers = None
                continue
            raise RuntimeError(f"{parsed.hostname} returned {exc.code}") from None
        with res:
            chunks, total = [], 0
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise RuntimeError("file is larger than allowed")
                chunks.append(chunk)
            return b"".join(chunks)
    raise RuntimeError("too many redirects")


def guess_type(path: str) -> str:
    lower = path.lower()
    if lower.startswith("resourcepacks/") or lower.startswith("texturepacks/"):
        return "resourcepack"
    if lower.startswith("shaderpacks/"):
        return "shader"
    if "datapacks/" in lower:
        return "datapack"
    if lower.endswith(".mrpack"):
        return "modpack"
    return "mod"


class Cache:
    def __init__(self, folder: str | None) -> None:
        self.folder = os.path.expanduser(folder) if folder else None
        if self.folder:
            os.makedirs(self.folder, exist_ok=True)

    def _path(self, sha512: str) -> str | None:
        if not self.folder or not re.fullmatch(r"[0-9a-f]{128}", sha512):
            return None
        return os.path.join(self.folder, f"{sha512}.json")

    def get(self, sha512: str) -> dict | None:
        path = self._path(sha512)
        if not path or not os.path.isfile(path):
            return None
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) and data.get("v") == 1 else None
        except (OSError, ValueError):
            return None

    def put(self, sha512: str, verdict: str, findings: list[dict]) -> None:
        path = self._path(sha512)
        if not path:
            return
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"v": 1, "verdict": verdict, "findings": findings[:20]}, handle)


def _child_findings(entry_path: str, findings: list[dict], report: Report) -> None:
    for f in findings:
        rule = str(f.get("rule", ""))
        # What a mod inside a pack claims to be is the pack author's business; only security findings carry over.
        if rule.startswith("metadata.") or rule.startswith("modpack.") or SEVERITY_RANK.get(f.get("severity"), 0) < 2:
            continue
        inner = f.get("path")
        report.add(f"pack.{rule}"[:80], f["severity"], f"{entry_path}: {f.get('detail', '')}"[:480], f"{entry_path}!/{inner}" if inner else entry_path)


def _verdict(findings: list[dict]) -> str:
    top = max((SEVERITY_RANK.get(f.get("severity"), 0) for f in findings), default=0)
    return "malicious" if top >= 4 else "suspicious" if top >= 3 else "clean"


class PackChecker:
    def __init__(self, client: api.WorkerClient | None, scan_fn: ScanFn, cache_dir: str | None, curseforge_key: str | None) -> None:
        self.client = client
        self.scan_fn = scan_fn
        self.cache = Cache(cache_dir)
        self.curseforge_key = curseforge_key
        self.total = 0

    def _known(self, hashes: list[str]) -> dict:
        if not self.client or not hashes:
            return {}
        out: dict = {}
        for i in range(0, len(hashes), 1000):
            out.update(self.client.call("/internal/scan/known", {"sha512": hashes[i:i + 1000]}).get("files", {}))
        return out

    def _fetch_and_scan(self, item: dict) -> tuple[str, list[dict], str | None]:
        cached = self.cache.get(item["sha512"]) if item.get("sha512") else None
        if cached:
            return cached["verdict"], cached["findings"], None
        size = item.get("size")
        limit = min(MAX_FILE_BYTES, size if isinstance(size, int) and size > 0 else MAX_FILE_BYTES)
        if self.total + limit > MAX_TOTAL_BYTES:
            return "unscanned", [], "The pack is too large to verify every file."
        last_error = "no download link"
        for url in item.get("urls", []):
            try:
                data = _download(url, limit)
            except RuntimeError as exc:
                last_error = str(exc)
                continue
            self.total += len(data)
            if isinstance(size, int) and size and len(data) != size:
                return "suspicious", [{"rule": "pack.size_mismatch", "severity": "high", "detail": "Downloaded size doesn't match the index"}], None
            if item.get("sha1") and hashlib.sha1(data).hexdigest() != item["sha1"]:
                return "suspicious", [{"rule": "pack.hash_mismatch", "severity": "high", "detail": "SHA-1 doesn't match the index"}], None
            sha512 = hashlib.sha512(data).hexdigest()
            if item.get("sha512") and sha512 != item["sha512"]:
                return "suspicious", [{"rule": "pack.hash_mismatch", "severity": "high", "detail": "SHA-512 doesn't match the index"}], None
            ptype = guess_type(item["path"])
            if ptype == "modpack":
                return "suspicious", [{"rule": "pack.nested_modpack", "severity": "high", "detail": "A modpack inside a modpack can't be verified"}], None
            result = self.scan_fn(data, ptype)
            findings = result.get("findings", [])
            self.cache.put(item.get("sha512") or sha512, result["verdict"], findings)
            return result["verdict"], findings, None
        return "unscanned", [], f"Could not download it ({last_error})."

    def _resolve_curseforge(self, items: list[dict], report: Report) -> None:
        if not items:
            return
        if not self.curseforge_key:
            report.add("modpack.unverifiable", "high", "This pack lists CurseForge files, which can't be checked without CurseForge API access. A moderator will review it.")
            return
        headers = {"x-api-key": self.curseforge_key, "Accept": "application/json", "Content-Type": "application/json", "User-Agent": UA}
        ids = [i["curseforge"][1] for i in items]
        files: dict[int, dict] = {}
        for start in range(0, len(ids), 500):
            body = json.dumps({"fileIds": ids[start:start + 500]}).encode()
            req = urllib.request.Request("https://api.curseforge.com/v1/mods/files", data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as res:
                for f in json.loads(res.read().decode()).get("data", []):
                    files[int(f["id"])] = f
        for item in items:
            info = files.get(item["curseforge"][1])
            if not info:
                report.add("modpack.missing_file", "high", f"CurseForge file {item['curseforge'][1]} doesn't exist")
                continue
            item["path"] = f"mods/{info.get('fileName', item['curseforge'][1])}"
            item["size"] = info.get("fileLength")
            sha1 = next((h["value"] for h in info.get("hashes", []) if h.get("algo") == 1), None)
            item["sha1"] = sha1.lower() if isinstance(sha1, str) else None
            url = info.get("downloadUrl")
            item["urls"] = [url] if isinstance(url, str) and (urllib.parse.urlparse(url).hostname or "") in CURSEFORGE_HOSTS else []
            item["host"] = urllib.parse.urlparse(url).hostname if isinstance(url, str) else None
            if not item["urls"]:
                report.add("modpack.unverifiable", "high", f"{item['path']} can't be downloaded from CurseForge by third parties, so it couldn't be scanned.")

    def check(self, meta: dict, report: Report, bundled: list[dict]) -> dict:
        items = meta.get("pack_files") or []
        external = [i for i in items if i.get("source") == "external"]
        curse = [i for i in items if i.get("source") == "curseforge"]
        self._resolve_curseforge(curse, report)
        known = self._known([i["sha512"] for i in external])

        entries: list[dict] = []
        todo: list[dict] = []
        for item in external + curse:
            hit = known.get(item.get("sha512") or "")
            if hit:
                entries.append(self._entry(item, "argonite", hit.get("verdict", "clean"), {"slug": hit["slug"], "name": hit["name"], "type": hit["type"]}))
            elif item.get("urls"):
                todo.append(item)
            else:
                entries.append(self._entry(item, item["source"], "unscanned", None))

        with ThreadPoolExecutor(max_workers=6) as pool:
            for item, (verdict, findings, error) in zip(todo, pool.map(self._fetch_and_scan, todo)):
                if error:
                    report.add("modpack.unscanned", "high", f"{item['path']}: {error}", item["path"])
                _child_findings(item["path"], findings, report)
                entries.append(self._entry(item, item["source"], verdict, None))

        for b in bundled:
            entries.append({**b, "source": "bundled", "host": None, "project": None, "env": None})
        entries.sort(key=lambda e: e["path"].lower())
        return {
            "minecraft": meta.get("pack_minecraft"),
            "loaders": meta.get("pack_loaders") or {},
            "entries": entries,
            "truncated": False,
        }

    @staticmethod
    def _entry(item: dict, source: str, verdict: str, project: dict | None) -> dict:
        urls = item.get("urls") or []
        host = item.get("host") or (urllib.parse.urlparse(urls[0]).hostname if urls else None)
        return {
            "path": item.get("path") or "",
            "size": item.get("size") or 0,
            "env": item.get("env"),
            "source": source,
            "host": host,
            "project": project,
            "verdict": verdict if verdict in ("clean", "suspicious", "malicious") else "unscanned",
        }


def bundled_files(walked_entries) -> list[dict]:
    """Jars shipped directly in the pack's overrides; they were scanned with the pack itself."""
    out = []
    for e in walked_entries:
        if e.depth != 0:
            continue
        lower = e.path.lower()
        if re.match(r"^(client-|server-)?overrides/(mods|resourcepacks|shaderpacks)/[^/]+\.(jar|zip)$", lower):
            out.append({"path": e.path.split("/", 1)[1], "size": len(e.data), "verdict": "clean"})
    return out
