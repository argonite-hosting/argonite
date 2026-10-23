"""Works out what a file claims to be, and whether that matches the project type.

Mods and modpacks are held to it: a "mod" without any loader metadata, or a modpack whose index is
broken or disagrees with what the author picked, goes to a moderator. Plugins, packs and shaders only
get a gentle note, because their formats are loose and plenty of good ones are packaged oddly.
"""

from __future__ import annotations

import json
import posixpath
import re
import tomllib
from urllib.parse import urlparse

from .archive import WalkResult
from .rules import Report

MODPACK_HOSTS = {"cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"}
CURSEFORGE_HOSTS = {"edge.forgecdn.net", "mediafilez.forgecdn.net"}
MAX_PACK_FILES = 3000

# Which declared loaders a piece of metadata can run on. A Fabric jar listed for NeoForge is fine
# (Sinytra Connector exists), so a mismatch is only ever a note.
FAMILIES = {
    "fabric.mod.json": {"fabric", "quilt", "legacy-fabric", "ornithe", "babric", "bta-babric"},
    "quilt.mod.json": {"quilt"},
    "META-INF/neoforge.mods.toml": {"neoforge"},
    "META-INF/mods.toml": {"forge", "neoforge"},
    "mcmod.info": {"forge", "sponge"},
    "riftmod.json": {"rift"},
    "litemod.json": {"liteloader"},
    "plugin.yml": {"bukkit", "spigot", "paper", "purpur", "folia", "bungeecord", "waterfall"},
    "paper-plugin.yml": {"paper", "purpur", "folia"},
    "bungee.yml": {"bungeecord", "waterfall"},
    "velocity-plugin.json": {"velocity"},
    "META-INF/sponge_plugins.json": {"sponge"},
    "extension.yml": {"geyser"},
}

# The loader each kind of metadata belongs to, for display. FAMILIES says where it can also run.
PRIMARY = {
    "fabric.mod.json": "fabric",
    "quilt.mod.json": "quilt",
    "META-INF/neoforge.mods.toml": "neoforge",
    "META-INF/mods.toml": "forge",
    "riftmod.json": "rift",
    "litemod.json": "liteloader",
    "plugin.yml": "bukkit",
    "paper-plugin.yml": "paper",
    "bungee.yml": "bungeecord",
    "velocity-plugin.json": "velocity",
    "META-INF/sponge_plugins.json": "sponge",
    "extension.yml": "geyser",
    "nilmod.css": "nilloader",
    "modloader": "modloader",
    "java-agent": "java-agent",
}

MRPACK_LOADERS = {"fabric-loader": "fabric", "quilt-loader": "quilt", "forge": "forge", "neoforge": "neoforge"}
CURSE_LOADERS = {"forge": "forge", "neoforge": "neoforge", "fabric": "fabric", "quilt": "quilt"}


def _top(walked: WalkResult) -> dict[str, bytes]:
    return {e.path: e.data for e in walked.entries if e.depth == 0}


def _json(data: bytes) -> dict | None:
    try:
        value = json.loads(data.decode("utf-8-sig", "replace"))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _simple_yaml(data: bytes) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in data.decode("utf-8", "replace").splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*['\"]?([^'\"#]*)['\"]?\s*(#.*)?$", line)
        if m and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip()[:200]
    return out


def _clip(value, limit: int = 200):
    if isinstance(value, str):
        return value[:limit]
    if isinstance(value, list):
        return [_clip(v, limit) for v in value[:20]]
    if isinstance(value, dict):
        return {str(k)[:64]: _clip(v, limit) for k, v in list(value.items())[:30]}
    return value


