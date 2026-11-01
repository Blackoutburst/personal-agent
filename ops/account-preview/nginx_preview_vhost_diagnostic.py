"""Read-only diagnostics for the pinned root-vhost qualifier, never approval.

A temporary per-thread trace observes the first refusal in the exact pinned
source. It does not alter the source or its decision. Output is restricted to
fixed codes, source lines, counts and booleans. No configuration values, paths,
names, exception diagnostics or frame locals are returned. The caller must
separately establish successful nginx -T and all filesystem/delta checks.
"""

import hashlib
import json
import sys
from pathlib import Path


QUALIFIER_SHA256 = "E7F9B29D93A6D37400D72A7FEF04E31AB77046773C7CF6D8CA41003BDBD4D247"
_FILENAME = "<pinned-nginx-preview-vhost-qualifier>"
_TARGET = "/etc/nginx/sites-enabled/bakushin"
_CANONICAL_TARGET = "/etc/nginx/sites-available/bakushin"
_MAX_INPUT = 2_000_000
_GUARDS = {
    40: ("SECTIONS", "SECTION_PATH_UNSUPPORTED"),
    42: ("SECTIONS", "SECTION_PATH_NONCANONICAL"),
    48: ("INPUT", "INPUT_TYPE_OR_SIZE"),
    56: ("SECTIONS", "SECTION_DUPLICATE_OR_LIMIT"),
    59: ("SECTIONS", "SECTION_MARKER_MALFORMED"),
    63: ("SECTIONS", "NONCOMMENT_PREAMBLE"),
    65: ("SECTIONS", "NO_CAPTURED_SECTIONS"),
    90: ("LEXER", "CONTROL_CHARACTER"),
    98: ("LEXER", "TOKEN_LIMIT"),
    116: ("LEXER", "NONASCII_WHITESPACE"),
    118: ("LEXER", "MIXED_TOKEN_OR_MIDTOKEN_COMMENT"),
    122: ("LEXER", "INCOMPLETE_ESCAPE"),
    129: ("LEXER", "UNSUPPORTED_SEPARATOR_ESCAPE"),
    135: ("LEXER", "CONTROL_CHARACTER"),
    139: ("LEXER", "UNTERMINATED_OR_ADJACENT_QUOTE"),
    141: ("LEXER", "EMPTY_UNQUOTED_TOKEN"),
    144: ("LEXER", "TOKEN_LIMIT"),
    155: ("GRAMMAR", "PARSE_DEPTH_LIMIT"),
    160: ("GRAMMAR", "UNEXPECTED_CLOSING_BRACE"),
    169: ("GRAMMAR", "MISSING_DIRECTIVE_OR_TERMINATOR"),
    177: ("GRAMMAR", "INVALID_TERMINATOR"),
    179: ("GRAMMAR", "UNCLOSED_BLOCK"),
    187: ("INCLUDES", "INCLUDE_EXPRESSION_UNSUPPORTED"),
    189: ("INCLUDES", "INCLUDE_PATH_NONCANONICAL"),
    192: ("INCLUDES", "INCLUDE_GLOB_SYNTAX_UNSUPPORTED"),
    195: ("INCLUDES", "INCLUDE_LITERAL_NOT_CAPTURED"),
    229: ("LOCATIONS", "LOCATION_ARGUMENTS_MISSING"),
    233: ("LOCATIONS", "LOCATION_NAME_UNSUPPORTED"),
    235: ("LOCATIONS", "LOCATION_MODIFIER_OR_ARITY_UNSUPPORTED"),
    237: ("LOCATIONS", "LOCATION_DYNAMIC"),
    244: ("LOCATIONS", "LOCATION_ESCAPE_OR_CONTROL_UNSUPPORTED"),
    258: ("ANCHOR", "ANCHOR_LINE_NOT_STANDALONE_LITERAL"),
    275: ("TARGET", "TARGET_SECTION_OR_CAPTURED_ALIAS"),
    291: ("GRAPH", "EXPANSION_OR_DEPTH_LIMIT"),
    294: ("LOGGING", "ACTIVE_DEBUG_CONNECTION"),
    297: ("INCLUDES", "INCLUDE_DIRECTIVE_SHAPE"),
    302: ("INCLUDES", "RESERVED_FUTURE_INCLUDE_MATCH"),
    305: ("INCLUDES", "INCLUDE_CYCLE"),
    314: ("GRAMMAR", "ROOT_BLOCK_CONTEXT_OR_ARGUMENTS"),
    319: ("GRAMMAR", "SERVER_CONTEXT_OR_ARGUMENTS"),
    328: ("GRAMMAR", "LOCATION_CONTEXT"),
    332: ("GRAMMAR", "PREDICATE_CONTEXT"),
    337: ("GRAMMAR", "TYPES_CONTEXT"),
    340: ("GRAMMAR", "OPAQUE_BLOCK_CONTEXT"),
    342: ("GRAMMAR", "BLOCK_CONSTRUCT_UNSUPPORTED"),
    359: ("GRAPH", "GRAPH_INVARIANTS"),
    362: ("ANCHOR", "ANCHOR_SERVER_SOURCE_OR_CONTEXT"),
    364: ("SERVER", "TARGET_NAME_OR_LISTENER_SHAPE"),
    367: ("LOCATIONS", "EXISTING_PREVIEW_LOCATION"),
    372: ("SERVER", "COMPETING_443_HOSTNAME"),
    375: ("SECURITY", "INHERITED_REWRITE_BEHAVIOR"),
    377: ("SECURITY", "INHERITED_AUTH_ACTIVE"),
    379: ("SECURITY", "INHERITED_EXTRA_REQUEST_ACTION"),
    381: ("LOGGING", "INHERITED_ERROR_LOG_SHAPE"),
    383: ("LOGGING", "INHERITED_DEBUG_ERROR_LOG"),
}


