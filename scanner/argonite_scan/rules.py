"""Static heuristics for Minecraft content. The goal is to route risky files to a human, not to be clever."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from . import classfile
from .archive import WalkResult

EXECUTABLE_SUFFIXES = (".exe", ".dll", ".scr", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".jse", ".wsf", ".hta", ".lnk")
NATIVE_SUFFIXES = (".so", ".dylib", ".jnilib", ".dll")
SCRIPT_SUFFIXES = (".sh", ".command", ".py", ".rb", ".pl")
PACK_BANNED_SUFFIXES = SCRIPT_SUFFIXES + (".js", ".apk", ".appimage", ".deb", ".rpm", ".pkg", ".dmg", ".msix", ".jnlp")
CODE_TYPES = ("mod", "plugin", "modpack", "addon")


def binary_kind(data: bytes) -> str | None:
    """Recognise executables by their first bytes, whatever the file happens to be called."""
    head = data[:64]
    if head[:4] == b"\xca\xfe\xba\xbe":
        # Java classes and Mach-O fat binaries share this magic; either way it's code.
        return "java"
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

    def add(self, rule: str, severity: str, detail: str, path: str | None = None) -> None:
        if len(self.findings) >= 200:
            return
        if any(f["rule"] == rule and f.get("path") == path for f in self.findings):
            return
        entry = {"rule": rule, "severity": severity, "detail": detail}
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
    text = data.decode("utf-8", "replace").lower()
    for ioc in ioc_strings:
        if ioc in text:
            report.add("ioc.string", "critical", f"Contains a known malware indicator ({ioc})", path)


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
        if kind in ("windows", "linux", "macos") and not leaf.endswith(EXECUTABLE_SUFFIXES + NATIVE_SUFFIXES):
            report.add("file.disguised_executable", "high", f"A {kind} program is hidden under another file extension", entry.path)
            report.capabilities.add("native_code")
        if leaf.endswith(EXECUTABLE_SUFFIXES):
            native_dll = leaf.endswith(".dll") and code_expected
            report.add("file.executable" if not native_dll else "file.native_library", "high", f"Bundles {leaf.rsplit('.', 1)[-1]} file", entry.path)
            if native_dll:
                report.capabilities.add("native_code")
        elif leaf.endswith(NATIVE_SUFFIXES):
            report.add("file.native_library", "high" if not code_expected else "medium", "Bundles a native library", entry.path)
            report.capabilities.add("native_code")
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
            _check_class(info, entry.path, report, ioc_strings, ioc_classes)
            if SHORT_NAME.match(info.name or ""):
                short_names += 1
        elif leaf.endswith(TEXT_SUFFIXES):
            _scan_text(entry.data, entry.path, report, ioc_strings)

    if report.class_count >= 20 and short_names / report.class_count > 0.6:
        report.add("class.obfuscated", "medium", "Most class names are one or two characters long (heavily obfuscated)")

    manifest = {k.lower(): v for k, v in walked.manifest.items()}
    for key in ("premain-class", "agent-class", "launcher-agent-class"):
        if key in manifest:
            report.capabilities.add("instrumentation")
            report.add("jar.java_agent", "high", f"Declares a Java agent ({key})")

    caps = report.capabilities
    # Combos alone don't make a file suspicious: plenty of honest mods shell out or fetch updates.
    # New risky capabilities still go to a human via the Worker's capability diff.
    if "process_exec" in caps and ("network" in caps or "dynamic_classloading" in caps):
        report.add("combo.exec_network", "medium", "Runs external programs and talks to the network or loads code at runtime")
    if "dynamic_classloading" in caps and "crypto_decode" in caps and "network" in caps:
        report.add("combo.remote_code", "high", "Downloads, decrypts and loads code at runtime")
    elif "dynamic_classloading" in caps and ("network" in caps or "crypto_decode" in caps):
        report.add("combo.remote_code", "medium", "Loads classes at runtime alongside network access or decryption")
    if "jar_writing" in caps and code_expected:
        report.add("combo.jar_writing", "medium", "Writes jar/zip files (self-spreading malware does this; so do some legit tools)")
    return report


def _check_class(info: classfile.ClassInfo, path: str, report: Report, ioc_strings: list[str], ioc_classes: set[str]) -> None:
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
            report.add("strings.credential_paths", "high", "References browser, Discord, wallet or launcher credential files", path)
            report.capabilities.add("credential_access")
        if any(p in text for p in PERSISTENCE):
            report.add("strings.persistence", "high", "References OS start-up or persistence locations", path)
        if SHADY_HOSTS.search(raw):
            report.add("strings.exfil_host", "high", "Contains a webhook, paste or tunnel URL often used to exfiltrate data", path)
        if RAW_IP_URL.search(raw):
            report.add("strings.raw_ip", "medium", "Contains a URL pointing at a bare IP address", path)
    for s in info.strings:
        if BASE64_BLOB.match(s):
            report.add("strings.embedded_blob", "medium", "Contains a large base64 blob", path)
            break
