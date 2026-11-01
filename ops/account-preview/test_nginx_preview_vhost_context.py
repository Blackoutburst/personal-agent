"""Synthetic qualification tests; no host configuration or nginx process is used."""

import unittest

from nginx_preview_vhost_context import (CANONICAL_TARGET, PUBLIC_ANCHOR, PUBLIC_ERROR, RESERVED_INCLUDE,
                                         TARGET_SECTION, nginx_dump_sections, qualify_nginx_dump)
from nginx_staging_context import qualify_nginx_dump as qualify_shared_public_edit


ROOT = "/etc/nginx/nginx.conf"
GAMES = "/etc/nginx/sites-enabled/games.blackoutburst.com"


def root_server(extra="", host="blackoutburst.com", listen="443 ssl", anchor=None):
    include = f"include {PUBLIC_ANCHOR};" if anchor is None else anchor
    return f"server {{\n    listen {listen};\n    server_name {host};\n    {extra}\n    {include}\n}}"


def dump(site=None, *, root_extra="", root=None, public="location / { return 404; }", extra=None):
    sections = {ROOT: root if root is not None else f"events {{ worker_connections 512; }} http {{ {root_extra} include /etc/nginx/sites-enabled/*; }}",
                TARGET_SECTION: root_server() if site is None else site, PUBLIC_ANCHOR: public}
    sections.update(extra or {})
    return "".join(f"# configuration file {name}:\n{body}\n" for name, body in sections.items())


