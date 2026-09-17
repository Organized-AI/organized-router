import copy
from contextlib import closing
from compression import zstd
import json
import io
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import tomllib
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/connection"))
import configure as connector
import catalog as projection
import ramp_sessions as migration
import service
import telemetry as grafana


NATIVE = {"models": [{"slug": "native-model", "base_instructions": "Native harness: preserve tool semantics.",
    "context_window": 272000, "input_modalities": ["text", "image"], "supported_in_api": True}]}
KEY = "fixture-local-secret-" + "x" * 32


class GrafanaSetupTests(unittest.TestCase):
    endpoint = "https://otlp-gateway-test.grafana.net/otlp"
    token = "glc_fixture_not_a_real_credential"

    def test_credentials_are_only_sent_to_the_selected_grafana_otlp_host(self):
        for endpoint in ("http://otlp-gateway-test.grafana.net/otlp", "https://grafana.net.evil.test/otlp",
                         "https://otlp-gateway-test.grafana.net/otlp?next=elsewhere",
                         "https://user@otlp-gateway-test.grafana.net/otlp", "https://otlp-gateway-test.grafana.net/login"):
            with self.assertRaises(RuntimeError):
                grafana.grafana_settings(endpoint, "123", self.token)

    def test_success_saves_private_settings_after_both_checks_and_preserves_sampling(self):
        from types import SimpleNamespace
        requests = []
        def open_request(request, **kwargs):
            requests.append(request)
            response = io.BytesIO(b'{}')
            response.status = 204 if request.full_url.endswith('/logs') else 200
            return response
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "telemetry.json"
            path.write_text('{"OTEL_TRACES_SAMPLER_ARG":"0.5"}')
            result = grafana.configure_grafana(path, self.endpoint, "123", self.token, opener=SimpleNamespace(open=open_request))
            self.assertEqual([r.full_url for r in requests], [self.endpoint + "/v1/logs", self.endpoint + "/v1/traces"])
            self.assertEqual([json.loads(r.data) for r in requests], [{"resourceLogs": []}, {"resourceSpans": []}])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["OTEL_TRACES_SAMPLER_ARG"], "0.5")
            self.assertFalse(result["hostedIngestionVerified"])
            self.assertNotIn(self.token, json.dumps(result))
            self.assertNotIn("Authorization", json.dumps(result))

    def test_rejected_trace_check_keeps_previous_settings_and_hides_response_details(self):
        from types import SimpleNamespace
        def open_request(request, **kwargs):
            if request.full_url.endswith("/traces"):
                raise urllib.error.HTTPError(request.full_url, 403, self.token, {}, io.BytesIO(self.token.encode()))
            response = io.BytesIO(b'{}')
            response.status = 200
            return response
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "telemetry.json"
            original = '{"OTEL_TRACES_SAMPLER_ARG":"0.5"}'
            path.write_text(original)
            with self.assertRaisesRegex(RuntimeError, "traces check returned HTTP 403") as error:
                grafana.configure_grafana(path, self.endpoint, "123", self.token, opener=SimpleNamespace(open=open_request))
            self.assertNotIn(self.token, str(error.exception))
            self.assertEqual(path.read_text(), original)

    def test_partial_rejections_fail_and_redirect_handler_never_forwards_auth(self):
        from types import SimpleNamespace
        response = io.BytesIO(b'{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"private details"}}')
        response.status = 200
        with self.assertRaisesRegex(RuntimeError, "logs check failed"):
            grafana.verify_access(self.endpoint, "Basic fixture", opener=SimpleNamespace(open=lambda *a, **kw: response))
        request = urllib.request.Request(self.endpoint, headers={"Authorization": "Basic fixture"})
        self.assertIsNone(grafana.NoRedirect().redirect_request(request, None, 302, "redirect", {}, "https://elsewhere.test"))


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / "config.toml"
        self.original = '# User comment\nmodel = "native-model"\n[projects."/my/project"]\ntrust_level = "trusted"\n'
        self.config.write_text(self.original)

    def setup_connection(self, mode="subscription", **options):
        with connector.lock(self.home):
            return connector.configure(self.home, mode, "http://127.0.0.1:8788/v1", KEY,
                                       copy.deepcopy(NATIVE), copy.deepcopy(NATIVE), **options)

    def make_session(self, identifier, *, archived=False, compressed=False, provider="openai"):
        directory = self.home / ("archived_sessions" if archived else "sessions")
        directory.mkdir(exist_ok=True)
        path = directory / (identifier + ".jsonl" + (".zst" if compressed else ""))
        text = json.dumps({"type": "session_meta", "payload": {"id": identifier, "model_provider": provider}}) + '\n'
        body = '{ "type": "event", "payload": {"text": "Exact private prompt bytes 🌱"}}\n'
        with (zstd.open if compressed else open)(path, "wt") as output:
            output.write(text + body)
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?, ?, ?)", (identifier, provider, str(path)))
        return path, body

    def read_session(self, path):
        with (zstd.open if path.suffix == ".zst" else open)(path, "rt") as source:
            text = source.read()
        first, rest = text.split('\n', 1)
        return json.loads(first)["payload"], rest

    def test_subscription_setup_is_persistent_private_idempotent_and_restorable(self):
        result = self.setup_connection()
        first = self.config.read_text()
        data = tomllib.loads(first)
        provider = data["model_providers"][connector.PROVIDER]
        self.assertEqual(data["model_provider"], "organized-router")
        self.assertEqual(data["model"], "native-model")
        self.assertTrue(provider["requires_openai_auth"])
        self.assertNotIn("auth", provider)
        self.assertEqual(provider["http_headers"]["X-Gateway-Client"], "codex")
        self.assertNotIn(KEY, json.dumps(result))
        for name in result["files"]:
            self.assertEqual((self.home / name).stat().st_mode & 0o777, 0o600)
        self.setup_connection()
        self.assertEqual(self.config.read_text(), first)
        connector.unconfigure(self.home)
        self.assertEqual(self.config.read_text(), self.original)
        self.assertFalse((self.home / connector.STATE).exists())

    def test_api_auth_matches_ramp_command_pattern_and_preserves_native_harness(self):
        self.setup_connection("api")
        data = tomllib.loads(self.config.read_text())
        provider = data["model_providers"][connector.PROVIDER]
        self.assertNotIn("requires_openai_auth", provider)
        self.assertNotIn("experimental_bearer_token", provider)
        self.assertEqual(provider["auth"], {"command": "/bin/cat", "args": [str(self.home / connector.KEY)], "timeout_ms": 5000})
        self.assertNotIn(KEY, self.config.read_text())
        self.assertEqual(Path(data["model_instructions_file"]).read_text(), NATIVE["models"][0]["base_instructions"])
        escape = tomllib.loads((self.home / connector.ORIGINAL_PROFILE).read_text())
        self.assertEqual(escape["model_provider"], "openai")
        self.assertEqual(Path(escape["model_instructions_file"]).read_text(), NATIVE["models"][0]["base_instructions"])
        connector.unconfigure(self.home)
        self.assertEqual(self.config.read_text(), self.original)

    def test_switch_modes_replaces_auth_completely_and_keeps_original_rollback(self):
        self.setup_connection()
        self.setup_connection("api")
        provider = tomllib.loads(self.config.read_text())["model_providers"][connector.PROVIDER]
        self.assertNotIn("requires_openai_auth", provider)
        self.setup_connection("subscription")
        provider = tomllib.loads(self.config.read_text())["model_providers"][connector.PROVIDER]
        self.assertNotIn("auth", provider)
        connector.unconfigure(self.home)
        self.assertEqual(self.config.read_text(), self.original)

    def test_migrates_live_archived_compressed_and_new_history_without_changing_bodies(self):
        files = [self.make_session("live"), self.make_session("archived", archived=True, compressed=True)]
        self.setup_connection()
        for path, body in files:
            meta, actual = self.read_session(path)
            self.assertEqual(meta["model_provider"], "organized-router")
            self.assertEqual(actual, body)
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT DISTINCT model_provider FROM threads").fetchall(), [("organized-router",)])
        new_path, new_body = self.make_session("created-while-connected", provider="organized-router")
        connector.unconfigure(self.home)
        for path, body in [*files, (new_path, new_body)]:
            meta, actual = self.read_session(path)
            self.assertEqual(meta["model_provider"], "openai")
            self.assertEqual(actual, body)

    def test_restores_moved_transcripts_and_preserves_later_provider_choices(self):
        path, body = self.make_session("moved")
        self.setup_connection()
        archive = self.home / "archived_sessions"
        archive.mkdir()
        moved = archive / path.name
        path.rename(moved)
        connector.unconfigure(self.home)
        self.assertEqual(self.read_session(moved), ({"id": "moved", "model_provider": "openai"}, body))
        self.setup_connection()
        text = moved.read_text().replace('"model_provider":"organized-router"', '"model_provider":"other"')
        moved.write_text(text)
        connector.unconfigure(self.home)
        self.assertEqual(self.read_session(moved)[0]["model_provider"], "other")

    def test_preserves_unrelated_changes_made_after_setup(self):
        self.setup_connection()
        self.config.write_text(self.config.read_text() + '\n[user_preferences]\ntheme = "dark"\n')
        connector.unconfigure(self.home)
        self.assertEqual(tomllib.loads(self.config.read_text())["user_preferences"], {"theme": "dark"})
        self.assertIn("# User comment", self.config.read_text())

    def test_fails_before_changes_for_invalid_catalog_or_unowned_artifacts(self):
        with self.assertRaises(RuntimeError):
            self.setup_connection(model="missing")
        self.assertEqual(self.config.read_text(), self.original)
        (self.home / connector.KEY).write_text("user-owned")
        with self.assertRaises(RuntimeError):
            self.setup_connection()
        self.assertEqual((self.home / connector.KEY).read_text(), "user-owned")
        self.assertEqual(self.config.read_text(), self.original)

    def test_disk_failure_restores_config_key_catalog_and_session_metadata(self):
        path, body = self.make_session("rollback")
        writer = connector.write_private
        def fail_config(path, *args, **kwargs):
            if path.name == "config.toml" and 'model_provider = "organized-router"' in args[0]:
                raise OSError("fixture disk failure")
            return writer(path, *args, **kwargs)
        with patch.object(connector, "write_private", side_effect=fail_config):
            with self.assertRaises(OSError):
                self.setup_connection()
        self.assertEqual(self.config.read_text(), self.original)
        self.assertEqual(self.read_session(path), ({"id": "rollback", "model_provider": "openai"}, body))
        self.assertFalse((self.home / connector.KEY).exists())
        self.assertFalse((self.home / connector.STATE).exists())

    def test_refuses_to_rewrite_an_open_transcript(self):
        path, _ = self.make_session("active")
        with path.open("a") as output:
            output.write('')
            with self.assertRaisesRegex(RuntimeError, "writing an existing conversation"):
                self.setup_connection()
        self.assertEqual(self.config.read_text(), self.original)

    def test_edited_managed_files_are_preserved(self):
        self.setup_connection()
        catalog = self.home / connector.CATALOG
        catalog.write_text('{"user":"edit"}')
        with self.assertRaisesRegex(RuntimeError, "user changes"):
            connector.unconfigure(self.home)
        self.assertEqual(catalog.read_text(), '{"user":"edit"}')

    def test_dry_run_does_not_write_files_or_migrate_history(self):
        path, body = self.make_session("preview")
        before = set(self.home.iterdir())
        result = connector.configure(self.home, "subscription", "http://127.0.0.1:8788/v1", KEY, NATIVE, NATIVE, dry_run=True)
        self.assertTrue(result["dryRun"])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual(set(self.home.iterdir()), before)
        self.assertEqual(self.read_session(path), ({"id": "preview", "model_provider": "openai"}, body))

    def test_api_catalog_projection_is_native_and_routes_are_explicit(self):
        routes = {"routes": {"alias": [{"model": "native-model", "endpoints": ["/v1/responses"]}]}}
        result = projection.project_catalog(routes, NATIVE)
        self.assertEqual(result["models"][0]["slug"], "alias")
        self.assertEqual(result["models"][0]["context_window"], 272000)
        self.assertEqual(result["models"][0]["base_instructions"], "")
        routes["routes"]["alias"][0]["model"] = "unknown-model"
        with self.assertRaises(RuntimeError):
            projection.project_catalog(routes, NATIVE)

    def test_concurrent_config_edit_is_not_overwritten_by_failure_rollback(self):
        writer = connector.write_private
        edited = self.original + '\n# Concurrent edit\n'
        def edit_before_write(path, *args, **kwargs):
            if path.name == "config.toml":
                path.write_text(edited)
            return writer(path, *args, **kwargs)
        with patch.object(connector, "write_private", side_effect=edit_before_write):
            with self.assertRaisesRegex(RuntimeError, "changed during setup"):
                self.setup_connection()
        self.assertEqual(self.config.read_text(), edited)
        self.assertFalse((self.home / connector.STATE).exists())

    def test_unconfigure_preserves_modified_provider(self):
        self.setup_connection()
        changed = self.config.read_text().replace('supports_websockets = false', 'supports_websockets = true')
        self.config.write_text(changed)
        with self.assertRaisesRegex(RuntimeError, "provider has user changes"):
            connector.unconfigure(self.home)
        self.assertEqual(self.config.read_text(), changed)

    def test_refresh_refuses_active_already_migrated_history(self):
        path, _ = self.make_session("active-router")
        self.setup_connection()
        before = self.config.read_text()
        with path.open("a"):
            with self.assertRaisesRegex(RuntimeError, "writing an existing conversation"):
                self.setup_connection()
        self.assertEqual(self.config.read_text(), before)

    def test_interrupted_setup_requires_recovery_and_can_be_restored(self):
        self.setup_connection()
        state = connector.state_file(self.home)
        state["phase"] = "installing"
        (self.home / connector.STATE).write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, "interrupted setup"):
            self.setup_connection()
        connector.unconfigure(self.home)
        self.assertEqual(self.config.read_text(), self.original)

    def test_service_definition_is_private_and_has_no_authentication_payload(self):
        data = service.definition(self.home, Path("/usr/local/bin/node"))
        self.assertEqual(data["ProgramArguments"], ["/usr/local/bin/node", str(self.home / "scripts/subscription-server.mjs")])
        self.assertEqual(data["Umask"], 0o077)
        self.assertNotIn("EnvironmentVariables", data)
        self.assertTrue(data["KeepAlive"])

    def test_service_does_not_take_over_other_installation_or_modified_job(self):
        import plistlib
        path = self.home / "service.plist"
        data = service.definition(self.home, Path("/usr/local/bin/node"))
        path.write_bytes(plistlib.dumps(data))
        self.assertIsNotNone(service.owned_definition(path, self.home))
        data["ProgramArguments"][1] = "/elsewhere/server.mjs"
        path.write_bytes(plistlib.dumps(data))
        with self.assertRaisesRegex(RuntimeError, "another installation"):
            service.owned_definition(path, self.home)
        data = service.definition(self.home, Path("/usr/local/bin/node"))
        data["KeepAlive"] = False
        path.write_bytes(plistlib.dumps(data))
        with self.assertRaisesRegex(RuntimeError, "user changes"):
            service.owned_definition(path, self.home)


if __name__ == "__main__":
    unittest.main()
