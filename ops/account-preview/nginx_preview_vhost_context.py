"""Bounded, read-only qualification of root-vhost preview insertion.

This is not a general nginx parser or a configuration rewriter. Relative includes,
dynamic includes, unknown block constructs and ambiguous literal-location escapes
require operator review. The caller must add an exact bare preview location and a
top-level ^~ preview subtree; existing PCRE locations are not interpreted. File
ownership, symlinks and nginx -T success are checked separately by the caller.
This module never reads configuration files from disk.

The caller inserts one standalone include at the returned anchor_byte_offset in
CANONICAL_TARGET, after proving TARGET_SECTION resolves to that root-controlled
file. PUBLIC_ANCHOR remains unchanged and may be used by other virtual hosts.
The caller must snapshot all captured source files and verify the exact delta.
"""

import fnmatch
import ipaddress
import re
from pathlib import PurePosixPath


PUBLIC_ERROR = "Nginx staging context could not be qualified."
TARGET_SECTION = "/etc/nginx/sites-enabled/bakushin"
CANONICAL_TARGET = "/etc/nginx/sites-available/bakushin"
PUBLIC_ANCHOR = "/etc/nginx/blackoutburst-platform/public.conf"
RESERVED_INCLUDE = "/etc/nginx/personal-agent-preview.locations"
_SECTION = re.compile(r"# configuration file (/[^\r\n]+):")
_PATH = re.compile(r"/[A-Za-z0-9_./-]+\Z")
_LEVELS = {"debug", "info", "notice", "warn", "error", "crit", "alert", "emerg"}
_SPACE = " \t\r\n"
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def _refuse():
    raise ValueError(PUBLIC_ERROR)


def _path(value):
    if not isinstance(value, str) or not _PATH.fullmatch(value):
        _refuse()
    if "//" in value or str(PurePosixPath(value)) != value or ".." in PurePosixPath(value).parts:
        _refuse()
    return value