def _report(qualified, stage, reason, structure=None, guard_line=None):
    result = {"schema_version": 1, "diagnostic_only": True, "expected_qualifier_sha256": QUALIFIER_SHA256,
              "qualified": qualified, "stage": stage, "reason": reason, "structure": structure or {}}
    if guard_line is not None:
        result["guard_line"] = guard_line
    return result


def _structure(frame, namespace):
    """Copy only fixed-key scalar observations; retain no raw frame or value."""
    observations = {}
    for _ in range(160):
        if frame is None or frame.f_code.co_filename != _FILENAME:
            break
        values = frame.f_locals
        if frame.f_code.co_name == "walk" and "context_depth" not in observations:
            observations["context_depth"] = len(values["contexts"])
            observations["include_depth"] = len(values["stack"])
        if frame.f_code.co_name == "qualify_nginx_dump":
            sections, parsed, visited = (values.get(key) for key in ("sections", "parsed", "visited"))
            if isinstance(sections, dict):
                observations["captured_sections"] = len(sections)
                observations["target_section_captured"] = _TARGET in sections
                observations["canonical_alias_captured"] = _CANONICAL_TARGET in sections
                if isinstance(visited, set):
                    observations["unvisited_sections"] = len(set(sections) - visited)
            if isinstance(parsed, dict):
                observations["parsed_sections"] = len(parsed)
            for local, public in (("http_count", "http_blocks"), ("target_inclusions", "target_section_inclusions"),
                                  ("expanded", "expanded_statements")):
                if local in values:
                    observations[public] = values[local]
            servers, anchors = values.get("servers"), values.get("anchors")
            if isinstance(servers, list):
                observations["http_servers"] = sum(bool(server["http"]) for server in servers)
            if isinstance(anchors, list):
                observations["intended_anchor_count"] = len(anchors)
                if len(anchors) == 1:
                    candidate, parent, _ = anchors[0]
                    observations["anchor_has_server"] = candidate is not None
                    observations["anchor_direct_server_context"] = parent == "server"
                    if isinstance(candidate, dict):
                        observations["anchor_has_http_server"] = candidate["http"]
                        observations["anchor_server_in_target_section"] = candidate["source"] == _TARGET
            intended = values.get("intended")
            if isinstance(intended, dict):
                observations["target_name_exact"] = intended["names"] == [("blackoutburst.com",)]
                observations["target_listener_count"] = len(intended["listen"])
                observations["target_listeners_all_tls443"] = bool(intended["listen"]) and all(
                    namespace["_tls443"](args) for args in intended["listen"])
            break
        frame = frame.f_back
    return observations


