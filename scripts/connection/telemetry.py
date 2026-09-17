"""Private Grafana OTLP setup. Credentials never enter command-line arguments."""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
import warnings
from urllib.parse import quote, urlsplit

from configure import ROOT, NoRedirect, read_optional, write_private


def grafana_settings(endpoint, instance, token):
    url = urlsplit(endpoint)
    if (url.scheme != "https" or not re.fullmatch(r"otlp-gateway-[a-z0-9-]+\.grafana\.net", url.hostname or "")
            or url.port not in (None, 443) or url.path.rstrip("/") != "/otlp"
            or url.username or url.password or url.query or url.fragment):
        raise RuntimeError("Use the HTTPS OTLP endpoint from your Grafana Cloud OpenTelemetry card.")
    if not re.fullmatch(r"[0-9]{1,20}", instance):
        raise RuntimeError("Use the numeric instance ID from the OpenTelemetry card.")
    if not token.startswith("glc_") or not 20 <= len(token) <= 8192 or not token.isascii() or any(c.isspace() for c in token):
        raise RuntimeError("A Grafana Cloud access-policy token is required.")
    auth = "Basic " + base64.b64encode((instance + ":" + token).encode()).decode()
    return {"OTEL_EXPORTER_OTLP_ENDPOINT": endpoint.rstrip("/"),
            "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=" + quote(auth, safe=""),
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json"}, auth


def verify_access(endpoint, auth, *, opener=None):
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for signal, key in (("logs", "resourceLogs"), ("traces", "resourceSpans")):
        request = urllib.request.Request(endpoint + "/v1/" + signal,
            data=json.dumps({key: []}).encode(), method="POST",
            headers={"Authorization": auth, "Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=10) as response:
                if response.status != 200:
                    raise RuntimeError(f"Grafana {signal} check returned HTTP {response.status}; settings were not saved.")
                body = response.read(65537)
            if len(body) > 65536:
                raise ValueError("oversized response")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError("invalid response")
            partial = result.get("partialSuccess", {})
            if not isinstance(partial, dict) or partial.get("errorMessage") or any(
                    int(partial.get(field, 0)) != 0 for field in ("rejectedSpans", "rejectedLogRecords")):
                raise ValueError("rejected records")
        except urllib.error.HTTPError as error:
            error.close()
            raise RuntimeError(f"Grafana {signal} check returned HTTP {error.code}; settings were not saved.") from None
        except (OSError, ValueError, TypeError):
            raise RuntimeError(f"Grafana {signal} check failed; settings were not saved.") from None


def configure_grafana(path, endpoint, instance, token, *, opener=None):
    previous = read_optional(path)
    saved = json.loads(previous) if previous is not None else {}
    if not isinstance(saved, dict):
        raise RuntimeError("Existing telemetry settings must be a JSON object.")
    settings, auth = grafana_settings(endpoint, instance, token)
    verify_access(settings["OTEL_EXPORTER_OTLP_ENDPOINT"], auth, opener=opener)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_private(path, json.dumps({**saved, **settings}, indent=2) + "\n", expected=previous)
    return {"configured": True, "destination": settings["OTEL_EXPORTER_OTLP_ENDPOINT"],
            "accessChecks": ["logs", "traces"], "hostedIngestionVerified": False}


def main():
    parser = argparse.ArgumentParser(description="Configure Grafana OTLP export with a hidden token prompt")
    parser.add_argument("--endpoint", help="HTTPS endpoint from Grafana's OpenTelemetry card")
    parser.add_argument("--instance", help="Instance ID from the same card, not necessarily your stack ID")
    parser.add_argument("--token-stdin", action="store_true", help="Read the token from private stdin instead of a terminal prompt")
    parser.add_argument("--restart", action="store_true", help="Restart the installed subscription service if idle")
    args = parser.parse_args()
    try:
        if args.token_stdin and (not args.endpoint or not args.instance):
            raise RuntimeError("With --token-stdin, supply --endpoint and --instance too.")
        if not args.token_stdin and not sys.stdin.isatty():
            raise RuntimeError("Run in a terminal for a hidden token prompt, or use --token-stdin with private input.")
        endpoint = args.endpoint or input("Grafana OTLP endpoint: ").strip()
        instance = args.instance or input("OpenTelemetry instance ID: ").strip()
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                token = sys.stdin.read(8194).strip() if args.token_stdin else getpass.getpass("Grafana access-policy token (hidden): ").strip()
            except getpass.GetPassWarning:
                raise RuntimeError("A hidden terminal prompt is unavailable; no token was read.") from None
        result = configure_grafana(ROOT / ".local/telemetry.json", endpoint, instance, token)
        print(json.dumps(result, indent=2))
        if args.restart:
            restarted = subprocess.run([sys.executable, str(ROOT / "scripts/connection/service.py"), "restart"], check=False)
            if restarted.returncode:
                print("Settings saved; service restart is still pending.", file=sys.stderr)
                return 1
        else:
            print("Restart the idle service with: npm run router -- service restart")
    except (OSError, ValueError, RuntimeError, EOFError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Grafana setup did not finish; no credentials were printed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
