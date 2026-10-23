"""Walks archives in memory with hard limits so a hostile upload can't exhaust the runner."""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field

MAX_DEPTH = 4
MAX_ENTRIES = 60_000
MAX_ENTRY_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 768 * 1024 * 1024
BOMB_RATIO = 250
NESTED_SUFFIXES = (".jar", ".zip", ".mrpack", ".war", ".ear")


@dataclass
class Entry:
    path: str
    data: bytes
    depth: int


@dataclass
class WalkResult:
    entries: list[Entry] = field(default_factory=list)
    problems: list[tuple[str, ...]] = field(default_factory=list)
    is_zip: bool = True
    total_bytes: int = 0
    manifest: dict[str, str] = field(default_factory=dict)


class _Budget:
    def __init__(self) -> None:
        self.entries = 0
        self.bytes = 0


def _read_limited(zf: zipfile.ZipFile, info: zipfile.ZipInfo, budget: _Budget) -> bytes | None:
    remaining = min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - budget.bytes)
    if remaining <= 0:
        return None
    chunks: list[bytes] = []
    size = 0
    with zf.open(info) as handle:
        while True:
            chunk = handle.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > remaining:
                return None
            chunks.append(chunk)
    budget.bytes += size
    return b"".join(chunks)


def _walk(data: bytes, prefix: str, depth: int, budget: _Budget, out: WalkResult) -> None:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError, ValueError):
        if depth == 0:
            out.is_zip = False
        else:
            out.problems.append(("archive.corrupt_nested", "medium", f"Nested archive {prefix} could not be opened"))
        return
    with zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            budget.entries += 1
            if budget.entries > MAX_ENTRIES:
                out.problems.append(("archive.too_many_entries", "high", "Archive has too many entries to scan fully"))
                return
            name = info.filename.replace("\\", "/")
            path = f"{prefix}!/{name}" if prefix else name
            if info.flag_bits & 0x1:
                out.problems.append(("archive.encrypted", "high", "Archive contains an encrypted entry", path))
                continue
            if info.compress_size and info.file_size / max(info.compress_size, 1) > BOMB_RATIO and info.file_size > 50 * 1024 * 1024:
                out.problems.append(("archive.bomb", "high", "Entry has an extreme compression ratio", path))
                continue
            try:
                content = _read_limited(zf, info, budget)
            except (zipfile.BadZipFile, OSError, ValueError, NotImplementedError, EOFError) as exc:
                out.problems.append(("archive.unreadable_entry", "medium", f"Could not read entry ({type(exc).__name__})", path))
                continue
            if content is None:
                out.problems.append(("archive.size_limit", "high", "Archive is too large to scan fully", path))
                return
            out.entries.append(Entry(path=path, data=content, depth=depth))
            if depth == 0 and name.upper() == "META-INF/MANIFEST.MF":
                out.manifest = parse_manifest(content)
            if name.lower().endswith(NESTED_SUFFIXES):
                if depth + 1 > MAX_DEPTH:
                    out.problems.append(("archive.too_deep", "high", "Archives are nested too deeply to scan", path))
                    continue
                _walk(content, path, depth + 1, budget, out)


def walk(data: bytes) -> WalkResult:
    out = WalkResult()
    budget = _Budget()
    _walk(data, "", 0, budget, out)
    out.total_bytes = budget.bytes
    return out


def parse_manifest(data: bytes) -> dict[str, str]:
    text = data.decode("utf-8", "replace").replace("\r\n", "\n")
    result: dict[str, str] = {}
    last = None
    for line in text.split("\n"):
        if line.startswith(" ") and last:
            result[last] += line[1:]
            continue
        if not line.strip():
            if result:
                break
            continue
        key, sep, value = line.partition(":")
        if sep:
            last = key.strip()
            result[last] = value.strip()
    return result
