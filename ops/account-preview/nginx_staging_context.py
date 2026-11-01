"""Bounded, read-only qualification of a successful nginx -T stdout capture.

This is not a general nginx parser or a configuration rewriter. Relative includes,
dynamic includes, unknown block constructs and ambiguous literal-location escapes
require operator review. The caller must add an exact bare preview location and a
top-level ^~ preview subtree; existing PCRE locations are not interpreted. File
ownership, symlinks and nginx -T success are checked separately by the caller.
This module never reads configuration files from disk.
"""

import fnmatch
import ipaddress
import re
from pathlib import PurePosixPath


PUBLIC_ERROR = "Nginx staging context could not be qualified."
DEFAULT_TARGET = "/etc/nginx/blackoutburst-platform/public.conf"
RESERVED_INCLUDE = "/etc/nginx/blackoutburst-platform/personal-agent-preview.conf"
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
            tokens.append((char, char))
            if len(tokens) > 100_000:
                _refuse()
            index += 1
            continue
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
        tokens.append(("word", "".join(value)))
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
            words = []
            while position < len(tokens) and tokens[position][0] == "word":
                words.append(tokens[position][1])
                position += 1
            if not words or position >= len(tokens):
                _refuse()
            terminator = tokens[position][0]
            position += 1
            if terminator == ";":
                nodes.append((words[0], tuple(words[1:]), None))
            elif terminator == "{":
                nodes.append((words[0], tuple(words[1:]), body(True, depth + 1)))
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


def qualify_nginx_dump(text, target=DEFAULT_TARGET):
    """Return a small qualification receipt, or raise one fixed public refusal."""
    try:
        target = _path(target)
        sections = nginx_dump_sections(text)
        if target not in sections:
            _refuse()
        parsed = {name: _parse(content) for name, content in sections.items()}
        root = next(iter(sections))
        visited = set()
        servers = []
        targets = []
        inherited = []
        http_count = 0
        expanded = 0

        def walk(nodes, contexts=(), server=None, stack=(), in_target=False):
            nonlocal http_count, expanded
            for name, arguments, children in nodes:
                expanded += 1
                if expanded > 50_000 or len(contexts) > 64 or len(stack) > 64:
                    _refuse()
                parent = contexts[-1] if contexts else None
                if name == "debug_connection" and parent not in {"map", "geo", "upstream", "types", "split_clients", "charset_map"}:
                    _refuse()
                if name == "include":
                    if children is not None or len(arguments) != 1:
                        _refuse()
                    matches = _include_names(arguments[0], {*sections, RESERVED_INCLUDE})
                    # Creating this file must not activate an older include or
                    # empty glob anywhere in the already qualified graph.
                    if RESERVED_INCLUDE in matches:
                        _refuse()
                    for filename in matches:
                        if filename in stack:
                            _refuse()
                        if filename == target:
                            targets.append(server)
                            if parent != "server" or server is None or not server["http"]:
                                _refuse()
                        visited.add(filename)
                        walk(parsed[filename], contexts, server, stack + (filename,), in_target or filename == target)
                    continue
                if children is not None:
                    if in_target and name in {"http", "server"}:
                        _refuse()
                    if name in {"http", "events", "stream", "mail"}:
                        if contexts or arguments:
                            _refuse()
                        if name == "http":
                            http_count += 1
                    elif name == "server":
                        if parent not in {"http", "stream", "mail"} or arguments:
                            _refuse()
                        server = {"http": parent == "http", "names": [], "listen": [], "locations": [], "security": []}
                        servers.append(server)
                        walk(children, contexts + (name,), server, stack, in_target)
                        server = None
                        continue
                    elif name == "location":
                        if server is None or not server["http"] or parent not in {"server", "location"}:
                            _refuse()
                        server["locations"].extend(_location_path(arguments))
                    elif name in {"if", "limit_except"}:
                        if server is None or parent not in {"server", "location"} or (in_target and parent == "server"):
                            _refuse()
                        if parent == "server":
                            server["security"].append(("server_rewrite_block", ()))
                    elif name in {"map", "geo", "upstream", "types", "split_clients", "charset_map"}:
                        if parent not in {"http", "stream"}:
                            _refuse()
                    else:
                        _refuse()
                    walk(children, contexts + (name,), server, stack, in_target)
                    continue
                if server is not None and parent == "server":
                    if name == "server_name":
                        server["names"].append(arguments)
                    elif name == "listen":
                        server["listen"].append(arguments)
                if name in {"auth_basic", "auth_request", "error_log", "return", "rewrite"}:
                    if not contexts or contexts == ("http",):
                        inherited.append((name, arguments))
                    elif server is not None and parent == "server":
                        server["security"].append((name, arguments))

        visited.add(root)
        walk(parsed[root], stack=(root,))
        if visited != set(sections) or http_count != 1 or len(targets) != 1 or targets[0] is None:
            _refuse()
        intended = targets[0]
        if intended["names"] != [("blackoutburst.com",)] or not intended["listen"] or not all(_tls443(args) for args in intended["listen"]):
            _refuse()
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
            if name == "error_log" and (len(arguments) not in {1, 2} or (len(arguments) == 2 and arguments[1] not in _LEVELS)):
                _refuse()
            if name == "error_log" and len(arguments) == 2 and arguments[1] == "debug":
                _refuse()
        return {"qualified": True, "target": target, "server_name": "blackoutburst.com", "tls_port": 443,
                "target_inclusions": 1, "captured_sections": len(sections),
                "captured_paths": sorted(sections),
                "requires_exact_and_caret_preview_locations": True}
    except Exception:
        raise ValueError(PUBLIC_ERROR) from None
