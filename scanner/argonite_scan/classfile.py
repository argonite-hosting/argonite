"""Just enough of the JVM class format to pull references, string constants and class-level annotations out."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field


@dataclass
class ClassInfo:
    name: str = ""
    classes: set[str] = field(default_factory=set)
    members: set[str] = field(default_factory=set)
    strings: list[str] = field(default_factory=list)
    utf8: list[str] = field(default_factory=list)
    interfaces: list[str] = field(default_factory=list)
    # Class-level annotations: type descriptor -> element name -> values. Class values are given as
    # internal names (a/b/C), strings and enum constants as written.
    annotations: dict[str, dict[str, list[str]]] = field(default_factory=dict)


class ClassFormatError(Exception):
    pass


def _modified_utf8(raw: bytes) -> str:
    return raw.replace(b"\xc0\x80", b"\x00").decode("utf-8", "replace")


def parse(data: bytes) -> ClassInfo:
    if len(data) < 10 or data[:4] != b"\xca\xfe\xba\xbe":
        raise ClassFormatError("not a class file")
    count = struct.unpack_from(">H", data, 8)[0]
    pos = 10
    pool: list[tuple | None] = [None] * count
    i = 1
    try:
        while i < count:
            tag = data[pos]
            pos += 1
            if tag == 1:
                (length,) = struct.unpack_from(">H", data, pos)
                pos += 2
                pool[i] = ("utf8", _modified_utf8(data[pos : pos + length]))
                pos += length
            elif tag in (3, 4):
                pos += 4
            elif tag in (5, 6):
                pos += 8
                i += 1
            elif tag in (7, 8, 16, 19, 20):
                pool[i] = (tag, struct.unpack_from(">H", data, pos)[0])
                pos += 2
            elif tag in (9, 10, 11, 12, 17, 18):
                pool[i] = (tag, *struct.unpack_from(">HH", data, pos))
                pos += 4
            elif tag == 15:
                pos += 3
            else:
                raise ClassFormatError(f"bad constant tag {tag}")
            i += 1
        this_class = struct.unpack_from(">H", data, pos + 2)[0]
        rest = pos + 6
    except (IndexError, struct.error) as exc:
        raise ClassFormatError("truncated class file") from exc

    def utf(index: int) -> str:
        item = pool[index] if 0 < index < count else None
        return item[1] if item and item[0] == "utf8" else ""

    def class_name(index: int) -> str:
        item = pool[index] if 0 < index < count else None
        return utf(item[1]) if item and item[0] == 7 else ""

    info = ClassInfo()
    for item in pool:
        if not item:
            continue
        kind = item[0]
        if kind == "utf8":
            info.utf8.append(item[1])
        elif kind == 7:
            info.classes.add(utf(item[1]))
        elif kind == 8:
            info.strings.append(utf(item[1]))
        elif kind in (9, 10, 11):
            owner = class_name(item[1])
            nat = pool[item[2]] if 0 < item[2] < count else None
            if nat and nat[0] == 12:
                info.members.add(f"{owner}.{utf(nat[1])}")
    info.name = class_name(this_class)
    try:
        _read_body(data, rest, utf, class_name, info)
    except (IndexError, struct.error, RecursionError):
        # The constant pool is what the rules mostly need; a damaged tail only loses annotations.
        pass
    return info


ANNOTATION_ATTRS = ("RuntimeVisibleAnnotations", "RuntimeInvisibleAnnotations")


def _read_body(data: bytes, pos: int, utf, class_name, info: ClassInfo) -> None:
    (count,) = struct.unpack_from(">H", data, pos)
    pos += 2
    for _ in range(count):
        info.interfaces.append(class_name(struct.unpack_from(">H", data, pos)[0]))
        pos += 2
    for _ in range(2):  # fields, then methods
        (members,) = struct.unpack_from(">H", data, pos)
        pos += 2
        for _ in range(members):
            pos += 6
            (attrs,) = struct.unpack_from(">H", data, pos)
            pos += 2
            for _ in range(attrs):
                pos += 2
                (length,) = struct.unpack_from(">I", data, pos)
                pos += 4 + length
    (attrs,) = struct.unpack_from(">H", data, pos)
    pos += 2
    for _ in range(attrs):
        name_index, length = struct.unpack_from(">HI", data, pos)
        pos += 6
        if utf(name_index) in ANNOTATION_ATTRS:
            _read_annotations(data, pos, utf, info)
        pos += length


def _read_annotations(data: bytes, pos: int, utf, info: ClassInfo) -> None:
    (count,) = struct.unpack_from(">H", data, pos)
    pos += 2
    for _ in range(count):
        kind = utf(struct.unpack_from(">H", data, pos)[0])
        pos, elements = _annotation_body(data, pos + 2, utf, 0)
        info.annotations.setdefault(kind, {}).update(elements)


def _annotation_body(data: bytes, pos: int, utf, depth: int) -> tuple[int, dict[str, list[str]]]:
    if depth > 8:
        raise RecursionError("annotations nested too deep")
    (pairs,) = struct.unpack_from(">H", data, pos)
    pos += 2
    elements: dict[str, list[str]] = {}
    for _ in range(pairs):
        name = utf(struct.unpack_from(">H", data, pos)[0])
        values: list[str] = []
        pos = _element_value(data, pos + 2, utf, values, depth)
        elements[name] = values
    return pos, elements


def _element_value(data: bytes, pos: int, utf, out: list[str], depth: int) -> int:
    tag = chr(data[pos])
    pos += 1
    if tag in "BCDFIJSZ":
        return pos + 2
    if tag == "s":
        out.append(utf(struct.unpack_from(">H", data, pos)[0]))
        return pos + 2
    if tag == "c":
        desc = utf(struct.unpack_from(">H", data, pos)[0])
        out.append(desc[1:-1] if desc.startswith("L") and desc.endswith(";") else desc)
        return pos + 2
    if tag == "e":
        out.append(utf(struct.unpack_from(">H", data, pos + 2)[0]))
        return pos + 4
    if tag == "@":
        pos, _ = _annotation_body(data, pos + 2, utf, depth + 1)
        return pos
    if tag == "[":
        (count,) = struct.unpack_from(">H", data, pos)
        pos += 2
        for _ in range(count):
            pos = _element_value(data, pos, utf, out, depth + 1)
        return pos
    raise IndexError(f"bad element tag {tag!r}")
