"""Static heuristics for Minecraft content. The goal is to route risky files to a human, not to be clever."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field

from . import classfile
from .archive import WalkResult

EXECUTABLE_SUFFIXES = (".exe", ".scr", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".jse", ".wsf", ".hta", ".lnk")
NATIVE_SUFFIXES = (".so", ".dylib", ".jnilib", ".dll")
SCRIPT_SUFFIXES = (".sh", ".command", ".py", ".rb", ".pl")
PACK_BANNED_SUFFIXES = SCRIPT_SUFFIXES + (".js", ".apk", ".appimage", ".deb", ".rpm", ".pkg", ".dmg", ".msix", ".jnlp")
CODE_TYPES = ("mod", "plugin", "modpack", "addon")


def binary_kind(data: bytes) -> str | None:
    """Recognise executables by their first bytes, whatever the file happens to be called."""
    head = data[:64]
    if head[:4] == b"\xca\xfe\xba\xbe":
        # Java classes and macOS universal ("fat") binaries share this magic. A class file follows it with
        # its version (major 45 or more); a universal binary with its number of architectures (a handful).
        arches = int.from_bytes(head[4:8], "big")
        return "macos" if 0 < arches <= 30 else "java"
    if head[:2] == b"MZ" and len(data) > 0x40:
        offset = int.from_bytes(data[0x3C:0x40], "little")
        if 0 < offset < len(data) - 4 and data[offset:offset + 4] == b"PE\x00\x00":
            return "windows"
    if head[:4] == b"\x7fELF":
        return "linux"
    if head[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
        return "macos"
    if head[:2] == b"#!":
        return "script"
    return None

CAPABILITY_MEMBERS = {
    "process_exec": ["java/lang/Runtime.exec", "java/lang/ProcessBuilder.start", "java/lang/ProcessBuilder.<init>"],
    "native_code": ["java/lang/System.load", "java/lang/System.loadLibrary", "java/lang/Runtime.load", "java/lang/Runtime.loadLibrary"],
    "dynamic_classloading": [
        "java/lang/ClassLoader.defineClass",
        "java/security/SecureClassLoader.defineClass",
        "java/lang/invoke/MethodHandles$Lookup.defineClass",
        "java/lang/invoke/MethodHandles$Lookup.defineHiddenClass",
        "sun/misc/Unsafe.defineClass",
        "sun/misc/Unsafe.defineAnonymousClass",
        "java/net/URLClassLoader.<init>",
        "java/net/URLClassLoader.newInstance",
    ],
    "network": [
        "java/net/URL.openConnection",
        "java/net/URL.openStream",
        "java/net/URI.toURL",
        "java/net/Socket.<init>",
        "java/net/http/HttpClient.send",
        "java/net/http/HttpClient.sendAsync",
        "java/net/http/HttpClient.newHttpClient",
        "java/nio/channels/SocketChannel.open",
    ],
    "jar_writing": ["java/util/jar/JarOutputStream.<init>", "java/util/zip/ZipOutputStream.<init>"],
    "instrumentation": ["java/lang/instrument/Instrumentation.addTransformer", "java/lang/instrument/Instrumentation.redefineClasses"],
    "crypto_decode": ["javax/crypto/Cipher.doFinal", "javax/crypto/Cipher.getInstance"],
}
CAPABILITY_CLASSES = {
    "native_code": ["com/sun/jna/Native", "com/sun/jna/Library"],
    "dynamic_classloading": ["java/net/URLClassLoader"],
}

# The player's session token logs in as them, so it's what Minecraft token stealers are after. These are
# the token getters under every mapping mods ship with: Mojang names (NeoForge, recent Forge), Fabric's
# intermediary names, and the old MCP names (Forge 1.12 and earlier).
SESSION_MEMBERS = {
    "net/minecraft/client/User.getAccessToken",
    "net/minecraft/client/User.getSessionId",
    "net/minecraft/class_320.method_1674",
    "net/minecraft/class_320.method_1675",
    "net/minecraft/util/Session.func_148254_d",
    "net/minecraft/util/Session.func_111286_b",
    "net/minecraft/util/Session.getToken",
    "net/minecraft/util/Session.getSessionID",
}
# The obfuscated names as plain strings, which is how reflection reaches them. Readable names like
# getAccessToken also appear in ordinary HTTP and OAuth libraries, so they are left out here.
SESSION_STRINGS = {"method_1674", "method_1675", "func_148254_d", "func_111286_b"}
# Classes holding the session or login, as Mixin targets.
SESSION_CLASSES = {"net/minecraft/client/User", "net/minecraft/class_320", "net/minecraft/util/Session"}
SESSION_PREFIXES = ("com/mojang/authlib/",)

# Ways a mod transforms other classes' bytecode as the game loads, outside Mixin.
TRANSFORMER_CLASSES = {
    "net/minecraft/launchwrapper/IClassTransformer",
    "net/minecraftforge/fml/relauncher/IFMLLoadingPlugin",
    "cpw/mods/modlauncher/api/ITransformationService",
    "cpw/mods/modlauncher/api/ITransformer",
    "com/chocohead/mm/api/ClassTinkerers",
}
TRANSFORMER_PREFIXES = ("net/minecraftforge/coremod/", "net/neoforged/coremod/", "net/neoforged/neoforgespi/transformation/")
TRANSFORMER_FILES = ("meta-inf/coremods.json", "meta-inf/services/cpw.mods.modlauncher.api.itransformationservice")
TRANSFORMER_MANIFEST = ("fmlcoreplugin", "tweakclass")

# Mixin targets that patch the mod loader, the Mixin library or Java itself rather than the game.
LOADER_PREFIXES = (
    "net/fabricmc/loader/", "org/quiltmc/loader/", "cpw/mods/", "net/minecraftforge/fml/", "net/neoforged/fml/",
    "org/spongepowered/asm/", "java/", "javax/", "jdk/", "sun/",
)
MIXIN = "Lorg/spongepowered/asm/mixin/Mixin;"

# Links compiled into a mod. Hosts are compared between versions and checked against malware lists.
URL_IN_CODE = re.compile(r"(?i)\bhttps?:[/\\]+[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?[^\s\"'<>`]*")
# XML and schema namespaces that libraries carry but never fetch.
NAMESPACE_HOSTS = {"www.w3.org", "w3.org", "xml.org", "www.xml.org", "java.sun.com", "xmlpull.org", "xml.apache.org", "www.apache.org", "apache.org", "json-schema.org", "purl.org", "ns.adobe.com", "schemas.microsoft.com", "www.oracle.com", "javafx.com"}
MAX_LINKS = 5000

# Ways to find the user's home or system folders, which lie outside the game folder.
OUTSIDE_MEMBERS = {"java/lang/System.getenv", "java/lang/System.getProperty"}
OUTSIDE_KEYS = {"user.home", "appdata", "localappdata", "userprofile", "programdata", "home", "xdg_config_home", "xdg_data_home", "homedrive", "homepath"}

SENSITIVE_PATHS = [
    "local storage/leveldb",
    "launcher_accounts.json",
    "launcher_accounts_microsoft_store.json",
    "launcher_msa_credentials",
    "essential/microsoft_accounts.json",
    "feather/accounts.json",
    "lunarclient/settings/game/accounts.json",
    ".lunarclient/settings",
    "polymc/accounts.json",
    "prismlauncher/accounts.json",
    "multimc/accounts.json",
    "user data/default/login data",
    "user data/default/cookies",
    "user data/default/network/cookies",
    "\\exodus\\exodus.wallet",
    "electrum/wallets",
    "atomic/local storage",
    "discordcanary",
    "discordptb",
    "telegram desktop/tdata",
    ".ssh/id_rsa",
    "metamask",
]
PERSISTENCE = [
    "software\\microsoft\\windows\\currentversion\\run",
    "schtasks",
    "start menu\\programs\\startup",
    "library/launchagents",
    "systemctl --user",
    "crontab -",
    ".config/autostart",
]
SHADY_HOSTS = re.compile(
    r"(?i)(pastebin\.com/raw|paste\.ee/r|hastebin\.com/raw|transfer\.sh|ngrok(-free)?\.(io|app)|"
    r"anonfiles|gofile\.io|catbox\.moe|discord(app)?\.com/api/webhooks|api\.telegram\.org/bot|"
    r"workers\.dev|trycloudflare\.com|webhook\.site|requestbin|iplogger|grabify)"
)
RAW_IP_URL = re.compile(r"(?i)\b(?:https?|tcp|udp)://(?:\d{1,3}\.){3}\d{1,3}")
BASE64_BLOB = re.compile(r"^[A-Za-z0-9+/]{1600,}={0,2}$")
SHORT_NAME = re.compile(r"^(?:[^/]+/)*[^/]{1,2}$")

DEFAULT_IOCS = {
    "strings": [
        "85.217.144.130",
        "107.189.3.101",
        "files-8ie.pages.dev",
        "skyrage.de",
        "dev/neko/nekoinjector",
        "dev/neko/nekoclient",
        "dev/neko/nekoinjector/template",
    ],
    "classes": ["dev/neko/nekoinjector/Injector", "dev/neko/nekoclient/Client"],
    "sha256": [],
}


@dataclass
class Report:
    findings: list[dict] = field(default_factory=list)
    capabilities: set[str] = field(default_factory=set)
    class_count: int = 0
    # Every bundled native library or program: path, sha256, size and platform.
    natives: list[dict] = field(default_factory=list)
    # Links found in code and config files, first place each was seen.
    links: dict[str, str] = field(default_factory=dict)

    def add(self, rule: str, severity: str, detail: str, path: str | None = None, sha256: str | None = None) -> None:
        # Padding a file with harmless findings must never push a serious one out, so the cap only
        # applies to low-severity notes.
        serious = severity in ("high", "critical")
        if len(self.findings) >= (5000 if serious else 200):
            return
        if any(f["rule"] == rule and f.get("path") == path for f in self.findings):
            return
        entry = {"rule": rule, "severity": severity, "detail": detail}
        if sha256:
            # The exact class this was found in. An approved finding only carries over to a later version
            # if this class is byte-identical there.
            entry["sha256"] = sha256
        if path:
            entry["path"] = path[:300]
        self.findings.append(entry)


def load_iocs() -> dict[str, list[str]]:
    iocs = {k: list(v) for k, v in DEFAULT_IOCS.items()}
    private = os.environ.get("ARGONITE_PRIVATE_RULES")
    if private:
        path = os.path.join(private, "iocs.json")
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                extra = json.load(handle)
            for key in iocs:
                iocs[key].extend(str(x) for x in extra.get(key, []))
    iocs["strings"] = [s.lower() for s in iocs["strings"]]
    iocs["sha256"] = [s.lower() for s in iocs["sha256"]]
    return iocs


TEXT_SUFFIXES = (".json", ".toml", ".yml", ".yaml", ".properties", ".cfg", ".txt", ".mcmeta", ".fsh", ".vsh", ".gsh", ".glsl", ".mcfunction", ".js", ".lang")


def _scan_text(data: bytes, path: str, report: Report, ioc_strings: list[str]) -> None:
    if len(data) > 4 * 1024 * 1024:
        return
    raw = data.decode("utf-8", "replace")
    text = raw.lower()
    for ioc in ioc_strings:
        if ioc in text:
            report.add("ioc.string", "critical", f"Contains a known malware indicator ({ioc})", path)
    _collect_links(raw, path, report)


def _looks_like_text(data: bytes) -> bool:
    sample = data[:4096]
    if not sample or b"\x00" in sample:
        return False
    printable = sum(1 for b in sample if b in (9, 10, 13) or 32 <= b < 127 or b >= 128)
    return printable / len(sample) > 0.95


def _collect_links(text: str, path: str, report: Report) -> None:
    if len(report.links) >= MAX_LINKS:
        return
    for m in URL_IN_CODE.finditer(text[:2_000_000]):
        url = re.sub(r"^(https?):[/\\]+", r"\1://", m.group(0), flags=re.I).replace("\\", "/").rstrip(".,;:!?)]}'\"")
        host = link_host(url)
        if host and host not in NAMESPACE_HOSTS and url not in report.links:
            report.links[url] = path
            if len(report.links) >= MAX_LINKS:
                return


def link_host(url: str) -> str:
    rest = url.split("://", 1)[-1]
    host = re.split(r"[/?#:]", rest, maxsplit=1)[0].lower().rstrip(".")
    return host if "." in host and not host.endswith((".local", ".localhost", ".invalid", ".example")) and host not in ("localhost",) else ""


def hosts_of(report: Report) -> list[str]:
    return sorted({link_host(u) for u in report.links} - {""})


def analyse(walked: WalkResult, project_type: str, iocs: dict[str, list[str]]) -> Report:
    report = Report()
    for problem in walked.problems:
        rule, severity, detail = problem[0], problem[1], problem[2]
        report.add(rule, severity, detail, problem[3] if len(problem) > 3 else None)

    code_expected = project_type in CODE_TYPES
    short_names = 0
    ioc_strings = iocs["strings"]
    ioc_classes = set(iocs["classes"])

    for entry in walked.entries:
        lower = entry.path.lower()
        leaf = lower.rsplit("/", 1)[-1]
        kind = binary_kind(entry.data)
        if not code_expected:
            # Resource packs, data packs and shaders never need code. Any of it is grounds for rejection.
            if kind == "java" or leaf.endswith((".class", ".jar", ".war", ".ear")):
                report.add("policy.no_code", "critical", "Resource packs, data packs and shaders can't contain Java code.", entry.path)
            elif kind in ("windows", "linux", "macos") or leaf.endswith(EXECUTABLE_SUFFIXES + NATIVE_SUFFIXES):
                report.add("policy.no_executable", "critical", "Resource packs, data packs and shaders can't contain programs or native libraries.", entry.path)
            elif kind == "script" or leaf.endswith(PACK_BANNED_SUFFIXES):
                report.add("policy.no_executable", "critical", "Resource packs, data packs and shaders can't contain scripts.", entry.path)
            if leaf.endswith(TEXT_SUFFIXES):
                _scan_text(entry.data, entry.path, report, ioc_strings)
            continue
        native = kind in ("windows", "linux", "macos") or leaf.endswith(NATIVE_SUFFIXES)
        if kind in ("windows", "linux", "macos") and not leaf.endswith(EXECUTABLE_SUFFIXES + NATIVE_SUFFIXES):
            report.add("file.disguised_executable", "high", f"A {kind} program is hidden under another file extension", entry.path)
        if native or leaf.endswith(EXECUTABLE_SUFFIXES):
            # Native code runs outside the Java sandbox and can't be inspected like bytecode, so every
            # native file gets a human look, and its hash is kept to spot swaps between versions.
            report.capabilities.add("native_code")
            if len(report.natives) < 200:
                report.natives.append({
                    "path": entry.path,
                    "sha256": hashlib.sha256(entry.data).hexdigest(),
                    "size": len(entry.data),
                    "platform": kind if kind in ("windows", "linux", "macos") else "unknown",
                })
        if leaf.endswith(EXECUTABLE_SUFFIXES):
            report.add("file.executable", "high", f"Bundles {leaf.rsplit('.', 1)[-1]} file", entry.path)
        elif native:
            report.add("file.native_library", "high", "Bundles a native library", entry.path)
        elif leaf.endswith(SCRIPT_SUFFIXES):
            report.add("file.script", "medium", "Bundles a script file", entry.path)

        if leaf.endswith(".class"):
            if not code_expected:
                report.add("file.unexpected_code", "high", "Compiled Java code in a pack that should not contain code", entry.path)
            report.class_count += 1
            try:
                info = classfile.parse(entry.data)
            except classfile.ClassFormatError:
                report.add("class.malformed", "medium", "A .class file could not be parsed", entry.path)
                continue
            _check_class(info, entry.path, report, ioc_strings, ioc_classes, hashlib.sha256(entry.data).hexdigest())
            if SHORT_NAME.match(info.name or ""):
                short_names += 1
        elif leaf.endswith(TEXT_SUFFIXES):
            _scan_text(entry.data, entry.path, report, ioc_strings)
        elif kind is None and not leaf.endswith((".jar", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ogg", ".wav", ".nbt", ".mca")) and len(entry.data) <= 2 * 1024 * 1024 and _looks_like_text(entry.data):
            # Links hide in files with any extension (.dat, .bin, no extension at all).
            _collect_links(entry.data.decode("utf-8", "replace"), entry.path, report)
        if lower.endswith(TRANSFORMER_FILES):
            _transformer(report, entry.path)

    if report.class_count >= 20 and short_names / report.class_count > 0.6:
        report.add("class.obfuscated", "medium", "Most class names are one or two characters long (heavily obfuscated)")

    manifest = {k.lower(): v for k, v in walked.manifest.items()}
    if any(key in manifest for key in TRANSFORMER_MANIFEST):
        _transformer(report, "META-INF/MANIFEST.MF")
    for key in ("premain-class", "agent-class", "launcher-agent-class"):
        if key in manifest:
            report.capabilities.add("instrumentation")
            report.add("jar.java_agent", "high", f"Declares a Java agent ({key})")

    caps = report.capabilities
    # Combos alone don't make a file suspicious: plenty of honest mods shell out or fetch updates.
    # New risky capabilities still go to a human via the Worker's capability diff.
    if "process_exec" in caps and ("network" in caps or "dynamic_classloading" in caps):
        report.add("combo.exec_network", "high", "Runs external programs and talks to the network or loads code at runtime")
    if "dynamic_classloading" in caps and "crypto_decode" in caps and "network" in caps:
        report.add("combo.remote_code", "high", "Downloads, decrypts and loads code at runtime")
    elif "dynamic_classloading" in caps and ("network" in caps or "crypto_decode" in caps):
        report.add("combo.remote_code", "high", "Loads classes at runtime alongside network access or decryption")
    if "outside_game_dir" in caps and "network" in caps:
        report.add("combo.outside_network", "high", "Looks outside the game folder and talks to the network")
    if "jar_writing" in caps and code_expected:
        report.add("combo.jar_writing", "medium", "Writes jar/zip files (self-spreading malware does this; so do some legit tools)")
    return report


def _transformer(report: Report, path: str) -> None:
    report.capabilities.add("class_transformer")
    report.add("class.transformer", "medium", "Rewrites other classes' bytecode as the game loads (a coremod or transformer)", path)


def _session(report: Report, path: str, how: str, digest: str | None) -> None:
    report.capabilities.add("session_token")
    report.add("class.session_token", "high", f"{how} the player's session token, which lets whoever holds it log in as them", path, digest)


def _check_bytecode_access(info: classfile.ClassInfo, path: str, report: Report, digest: str | None = None) -> None:
    if info.members & SESSION_MEMBERS:
        _session(report, path, "Reads", digest)
    elif any(s in SESSION_STRINGS for s in info.strings):
        _session(report, path, "Looks up (by name)", digest)

    if info.classes & TRANSFORMER_CLASSES or any(c.startswith(TRANSFORMER_PREFIXES) for c in info.classes) or set(info.interfaces) & TRANSFORMER_CLASSES:
        _transformer(report, path)

    mixin = info.annotations.get(MIXIN)
    if mixin is None:
        return
    targets = {t.replace(".", "/") for t in mixin.get("value", []) + mixin.get("targets", [])}
    for target in sorted(targets):
        if target in SESSION_CLASSES or target.startswith(SESSION_PREFIXES):
            _session(report, path, f"A mixin into {target} can reach", digest)
        elif target.startswith(LOADER_PREFIXES):
            report.capabilities.add("patches_loader")
            report.add("mixin.loader_target", "high", f"A mixin patches the mod loader, Mixin or Java itself ({target})", path, digest)


def _check_class(info: classfile.ClassInfo, path: str, report: Report, ioc_strings: list[str], ioc_classes: set[str], digest: str | None = None) -> None:
    _check_bytecode_access(info, path, report, digest)
    for cap, members in CAPABILITY_MEMBERS.items():
        if any(m in info.members for m in members):
            report.capabilities.add(cap)
    for cap, classes in CAPABILITY_CLASSES.items():
        if any(c in info.classes for c in classes):
            report.capabilities.add(cap)

    if info.name in ioc_classes or any(c in ioc_classes for c in info.classes):
        report.add("ioc.class", "critical", "References a class from known Minecraft malware", path)

    for raw in info.utf8:
        if len(raw) > 20000:
            raw = raw[:20000]
        text = raw.lower()
        for ioc in ioc_strings:
            if ioc in text:
                report.add("ioc.string", "critical", f"Contains a known malware indicator ({ioc})", path)
        if any(p in text for p in SENSITIVE_PATHS):
            report.add("strings.credential_paths", "high", "References browser, Discord, wallet or launcher credential files", path, digest)
            report.capabilities.add("credential_access")
        if any(p in text for p in PERSISTENCE):
            report.add("strings.persistence", "high", "References OS start-up or persistence locations", path, digest)
        if SHADY_HOSTS.search(raw):
            report.add("strings.exfil_host", "high", "Contains a webhook, paste or tunnel URL often used to exfiltrate data", path, digest)
        if RAW_IP_URL.search(raw):
            report.add("strings.raw_ip", "medium", "Contains a URL pointing at a bare IP address", path)
    for s in info.strings:
        if BASE64_BLOB.match(s):
            report.add("strings.embedded_blob", "medium", "Contains a large base64 blob", path)
            break
    for s in info.strings:
        if "http" in s.lower():
            _collect_links(s, path, report)
    if info.members & OUTSIDE_MEMBERS and any(s.strip().lower() in OUTSIDE_KEYS for s in info.strings):
        report.capabilities.add("outside_game_dir")
        report.add("class.outside_game_dir", "medium", "Finds the user's home or system folders, outside the game folder", path)
