"""Opt-in Jev shadow configuration. Never accept API keys in command arguments."""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
import warnings

from configure import ROOT, NoRedirect, read_optional, write_private


def verify_key(key, *, opener=None):
    if not isinstance(key, str) or not re.fullmatch(r"[\x21-\x7e]{10,8192}", key):
        raise RuntimeError("A TypeSafe API key is required; no settings were changed.")
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request("https://api.typesafe.ai/v1/models", headers={"Authorization": "Bearer " + key})
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError("TypeSafe did not accept the key; no settings were changed.")
            body = response.read(65537)
            if len(body) > 65536 or not isinstance(json.loads(body), (dict, list)):
                raise ValueError("Invalid model catalog")
    except urllib.error.HTTPError as error:
        error.close()
        raise RuntimeError(f"TypeSafe access check returned HTTP {error.code}; no settings were changed.") from None
    except (OSError, ValueError):
        raise RuntimeError("TypeSafe access check failed; no settings were changed.") from None


def configure(path, key, models, *, opener=None):
    previous = read_optional(path)
    saved = json.loads(previous) if previous is not None else {}
    if not isinstance(saved, dict):
        raise RuntimeError("Existing Jev settings must be a JSON object.")
    if set(models) != {"routine", "standard", "complex"} or any(
            not re.fullmatch(r"[a-zA-Z0-9._/-]{1,128}", name) for name in models.values()):
        raise RuntimeError("Configure a model for each Jev task class.")
    verify_key(key, opener=opener)
    saved.update({"mode": "shadow", "model": "jev-1.13.0", "apiKey": key, "models": models})
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_private(path, json.dumps(saved, indent=2) + "\n", expected=previous)
    return {"saved": True, "mode": "shadow", "model": saved["model"], "models": models,
            "inputPolicy": "latest_user_excerpt", "accessVerified": True, "liveDecisionVerified": False}


def main():
    parser = argparse.ArgumentParser(description="Enable Jev shadow recommendations using a private TypeSafe key")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--key-file", type=Path, help="Read the API key from a private file")
    source.add_argument("--key-stdin", action="store_true", help="Read a key through private stdin")
    source.add_argument("--off", action="store_true", help="Disable Jev without deleting saved configuration")
    parser.add_argument("--routine-model", default="gpt-5.6-luna")
    parser.add_argument("--standard-model", default="gpt-5.6-terra")
    parser.add_argument("--complex-model", default="gpt-6-astra")
    parser.add_argument("--restart", action="store_true", help="Restart the installed service only if idle")
    args = parser.parse_args()
    path = ROOT / ".local/jev.json"
    try:
        if args.off:
            previous = read_optional(path)
            saved = json.loads(previous) if previous is not None else {}
            saved["mode"] = "off"
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            write_private(path, json.dumps(saved, indent=2) + "\n", expected=previous)
            result = {"saved": True, "mode": "off"}
        else:
            if args.key_file:
                with args.key_file.expanduser().open() as source_file:
                    key = source_file.read(8194).strip()
            elif args.key_stdin:
                key = sys.stdin.read(8194).strip()
            elif os.environ.get("TYPESAFE_API_KEY"):
                key = os.environ["TYPESAFE_API_KEY"].strip()
            elif sys.stdin.isatty():
                with warnings.catch_warnings():
                    warnings.simplefilter("error", getpass.GetPassWarning)
                    key = getpass.getpass("TypeSafe API key (hidden): ").strip()
            else:
                raise RuntimeError("Use --key-file with a private key file, or run in a terminal for a hidden prompt.")
            models = {"routine": args.routine_model, "standard": args.standard_model, "complex": args.complex_model}
            catalog = ROOT / ".local/subscription-models.json"
            if catalog.is_file():
                known = {item.get("slug") for item in json.loads(catalog.read_text()).get("models", [])}
                if any(name not in known for name in models.values()):
                    raise RuntimeError("A proposed model is absent from this installation's Codex catalog.")
            result = configure(path, key, models)
        print(json.dumps(result, indent=2))
        if args.restart:
            return subprocess.run([sys.executable, str(ROOT / "scripts/connection/service.py"), "restart"], check=False).returncode
        print("Apply to the running service with: npm run router -- service restart")
    except (OSError, ValueError, TypeError, RuntimeError, EOFError, KeyboardInterrupt, getpass.GetPassWarning) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Jev setup did not finish; no credentials were printed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
