from __future__ import annotations

import hashlib
import os
import tempfile
from typing import Callable

from . import archive, engines, metadata, rules
from .modpack import bundled_files

SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_RULES = os.path.join(os.path.dirname(HERE), "rules")

# Gets a modpack's metadata and report, returns its contents list. Kept as a callback so local scans
# (and the files inside a pack) never touch the network.
PackFn = Callable[[dict, "rules.Report", list], dict]


def hashes(data: bytes) -> dict[str, str]:
    return {
        "sha1": hashlib.sha1(data).hexdigest(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "sha512": hashlib.sha512(data).hexdigest(),
    }


def verdict_for(findings: list[dict]) -> str:
    top = max((SEVERITY_RANK.get(f["severity"], 0) for f in findings), default=0)
    if top >= SEVERITY_RANK["critical"]:
        return "malicious"
    if top >= SEVERITY_RANK["high"]:
        return "suspicious"
    return "clean"


def scan_bytes(
    data: bytes,
    project_type: str,
    *,
    require_clamav: bool = False,
    api_host: str = "",
    declared: dict | None = None,
    pack: PackFn | None = None,
    lookups: bool = True,
) -> dict:
    digests = hashes(data)
    iocs = rules.load_iocs()
    walked = archive.walk(data)
    report = rules.analyse(walked, project_type, iocs)
    meta = metadata.extract(walked, project_type, report, api_host, declared)
    used = ["argonite-heuristics"]

    if digests["sha256"] in iocs["sha256"]:
        report.add("ioc.hash", "critical", "File hash matches known malware")

    rule_dirs = [PUBLIC_RULES]
    private = os.environ.get("ARGONITE_PRIVATE_RULES")
    if private:
        rule_dirs.append(private)

    with tempfile.TemporaryDirectory(prefix="argonite-file-") as tmp:
        path = os.path.join(tmp, "upload.bin")
        with open(path, "wb") as handle:
            handle.write(data)
        if engines.clamav(path, report, require_clamav):
            used.append("clamav")
        if engines.yara(walked, rule_dirs, report, path):
            used.append("yara")
    if lookups:
        if engines.malwarebazaar(digests["sha256"], report):
            used.append("malwarebazaar")
        if engines.virustotal(digests["sha256"], report):
            used.append("virustotal")

    pack_info = {"pack_files": meta.pop("pack_files", None), "pack_minecraft": meta.pop("pack_minecraft", None), "pack_loaders": meta.pop("pack_loaders", None)}
    contents = None
    if project_type == "modpack" and pack is not None and pack_info["pack_files"] is not None:
        contents = pack(pack_info, report, bundled_files(walked.entries))
        used.append("pack-contents")

    findings = sorted(report.findings, key=lambda f: -SEVERITY_RANK.get(f["severity"], 0))
    return {
        **digests,
        "size": len(data),
        "verdict": verdict_for(findings),
        "findings": findings,
        "capabilities": sorted(report.capabilities),
        "engines": used,
        "metadata": {**meta, "classes": report.class_count, "entries": len(walked.entries)},
        "contents": contents,
    }

