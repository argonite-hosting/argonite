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


SHARED_HOSTS = {
    "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com", "api.github.com",
    "gitlab.com", "bitbucket.org", "codeberg.org", "modrinth.com", "api.modrinth.com", "cdn.modrinth.com", "curseforge.com", "www.curseforge.com",
    "api.curseforge.com", "edge.forgecdn.net", "mediafilez.forgecdn.net", "maven.fabricmc.net", "meta.fabricmc.net", "maven.neoforged.net",
    "maven.minecraftforge.net", "files.minecraftforge.net", "youtube.com", "www.youtube.com", "youtu.be", "discord.gg", "discord.com",
    "minecraft.net", "www.minecraft.net", "minecraft.wiki", "mojang.com", "api.mojang.com", "sessionserver.mojang.com", "textures.minecraft.net",
    "launcher.mojang.com", "piston-meta.mojang.com", "piston-data.mojang.com", "login.microsoftonline.com", "user.auth.xboxlive.com",
    "xsts.auth.xboxlive.com", "api.minecraftservices.com", "patreon.com", "www.patreon.com", "ko-fi.com", "paypal.com", "www.paypal.com",
}


def check_links(links: dict[str, str], report: Report, hosts: list[str]) -> bool:
    """Checks links compiled into the file against malware and phishing lists.

    Every site goes through Cloudflare's malware-blocking resolver (it answers 0.0.0.0 for listed
    domains). With an abuse.ch key, URLhaus is asked about each exact URL as well.
    """
    from concurrent.futures import ThreadPoolExecutor

    if not links:
        return False

    def resolver(host: str) -> bool:
        if host in SHARED_HOSTS or host.replace(".", "").isdigit():
            return False
        url = "https://security.cloudflare-dns.com/dns-query?" + urllib.parse.urlencode({"name": host, "type": "A"})
        req = urllib.request.Request(url, headers={"Accept": "application/dns-json", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                answers = json.loads(res.read().decode()).get("Answer") or []
        except (urllib.error.URLError, ValueError, TimeoutError):
            return False
        return any(a.get("type") == 1 and a.get("data") == "0.0.0.0" for a in answers)

    key = os.environ.get("URLHAUS_KEY") or os.environ.get("MALWAREBAZAAR_KEY")

    def urlhaus(url: str) -> bool:
        try:
            data = _post_form("https://urlhaus-api.abuse.ch/v1/url/", {"url": url}, {"Auth-Key": key or ""})
        except (urllib.error.URLError, ValueError, TimeoutError):
            return False
        return data.get("query_status") == "ok" and data.get("url_status") in ("online", "unknown")

    first_seen = {}
    for url, where in links.items():
        from .rules import link_host
        first_seen.setdefault(link_host(url), where)
    with ThreadPoolExecutor(max_workers=16) as pool:
        flagged = [h for h, bad in zip(hosts, pool.map(resolver, hosts)) if bad]
        for host in flagged:
            report.add("link.malicious_host", "high", f"Links to {host}, which is on a malware or phishing list", first_seen.get(host))
        if key:
            urls = list(links)[:100]
            for url, bad in zip(urls, pool.map(urlhaus, urls)):
                if bad:
                    report.add("link.malicious_url", "critical", f"Links to a URL listed on URLhaus as serving malware ({url[:120]})", links[url])
    return True


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
