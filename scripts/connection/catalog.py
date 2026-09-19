"""Prepare the API gateway's Codex-specific catalog from installed native metadata."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import sys

from configure import ROOT, read_vars, run_codex_catalog, write_private


def project_catalog(config, native):
    by_model = {row["slug"]: row for row in native["models"]}
    rows = []
    for alias, candidates in config["routes"].items():
        if not candidates or not all("/v1/responses" in candidate["endpoints"] for candidate in candidates):
            continue
        model_ids = {candidate["model"] for candidate in candidates}
        if len(model_ids) != 1 or next(iter(model_ids)) not in by_model:
            raise RuntimeError(f"Route {alias!r} needs a verified Codex catalog for all of its candidate models.")
        model = next(iter(model_ids))
        row = copy.deepcopy(by_model[model])
        row.update(slug=alias, display_name=alias, organized_upstream_model=model)
        # Ramp supplies the native harness locally because gateway catalogs do
        # not own Codex's version-specific instructions. Do the same here.
        row.pop("model_messages", None)
        row["base_instructions"] = ""
        rows.append(row)
    if not rows:
        raise RuntimeError("Configure at least one native Codex Responses route first.")
    return {"models": rows}


def prepare(path, native):
    before = path.read_text()
    variables = read_vars(path)
    catalog = project_catalog(json.loads(variables["ROUTER_CONFIG"]), native)
    value = json.dumps(catalog, separators=(",", ":"))
    if len(value.encode()) > 32 * 1024:
        raise RuntimeError("The gateway model catalog exceeds the 32 KiB secret limit; configure fewer Codex aliases.")
    lines = [line for line in before.splitlines() if not line.startswith("CODEX_CATALOG=")]
    write_private(path, "\n".join([*lines, "CODEX_CATALOG=" + value]) + "\n", expected=before)
    return {"models": [row["slug"] for row in catalog["models"]], "catalogBytes": len(value.encode())}


if __name__ == "__main__":
    try:
        print(json.dumps(prepare(ROOT / ".dev.vars", run_codex_catalog([], bundled=True)), indent=2))
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Could not prepare the local Codex catalog.", file=sys.stderr)
        raise SystemExit(1)
