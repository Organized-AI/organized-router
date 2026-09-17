"""Persistent Codex connector with Ramp's configure/refresh/unconfigure lifecycle.

Python 3.14+ uses stdlib TOML, SQLite and zstd. Codex owns OAuth storage and refresh.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
from urllib.parse import urlsplit

import ramp_sessions as sessions

ROOT = Path(__file__).resolve().parents[2]
PROVIDER = sessions.ROUTER_PROVIDER
STATE = "organized-router-state.json"
KEY = "organized-router-key"
CATALOG = "organized-router-models.json"
INSTRUCTIONS = "organized-router-instructions.md"
ORIGINAL_PROFILE = "organized-original.config.toml"
ORIGINAL_CATALOG = "organized-original-models.json"
ORIGINAL_INSTRUCTIONS = "organized-original-instructions.md"
OWNED_ROOT = ("model", "model_provider", "model_catalog_json", "model_instructions_file", "forced_login_method")
TABLE = re.compile(r"^\s*\[.*]\s*(?:#.*)?$")
OWNED_TABLE = re.compile(r'''^\s*\[\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:organized-router|"organized-router"|'organized-router')\s*(?:\.|])''')
ROOT_KEY = re.compile(r"^\s*(?:" + "|".join(OWNED_ROOT) + r")\s*=")


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_optional(path):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {path.name}")
    return path.read_text() if path.exists() else None


def write_private(path, text, *, expected=...):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace a symlink: {path.name}")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        if expected is not ... and read_optional(path) != expected:
            raise RuntimeError(f"{path.name} changed during setup; no replacement was made.")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def lock(home):
    home.mkdir(parents=True, exist_ok=True)
    path = home / ".organized-router-config.lock"
    if path.is_symlink():
        raise RuntimeError("The configuration lock must not be a symlink.")
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise RuntimeError("Another Organized Router configuration operation is running.") from None
    finally:
        os.close(fd)


def chunks(text):
    result = [[]]
    for line in text.splitlines(keepends=True):
        if TABLE.match(line):
            result.append([])
        result[-1].append(line)
    return result


def unrelated(data):
    result = copy.deepcopy(data)
    for key in OWNED_ROOT:
        result.pop(key, None)
    providers = result.get("model_providers", {})
    providers.pop(PROVIDER, None)
    if not providers:
        result.pop("model_providers", None)
    return result


def render_config(text, values, provider_text):
    before = tomllib.loads(text)
    parts = chunks(text)
    root = "".join(line for line in parts[0] if not ROOT_KEY.match(line)).rstrip()
    settings = "\n".join(f"{key} = {json.dumps(value)}" for key, value in values.items() if value is not None)
    parts[0] = [root + ("\n" if root else "") + settings + "\n"]
    preserved = "".join("".join(part) for part in parts if not part or not OWNED_TABLE.match(part[0])).rstrip()
    updated = preserved + ("\n\n" if preserved and provider_text else "") + provider_text
    updated = updated.rstrip() + "\n"
    after = tomllib.loads(updated)
    if unrelated(before) != unrelated(after):
        raise RuntimeError("Cannot edit this TOML layout without changing unrelated settings.")
    for key in OWNED_ROOT:
        if after.get(key) != values.get(key):
            raise RuntimeError(f"Could not safely update {key} in this TOML layout.")
    return updated


def provider_config(mode, home, base_url, key):
    text = f'''[model_providers.{PROVIDER}]
name = "Organized Router ({mode})"
base_url = {json.dumps(base_url)}
wire_api = "responses"
supports_websockets = false
'''
    if mode == "subscription":
        text += 'requires_openai_auth = true\n'
        text += 'http_headers = { "X-Gateway-Client" = "codex", "x-organized-gateway-key" = ' + json.dumps(key) + ' }\n'
    else:
        text += 'http_headers = { "X-Gateway-Client" = "codex", "X-Organized-Cache" = "off" }\n'
        text += f'''\n[model_providers.{PROVIDER}.auth]
command = "/bin/cat"
args = [{json.dumps(str(home / KEY))}]
timeout_ms = 5000
'''
    return text


def validate_catalog(catalog, model):
    rows = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("The gateway did not return a native Codex model catalog.")
    if any(not isinstance(row, dict) or not isinstance(row.get("slug"), str) for row in rows):
        raise RuntimeError("Invalid Codex model catalog.")
    if len({row["slug"] for row in rows}) != len(rows):
        raise RuntimeError("Duplicate model IDs in the Codex catalog.")
    selected = next((row for row in rows if row["slug"] == model), None)
    if selected is None:
        raise RuntimeError(f"The selected model {model!r} is not available through this connection.")
    limited = rows[:100]
    if selected not in limited:
        limited[-1] = selected
    return {**catalog, "models": limited}


def assert_no_open_writers(home, entries):
    paths = [str(home / entry["path"]) for entry in entries if entry.get("transcript_updated", True)]
    if not paths:
        return
    if not shutil.which("lsof"):
        raise RuntimeError("Install lsof before migrating existing conversations; active writers must be checked.")
    result = subprocess.run(["lsof", "-nP", "-Ffan", "--", *paths], capture_output=True, text=True, timeout=30)
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not check active conversation writers; no configuration was changed.")
    access = None
    for line in result.stdout.splitlines():
        if line.startswith("f"):
            access = None
        elif line.startswith("a"):
            access = line[1:]
        elif line.startswith("n") and access in ("w", "u"):
            raise RuntimeError("Codex is writing an existing conversation. Close Codex CLI and desktop, then rerun configure; no configuration was changed.")


def state_file(home):
    raw = read_optional(home / STATE)
    if raw is None:
        return None
    state = json.loads(raw)
    if state.get("version") != 1 or not isinstance(state.get("sessions"), list):
        raise RuntimeError("Unknown Organized Router configuration receipt; refusing to overwrite it.")
    return state


def safe_owned_files(home, state):
    for name, record in state.get("files", {}).items():
        if name not in {KEY, CATALOG, INSTRUCTIONS, ORIGINAL_PROFILE, ORIGINAL_CATALOG, ORIGINAL_INSTRUCTIONS}:
            raise RuntimeError("Invalid artifact in configuration receipt.")
        current = read_optional(home / name)
        if current is not None and digest(current) != record["digest"]:
            raise RuntimeError(f"{name} has user changes. Preserve or move it before changing this connection.")


def configure(home, mode, base_url, key, catalog, original_catalog, *, model=None, dry_run=False):
    config_path = home / "config.toml"
    current = read_optional(config_path) or ""
    data = tomllib.loads(current)
    state = state_file(home)
    selected = model or data.get("model")
    if not selected:
        raise RuntimeError("Choose a model explicitly with --model; setup does not change models implicitly.")
    catalog = validate_catalog(catalog, selected)
    if not key or "\n" in key:
        raise RuntimeError("A valid local gateway key is required.")
    discovered = sessions._prepare_codex_sessions(home)
    if state:
        if state.get("phase") != "connected":
            raise RuntimeError("An interrupted setup receipt exists. Run unconfigure to recover before configuring again.")
        safe_owned_files(home, state)
        expected = state["provider_digest"]
        if digest(json.dumps(data.get("model_providers", {}).get(PROVIDER), sort_keys=True)) != expected:
            raise RuntimeError("The managed provider has user changes; refusing to overwrite them.")
        state = copy.deepcopy(state)
        state["sessions"] = sessions._merge_codex_receipt_sessions(state["sessions"], discovered)
    else:
        state = {"version": 1, "root": {key: data[key] for key in OWNED_ROOT if key in data},
                 "provider": "".join("".join(part) for part in chunks(current) if part and OWNED_TABLE.match(part[0])),
                 "original_config": current, "sessions": discovered, "files": {},
                 "preexisting_router_sessions": sessions._preexisting_codex_router_session_ids(home)}
    artifacts = {KEY: key, CATALOG: json.dumps(catalog, indent=2) + "\n"}
    values = {"model": selected, "model_provider": PROVIDER, "model_catalog_json": str(home / CATALOG)}
    original_instructions = state["root"].get("model_instructions_file")
    if original_instructions:
        values["model_instructions_file"] = original_instructions
    elif mode == "api":
        selected_row = next(row for row in catalog["models"] if row["slug"] == selected)
        prompt = selected_row.get("base_instructions")
        if not prompt:
            source_model = selected_row.get("organized_upstream_model", selected)
            prompt = next((row.get("base_instructions") for row in original_catalog["models"] if row["slug"] == source_model), None)
        if not prompt:
            raise RuntimeError("The API model has no verified native Codex harness; prepare its catalog first.")
        artifacts[INSTRUCTIONS] = prompt
        values["model_instructions_file"] = str(home / INSTRUCTIONS)
    if mode == "subscription":
        values["forced_login_method"] = "chatgpt"
    provider = provider_config(mode, home, base_url, key)
    updated = render_config(current, values, provider)
    original_values = dict(state["root"])
    original_values["model_provider"] = original_values.get("model_provider", "openai")
    if not original_values.get("model_catalog_json"):
        artifacts[ORIGINAL_CATALOG] = json.dumps(original_catalog, indent=2) + "\n"
        original_values["model_catalog_json"] = str(home / ORIGINAL_CATALOG)
    # An empty instruction path is invalid in Codex. If the managed API mode
    # sets one, isolate the original profile with its original model's harness.
    original_prompt = next((row.get("base_instructions") for row in original_catalog.get("models", []) if row["slug"] == original_values.get("model")), None)
    if mode == "api" and not original_values.get("model_instructions_file"):
        if not original_prompt:
            raise RuntimeError("Cannot create a working original profile without its native harness.")
        artifacts[ORIGINAL_INSTRUCTIONS] = original_prompt
        original_values["model_instructions_file"] = str(home / ORIGINAL_INSTRUCTIONS)
    artifacts[ORIGINAL_PROFILE] = "".join(f"{key} = {json.dumps(value)}\n" for key, value in original_values.items())
    for name, body in artifacts.items():
        previous = read_optional(home / name)
        if name not in state["files"] and previous is not None:
            raise RuntimeError(f"{name} already exists without an ownership receipt.")
        state["files"].setdefault(name, {"before": previous})
        state["files"][name]["digest"] = digest(body)
    state.update(mode=mode, base_url=base_url, model=selected, phase="installing",
                 provider_digest=digest(json.dumps(tomllib.loads(updated)["model_providers"][PROVIDER], sort_keys=True)),
                 config_digest=digest(updated))
    preview = {"mode": mode, "model": selected, "provider": PROVIDER, "baseUrl": base_url,
               "modelCount": len(catalog["models"]), "conversationsToMigrate": len(discovered),
               "files": ["config.toml", STATE, *artifacts], "dryRun": dry_run}
    if dry_run:
        return preview
    assert_no_open_writers(home, [{"path": str(path.relative_to(home))} for path in sessions._codex_transcripts(home)])
    backups = {name: read_optional(home / name) for name in [STATE, "config.toml", *artifacts]}
    written = {}
    sessions_started = False
    try:
        receipt = json.dumps(state, indent=2) + "\n"
        write_private(home / STATE, receipt, expected=backups[STATE])
        written[STATE] = receipt
        for name, body in artifacts.items():
            write_private(home / name, body, expected=backups[name])
            written[name] = body
        write_private(config_path, updated, expected=current or backups["config.toml"])
        written["config.toml"] = updated
        sessions_started = True
        sessions._sync_codex_sessions(home, state["sessions"])
        sessions._update_codex_session_index(home, state["sessions"], restore=False)
        state["phase"] = "connected"
        write_private(home / STATE, json.dumps(state, indent=2) + "\n", expected=receipt)
    except Exception:
        failures = []
        if sessions_started:
            try:
                # Only newly migrated sessions belong to this failed invocation.
                sessions._restore_codex_sessions(home, discovered)
            except Exception:
                failures.append("history")
        # Compare before rollback, too: a concurrent user's edit is never ours
        # to overwrite. Keep the receipt if any part needs manual recovery.
        for name in reversed(written):
            if name == STATE:
                continue
            try:
                if read_optional(home / name) != written[name]:
                    failures.append(name)
                    continue
                body = backups[name]
                if body is None:
                    (home / name).unlink(missing_ok=True)
                else:
                    write_private(home / name, body, expected=written[name])
            except Exception:
                failures.append(name)
        if failures:
            raise RuntimeError("Setup failed and rollback could not finish safely. The recovery receipt was retained; preserve user edits before running unconfigure.") from None
        if STATE in written:
            if read_optional(home / STATE) != written[STATE]:
                raise RuntimeError("The recovery receipt changed during setup; it was preserved.") from None
            if backups[STATE] is None:
                (home / STATE).unlink(missing_ok=True)
            else:
                write_private(home / STATE, backups[STATE], expected=written[STATE])
        raise
    return preview


def unconfigure(home):
    state = state_file(home)
    if not state:
        return {"connected": False, "changed": False}
    current = read_optional(home / "config.toml") or ""
    safe_owned_files(home, state)
    provider = tomllib.loads(current).get("model_providers", {}).get(PROVIDER)
    original_provider = tomllib.loads(state["original_config"]).get("model_providers", {}).get(PROVIDER)
    if digest(json.dumps(provider, sort_keys=True)) != state["provider_digest"] and provider != original_provider:
        raise RuntimeError("The managed provider has user changes; refusing to overwrite them.")
    all_transcripts = [{"path": str(path.relative_to(home))} for path in sessions._codex_transcripts(home)]
    assert_no_open_writers(home, all_transcripts)
    if digest(current) == state["config_digest"]:
        updated = state["original_config"]
    else:
        updated = render_config(current, state["root"], state["provider"])
    sessions._restore_codex_sessions(home, state["sessions"])
    try:
        write_private(home / "config.toml", updated, expected=current)
    except Exception:
        sessions._rollback_codex_sessions(home, state["sessions"])
        raise
    sessions._reclaim_codex_router_sessions(home, state["sessions"], sessions._codex_restored_provider(state["root"]),
                                          preexisting_router_sessions=state["preexisting_router_sessions"])
    for name, record in state["files"].items():
        if record["before"] is None:
            (home / name).unlink(missing_ok=True)
        else:
            write_private(home / name, record["before"])
    (home / STATE).unlink()
    return {"connected": False, "restored": True}


def run_codex_catalog(arguments, *, environment=None, bundled=False):
    result = subprocess.run(["codex", *arguments, "debug", "models", *(["--bundled"] if bundled else [])], env=environment,
                            capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError("Codex could not read the model catalog. Check login and the local router.")
    return json.loads(result.stdout)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def fetch_catalog(base_url, key):
    parsed = urlsplit(base_url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise RuntimeError("Invalid gateway base URL.")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise RuntimeError("The API gateway must use HTTPS or loopback HTTP.")
    request = urllib.request.Request(base_url.rstrip("/") + "/models", headers={"Authorization": "Bearer " + key, "X-Gateway-Client": "codex"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        return json.load(response)


def read_vars(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#") and "=" in line)


def discover(mode, api_base_url, api_key_file, home):
    original = run_codex_catalog([], bundled=True)
    if mode == "subscription":
        key = (ROOT / ".local/subscription.key").read_text().strip()
        base = "http://127.0.0.1:8788/v1"
        # Pinned catalogs make `codex debug models` static. Read only Codex's
        # documented file credential for this authenticated discovery request;
        # never copy it, write it, log it, or implement our own OAuth refresh.
        auth_path = home / "auth.json"
        if not auth_path.is_file():
            raise RuntimeError("Subscription discovery requires Codex's file-backed ChatGPT login. This connector does not extract credentials from the OS keyring.")
        tokens = json.loads(auth_path.read_text()).get("tokens") or {}
        bearer = tokens.get("access_token")
        account = tokens.get("account_id")
        if not isinstance(bearer, str) or not isinstance(account, str) or not bearer or not account:
            raise RuntimeError("Sign in with ChatGPT using codex login before subscription setup.")
        version = subprocess.run(["codex", "--version"], capture_output=True, text=True, check=True).stdout.strip().split()[-1]
        request = urllib.request.Request(base + "/models?client_version=" + version,
            headers={"Authorization": "Bearer " + bearer, "ChatGPT-Account-Id": account,
                     "x-organized-gateway-key": key, "X-Gateway-Client": "codex"})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=20) as response:
                catalog = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError("Codex's saved ChatGPT credential needs refresh. Run a normal Codex session or codex login, then retry setup.") from None
            raise RuntimeError(f"Subscription model discovery failed (HTTP {error.code}).") from None
    else:
        base = api_base_url or "http://127.0.0.1:8787/v1"
        key = api_key_file.read_text().strip() if api_key_file else read_vars(ROOT / ".dev.vars")["GATE_API_KEY"]
        catalog = fetch_catalog(base, key)
    return base, key, catalog, original


def main():
    parser = argparse.ArgumentParser(description="Connect Codex CLI and desktop to Organized Router")
    parser.add_argument("action", choices=("configure", "refresh", "unconfigure", "status"))
    parser.add_argument("client", nargs="?", choices=("codex",), default="codex")
    parser.add_argument("--mode", choices=("subscription", "api"))
    parser.add_argument("--model")
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    parser.add_argument("--api-base-url")
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    home = args.codex_home.expanduser().resolve()
    try:
        state = state_file(home)
        if args.action == "status":
            current = tomllib.loads(read_optional(home / "config.toml") or "")
            registered = current.get("model_providers", {}).get(PROVIDER)
            intact = bool(state) and digest(json.dumps(registered, sort_keys=True)) == state["provider_digest"]
            result = {"connected": bool(state) and state.get("phase") == "connected" and intact and current.get("model_provider") == PROVIDER,
                      "receiptExists": bool(state), "providerIntact": intact, "phase": state.get("phase") if state else None,
                      "mode": state.get("mode") if state else None, "provider": current.get("model_provider", "openai"),
                      "model": current.get("model"), "config": str(home / "config.toml")}
        elif args.action == "unconfigure":
            with lock(home):
                result = unconfigure(home)
        else:
            if args.action == "refresh" and not state:
                raise RuntimeError("Configure Codex before refreshing.")
            mode = args.mode or (state["mode"] if state else "subscription")
            same_connection = state and mode == state["mode"] and (not args.api_base_url or args.api_base_url == state.get("base_url"))
            key_file = args.api_key_file or (home / KEY if same_connection and mode == "api" else None)
            base, key, catalog, original = discover(mode, args.api_base_url or (state.get("base_url") if same_connection else None), key_file, home)
            if args.dry_run:
                result = configure(home, mode, base, key, catalog, original, model=args.model, dry_run=True)
            else:
                with lock(home):
                    result = configure(home, mode, base, key, catalog, original, model=args.model)
        print(json.dumps(result, indent=2))
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        # Avoid printing provider bodies, credential-bearing commands or config.
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        else:
            print(f"Connection operation failed ({type(error).__name__}). No credentials were printed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
