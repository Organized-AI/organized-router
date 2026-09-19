"""macOS user service for the local subscription transport. No OAuth storage."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

from configure import ROOT, NoRedirect, read_optional, write_private

LABEL = "ai.organized.router.subscription"


def definition(root, node):
    return {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(root / "scripts/subscription-server.mjs")],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "Umask": 0o077,
        "StandardOutPath": str(root / ".local/subscription.stdout.log"),
        "StandardErrorPath": str(root / ".local/subscription.stderr.log"),
    }


def owned_definition(path, root):
    raw = read_optional(path)
    if raw is None:
        return None
    parsed = plistlib.loads(raw.encode())
    arguments = parsed.get("ProgramArguments", [])
    if parsed.get("Label") != LABEL or len(arguments) != 2 or arguments[1] != str(root / "scripts/subscription-server.mjs"):
        raise RuntimeError("The existing launch agent belongs to another installation; it was left unchanged.")
    if parsed != definition(root, Path(arguments[0])):
        raise RuntimeError("The launch agent has user changes; preserve it before modifying this service.")
    return raw


def launchctl(*arguments, required=True):
    result = subprocess.run(["launchctl", *arguments], capture_output=True, text=True, timeout=15)
    if required and result.returncode:
        raise RuntimeError(f"launchctl {arguments[0]} failed (exit {result.returncode}); the service was not verified.")
    return result


def target():
    return f"gui/{os.getuid()}/{LABEL}"


def loaded():
    result = launchctl("print", target(), required=False)
    pid = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
    return {"loaded": result.returncode == 0, "pid": int(pid[1]) if pid else None}


def cache_stats(root):
    try:
        key = (root / ".local/subscription.key").read_text().strip()
        request = urllib.request.Request("http://127.0.0.1:8788/api/cache/stats", headers={"x-organized-gateway-key": key})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=2) as response:
            data = json.load(response)
        if data.get("mode") == "chatgpt-subscription" and isinstance(data.get("inFlight"), int):
            return data
    except (OSError, ValueError):
        pass
    return None


def status(root, path):
    result = loaded()
    data = cache_stats(root)
    return {"label": LABEL, "installed": path.is_file(), **result,
            "ready": result["loaded"] and result["pid"] is not None and data is not None,
            "inFlight": data.get("inFlight") if data else None,
            "endpoint": "http://127.0.0.1:8788/v1"}


def require_idle(root):
    data = cache_stats(root)
    if data is None or data["inFlight"] != 0 or data.get("telemetry", {}).get("flushing"):
        raise RuntimeError("The subscription router is busy or could not confirm idle. Finish active turns before stopping it.")


def install(root, path, node):
    previous = owned_definition(path, root)
    current = loaded()
    if current["loaded"]:
        if previous is None:
            raise RuntimeError("A service with this label is loaded without our launch-agent file; it was left unchanged.")
        return status(root, path)
    listeners = subprocess.run(["lsof", "-nP", "-iTCP:8788", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=5)
    if listeners.returncode not in (0, 1) or listeners.stdout.strip():
        raise RuntimeError("Port 8788 is already in use. Stop the foreground subscription router before installing the service.")
    local = root / ".local"
    local.mkdir(mode=0o700, exist_ok=True)
    for filename in ("subscription.stdout.log", "subscription.stderr.log"):
        log = local / filename
        if log.is_symlink():
            raise RuntimeError("A service log must not be a symlink.")
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
    path.parent.mkdir(parents=True, exist_ok=True)
    desired = plistlib.dumps(definition(root, node)).decode()
    write_private(path, desired, expected=previous)
    try:
        launchctl("bootstrap", f"gui/{os.getuid()}", str(path))
    except RuntimeError:
        # No loaded agent was modified. Restore only the file we just wrote.
        if read_optional(path) == desired:
            if previous is None:
                path.unlink()
            else:
                write_private(path, previous, expected=desired)
        raise
    return wait_ready(root, path)


def wait_ready(root, path):
    for _ in range(30):
        result = status(root, path)
        if result["ready"]:
            return result
        time.sleep(0.2)
    raise RuntimeError("The service is installed but did not become ready. Inspect .local/subscription.stderr.log before activation.")


def main():
    parser = argparse.ArgumentParser(description="Run the subscription router as a macOS user service")
    parser.add_argument("action", choices=("install", "status", "restart", "uninstall"))
    args = parser.parse_args()
    path = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    try:
        if sys.platform != "darwin":
            raise RuntimeError("This service command requires macOS; use npm run router:subscription on other systems.")
        if args.action == "status":
            result = status(ROOT, path)
        elif args.action == "install":
            node = shutil.which("node")
            if not node:
                raise RuntimeError("Node.js is required to run the subscription service.")
            result = install(ROOT, path, Path(node).resolve())
        else:
            previous = owned_definition(path, ROOT)
            if previous is None:
                raise RuntimeError("No owned subscription service is installed.")
            if loaded()["loaded"]:
                require_idle(ROOT)
                if args.action == "restart":
                    launchctl("kickstart", "-k", target())
                    print(json.dumps(wait_ready(ROOT, path), indent=2))
                    return 0
                launchctl("bootout", target())
            if args.action == "restart":
                launchctl("bootstrap", f"gui/{os.getuid()}", str(path))
                result = wait_ready(ROOT, path)
            else:
                if read_optional(path) != previous:
                    raise RuntimeError("The launch-agent file changed; it was not deleted.")
                path.unlink()
                result = {"label": LABEL, "installed": False, "loaded": False}
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, RuntimeError) else f"Service operation failed ({type(error).__name__}).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
