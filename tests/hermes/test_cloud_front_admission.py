"""Static admission contract and body-memory budget; no nginx runtime claim."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CLOUD = ROOT / "deploy/cloud"


class CloudFrontAdmissionTests(unittest.TestCase):
    def render(self, root):
        cloud = root / "deploy/cloud"
        cloud.mkdir(parents=True)
        for name in ("prepare-build.py", "staging_config.py", "cloud.json", "front.conf.in", "paios_roaming_guard.js.in", "paios-staging-snapshot.timer"):
            shutil.copyfile(CLOUD / name, cloud / name)
        env = dict(os.environ, PAIOS_PUBLIC_API_URL="https://front.example.invalid:9443",
                   PAIOS_LEGACY_PUBLIC_API_URLS="https://legacy.example.invalid",
                   PAIOS_LIVEKIT_URL="", PAIOS_LIVEKIT_API_URL="")
        subprocess.run([sys.executable, str(cloud / "prepare-build.py"), "--config-only"],
                       check=True, env=env, capture_output=True)
        return [(cloud / ".build" / name).read_text()
                for name in ("front.conf", "front-staging.conf")]

    def test_global_and_source_admission_cover_every_rendered_proxy_before_body_read(self):
        nginx = (CLOUD / "front.conf.in").read_text()
        self.assertRegex(nginx, r"limit_conn_zone \$paios_body_global zone=paios_body_global:32k;")
        self.assertRegex(nginx, r"limit_conn_zone \$paios_body_source zone=paios_body_source:32k;")
        with tempfile.TemporaryDirectory() as temporary:
            for front in self.render(Path(temporary)):
                for server in front.split("server {")[1:]:
                    inherited, locations = server.split("    location ", 1)
                    self.assertIn("limit_conn paios_body_global 8;", inherited)
                    self.assertIn("limit_conn paios_body_source 8;", inherited)
                    self.assertIn("limit_conn_status 429;", inherited)
                    self.assertIn("error_page 429 = @paios_body_busy;", inherited)
                    self.assertIn('return 429 \'{"error":"ROAMING_BODY_BUSY"}\';', locations)
                    # A location-level limit would replace both inherited limits.
                    self.assertNotRegex(locations, r"\blimit_conn\s+")
                    self.assertIn("proxy_set_header Authorization $http_authorization;", inherited)
                    self.assertIn("client_max_body_size 1000000;", locations)
                    self.assertIn("client_max_body_size 5242880;", locations)
                    self.assertIn("client_body_buffer_size 1000000;", locations)
                    self.assertIn("proxy_request_buffering off;", locations)
                    # The Watch-specific 413 overrides server error_page inheritance.
                    watch = locations.split("location = /v1/watch/utterances {", 1)[1].split("\n    }", 1)[0]
                    self.assertIn("error_page 413 = @watch_too_large;", watch)
                    self.assertIn("error_page 429 = @paios_body_busy;", watch)
                self.assertIn("js_access paios_roaming_guard.enforce;", front)

    def test_header_framing_selects_small_body_pool_without_claiming_http2_gets_are_empty(self):
        nginx = (CLOUD / "front.conf.in").read_text()
        match = re.search(r'map "\$request_method:\$http_content_length:\$http_transfer_encoding" '
                          r'\$paios_body_global \{(.*?)\n\}', nginx, re.S)
        self.assertIsNotNone(match, "Admission must classify framing, not just POST")
        rows = dict(re.findall(r'("[^"]*"|default)\s+("[^"]*"|[\w$]+);', match[1]))
        def key(method, length="", transfer=""):
            return rows.get(f'"{method}:{length}:{transfer}"', rows["default"]).strip('"')
        self.assertEqual(key("GET"), "")
        self.assertEqual(key("GET", "0"), "")
        for method, length, transfer in (("POST", "1000000", ""), ("POST", "0", ""),
                                          ("GET", "1000000", ""), ("GET", "", "chunked")):
            self.assertEqual(key(method, length, transfer), "body")
        self.assertRegex(nginx, r'map \$paios_body_global \$paios_body_source \{\s*'
                         r'"" "";\s*default \$binary_remote_addr;\s*\}')

    def test_http2_get_without_length_still_has_global_and_source_admission(self):
        front = (CLOUD / "front.conf.in").read_text()
        # HTTP/2 DATA does not require CL/TE. GET:: alone cannot establish an empty body.
        self.assertIn("limit_conn_zone front zone=paios_requests_global:32k;", front)
        self.assertIn("limit_conn_zone $binary_remote_addr zone=paios_requests_source:32k;", front)
        with tempfile.TemporaryDirectory() as temporary:
            for rendered in self.render(Path(temporary)):
                for server in rendered.split("server {")[1:]:
                    inherited, locations = server.split("    location ", 1)
                    self.assertIn("limit_conn paios_requests_global 64;", inherited)
                    self.assertIn("limit_conn paios_requests_source 32;", inherited)
                    self.assertIn("client_body_buffer_size 8192;", inherited)
                    self.assertIn("http2_body_preread_size 8192;", inherited)
                    self.assertNotRegex(locations, r"\blimit_conn\s+")

    def test_aggregate_body_envelope_fits_32_mib_without_lowering_payloads(self):
        front = (CLOUD / "front.conf.in").read_text()
        limit = re.search(r"limit_conn paios_body_global (\d+);", front)
        self.assertIsNotNone(limit, "No global body admission: 512 near-limit bodies exceed 32 MiB")
        slots = int(limit[1])
        source_slots = int(re.search(r"limit_conn paios_body_source (\d+);", front)[1])
        buffers = [int(value) for value in re.findall(r"client_body_buffer_size (\d+);", front)]
        # Nginx may allocate up to 125% of the configured body buffer.
        body_envelope = slots * max(buffers) * 5 // 4
        self.assertEqual(max(buffers), 1_000_000)
        self.assertLessEqual(body_envelope, 32 * 1024 * 1024 // 3)
        self.assertGreaterEqual(source_slots, 8, "Four devices may each reconnect with two requests")
        self.assertLessEqual(source_slots, slots)
        general = re.search(r"limit_conn paios_requests_global (\d+);", front)
        self.assertIsNotNone(general, "Unknown-length HTTP/2 bodies need unconditional admission")
        inherited = front.split("server {", 1)[1].split("    location ", 1)[0]
        small = int(re.search(r"client_body_buffer_size (\d+);", inherited)[1])
        preread = int(re.search(r"http2_body_preread_size (\d+);", inherited)[1])
        # Conservatively include both the small buffer and the transient H2 preread copy.
        all_body_envelope = body_envelope + int(general[1]) * (small * 5 // 4 + preread)
        zones = sum(int(size) * 1024 for size in re.findall(r"zone=\w+:(\d+)k;", front))
        self.assertLessEqual(all_body_envelope + zones, 12 * 1024 * 1024)
        for name in ("front", "front-staging"):
            compose = re.search(rf"^  {name}:\n(.*?)(?=^  [a-z][\w-]*:|\Z)",
                                (CLOUD / "compose.yaml").read_text(), re.S | re.M)[1]
            self.assertIn("mem_limit: 32m", compose)
            self.assertIn("memswap_limit: 32m", compose)


if __name__ == "__main__":
    unittest.main()
