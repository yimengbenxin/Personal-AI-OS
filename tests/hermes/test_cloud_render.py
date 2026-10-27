"""Local config rendering only; no Docker, network, credentials or host installation."""
import json
import re
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from io import BytesIO
import runpy
import yaml

ROOT = Path(__file__).resolve().parents[2]
CANONICAL = "https://bj.xn--fsq092h.xn--0zwm56d:9443"


class CloudRenderTests(unittest.TestCase):
    def test_owner_mac_initializes_empty_bootstrap_placeholder_without_rotating_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            secrets = Path(temporary)
            environment = dict(os.environ, PAIOS_PHONE_PROVIDER="off")
            subprocess.run([sys.executable, str(ROOT / "deploy/cloud/prepare-secrets.py"),
                            "--secrets-dir", str(secrets), "--public-host", "fixture.invalid",
                            "--public-ipv4", "192.0.2.10"], env=environment, check=True, capture_output=True)
            relay = secrets / "owner-mac-relay.json"
            self.assertEqual(relay.read_bytes(), b"")
            command = [sys.executable, str(ROOT / "deploy/cloud/prepare-owner-mac.py"),
                       "--secrets-dir", str(secrets), "--relay-host", "fixture.invalid"]
            subprocess.run(command, check=True, capture_output=True)
            original = relay.read_bytes()
            configured = json.loads(original)
            self.assertTrue(configured["token"] and configured["admin_password"])
            self.assertEqual(relay.stat().st_mode & 0o777, 0o600)
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(relay.read_bytes(), original)
            failed = subprocess.run(command[:-1] + ["different.invalid"], capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(relay.read_bytes(), original)

    def test_owner_mac_rejects_nonempty_invalid_configuration_without_overwriting_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            secrets = Path(temporary)
            relay = secrets / "owner-mac-relay.json"
            for content in (" ", "{invalid", "{}"):
                relay.write_text(content)
                failed = subprocess.run([sys.executable, str(ROOT / "deploy/cloud/prepare-owner-mac.py"),
                    "--secrets-dir", str(secrets), "--relay-host", "fixture.invalid"], capture_output=True)
                self.assertNotEqual(failed.returncode, 0)
                self.assertEqual(relay.read_text(), content)
                self.assertFalse((secrets / "owner-mac-frps.toml").exists())

    def single_host_overlay(self):
        class ComposeLoader(yaml.SafeLoader):
            pass
        ComposeLoader.add_constructor("!override", lambda loader, node: loader.construct_sequence(node))
        ComposeLoader.add_constructor("!reset", lambda loader, node: loader.construct_mapping(node))
        return yaml.load((ROOT / "deploy/cloud/compose.single-host.yaml").read_text(), Loader=ComposeLoader)

    def test_single_host_keeps_owner_mac_shared_directory_permissions(self):
        services = self.single_host_overlay()["services"]
        self.assertIn("${PAIOS_SECRETS_DIR:?}/owner-mac:/run/owner-mac", services["gateway"]["volumes"])
        self.assertIn("${PAIOS_SECRETS_DIR:?}/owner-mac:/run/owner-mac:ro", services["hermes"]["volumes"])
        self.assertIn("${PAIOS_SECRETS_DIR:?}:/run/secrets:ro", services["gateway"]["volumes"])
        # Hermes mounts only its own key files, never the whole secrets directory (deploy-credential isolation).
        self.assertNotIn("${PAIOS_SECRETS_DIR:?}:/run/secrets:ro", services["hermes"]["volumes"])
        self.assertIn("${PAIOS_SECRETS_DIR:?}/hermes-api.key:/run/secrets/hermes-api.key:ro", services["hermes"]["volumes"])

    def test_single_host_preserves_bounded_workshop_and_output_volumes(self):
        base = yaml.safe_load((ROOT / "deploy/cloud/compose.yaml").read_text())
        overlay = self.single_host_overlay()
        for name in ("workshop-data", "desktop-out", "workshop-snapshots"):
            final = {**base["volumes"][name], **overlay.get("volumes", {}).get(name, {})}
            self.assertEqual(final["driver_opts"], base["volumes"][name]["driver_opts"])

    def test_first_run_prepares_bounded_workshop_before_starting_services(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cloud = root / "deploy/cloud"
            cloud.mkdir(parents=True)
            shutil.copyfile(ROOT / "deploy/cloud/build.sh", cloud / "build.sh")
            env = cloud / "fixture.env"
            env.write_text("PAIOS_SECRETS_DIR=secrets\nPAIOS_TLS_DIR=tls\nPAIOS_PUBLIC_HOST=fixture.invalid\n"
                           "PAIOS_PUBLIC_IPV4=192.0.2.10\nPAIOS_ENABLE_PHONE=0\n"
                           "PAIOS_GATEWAY_IMAGE=fixture-gateway:test\nPAIOS_HERMES_IMAGE=fixture-hermes:test\n"
                           "PAIOS_FRONT_IMAGE=fixture-front:test\nPAIOS_WORKSHOP_IMAGE=fixture-workshop:test\n")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            calls = root / "commands.jsonl"
            for tool, code in (("docker", ""), ("python3", "sys.exit(73)")):
                target = bin_dir / tool
                target.write_text(f"#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\n"
                    f"with Path({str(calls)!r}).open('a') as out: out.write(json.dumps(sys.argv)+'\\n')\n" + code)
                target.chmod(0o755)
            result = subprocess.run(["sh", str(cloud / "build.sh"), "--up", "--env-file", str(env)],
                env={**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"]}, capture_output=True)
            self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
            rows = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertEqual(rows[-1][1:], ["migrate.py", "prepare-workshop", "--compose", "compose.yaml",
                                           "--env-file", str(env)])
            self.assertFalse(any("up" in row or "Dockerfile.gateway" in row for row in rows))

    def copy_renderer(self, root):
        for relative in ("deploy/cloud/prepare-build.py", "deploy/cloud/staging_config.py", "deploy/cloud/cloud.json",
                         "deploy/cloud/front.conf.in", "deploy/cloud/paios-staging-snapshot.timer",
                         "deploy/cloud/paios_roaming_guard.js.in"):
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)

    def test_time_zone_default_override_private_config_and_staging(self):
        for zone in ('America/Los_Angeles', 'UTC', 'Asia/Taipei'):
            with self.subTest(zone=zone), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.copy_renderer(root)
                script = root / 'deploy/cloud/prepare-build.py'
                config = script.parent / 'cloud.json'
                product = json.loads(config.read_text())
                product['time_zone'] = 'Asia/Taipei'  # explicit instance override for this fixture
                del product['time_zone']  # public deployment has no private instance override
                config.write_text(json.dumps(product))
                environment = dict(os.environ, PAIOS_PUBLIC_API_URL=CANONICAL,
                                   PAIOS_LEGACY_PUBLIC_API_URLS='', TZ=zone, PAIOS_TIME_ZONE='')
                def render():
                    subprocess.run([sys.executable, str(script), '--config-only'], env=environment,
                                   check=True, capture_output=True)
                    return [json.loads((script.parent / '.build' / name).read_text())
                            for name in ('production.json', 'staging.json')]
                for output in render():
                    self.assertEqual(output['time_zone'], zone)
                    self.assertNotIn('day_timezone', output['payment'])
                self.assertIn('05:00 ' + zone, (script.parent / '.build/paios-staging-snapshot.timer').read_text())
                product['time_zone'] = 'Asia/Taipei'
                config.write_text(json.dumps(product))
                self.assertEqual(render()[0]['time_zone'], 'Asia/Taipei')
                environment['PAIOS_TIME_ZONE'] = zone
                self.assertEqual(render()[0]['time_zone'], zone)
                environment['PAIOS_TIME_ZONE'] = 'Invalid/Zone'
                self.assertNotEqual(subprocess.run([sys.executable, str(script), '--config-only'],
                    env=environment, capture_output=True).returncode, 0)

    def test_watch_routes_render_metadata_and_only_the_contract_long_poll_query(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.copy_renderer(root)
            environment = dict(os.environ, PAIOS_PUBLIC_API_URL=CANONICAL,
                               PAIOS_LEGACY_PUBLIC_API_URLS="")
            subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                           env=environment, check=True, capture_output=True)
            build = root / "deploy/cloud/.build"
            for name in ("front.conf", "front-staging.conf"):
                front = (build / name).read_text()
                for route in ("/v1/realtime/watch-binding/credential", "/v1/watch/utterances", "/v1/watch/turns/"):
                    self.assertIn(route, front)
                for header in ("Turn-ID", "Codec", "Sample-Rate-Hz", "Channels", "Duration-Ms"):
                    self.assertIn("proxy_set_header X-Watch-" + header, front)
                self.assertIn("[?]wait=25$ 1;", front)
                self.assertIn("client_max_body_size 1000000;", front)
                self.assertIn("proxy_read_timeout 50s;", front)
            subprocess.run(["node", "--input-type=module", "-e", r"""
                import {pathToFileURL} from 'node:url';
                import assert from 'node:assert/strict';
                const guard = (await import(pathToFileURL(process.argv[1]))).default;
                function request(route, args) {
                    return {rawHeadersIn:[['Host','bj.xn--fsq092h.xn--0zwm56d:9443']], headersOut:{},
                        variables:{is_args:args ? '?' : '',args,paios_roaming_route_class:route},
                        return(status){this.status=status;}};
                }
                for (const [route,args,status] of [['watch_turn','wait=25',undefined],
                    ['watch_turn','wait=25&wait=25',400],['watch_turn','wait=26',400],
                    ['watch_utterance','wait=25',400],['realtime_watch_binding','wait=25',400]]) {
                    const r=request(route,args);guard.enforce(r);assert.equal(r.status,status);
                }
                """, str(build / "paios_roaming_guard.js")], check=True, capture_output=True, env=environment)

    def test_acme_exec_hook_uses_unicode_zone_and_cleans_only_its_txt(self):
        calls = []
        def response(url, **_):
            query = parse_qs(urlsplit(url).query)
            calls.append(query)
            action = query["Action"][0]
            if action == "DescribeDomains":
                result = {"TotalCount": 1, "Domains": {"Domain": [
                    {"DomainName": "示例.测试", "PunyCode": "xn--fsq092h.xn--0zwm56d"}]}}
            elif action == "DescribeDomainRecords":
                result = {"DomainRecords": {"Record": [
                    {"RR": "_acme-challenge.bj", "Type": "TXT", "Value": "fixture-txt", "RecordId": "owned"},
                    {"RR": "_acme-challenge.bj", "Type": "TXT", "Value": "other-txt", "RecordId": "other"}]}}
            else:
                result = {"RecordId": "owned"}
            return BytesIO(json.dumps(result).encode())
        for action in ("present", "cleanup"):
            with patch.dict(os.environ, ALICLOUD_ACCESS_KEY="fixture-id", ALICLOUD_SECRET_KEY="fixture-secret"), \
                    patch.object(sys, "argv", ["hook", action, "_acme-challenge.bj.xn--fsq092h.xn--0zwm56d.", "fixture-txt"]), \
                    patch("urllib.request.urlopen", side_effect=response):
                runpy.run_path(str(ROOT / "deploy/cloud/acme/alidns-hook.py"))
        zoned = [call for call in calls if "DomainName" in call]
        self.assertTrue(zoned)
        self.assertTrue(all(call["DomainName"] == ["示例.测试"] for call in zoned))
        deleted = [call["RecordId"] for call in calls if call["Action"] == ["DeleteDomainRecord"]]
        self.assertEqual(deleted, [["owned"]])

    def test_canonical_origin_overrides_stale_public_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.copy_renderer(root)
            environment = dict(os.environ, PAIOS_PUBLIC_HOST="ai.example.invalid",
                               PAIOS_PUBLIC_API_URL=CANONICAL, PAIOS_LIVEKIT_SIGNAL_PORT="17880",
                               PAIOS_STAGING_TLS_PORT="19443", PAIOS_TLS_PORT="9443",
                               PAIOS_LIVEKIT_URL="", PAIOS_LIVEKIT_API_URL="", PAIOS_LEGACY_PUBLIC_API_URLS="")
            subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                           env=environment, check=True, capture_output=True)
            build = root / "deploy/cloud/.build"
            front = (build / "front.conf").read_text()
            guard = (build / "paios_roaming_guard.js").read_text()
            self.assertIn("~^bj[.]xn--fsq092h[.]xn--0zwm56d$ 1;", front)
            self.assertIn("server_name bj.xn--fsq092h.xn--0zwm56d;", front)
            self.assertIn("Host bj.xn--fsq092h.xn--0zwm56d:9443;", front)
            self.assertIn("X-Forwarded-Host bj.xn--fsq092h.xn--0zwm56d:9443;", front)
            self.assertIn("EXACT_HOST = 'bj.xn--fsq092h.xn--0zwm56d:9443'", guard)
            self.assertNotIn("ai.example.invalid", front + guard)
            resources = json.loads((build / "production.json").read_text())["product_resources"]
            self.assertEqual(resources["public_api_url"], CANONICAL)
            self.assertEqual(resources["livekit_url"], "wss://bj.xn--fsq092h.xn--0zwm56d:9443")
            self.assertEqual(resources["livekit_api_url"], "http://127.0.0.1:17880")
            public = dict(line.split("=", 1) for line in (build / "production.public.env").read_text().splitlines())
            self.assertEqual(public["PAIOS_PUBLIC_API_URL"], CANONICAL)
            self.assertEqual(public["PAIOS_LIVEKIT_URL"], resources["livekit_url"])
            self.assertEqual(public["PAIOS_LIVEKIT_API_URL"], resources["livekit_api_url"])
            self.assertEqual(public["PAIOS_PUBLIC_HOST"], "bj.xn--fsq092h.xn--0zwm56d")
            stage = json.loads((build / "staging.json").read_text())["product_resources"]
            self.assertEqual(stage["public_api_url"], "https://bj.xn--fsq092h.xn--0zwm56d:19443")
            self.assertEqual(stage["legacy_public_api_urls"], "")
            self.assertEqual(public["PAIOS_STAGING_PUBLIC_API_URL"], stage["public_api_url"])
            self.assertEqual(public["PAIOS_STAGING_LIVEKIT_URL"], stage["livekit_url"])
            # An API rollback must preserve phase-2a media/signaling when explicitly configured.
            environment.update(PAIOS_PUBLIC_API_URL="https://ai.example.invalid",
                               PAIOS_LIVEKIT_URL="wss://bj.xn--fsq092h.xn--0zwm56d:9443",
                               PAIOS_LIVEKIT_API_URL="http://127.0.0.1:7880")
            subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                           env=environment, check=True, capture_output=True)
            rollback = json.loads((build / "production.json").read_text())["product_resources"]
            self.assertEqual(rollback["public_api_url"], "https://ai.example.invalid")
            self.assertEqual(rollback["livekit_url"], "wss://bj.xn--fsq092h.xn--0zwm56d:9443")
            self.assertEqual(rollback["livekit_api_url"], "http://127.0.0.1:7880")
            self.assertIn("PAIOS_LIVEKIT_URL=wss://bj.xn--fsq092h.xn--0zwm56d:9443\n",
                          (build / "production.public.env").read_text())
            isolated = json.loads((build / "staging.json").read_text())["product_resources"]
            self.assertEqual(isolated["livekit_api_url"], "http://127.0.0.1:17880")
            stage_front = (build / "front-staging.conf").read_text()
            self.assertIn("server_name ai.example.invalid;", stage_front)
            self.assertNotIn("server_name ai.example.invalid:", stage_front)
            self.assertIn("Host ai.example.invalid:19443;", stage_front)
            self.assertIn("'ai.example.invalid:19443'", (build / "paios_roaming_guard-staging.js").read_text())

    def test_staging_has_independent_sni_and_no_edge_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.copy_renderer(root)
            env = dict(os.environ, PAIOS_PUBLIC_API_URL=CANONICAL,
                       PAIOS_STAGING_PUBLIC_HOST="staging.example.invalid", PAIOS_STAGING_TLS_PORT="19443",
                       PAIOS_LIVEKIT_URL="", PAIOS_LEGACY_PUBLIC_API_URLS="")
            subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                           env=env, check=True, capture_output=True)
            build = root / "deploy/cloud/.build"
            front = (build / "front-staging.conf").read_text()
            public = dict(line.split("=", 1) for line in (build / "production.public.env").read_text().splitlines())
            self.assertEqual(public["PAIOS_WORKSHOP_DENY_HOSTS"], "bj.xn--fsq092h.xn--0zwm56d,staging.example.invalid")
            self.assertIn("server_name staging.example.invalid;", front)
            self.assertIn("~^staging[.]example[.]invalid$ 1;", front)
            self.assertIn("Host staging.example.invalid:19443;", front)
            self.assertIn("'staging.example.invalid:19443'", (build / "paios_roaming_guard-staging.js").read_text())
            for path in build.iterdir():
                text = path.read_text()
                self.assertNotIn("ai.example.invalid", text)
                # The only frp path is the owner-Mac relay location served by this front's own loopback frps.
                self.assertEqual(text.count("/~!frp"), 2 * text.count("location = /~!frp {"))
            relay = front[front.index("location = /~!frp {"):]
            relay = relay[:relay.index("\n    }\n")]
            self.assertIn("proxy_pass http://127.0.0.1:7000;", relay)
            self.assertIn("proxy_pass_request_headers on;", relay)
            # Every upstream is the rendered gateway/LiveKit authority or the in-namespace relay, never a hard-coded port.
            targets = set(re.findall(r"proxy_pass http://([^;]+);", front))
            self.assertEqual(targets - {"127.0.0.1:7000"}, {"127.0.0.1:8787", "127.0.0.1:7880"})
            self.assertEqual(json.loads((build / "staging.json").read_text())["product_resources"]["public_api_url"],
                             "https://staging.example.invalid:19443")

    def test_workshop_blocks_both_origins_and_distinct_public_livekit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.copy_renderer(root)
            env = dict(os.environ, PAIOS_PUBLIC_HOST="stale.invalid", PAIOS_PUBLIC_API_URL=CANONICAL,
                       PAIOS_LEGACY_PUBLIC_API_URLS="https://ai.example.invalid",
                       PAIOS_LIVEKIT_URL="wss://media.example.invalid", PAIOS_LIVEKIT_API_URL="")
            subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                           env=env, check=True, capture_output=True)
            build = root / "deploy/cloud/.build"
            public = dict(line.split("=", 1) for line in (build / "production.public.env").read_text().splitlines())
            self.assertEqual(public["PAIOS_WORKSHOP_DENY_HOSTS"],
                             "bj.xn--fsq092h.xn--0zwm56d,ai.example.invalid,media.example.invalid")
            resources = json.loads((build / "production.json").read_text())["product_resources"]
            self.assertEqual(resources["legacy_public_api_urls"], public["PAIOS_LEGACY_PUBLIC_API_URLS"])
            commands = {"iptables": 'printf "%s\\n" "$*" >> "$RULES"', "cp": "exit 73", "python3": "echo 192.0.2.99",
                        "getent": '''[ "$2" = "${FAIL_HOST:-}" ] && exit 2
case "$2" in
  bj.*) printf '192.0.2.10 STREAM\\n192.0.2.11 DGRAM\\n192.0.2.10 RAW\\n' ;;
  ai.*) printf '198.51.100.20 STREAM\\n' ;;
  media.*) printf '203.0.113.30 STREAM\\n' ;;
  *) exit 2 ;;
esac'''}
            for name, body in commands.items():
                path = root / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o755)
            command = ["/bin/sh", str(ROOT / "deploy/cloud/workshop-start.sh")]
            rules = root / "rules"
            shell_env = {"PATH": str(root) + ":/usr/bin:/bin", "RULES": str(rules),
                         "PAIOS_WORKSHOP_DENY_HOSTS": public["PAIOS_WORKSHOP_DENY_HOSTS"]}
            self.assertEqual(subprocess.run(command, env=shell_env, capture_output=True).returncode, 73)
            for address in ("192.0.2.99", "192.0.2.10", "192.0.2.11", "198.51.100.20", "203.0.113.30"):
                self.assertEqual(rules.read_text().count(f"-A OUTPUT -d {address} -j REJECT\n"), 1)
            shell_env["FAIL_HOST"] = "ai.example.invalid"
            self.assertEqual(subprocess.run(command, env=shell_env, capture_output=True).returncode, 2)

    def test_invalid_origin_configuration_never_writes_runtime_or_workshop_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.copy_renderer(root)
            env = dict(os.environ, PAIOS_PUBLIC_API_URL=CANONICAL, PAIOS_LIVEKIT_URL="")
            for value in (CANONICAL, "https://ai.example/", "https://ai.example:443", " https://ai.example",
                          ",".join(f"https://old{i}.example" for i in range(9))):
                with self.subTest(legacy=value):
                    env["PAIOS_LEGACY_PUBLIC_API_URLS"] = value
                    result = subprocess.run([sys.executable, str(root / "deploy/cloud/prepare-build.py"), "--config-only"],
                                            env=env, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / "deploy/cloud/.build/production.json").exists())
                    self.assertFalse((root / "deploy/cloud/.build/production.public.env").exists())

    def test_certificate_deploy_failure_keeps_turn_reload_pending(self):
        # A renewed cert may already exist when nginx reload fails. The next lego
        # check can skip the deploy hook, so the pending action must survive it.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            certificates = root / "certificates"
            certificates.mkdir()
            tls = root / "tls"
            tls.mkdir()
            (certificates / "fixture.invalid.crt").write_text("synthetic certificate")
            (certificates / "fixture.invalid.key").write_text("synthetic key")
            for name, body in {
                "openssl": "printf 'fixture-public-key\\n'",
                "install": 'while [ "$#" -gt 2 ]; do shift; done; cp "$1" "$2"',
                "docker": "exit 73",
            }.items():
                tool = root / name
                tool.write_text("#!/bin/sh\n" + body + "\n")
                tool.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + ":" + os.environ["PATH"],
                       PAIOS_DIRECT_HOST="fixture.invalid", PAIOS_ACME_PATH=str(root),
                       PAIOS_TLS_DIR=str(tls), PAIOS_FRONT_CONTAINER="fixture-front",
                       PAIOS_LIVEKIT_CONTAINER="fixture-livekit")
            result = subprocess.run(["sh", str(ROOT / "deploy/cloud/acme/deploy.sh")], env=env, capture_output=True)
            self.assertEqual(result.returncode, 73)
            self.assertEqual((tls / "turn-reload-required").read_text(), "fixture-livekit\n")
            self.assertEqual((tls / "fullchain.pem").read_text(), "synthetic certificate")
            self.assertIn("turn-reload-required", (ROOT / "deploy/cloud/acme/paios-acme-renew.service").read_text())

    def test_turn_defaults_disabled_and_explicit_config_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            secrets = Path(temporary)
            for name in ("proxy-attestation", "livekit-api-key", "livekit-api-secret"):
                (secrets / name).write_text("synthetic-fixture-only")
            command = [sys.executable, str(ROOT / "deploy/cloud/prepare-secrets.py"),
                       "--secrets-dir", str(secrets), "--public-host", "bj.xn--fsq092h.xn--0zwm56d",
                       "--public-ipv4", "192.0.2.10", "--staging"]
            environment = dict(os.environ)
            environment.pop("PAIOS_STAGING_TURN_ENABLED", None)
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertEqual(json.loads((secrets / "livekit.yaml").read_text())["turn"], {"enabled": False})
            environment.update(PAIOS_STAGING_TURN_ENABLED="true", PAIOS_STAGING_TURN_TLS_PORT="15350")
            subprocess.run(command, env=environment, check=True, capture_output=True)
            config = json.loads((secrets / "livekit.yaml").read_text())
            self.assertTrue(config["turn"]["enabled"])
            self.assertEqual(config["turn"]["tls_port"], 15350)
            self.assertEqual(config["turn"]["domain"], "bj.xn--fsq092h.xn--0zwm56d")
            self.assertEqual(config["rtc"]["node_ip"], "192.0.2.10")


if __name__ == "__main__":
    unittest.main()
