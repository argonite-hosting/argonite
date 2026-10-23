"""Optional external engines. Each returns findings and stays quiet if the tool or key isn't available."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from .archive import WalkResult
from .rules import Report

UA = "Argonite-Scanner"


def clamav(path: str, report: Report, required: bool) -> bool:
    exe = shutil.which("clamscan")
    if not exe:
        if required:
            raise RuntimeError("clamscan is required but not installed")
        return False
    db = os.environ.get("ARGONITE_CLAMAV_DB")
    proc = subprocess.run(
        [exe, *([f"--database={db}"] if db else []), "--no-summary", "--infected", "--scan-archive=yes", "--max-filesize=300M", "--max-scansize=900M", "--max-recursion=8", "--alert-encrypted-archive=no", path],
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )
    if proc.returncode == 1:
        for line in proc.stdout.splitlines():
            if line.endswith(" FOUND"):
                signature = line.rsplit(":", 1)[-1].replace(" FOUND", "").strip()
                report.add("clamav", "critical", f"ClamAV detected {signature[:120]}")
    elif proc.returncode != 0:
        raise RuntimeError(f"clamscan failed with exit code {proc.returncode}")
    return True


def yara(walked: WalkResult, rule_dirs: list[str], report: Report, original: str) -> bool:
    exe = shutil.which("yara")
    rules = [os.path.join(d, f) for d in rule_dirs if os.path.isdir(d) for f in sorted(os.listdir(d)) if f.endswith((".yar", ".yara"))]
    if not exe or not rules:
        return False
    with tempfile.TemporaryDirectory(prefix="argonite-yara-") as tmp:
        # Entries get numbered names so archive paths never touch the filesystem.
        index: dict[str, str] = {}
        for i, entry in enumerate(walked.entries):
            name = f"{i:06d}.bin"
            with open(os.path.join(tmp, name), "wb") as handle:
                handle.write(entry.data)
            index[name] = entry.path
        targets = [original, tmp]
        for rule_file in rules:
            for target in targets:
                proc = subprocess.run([exe, "-r", "-m", "-w", rule_file, target], capture_output=True, text=True, timeout=600, check=False)
                if proc.returncode not in (0, 1):
                    raise RuntimeError(f"yara failed on {os.path.basename(rule_file)}")
                for line in proc.stdout.splitlines():
                    rule, _, rest = line.partition(" ")
                    meta_part, _, hit_path = rest.rpartition("] ")
                    severity = "high"
                    if "severity=\"critical\"" in meta_part:
                        severity = "critical"
                    elif "severity=\"medium\"" in meta_part:
                        severity = "medium"
                    where = index.get(os.path.basename(hit_path.strip()), None) if hit_path else None
                    report.add(f"yara.{rule[:60]}", severity, f"Matched YARA rule {rule[:60]}", where)
    return True


def _post_form(url: str, fields: dict[str, str], headers: dict[str, str]) -> dict:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA, **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode())


def malwarebazaar(sha256: str, report: Report, path: str | None = None) -> bool:
    key = os.environ.get("MALWAREBAZAAR_KEY")
    if not key:
        return False
    try:
        data = _post_form("https://mb-api.abuse.ch/api/v1/", {"query": "get_info", "hash": sha256}, {"Auth-Key": key})
    except (urllib.error.URLError, ValueError, TimeoutError):
        return False
    if data.get("query_status") == "ok":
        sig = (data.get("data") or [{}])[0].get("signature") or "known malware"
        report.add("reputation.malwarebazaar", "critical", f"Hash is listed on MalwareBazaar ({str(sig)[:80]})", path)
    return True


def virustotal(sha256: str, report: Report, path: str | None = None) -> bool:
    key = os.environ.get("VIRUSTOTAL_KEY")
    if not key:
        return False
    req = urllib.request.Request(f"https://www.virustotal.com/api/v3/files/{sha256}", headers={"x-apikey": key, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            stats = json.loads(res.read().decode())["data"]["attributes"]["last_analysis_stats"]
    except urllib.error.HTTPError as exc:
        return exc.code == 404
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
        return False
    malicious = int(stats.get("malicious", 0))
    if malicious >= 3:
        report.add("reputation.virustotal", "critical", f"{malicious} VirusTotal engines flag this hash", path)
    elif malicious > 0:
        report.add("reputation.virustotal", "high", f"{malicious} VirusTotal engine(s) flag this hash", path)
    return True