def _sections(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 2_000_000:
        _refuse()
    sections = {}
    current = None
    for line in text.splitlines(keepends=True):
        marker = _SECTION.fullmatch(line.rstrip("\r\n"))
        if marker:
            current = _path(marker.group(1))
            if current in sections or len(sections) >= 512:
                _refuse()
            sections[current] = []
        elif line.startswith("# configuration file "):
            _refuse()
        elif current is not None:
            sections[current].append(line)
        elif line.strip() and not line.lstrip().startswith("#"):
            _refuse()
    if not sections:
        _refuse()
    return {name: "".join(lines) for name, lines in sections.items()}


def nginx_dump_sections(text):
    """Return captured absolute names and exact bodies between dump headers.

    Bodies retain all whitespace, including nginx's dump separator newlines.
    This bounded section reader does not read files or qualify nginx grammar.
    """
    try:
        return _sections(text)
    except Exception:
        raise ValueError(PUBLIC_ERROR) from None
def _tokens(text):
    tokens = []
    index = 0
    while index < len(text):
        char = text[index]
        if char in _SPACE:
            index += 1
            continue
        if ord(char) < 32 or ord(char) == 127:
            _refuse()
        if char == "#":
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
            continue
        if char in "{};":
            tokens.append((char, char, index))
            if len(tokens) > 100_000:
                _refuse()
            index += 1
            continue
        start = index
        quoted = char in "\"'"
        quote = char if quoted else None
        index += int(quoted)
        value = []
        closed = not quoted
        while index < len(text):
            char = text[index]
            if quoted and char == quote:
                index += 1
                closed = True
                break
            if not quoted and (char in _SPACE or char in "{};"):
                break
            if not quoted and char.isspace():
                _refuse()
            if not quoted and char in "#\"'":
                _refuse()  # Mixed quoted fragments and mid-token comments are not guessed.
            if char == "\\":
                index += 1
                if index >= len(text):
                    _refuse()
                following = text[index]
                if following in "\\\"'":
                    value.append(following)
                elif following in "nrt":
                    value.append({"n": "\n", "r": "\r", "t": "\t"}[following])
                elif following.isspace() or following in "#;{}":
                    _refuse()
                else:
                    value.extend(("\\", following))
                index += 1
                continue
            if ord(char) < 32 and char not in "\t\r\n":
                _refuse()
            value.append(char)
            index += 1
        if not closed or (quoted and index < len(text) and text[index] not in _SPACE + "{};#"):
            _refuse()
        if not quoted and not value:
            _refuse()
        tokens.append(("word", "".join(value), start))
        if len(tokens) > 100_000:
            _refuse()
    return tokens


def _parse(text):
    tokens = _tokens(text)
    position = 0

    def body(nested=False, depth=0):
        nonlocal position
        if depth > 64:
            _refuse()
        nodes = []
        while position < len(tokens):
            if tokens[position][0] == "}":
                if not nested:
                    _refuse()
                position += 1
                return nodes
            offset = tokens[position][2]
            words = []
            while position < len(tokens) and tokens[position][0] == "word":
                words.append(tokens[position][1])
                position += 1
            if not words or position >= len(tokens):
                _refuse()
            terminator = tokens[position][0]
            position += 1
            if terminator == ";":
                nodes.append((words[0], tuple(words[1:]), None, offset))
            elif terminator == "{":
                nodes.append((words[0], tuple(words[1:]), body(True, depth + 1), offset))
            else:
                _refuse()
        if nested:
            _refuse()
        return nodes

    return body()


def _include_names(pattern, names):
    if not pattern.startswith("/") or "$" in pattern or "\\" in pattern or "**" in pattern:
        _refuse()
    if any(part in {".", ".."} for part in pattern.split("/")) or "//" in pattern or pattern.endswith("/"):
        _refuse()
    # Character-class globs have locale-dependent semantics and need review.
    if not re.fullmatch(r"/[A-Za-z0-9_./*?-]+", pattern):
        _refuse()
    wildcard = any(char in pattern for char in "*?")
    if not wildcard:
        return [pattern] if pattern in names else _refuse()
    parts = pattern.split("/")
    # Match components separately: a '*' in nginx glob syntax does not cross '/'.
    return sorted(name for name in names if len(name.split("/")) == len(parts)
                  and all((not part.startswith(".") or wanted.startswith(".")) and fnmatch.fnmatchcase(part, wanted)
                          for part, wanted in zip(name.split("/"), parts)))


def _tls443(arguments):
    if len(arguments) < 2 or "ssl" not in arguments:
        return False
    address = arguments[0]
    if address == "443" or address == "*:443":
        return True
    try:
        if address.startswith("["):
            match = re.fullmatch(r"\[([^]]+)\]:443", address)
            return bool(match and ipaddress.ip_address(match.group(1)).version == 6)
        host, port = address.rsplit(":", 1)
        return port == "443" and ipaddress.ip_address(host).version == 4
    except ValueError:
        return False


def _port443(arguments):
    """Conservatively identify competing port-443 listeners, even without ssl."""
    if not arguments:
        return False
    port = arguments[0].rsplit(":", 1)[-1]
    return bool(re.fullmatch(r"[0-9]+", port) and port.lstrip("0") == "443")


def _location_path(arguments):
    if not arguments:
        _refuse()
    regex = len(arguments) == 2 and arguments[0] in {"~", "~*"}
    if len(arguments) == 1:
        if not arguments[0].startswith(("/", "@")):
            _refuse()
    elif not regex and (len(arguments) != 2 or arguments[0] not in {"=", "^~"} or not arguments[1].startswith("/")):
        _refuse()
    if any((re.search(r"\$[A-Za-z_{]", value) if regex else "$" in value) for value in arguments):
        _refuse()
    # Punctuation escapes can be compared conservatively. Encoded characters,
    # backreferences and other ambiguous escapes require explicit operator review.
    values = []
    for value in arguments:
        value = re.sub(r"\\([./_~-])", r"\1", value)
        if ("\\" in value and not regex) or any(ord(char) < 32 for char in value):
            _refuse()
        values.append(value)
    return values


def _anchor_position(content, offset):
    """Require an entire unquoted include line at the AST node's source offset."""
    start = content.rfind("\n", 0, offset) + 1
    end = content.find("\n", offset)
    if end < 0:
        end = len(content)
    line = content[start:end]
    pattern = r"[ \t]*include[ \t]+" + re.escape(PUBLIC_ANCHOR) + r"[ \t]*;[ \t]*(?:#[^\r\n]*)?\r?"
    if not re.fullmatch(pattern, line) or line[:offset - start].strip(" \t"):
        _refuse()
    return content.count("\n", 0, start) + 1, len(content[:start].encode("utf-8"))


def qualify_nginx_dump(text):
    """Qualify one root-vhost anchor; never authorize editing the shared include.

    anchor_byte_offset is the UTF-8 offset of the line start within the preserved
    target section; the caller must verify the literal anchor again at that exact
    offset in the original canonical file bytes. anchor_line is one-based and
    counts LF only, for diagnostics; do not position insertion with splitlines().
    CANONICAL_TARGET is the required filesystem destination, not proof of path
    resolution or ownership. The caller must establish those facts separately.
    """
    try:
        sections = nginx_dump_sections(text)
        if TARGET_SECTION not in sections or CANONICAL_TARGET in sections:
            _refuse()
        parsed = {name: _parse(content) for name, content in sections.items()}
        root = next(iter(sections))
        visited = set()
        servers = []
        anchors = []
        inherited = []
        target_inclusions = 0
        http_count = 0
        expanded = 0

        def walk(nodes, source, contexts=(), server=None, stack=()):
            nonlocal http_count, expanded, target_inclusions
            for name, arguments, children, offset in nodes:
                expanded += 1
                if expanded > 50_000 or len(contexts) > 64 or len(stack) > 64:
                    _refuse()
                parent = contexts[-1] if contexts else None
                if name == "debug_connection" and parent not in {"map", "geo", "upstream", "types", "split_clients", "charset_map"}:
                    _refuse()
                if name == "include":
                    if children is not None or len(arguments) != 1:
                        _refuse()
                    if source == TARGET_SECTION and arguments == (PUBLIC_ANCHOR,):
                        anchors.append((server, parent, offset))
                    matches = _include_names(arguments[0], {*sections, RESERVED_INCLUDE})
                    if RESERVED_INCLUDE in matches:
                        _refuse()
                    for filename in matches:
                        if filename in stack:
                            _refuse()
                        if filename == TARGET_SECTION:
                            target_inclusions += 1
                        visited.add(filename)
                        walk(parsed[filename], filename, contexts, server, stack + (filename,))
                    continue
                if children is not None:
                    if name in {"http", "events", "stream", "mail"}:
                        if contexts or arguments:
                            _refuse()
                        if name == "http":
                            http_count += 1
                    elif name == "server":
                        if parent not in {"http", "stream", "mail"} or arguments:
                            _refuse()
                        server = {"http": parent == "http", "source": source, "names": [],
                                  "listen": [], "locations": [], "security": []}
                        servers.append(server)
                        walk(children, source, contexts + (name,), server, stack)
                        server = None
                        continue
                    elif name == "location":
                        if server is None or not server["http"] or parent not in {"server", "location"}:
                            _refuse()
                        server["locations"].extend(_location_path(arguments))
                    elif name in {"if", "limit_except"}:
                        if server is None or parent not in {"server", "location"}:
                            _refuse()
                        if parent == "server":
                            server["security"].append(("server_rewrite_block", ()))
                    elif name == "types":
                        if parent not in {"http", "server", "location"}:
                            _refuse()
                    elif name in {"map", "geo", "upstream", "split_clients", "charset_map"}:
                        if parent not in {"http", "stream"}:
                            _refuse()
                    else:
                        _refuse()
                    walk(children, source, contexts + (name,), server, stack)
                    continue
                if server is not None and parent == "server":
                    if name == "server_name":
                        server["names"].append(arguments)
                    elif name == "listen":
                        server["listen"].append(arguments)
                if name in {"auth_basic", "auth_request", "error_log", "return", "rewrite", "mirror", "post_action"}:
                    if not contexts or contexts == ("http",):
                        inherited.append((name, arguments))
                    elif server is not None and parent == "server":
                        server["security"].append((name, arguments))

        visited.add(root)
        walk(parsed[root], root, stack=(root,))
        if visited != set(sections) or http_count != 1 or target_inclusions != 1 or len(anchors) != 1:
            _refuse()
        intended, parent, offset = anchors[0]
        if intended is None or not intended["http"] or intended["source"] != TARGET_SECTION or parent != "server":
            _refuse()
        if intended["names"] != [("blackoutburst.com",)] or not intended["listen"] or not all(_tls443(args) for args in intended["listen"]):
            _refuse()
        anchor_line, anchor_byte_offset = _anchor_position(sections[TARGET_SECTION], offset)
        if any("/personal-agent-preview" in value for value in intended["locations"]):
            _refuse()
        for other in servers:
            if other is not intended and other["http"] and any(_port443(args) for args in other["listen"]):
                names = [name.translate(_ASCII_LOWER) for group in other["names"] for name in group]
                if "blackoutburst.com" in names or any("$" in name for name in names if not name.startswith("~")):
                    _refuse()
        for name, arguments in inherited + intended["security"]:
            if name in {"return", "rewrite", "server_rewrite_block"}:
                _refuse()
            if name in {"auth_basic", "auth_request"} and arguments != ("off",):
                _refuse()
            if name == "post_action" or (name == "mirror" and arguments != ("off",)):
                _refuse()
            if name == "error_log" and (len(arguments) not in {1, 2} or (len(arguments) == 2 and arguments[1] not in _LEVELS)):
                _refuse()
            if name == "error_log" and len(arguments) == 2 and arguments[1] == "debug":
                _refuse()
        return {"qualified": True, "target_section": TARGET_SECTION, "canonical_target": CANONICAL_TARGET,
                "public_anchor": PUBLIC_ANCHOR, "reserved_include": RESERVED_INCLUDE,
                "server_name": "blackoutburst.com", "tls_port": 443,
                "target_section_inclusions": target_inclusions, "intended_anchor_count": len(anchors),
                "anchor_line": anchor_line, "anchor_byte_offset": anchor_byte_offset,
                "captured_sections": len(sections), "captured_paths": sorted(sections),
                "requires_exact_and_caret_preview_locations": True, "shared_public_must_remain_unchanged": True}
    except Exception:
        raise ValueError(PUBLIC_ERROR) from None
