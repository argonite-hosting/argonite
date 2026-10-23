"""Ed25519 signing via the system openssl, so the runner needs no pip packages.

The canonical layout must match shared/signing.ts exactly.
"""

from __future__ import annotations

import base64
import os
import subprocess
import tempfile


def canonical(record: dict) -> bytes:
    lines = [
        "argonite-file-v2",
        f"file:{record['fileId']}",
        f"version:{record['versionId']}",
        f"project:{record['projectId']}",
        f"repo:{record['repoId']}",
        f"release:{record['releaseId']}",
        f"asset:{record['assetId']}",
        f"name:{record['filename']}",
        f"size:{record['size']}",
        f"sha1:{record['sha1']}",
        f"sha256:{record['sha256']}",
        f"sha512:{record['sha512']}",
    ]
    for line in lines:
        if "\n" in line or "\r" in line:
            raise ValueError("record field contains a newline")
    return "\n".join(lines).encode("utf-8")


def sign(record: dict, private_key_pem: str) -> str:
    if "BEGIN PRIVATE KEY" not in private_key_pem:
        raise ValueError("signing key must be a PKCS#8 PEM")
    with tempfile.TemporaryDirectory(prefix="argonite-sign-") as tmp:
        key_path = os.path.join(tmp, "key.pem")
        msg_path = os.path.join(tmp, "msg.bin")
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(private_key_pem)
        with open(msg_path, "wb") as handle:
            handle.write(canonical(record))
        proc = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", key_path, "-in", msg_path],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if proc.returncode != 0 or len(proc.stdout) != 64:
            raise RuntimeError("openssl could not produce an Ed25519 signature")
        return base64.b64encode(proc.stdout).decode()
