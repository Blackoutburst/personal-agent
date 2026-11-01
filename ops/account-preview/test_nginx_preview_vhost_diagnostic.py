"""Synthetic diagnostic tests; no host configuration or nginx invocation."""

import ast
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from nginx_preview_vhost_context import CANONICAL_TARGET, PUBLIC_ANCHOR, RESERVED_INCLUDE, TARGET_SECTION, qualify_nginx_dump
from nginx_preview_vhost_diagnostic import QUALIFIER_SHA256, _GUARDS, diagnose_nginx_dump


def dump(extra="", *, host="blackoutburst.com", listen="443 ssl", anchor=None, site=None, root=None, extra_sections=None):
    anchor = f"include {PUBLIC_ANCHOR};" if anchor is None else anchor
    site = f"server {{\n listen {listen}; server_name {host};\n {extra}\n {anchor}\n}}" if site is None else site
    sections = {"/etc/nginx/nginx.conf": root or "http { include /etc/nginx/sites-enabled/*; }",
                TARGET_SECTION: site, PUBLIC_ANCHOR: "location / { return 404; }", **(extra_sections or {})}
    return "".join(f"# configuration file {name}:\n{body}\n" for name, body in sections.items())


class PreviewDiagnosticTests(unittest.TestCase):
    def report(self, text, reason, line=None):
        result = diagnose_nginx_dump(text)
        self.assertEqual(result["reason"], reason)
        self.assertTrue(result["diagnostic_only"])
        self.assertEqual(result["expected_qualifier_sha256"], QUALIFIER_SHA256)
        self.assertEqual(set(result) - {"guard_line"}, {"schema_version", "diagnostic_only", "expected_qualifier_sha256",
                                                           "qualified", "stage", "reason", "structure"})
        self.assertTrue(all(type(value) in {int, bool} for value in result["structure"].values()))
        if line is not None:
            self.assertEqual(result["guard_line"], line)
        try:
            qualify_nginx_dump(text)
            expected = True
        except ValueError:
            expected = False
        self.assertIs(result["qualified"], expected)
        self.assertIsNone(sys.gettrace())
        rendered = json.dumps(result)
        for private in ["/etc/", "blackoutburst.com", "bakushin", "captured_paths", "private-marker"]:
            self.assertNotIn(private, rendered)
        return result

    def test_guard_mapping_covers_every_refusal_in_exact_pinned_source(self):
        source = Path(__file__).with_name("nginx_preview_vhost_context.py").read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest().upper(), QUALIFIER_SHA256)
        calls = {node.lineno for node in ast.walk(ast.parse(source))
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_refuse"}
        self.assertEqual(set(_GUARDS), calls)

    def test_success_and_shared_public_return_only_scalar_structure(self):
        games = "/etc/nginx/sites-enabled/private-marker-games"
        result = self.report(dump(extra='add_header X-Synthetic "private-marker";', extra_sections={
            games: f"server {{ listen 443 ssl; server_name private-marker.invalid; include {PUBLIC_ANCHOR}; }}"}), "QUALIFIED")
        self.assertEqual(result["structure"]["http_servers"], 2)
        self.assertEqual(result["structure"]["intended_anchor_count"], 1)
        self.assertTrue(result["structure"]["target_name_exact"])

    def test_target_graph_and_anchor_failures_are_actionable(self):
        missing_target = dump().replace(f"# configuration file {TARGET_SECTION}:",
                                        "# configuration file /etc/nginx/sites-enabled/private-marker:")
        self.report(missing_target, "TARGET_SECTION_MISSING", 275)
        self.report(dump(extra_sections={CANONICAL_TARGET: "# private-marker"}), "CANONICAL_TARGET_CAPTURED_ALIAS", 275)
        self.report(dump(root="http {}"), "UNREACHABLE_CAPTURED_SECTIONS", 359)
        result = self.report(dump(root=f"http {{ include {TARGET_SECTION}; include {TARGET_SECTION}; }}"), "TARGET_SECTION_INCLUDE_COUNT", 359)
        self.assertEqual(result["structure"]["target_section_inclusions"], 2)
        self.report(dump(anchor="location / { return 404; }", extra_sections={
            "/etc/nginx/sites-enabled/private-marker-games":
            f"server {{ listen 443 ssl; server_name private-marker.invalid; include {PUBLIC_ANCHOR}; }}"}), "ANCHOR_COUNT", 359)
        result = self.report(dump(anchor=f"location /nested {{ include {PUBLIC_ANCHOR}; }}"), "ANCHOR_NOT_DIRECT_SERVER_CONTEXT", 362)
        self.assertFalse(result["structure"]["anchor_direct_server_context"])
        self.report(dump(anchor=f'include "{PUBLIC_ANCHOR}";'), "ANCHOR_LINE_NOT_STANDALONE_LITERAL", 258)
        self.report(dump(host="private-marker.invalid"), "TARGET_SERVER_NAME_SHAPE", 364)
        self.report(dump(listen="8443 ssl"), "TARGET_LISTENER_UNSUPPORTED", 364)

    def test_security_logging_locations_and_includes_redact_values(self):
        cases = [
            (dump(extra=f'include "{RESERVED_INCLUDE}";'), "RESERVED_FUTURE_INCLUDE_MATCH", 302),
            (dump(extra="include /etc/nginx/personal-agent-*.locations;"), "RESERVED_FUTURE_INCLUDE_MATCH", 302),
            (dump(extra="include private-marker.conf;"), "INCLUDE_RELATIVE", 187),
            (dump(extra="include /etc/nginx/$private_marker.conf;"), "INCLUDE_DYNAMIC", 187),
            (dump(extra="include /private-marker.conf;"), "INCLUDE_LITERAL_NOT_CAPTURED", 195),
            (dump(extra='auth_basic "private-marker";'), "INHERITED_AUTH_ACTIVE", 377),
            (dump(extra="mirror /private-marker;"), "INHERITED_MIRROR_ACTIVE", 379),
            (dump(extra="post_action /private-marker;"), "INHERITED_POST_ACTION", 379),
            (dump(extra="error_log /private-marker debug;"), "INHERITED_DEBUG_ERROR_LOG", 383),
            (dump(extra="return 302 /private-marker;"), "INHERITED_REWRITE_BEHAVIOR", 375),
            (dump(extra="location /personal-agent-preview/ { return 404; }"), "EXISTING_PREVIEW_LOCATION", 367),
            (dump(extra="lua_block { private-marker; }"), "BLOCK_CONSTRUCT_UNSUPPORTED", 342),
            (dump(extra='add_header X "private-marker;'), "UNTERMINATED_OR_ADJACENT_QUOTE", 139),
        ]
        for text, reason, line in cases:
            with self.subTest(reason=reason):
                self.report(text, reason, line)

    def test_competing_vhost_and_debug_connection_report_no_names_or_addresses(self):
        self.report(dump(extra_sections={"/etc/nginx/sites-enabled/private-marker":
                    "server { listen 443; server_name BLACKOUTBURST.COM; }"}), "COMPETING_443_HOSTNAME", 372)
        self.report(dump(root=f"events {{ debug_connection 192.0.2.33; }} http {{ include {TARGET_SECTION}; }}"), "ACTIVE_DEBUG_CONNECTION", 294)

    def test_stale_or_missing_qualifier_is_not_executed_and_reports_no_raw_error(self):
        with tempfile.TemporaryDirectory(prefix="preview-diagnostic-synthetic-") as temporary:
            source = Path(temporary) / "private-marker.py"
            source.write_text("raise RuntimeError('private-marker')", encoding="utf-8")
            stale = diagnose_nginx_dump(dump(), qualifier_path=source)
            self.assertIsNone(stale["qualified"])
            self.assertEqual(stale["reason"], "QUALIFIER_PIN_MISMATCH")
            missing = diagnose_nginx_dump(dump(), qualifier_path=source.with_name("missing-private-marker.py"))
            self.assertEqual(missing["reason"], "QUALIFIER_LOAD_UNAVAILABLE")
            for result in [stale, missing]:
                self.assertNotIn("private-marker", json.dumps(result))
                self.assertNotIn(temporary, json.dumps(result))

    def test_existing_trace_is_preserved_and_inputs_are_bounded(self):
        def existing_trace(frame, event, argument):
            return existing_trace
        sys.settrace(existing_trace)
        try:
            result = diagnose_nginx_dump(dump())
            self.assertIsNone(result["qualified"])
            self.assertEqual(result["reason"], "EXISTING_TRACE_UNSUPPORTED")
            self.assertIs(sys.gettrace(), existing_trace)
        finally:
            sys.settrace(None)
        self.report(None, "INPUT_TYPE_OR_SIZE", 48)
        self.report("x" * 2_000_001, "INPUT_TYPE_OR_SIZE", 48)
        self.assertEqual(diagnose_nginx_dump("\ud800")["reason"], "INPUT_ENCODING_UNSUPPORTED")

    def test_stdin_cli_emits_one_sanitized_report_without_stderr(self):
        script = Path(__file__).with_name("nginx_preview_vhost_diagnostic.py")
        process = subprocess.run([sys.executable, "-I", "-B", str(script)], input=dump(extra='auth_basic "private-marker";'),
                                 text=True, capture_output=True, timeout=5, check=True)
        self.assertEqual(process.stderr, "")
        self.assertEqual(json.loads(process.stdout)["reason"], "INHERITED_AUTH_ACTIVE")
        self.assertEqual(len(process.stdout.splitlines()), 1)
        self.assertNotIn("private-marker", process.stdout)


if __name__ == "__main__":
    unittest.main()