def _reason(line, frame, structure):
    stage, reason = _GUARDS.get(line, ("DIAGNOSTIC", "UNMAPPED_REFUSAL"))
    values = frame.f_locals
    if line == 56:
        reason = "SECTION_DUPLICATE" if values["current"] in values["sections"] else "SECTION_LIMIT"
    elif line == 187:
        pattern = values["pattern"]
        reason = ("INCLUDE_RELATIVE" if not pattern.startswith("/") else "INCLUDE_DYNAMIC" if "$" in pattern
                  else "INCLUDE_ESCAPED" if "\\" in pattern else "INCLUDE_RECURSIVE_GLOB")
    elif line == 275:
        reason = "TARGET_SECTION_MISSING" if not structure.get("target_section_captured") else "CANONICAL_TARGET_CAPTURED_ALIAS"
    elif line == 291:
        reason = ("EXPANDED_STATEMENT_LIMIT" if values["expanded"] > 50_000 else
                  "CONTEXT_DEPTH_LIMIT" if len(values["contexts"]) > 64 else "INCLUDE_DEPTH_LIMIT")
    elif line == 359:
        reason = ("UNREACHABLE_CAPTURED_SECTIONS" if structure.get("unvisited_sections") else
                  "HTTP_BLOCK_COUNT" if structure.get("http_blocks") != 1 else
                  "TARGET_SECTION_INCLUDE_COUNT" if structure.get("target_section_inclusions") != 1 else "ANCHOR_COUNT")
    elif line == 362:
        reason = ("ANCHOR_SERVER_MISSING" if not structure.get("anchor_has_server") else
                  "ANCHOR_SERVER_NOT_HTTP" if not structure.get("anchor_has_http_server") else
                  "ANCHOR_SERVER_OUTSIDE_TARGET_SECTION" if not structure.get("anchor_server_in_target_section") else
                  "ANCHOR_NOT_DIRECT_SERVER_CONTEXT")
    elif line == 364:
        reason = ("TARGET_SERVER_NAME_SHAPE" if not structure.get("target_name_exact") else
                  "TARGET_LISTENER_MISSING" if not structure.get("target_listener_count") else "TARGET_LISTENER_UNSUPPORTED")
    elif line == 379:
        reason = "INHERITED_POST_ACTION" if values["name"] == "post_action" else "INHERITED_MIRROR_ACTIVE"
    return stage, reason


def diagnose_nginx_dump(text, *, qualifier_path=None):
    """Return sanitized evidence, never installation permission.

    qualifier_path is a trusted code location. A stale pin, existing trace or
    unexpected failure yields qualified=None and no raw exception diagnostics.
    expected_qualifier_sha256 always names the required pin, including when the
    source could not be loaded or verified.
    """
    if not isinstance(text, str):
        return _report(False, "INPUT", "INPUT_TYPE_OR_SIZE", guard_line=48)
    try:
        if len(text.encode("utf-8")) > _MAX_INPUT:
            return _report(False, "INPUT", "INPUT_TYPE_OR_SIZE", guard_line=48)
    except UnicodeError:
        return _report(None, "INPUT", "INPUT_ENCODING_UNSUPPORTED")
    if sys.gettrace() is not None:
        return _report(None, "DIAGNOSTIC", "EXISTING_TRACE_UNSUPPORTED")
    try:
        source_path = Path(qualifier_path) if qualifier_path is not None else Path(__file__).with_name("nginx_preview_vhost_context.py")
        with source_path.open("rb") as source_file:
            source = source_file.read(65_537)
        if len(source) > 65_536 or hashlib.sha256(source).hexdigest().upper() != QUALIFIER_SHA256:
            return _report(None, "DIAGNOSTIC", "QUALIFIER_PIN_MISMATCH")
        namespace = {"__name__": "_pinned_nginx_preview_vhost_qualifier", "__file__": _FILENAME}
        exec(compile(source, _FILENAME, "exec"), namespace)
    except Exception:
        return _report(None, "DIAGNOSTIC", "QUALIFIER_LOAD_UNAVAILABLE")
    observed = {}

    def trace(frame, event, argument):
        if frame.f_code.co_filename != _FILENAME:
            return None
        frame.f_trace_lines = False
        frame.f_trace_opcodes = False
        if event == "call" and frame.f_code.co_name == "_refuse" and not observed:
            caller = frame.f_back
            structure = _structure(caller, namespace)
            stage, reason = _reason(caller.f_lineno, caller, structure)
            observed.update(_report(False, stage, reason, structure, caller.f_lineno))
        elif event == "return" and frame.f_code.co_name == "qualify_nginx_dump" and isinstance(argument, dict):
            observed.update(_report(True, "COMPLETE", "QUALIFIED", _structure(frame, namespace)))
        return trace

    try:
        sys.settrace(trace)
        namespace["qualify_nginx_dump"](text)
    except Exception:
        pass
    finally:
        sys.settrace(None)
    return observed or _report(None, "DIAGNOSTIC", "UNCLASSIFIED_FAILURE")


def main():
    """Read a bounded stdin capture; emit one sanitized JSON report."""
    try:
        raw = sys.stdin.buffer.read(_MAX_INPUT + 1)
        report = (_report(False, "INPUT", "INPUT_TYPE_OR_SIZE", guard_line=48) if len(raw) > _MAX_INPUT
                  else diagnose_nginx_dump(raw.decode("utf-8")))
    except Exception:
        report = _report(None, "INPUT", "INPUT_READ_UNAVAILABLE")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