class VhostQualificationTests(unittest.TestCase):
    def accepted(self, text):
        result = qualify_nginx_dump(text)
        self.assertTrue(result["qualified"])
        self.assertEqual(result["target_section"], TARGET_SECTION)
        self.assertEqual(result["canonical_target"], CANONICAL_TARGET)
        self.assertEqual(result["intended_anchor_count"], 1)
        self.assertEqual(result["target_section_inclusions"], 1)
        self.assertEqual(result["captured_sections"], len(result["captured_paths"]))
        body = nginx_dump_sections(text)[TARGET_SECTION]
        line = body.split("\n")[result["anchor_line"] - 1]
        self.assertTrue(line.strip().startswith(f"include {PUBLIC_ANCHOR};"))
        raw_line = body.encode("utf-8")[result["anchor_byte_offset"]:].split(b"\n", 1)[0]
        self.assertEqual(raw_line, line.encode("utf-8"))
        return result

    def refused(self, text):
        with self.assertRaises(ValueError) as captured:
            qualify_nginx_dump(text)
        self.assertEqual(str(captured.exception), PUBLIC_ERROR)
        self.assertIsNone(captured.exception.__cause__)

    def test_shared_public_qualifies_root_insertion_but_refuses_shared_edit(self):
        text = dump(extra={GAMES: root_server(host="games.blackoutburst.com")})
        result = self.accepted(text)
        self.assertTrue(result["shared_public_must_remain_unchanged"])
        with self.assertRaises(ValueError):
            qualify_shared_public_edit(text)

    def test_types_are_allowed_in_http_server_and_location(self):
        text = dump(site=root_server("types { application/json json; } location /local { types { text/plain txt; } }"),
                    root_extra="types { text/html html; }",
                    extra={GAMES: root_server('location /file { types { application/wasm wasm; } auth_basic "Other host"; }', host="games.blackoutburst.com")})
        self.accepted(text)
        for location in ["events { types { text/plain txt; } }", "stream { types { text/plain txt; } }"]:
            self.refused(dump(root=location + f" http {{ include {TARGET_SECTION}; }}"))

    def test_section_reader_preserves_separator_newlines_and_sanitizes(self):
        text = f"# configuration file {ROOT}:\nhttp {{}}\n\n# configuration file {TARGET_SECTION}:\n# comment\n"
        self.assertEqual(nginx_dump_sections(text)[ROOT], "http {}\n\n")
        self.assertEqual(nginx_dump_sections(text)[TARGET_SECTION], "# comment\n")
        for invalid in [None, "", text + f"# configuration file {ROOT}:\n", "private error\n" + text]:
            with self.assertRaisesRegex(ValueError, "^Nginx staging context could not be qualified\\.$"):
                nginx_dump_sections(invalid)

    def test_anchor_must_be_unique_standalone_unquoted_and_direct_in_target_server(self):
        anchors = [f'include "{PUBLIC_ANCHOR}";', f"include {PUBLIC_ANCHOR}; include {PUBLIC_ANCHOR};",
                   f"location /nested {{ include {PUBLIC_ANCHOR}; }}", f"include /etc/nginx/public-wrapper.conf;",
                   f"include /etc/nginx/blackoutburst-platform/public*.conf;"]
        for anchor in anchors:
            self.refused(dump(site=root_server(anchor=anchor), extra={"/etc/nginx/public-wrapper.conf": f"include {PUBLIC_ANCHOR};"} if "wrapper" in anchor else None))
        self.refused(dump(site=root_server() + "\n" + root_server(host="other.invalid")))
        self.refused(dump(root=f"http {{ include {PUBLIC_ANCHOR}; include {TARGET_SECTION}; }}"))
        # A public include elsewhere is okay; an anchor declared outside the target source is not.
        wrapper = "/etc/nginx/root-server.conf"
        self.refused(dump(site=f"include {wrapper};", extra={wrapper: root_server()}))
        self.accepted(dump(site=root_server(anchor=f"include {PUBLIC_ANCHOR}; # retained comment")))

    def test_target_is_loaded_once_and_canonical_alias_requires_operator_review(self):
        self.refused(dump(root=f"http {{ include {TARGET_SECTION}; include {TARGET_SECTION}; }}"))
        self.refused(dump(root="http {}"))
        self.refused(dump(extra={CANONICAL_TARGET: root_server(host="other.invalid")}))
        self.refused(dump(root=f"include {TARGET_SECTION}; http {{}}"))

    def test_anchor_byte_offset_binds_lf_line_after_multibyte_and_other_separators(self):
        text = dump(site=root_server("# synthetic multibyte café, separator \u2028 and CR \r remain a comment"))
        result = self.accepted(text)
        body = nginx_dump_sections(text)[TARGET_SECTION]
        before = body.encode("utf-8")[:result["anchor_byte_offset"]]
        self.assertTrue(before.endswith(b"\n"))
        self.assertEqual(before.count(b"\n") + 1, result["anchor_line"])
        self.assertGreater(len(body.splitlines()), len(body.split("\n")))

    def test_exact_host_tls_and_duplicate_vhosts_remain_guarded(self):
        for host in ["other.invalid", "BLACKOUTBURST.COM", "blackoutburst.com www.blackoutburst.com", "*.blackoutburst.com"]:
            self.refused(dump(site=root_server(host=host)))
        for listen in ["443", "8443 ssl", "80", "localhost:443 ssl"]:
            self.refused(dump(site=root_server(listen=listen)))
        self.refused(dump(site=root_server("listen 80;")))
        for host, listen in [("blackoutburst.com", "443 ssl"), ("BLACKOUTBURST.COM", "443"), ("$hostname", "0.0.0.0:00443")]:
            self.refused(dump(extra={GAMES: f"server {{ listen {listen}; server_name {host}; }}"}))
        self.accepted(dump(site=root_server(listen="[::]:443 ssl http2"),
                           extra={GAMES: "server { listen 80; server_name blackoutburst.com; return 301 https://$host$request_uri; }"}))

    def test_reserved_future_include_is_rejected_in_other_vhost_and_empty_globs(self):
        for pattern in [RESERVED_INCLUDE, "/etc/nginx/personal-agent-*.locations", "/etc/*/personal-agent-preview.locations"]:
            self.refused(dump(site=root_server(f'include "{pattern}";')))
            self.refused(dump(extra={GAMES: f'server {{ listen 443 ssl; server_name other.invalid; include "{pattern}"; }}'}))
        self.accepted(dump(site=root_server("include /etc/nginx/empty/*.conf;")))

    def test_inherited_auth_debug_and_rewrite_remain_guarded(self):
        for directive in ['auth_basic "private-marker";', "auth_request /private-marker;", "return 302 /private-marker;",
                          "rewrite ^ /private-marker last;", "error_log /private-marker debug;", "if ($host) { return 403; }"]:
            self.refused(dump(site=root_server(directive)))
        for directive in ['auth_basic "private-marker";', "auth_request /private-marker;", "error_log /private-marker debug;"]:
            self.refused(dump(root_extra=directive))
            self.refused(dump(root=directive + f" http {{ include {TARGET_SECTION}; }}"))
            self.refused(dump(public=directive + "location / { return 404; }"))
        self.refused(dump(root=f"events {{ debug_connection 127.0.0.1; }} http {{ include {TARGET_SECTION}; }}"))
        self.accepted(dump(site=root_server('auth_basic off; auth_request off; location /private { auth_basic "Local only"; rewrite ^ /other last; }')))

    def test_inherited_mirror_and_post_action_require_operator_review(self):
        for directive in ["mirror /synthetic-audit;", "post_action /synthetic-audit;", "post_action off;"]:
            self.refused(dump(site=root_server(directive)))
            self.refused(dump(root_extra=directive))
            self.refused(dump(public=directive + "location / { return 404; }"))
        self.accepted(dump(site=root_server("mirror off; location /other { mirror /synthetic-audit; post_action /synthetic-after; }")))

    def test_preview_conflicts_dynamic_locations_and_ambiguous_escapes_are_refused(self):
        for location in ["location /personal-agent-preview/ { return 404; }",
                         'location ^~ "/personal\\-agent\\-preview/" { return 404; }',
                         'location "/personal\\x2dagent-preview" { return 404; }',
                         'location ~ "^/personal-agent-preview.*" { return 404; }',
                         "location $uri { return 404; }"]:
            self.refused(dump(site=root_server(location)))
        self.accepted(dump(site=root_server('location ~* "\\.(css|js)$" { expires 1h; }')))

    def test_include_cycles_unsupported_blocks_and_malformed_input_fail_closed(self):
        for include in ["include relative.conf;", "include /etc/nginx/$host.conf;", "include /missing.conf;",
                        "include /etc/nginx/[a-z]*.conf;"]:
            self.refused(dump(site=root_server(include)))
        self.refused(dump(site=root_server("include /etc/nginx/cycle.conf;"), extra={"/etc/nginx/cycle.conf": "include /etc/nginx/cycle.conf;"}))
        self.refused(dump(site=root_server("lua_block { synthetic; }")))
        self.refused(dump(site=root_server()) + "x" * 2_000_001)
        self.refused(dump(site=root_server()).replace("server_name blackoutburst.com", "server_name\u00a0blackoutburst.com"))
        self.refused(dump(site=root_server()).replace("server_name", "server_name\x00"))
        self.refused(dump(site=root_server()) + f"# configuration file {ROOT}:\nhttp {{}}\n")


if __name__ == "__main__":
    unittest.main()
