"""Entry point. Run with `python -I scanner/run.py ...` so nothing from the working directory gets imported."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from argonite_scan import api, modpack, rules, scan, signing  # noqa: E402

JOB_ID = re.compile(r"^[0-9a-z]{26}$")
CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "site.json")


def default_api() -> str:
    with open(CONFIG, encoding="utf-8") as handle:
        site = json.load(handle)
    return f"https://{site['apiSubdomain']}.{site['domain']}"


def in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def mask(value: str) -> None:
    if in_actions():
        print(f"::add-mask::{value}", flush=True)


def process(client: api.WorkerClient, job: dict, key_pem: str, token: str | None, require_clamav: bool, api_host: str) -> str:
    try:
        if job.get("downloadUrl"):
            data = api.download_signed(job["downloadUrl"], job["size"])
        else:
            data = api.download_asset(job["repoId"], job["assetId"], job["size"], token)
    except api.Missing:
        if job["kind"] == "verify":
            client.call("/internal/scan/result", {"jobId": job["id"], "claimToken": job["claimToken"], "result": {"missing": True}})
            return "missing"
        raise

    if job["kind"] == "verify":
        digests = scan.hashes(data)
        client.call(
            "/internal/scan/result",
            {"jobId": job["id"], "claimToken": job["claimToken"], "result": {"sha256": digests["sha256"], "size": len(data)}},
        )
        return "verified"

    if len(data) != job["size"]:
        raise RuntimeError("downloaded size does not match the uploaded asset")
    # Extra files (sources, server packs...) get the security checks but not the "is this really a mod" checks.
    project_type = job["projectType"]
    if job.get("fileKind", "primary") != "primary" and project_type in rules.CODE_TYPES:
        project_type = "addon"
    checker = modpack.PackChecker(
        client,
        lambda blob, ptype: scan.scan_bytes(blob, ptype, require_clamav=require_clamav, lookups=False),
        os.environ.get("ARGONITE_SCAN_CACHE") or None,
        os.environ.get("CURSEFORGE_API_KEY") or None,
    )
    result = scan.scan_bytes(
        data,
        project_type,
        require_clamav=require_clamav,
        api_host=api_host,
        declared=job.get("declared") or {},
        pack=checker.check if job.get("fileKind", "primary") == "primary" else None,
    )
    record = {
        "fileId": job["fileId"],
        "versionId": job["versionId"],
        "projectId": job["projectId"],
        "repoId": job["repoId"],
        "releaseId": job["releaseId"],
        "assetId": job["assetId"],
        "filename": job["filename"],
        "size": result["size"],
        "sha1": result["sha1"],
        "sha256": result["sha256"],
        "sha512": result["sha512"],
    }
    result["signature"] = signing.sign(record, key_pem)
    client.call("/internal/scan/result", {"jobId": job["id"], "claimToken": job["claimToken"], "result": result})
    return result["verdict"]


def cmd_run(args: argparse.Namespace) -> int:
    secret = os.environ.get("ARGONITE_SCANNER_SECRET", "")
    key_pem = os.environ.get("ARGONITE_SIGNING_KEY", "")
    if not secret or not key_pem:
        print("ARGONITE_SCANNER_SECRET and ARGONITE_SIGNING_KEY must be set", file=sys.stderr)
        return 2
    token = os.environ.get("GITHUB_TOKEN") or None
    base = args.api or default_api()
    client = api.WorkerClient(base, secret)
    api_host = re.sub(r"^https?://", "", base).split("/")[0]
    first = args.job if args.job and JOB_ID.match(args.job) else None
    failures = 0
    for _ in range(args.max_jobs):
        claim = client.call("/internal/scan/claim", {"jobId": first} if first else {})
        first = None
        job = claim.get("job")
        if not job:
            if claim.get("skipped"):
                continue
            break
        mask(job["claimToken"])
        if job.get("downloadUrl"):
            mask(job["downloadUrl"])
        try:
            outcome = process(client, job, key_pem, token, args.require_clamav, api_host)
            print(f"job {job['id']} ({job['kind']}): {outcome}", flush=True)
        except Exception as exc:  # noqa: BLE001 - any failure gets reported back so the job can retry
            failures += 1
            print(f"job {job['id']} failed: {type(exc).__name__}", flush=True)
            if not in_actions():
                traceback.print_exc()
            try:
                client.call("/internal/scan/result", {"jobId": job["id"], "claimToken": job["claimToken"], "error": f"{type(exc).__name__}: {exc}"[:400]})
            except Exception:  # noqa: BLE001
                pass
    return 1 if failures else 0


def cmd_local(args: argparse.Namespace) -> int:
    with open(args.file, "rb") as handle:
        data = handle.read()
    result = scan.scan_bytes(data, args.type, require_clamav=args.require_clamav)
    json.dump(result, sys.stdout, indent=2)
    print()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="argonite-scan")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="claim and process jobs from the Worker")
    run.add_argument("--api", default="")
    run.add_argument("--job", default="")
    run.add_argument("--max-jobs", type=int, default=10)
    run.add_argument("--require-clamav", action="store_true")
    run.set_defaults(func=cmd_run)
    local = sub.add_parser("local", help="scan a file on disk and print the report")
    local.add_argument("file")
    local.add_argument("--type", default="mod", choices=["mod", "plugin", "resourcepack", "shader", "datapack", "modpack", "addon"])
    local.add_argument("--require-clamav", action="store_true")
    local.set_defaults(func=cmd_local)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