def _hex(value, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and re.fullmatch(r"[0-9a-fA-F]+", value) is not None


def safe_pack_path(path: str) -> bool:
    """Same rules as the .mrpack spec: no traversal, no absolute paths, no drive letters."""
    if not isinstance(path, str) or not path or len(path) > 300 or "\x00" in path:
        return False
    if "\\" in path or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return False
    if any(part == ".." for part in path.split("/")):
        return False
    return posixpath.normpath(path) not in (".", "")


def _detect_loaders(top: dict[str, bytes], walked: WalkResult, meta: dict, report: Report) -> set[str]:
    found: set[str] = set()
    for name, family in FAMILIES.items():
        if name not in top:
            continue
        found.add(name)
        data = top[name]
        if name == "fabric.mod.json":
            info = _json(data) or {}
            meta["fabric"] = _clip({k: info.get(k) for k in ("id", "version", "name", "environment", "depends")})
        elif name == "quilt.mod.json":
            meta["quilt"] = _clip((_json(data) or {}).get("quilt_loader", {}))
        elif name.endswith("mods.toml"):
            try:
                info = tomllib.loads(data.decode("utf-8", "replace"))
            except tomllib.TOMLDecodeError:
                report.add("metadata.invalid", "low", f"{name} is not valid TOML")
                continue
            mods = info.get("mods") or [{}]
            key = "neoforge" if "neoforge" in name else "forge"
            meta[key] = _clip({"loaderVersion": info.get("loaderVersion"), "mods": [{k: m.get(k) for k in ("modId", "version", "displayName")} for m in mods if isinstance(m, dict)]})
        elif name in ("plugin.yml", "paper-plugin.yml", "bungee.yml", "extension.yml"):
            yml = _simple_yaml(data)
            meta["plugin"] = _clip({k: v for k, v in yml.items() if k in ("name", "id", "version", "main", "api-version", "api", "author", "folia-supported")})
        elif name in ("velocity-plugin.json", "META-INF/sponge_plugins.json", "litemod.json", "riftmod.json"):
            meta[name.split("/")[-1].split(".")[0].replace("_plugins", "")] = _clip({k: v for k, v in (_json(data) or {}).items() if k in ("id", "name", "version", "main", "loader", "mcversion")})
    names = set(top)
    if any(re.fullmatch(r"[^/]+\.nilmod\.css", n) for n in names):
        found.add("nilmod.css")
    if any(re.fullmatch(r"mod_[A-Za-z0-9_$]+\.class", n) for n in names):
        found.add("modloader")
    manifest = {k.lower() for k in walked.manifest}
    if manifest & {"premain-class", "agent-class", "launcher-agent-class"}:
        found.add("java-agent")
    return found


def _families(found: set[str]) -> set[str]:
    out: set[str] = set()
    for key in found:
        out |= FAMILIES.get(key, set())
    if "nilmod.css" in found:
        out.add("nilloader")
    if "modloader" in found:
        out.add("modloader")
    if "java-agent" in found:
        out.add("java-agent")
    return out


def _wrapped_folder(names: set[str], markers: tuple[str, ...]) -> str | None:
    """The classic mistake: zipping the folder instead of its contents."""
    tops = {n.split("/", 1)[0] for n in names if "/" in n}
    if len(tops) != 1 or any("/" not in n for n in names):
        return None
    folder = next(iter(tops))
    for m in markers:
        target = f"{folder}/{m}"
        if (m.endswith("/") and any(n.startswith(target) for n in names)) or target in names:
            return folder
    return None


def _parse_mrpack(index: dict, report: Report, meta: dict) -> list[dict] | None:
    if index.get("formatVersion") != 1 or index.get("game") != "minecraft":
        report.add("modpack.invalid_index", "high", "modrinth.index.json is not a formatVersion 1 Minecraft modpack")
        return None
    deps = index.get("dependencies") if isinstance(index.get("dependencies"), dict) else {}
    meta["modpack"] = _clip({"name": index.get("name"), "versionId": index.get("versionId"), "dependencies": deps})
    files = index.get("files")
    if not isinstance(files, list):
        report.add("modpack.invalid_index", "high", "modrinth.index.json has no file list")
        return None
    if len(files) > MAX_PACK_FILES:
        report.add("modpack.too_many_files", "high", f"Modpack lists more than {MAX_PACK_FILES} files")
        files = files[:MAX_PACK_FILES]
    parsed: list[dict] = []
    for f in files:
        if not isinstance(f, dict):
            report.add("modpack.invalid_index", "high", "modrinth.index.json has a malformed file entry")
            continue
        path = f.get("path")
        if not safe_pack_path(path):
            report.add("modpack.path_traversal", "critical", "Modpack tries to write a file outside the game folder", str(path)[:200])
            continue
        hashes = f.get("hashes") if isinstance(f.get("hashes"), dict) else {}
        if not _hex(hashes.get("sha1"), 40) or not _hex(hashes.get("sha512"), 128):
            report.add("modpack.missing_hash", "high", "A modpack file has no valid sha1 and sha512 hash", path)
            continue
        size = f.get("fileSize")
        urls = [u for u in (f.get("downloads") or [])[:5] if isinstance(u, str)]
        good = [u for u in urls if urlparse(u).scheme == "https" and (urlparse(u).hostname or "") in MODPACK_HOSTS]
        if not good:
            host = urlparse(urls[0]).hostname if urls else None
            report.add("modpack.untrusted_download", "high", f"Modpack downloads a file from an unrecognised host ({host or 'no URL'})", path)
            continue
        env = f.get("env") if isinstance(f.get("env"), dict) else None
        parsed.append(
            {
                "path": path,
                "sha1": hashes["sha1"].lower(),
                "sha512": hashes["sha512"].lower(),
                "size": size if isinstance(size, int) and size >= 0 else None,
                "urls": good,
                "env": {"client": str(env.get("client", "required")), "server": str(env.get("server", "required"))} if env else None,
                "source": "external",
            }
        )
    meta["pack_minecraft"] = deps.get("minecraft") if isinstance(deps.get("minecraft"), str) else None
    meta["pack_loaders"] = {MRPACK_LOADERS[k]: str(v) for k, v in deps.items() if k in MRPACK_LOADERS}
    return parsed


def _parse_curseforge(manifest: dict, report: Report, meta: dict) -> list[dict] | None:
    if manifest.get("manifestType") != "minecraftModpack":
        report.add("modpack.invalid_index", "high", "manifest.json is not a CurseForge modpack manifest")
        return None
    mc = manifest.get("minecraft") if isinstance(manifest.get("minecraft"), dict) else {}
    loaders: dict[str, str] = {}
    for loader in mc.get("modLoaders") or []:
        lid = str(loader.get("id", "")) if isinstance(loader, dict) else ""
        name, _, version = lid.partition("-")
        if name in CURSE_LOADERS:
            loaders[CURSE_LOADERS[name]] = version
    meta["pack_minecraft"] = mc.get("version") if isinstance(mc.get("version"), str) else None
    meta["pack_loaders"] = loaders
    meta["modpack"] = _clip({"name": manifest.get("name"), "version": manifest.get("version"), "minecraft": meta["pack_minecraft"], "loaders": loaders})
    out: list[dict] = []
    for f in (manifest.get("files") or [])[:MAX_PACK_FILES]:
        if not isinstance(f, dict) or not isinstance(f.get("projectID"), int) or not isinstance(f.get("fileID"), int):
            report.add("modpack.invalid_index", "high", "manifest.json has a malformed file entry")
            continue
        out.append({"curseforge": (f["projectID"], f["fileID"]), "required": f.get("required", True) is not False, "source": "curseforge"})
    return out


def extract(walked: WalkResult, project_type: str, report: Report, api_host: str, declared: dict | None = None) -> dict:
    top = _top(walked)
    names = set(top)
    declared = declared or {}
    declared_loaders = set(declared.get("loaders") or [])
    declared_versions = set(declared.get("gameVersions") or [])
    meta: dict = {"loaders": [], "detected": []}
    has_dir = lambda prefix: any(n.startswith(prefix) for n in names)  # noqa: E731

    found = _detect_loaders(top, walked, meta, report)
    families = _families(found)
    meta["detected"] = sorted(found)
    primary = {PRIMARY[k] for k in found if k in PRIMARY}
    if "mcmod.info" in found:
        primary.add("sponge" if project_type == "plugin" else "forge")
    meta["loaders"] = sorted(primary)
    meta["compatible"] = sorted(families)

    if "pack.mcmeta" in top:
        pack = (_json(top["pack.mcmeta"]) or {}).get("pack", {})
        if isinstance(pack, dict):
            meta["pack"] = _clip({k: pack.get(k) for k in ("pack_format", "min_format", "max_format", "supported_formats", "description")})

    if not walked.is_zip:
        report.add("file.not_archive", "high", "The file is not a valid zip/jar archive")
        return meta

    if project_type == "mod":
        mod_markers = families & {"fabric", "quilt", "forge", "neoforge", "legacy-fabric", "ornithe", "babric", "bta-babric", "rift", "liteloader", "nilloader", "modloader", "java-agent"}
        if not mod_markers:
            folder = _wrapped_folder(names, ("fabric.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "quilt.mod.json"))
            hint = f" It looks like the jar was built with everything inside a \"{folder}\" folder." if folder else ""
            report.add("metadata.mismatch", "high", f"This doesn't look like a mod: no loader metadata (fabric.mod.json, mods.toml, mcmod.info...) was found.{hint}")
        elif declared_loaders and not (declared_loaders & families):
            report.add(
                "metadata.loader_note",
                "info",
                f"Listed for {', '.join(sorted(declared_loaders))} but the jar only has metadata for {', '.join(sorted(mod_markers))}. That's fine if it runs through a compatibility layer.",
            )
    elif project_type == "plugin":
        if not families & {"bukkit", "spigot", "paper", "purpur", "folia", "bungeecord", "waterfall", "velocity", "sponge", "geyser"}:
            report.add("metadata.mismatch", "low", "No plugin metadata (plugin.yml, velocity-plugin.json...) was found at the top of the jar.")
    elif project_type in ("resourcepack", "datapack"):
        marker = "assets/" if project_type == "resourcepack" else "data/"
        if "pack.mcmeta" not in names or not has_dir(marker):
            folder = _wrapped_folder(names, ("pack.mcmeta",))
            hint = f" Everything is inside a \"{folder}\" folder; zip the folder's contents instead." if folder else ""
            report.add("metadata.mismatch", "low", f"This doesn't look like a {'resource' if project_type == 'resourcepack' else 'data'} pack (pack.mcmeta and {marker} at the top).{hint}")
    elif project_type == "shader":
        ok = has_dir("shaders/") or ("pack.mcmeta" in names and has_dir("assets/"))
        if not ok:
            folder = _wrapped_folder(names, ("shaders/", "pack.mcmeta"))
            hint = f" Everything is inside a \"{folder}\" folder; zip the folder's contents instead." if folder else ""
            report.add("metadata.mismatch", "low", f"No shaders/ folder or vanilla shader pack was found at the top of the zip.{hint}")
    elif project_type == "modpack":
        pack_files: list[dict] | None = None
        if "modrinth.index.json" in top:
            index = _json(top["modrinth.index.json"])
            if index is None:
                report.add("modpack.invalid_index", "high", "modrinth.index.json is not valid JSON")
            else:
                pack_files = _parse_mrpack(index, report, meta)
        elif "manifest.json" in top:
            manifest = _json(top["manifest.json"])
            if manifest is None:
                report.add("modpack.invalid_index", "high", "manifest.json is not valid JSON")
            else:
                pack_files = _parse_curseforge(manifest, report, meta)
        else:
            report.add("metadata.mismatch", "high", "This doesn't look like a modpack: there's no modrinth.index.json or CurseForge manifest.json at the top.")
        if pack_files is not None:
            meta["pack_files"] = pack_files
            mc = meta.get("pack_minecraft")
            if mc and declared_versions and mc not in declared_versions:
                report.add("modpack.version_mismatch", "high", f"The pack is built for Minecraft {mc}, which isn't one of the versions picked for it.")
            pack_loaders = set(meta.get("pack_loaders") or {})
            if pack_loaders and declared_loaders and not (pack_loaders & declared_loaders):
                report.add("modpack.loader_mismatch", "high", f"The pack runs on {', '.join(sorted(pack_loaders))}, but it's listed for {', '.join(sorted(declared_loaders))}.")
            if pack_loaders:
                meta["loaders"] = sorted(pack_loaders)
    return meta
