"""Ramp Codex history migration, adapted for Organized Router.

Copyright 2026 Ramp Business Corporation. MIT license; see THIRD_PARTY_NOTICES.md.
Source: ramp-public/ramp-cli, commit 707b8e414c90c7b961f4aaf74e0a737e08d0de6e.
Changes: provider name, stdlib zstd (Python 3.14), and RuntimeError diagnostics.
This module is used only by explicit configure/refresh/unconfigure operations.
"""
from __future__ import annotations
import json
import os
import sqlite3
import tempfile
from compression import zstd as zstandard
from contextlib import contextmanager, closing
from pathlib import Path
from typing import Callable, Iterator

ROUTER_PROVIDER = "organized-router"
CODEX_SESSION_DIRECTORIES = ("sessions", "archived_sessions")

@contextmanager
def _open_codex_session(path: Path):
    opener = zstandard.open if path.suffix == ".zst" else open
    with opener(path, "rt", encoding="utf-8") as session:
        yield session

def _codex_transcripts(home: Path) -> Iterator[Path]:
    """Every regular-file Codex transcript under home, live and archived.

    Symlinks are skipped, each directory is walked in sorted order, and a file
    reached through a symlinked directory that resolves outside home is left
    alone: the receipt only ever names paths inside CODEX_HOME, and recording
    one it cannot restore would fail the whole configure later.
    """
    resolved_home = home.resolve()
    inside: dict[Path, bool] = {}
    for directory in CODEX_SESSION_DIRECTORIES:
        root = home / directory
        if not root.is_dir():
            continue
        for transcript in sorted(root.rglob("*")):
            if transcript.is_symlink() or not transcript.is_file():
                continue
            if not transcript.name.endswith((".jsonl", ".jsonl.zst")):
                continue
            parent = transcript.parent
            if parent not in inside:
                try:
                    parent.resolve().relative_to(resolved_home)
                except (OSError, RuntimeError, ValueError):
                    inside[parent] = False
                else:
                    inside[parent] = True
            if inside[parent]:
                yield transcript


def _preexisting_codex_router_session_ids(home: Path) -> list[str]:
    """Snapshot Router threads that predate this CLI-managed configuration."""
    identifiers: set[str] = set()
    for transcript in _codex_transcripts(home):
        try:
            item = _read_codex_session_meta(transcript)
        except (OSError, UnicodeError, zstandard.ZstdError):
            continue
        if item is None or item["payload"].get("model_provider") != ROUTER_PROVIDER:
            continue
        identifier = item["payload"].get("id")
        if isinstance(identifier, str):
            identifiers.add(identifier)

    database_path = home / "state_5.sqlite"
    if database_path.is_file():
        try:
            with closing(sqlite3.connect(database_path, timeout=1)) as database, database:
                columns = {
                    row[1]
                    for row in database.execute("PRAGMA table_info(threads)").fetchall()
                }
                if {"id", "model_provider"}.issubset(columns):
                    identifiers.update(
                        identifier
                        for (identifier,) in database.execute(
                            "SELECT id FROM threads WHERE model_provider = ?",
                            (ROUTER_PROVIDER,),
                        )
                        if isinstance(identifier, str)
                    )
        except sqlite3.Error as exc:
            raise RuntimeError(
                f"Could not read Codex session index {database_path}: {exc}"
            ) from None
    return sorted(identifiers)


def _prepare_codex_sessions(home: Path) -> list[dict]:
    # Codex hides sessions whose provider differs from the active provider.
    # See https://github.com/openai/codex/issues/15494.
    # Archived transcripts are covered too: the Archived chats list applies the
    # same provider filter, and unconfigure reclaims archived threads back to
    # the restored provider, so leaving them out here strands every archived
    # thread on the old provider after an unconfigure/configure round trip.
    sessions = []
    for session_path in _codex_transcripts(home):
        try:
            item = _read_codex_session_meta(session_path)
        except (OSError, UnicodeError, zstandard.ZstdError):
            continue
        if item is None:
            continue
        payload = item["payload"]
        item_session_id = payload.get("id")
        provider = payload.get("model_provider")
        if (
            not isinstance(item_session_id, str)
            or (provider is not None and not isinstance(provider, str))
            or provider == ROUTER_PROVIDER
        ):
            continue
        sessions.append(
            {
                "path": str(session_path.relative_to(home)),
                "id": item_session_id,
                "transcript_updated": True,
                "had_model_provider": "model_provider" in payload,
                "model_provider": provider,
            }
        )

    _record_codex_index_providers(home, sessions)
    return sessions


def _merge_codex_receipt_sessions(
    existing_sessions: list, discovered: list[dict]
) -> list[dict]:
    """Fold newly discovered transcripts into the cumulative receipt.

    A thread already on the receipt keeps its entry, except when that entry was
    recorded from the index alone because its transcript was missing at the
    time: a transcript found for it now replaces the entry, keeping the index
    provider recorded back then, so the transcript is retagged with this pass
    and both it and the row are restored at unconfigure.
    """
    upgrades = {
        session["id"]: session
        for session in discovered
        if session.get("transcript_updated", True)
    }
    merged: list[dict] = []
    recorded_ids: set = set()
    for existing in existing_sessions:
        if not isinstance(existing, dict):
            merged.append(existing)
            continue
        identifier = existing.get("id")
        recorded_ids.add(identifier)
        upgrade = upgrades.get(identifier)
        if upgrade is None or existing.get("transcript_updated", True):
            merged.append(existing)
            continue
        replacement = dict(upgrade)
        if "index_model_provider" in existing:
            replacement["index_model_provider"] = existing["index_model_provider"]
        merged.append(replacement)
    merged.extend(
        session for session in discovered if session.get("id") not in recorded_ids
    )
    return merged


def _record_codex_index_providers(home: Path, sessions: list[dict]) -> None:
    database_path = home / "state_5.sqlite"
    if not database_path.is_file():
        return
    try:
        with closing(sqlite3.connect(database_path, timeout=1)) as database, database:
            columns = {
                row[1]
                for row in database.execute("PRAGMA table_info(threads)").fetchall()
            }
            if not {"id", "model_provider"}.issubset(columns):
                return
            sessions_by_id: dict[str, list[dict]] = {}
            for session in sessions:
                sessions_by_id.setdefault(session["id"], []).append(session)
            has_rollout_path = "rollout_path" in columns
            selected_columns = (
                "id, model_provider, rollout_path"
                if has_rollout_path
                else "id, model_provider"
            )
            for row in database.execute(f"SELECT {selected_columns} FROM threads"):
                session_id, provider, *rollout_path = row
                transcript_sessions = sessions_by_id.get(session_id)
                if transcript_sessions:
                    for session in transcript_sessions:
                        session["index_model_provider"] = provider
                    continue
                if (
                    not has_rollout_path
                    or provider is None
                    or provider == ROUTER_PROVIDER
                ):
                    continue
                try:
                    relative_path = (
                        Path(rollout_path[0]).resolve().relative_to(home.resolve())
                    )
                except (TypeError, ValueError):
                    continue
                if (
                    not relative_path.parts
                    or relative_path.parts[0] not in CODEX_SESSION_DIRECTORIES
                ):
                    continue
                session = {
                    "path": str(relative_path),
                    "id": session_id,
                    "transcript_updated": False,
                    "index_model_provider": provider,
                }
                sessions.append(session)
                sessions_by_id[session_id] = [session]
    except sqlite3.Error as exc:
        raise RuntimeError(
            f"Could not read Codex session index {database_path}: {exc}"
        ) from None


def _update_codex_session_index(
    home: Path, sessions: list[dict], *, restore: bool
) -> None:
    database_path = home / "state_5.sqlite"
    if not database_path.is_file() or not sessions:
        return
    try:
        with closing(sqlite3.connect(database_path, timeout=1)) as database, database:
            columns = {
                row[1]
                for row in database.execute("PRAGMA table_info(threads)").fetchall()
            }
            if not {"id", "model_provider"}.issubset(columns):
                return
            for session in sessions:
                if restore:
                    if "index_model_provider" not in session:
                        continue
                    provider = session["index_model_provider"]
                    expected_provider = ROUTER_PROVIDER
                else:
                    provider = ROUTER_PROVIDER
                    expected_provider = session.get(
                        "index_model_provider", session.get("model_provider")
                    )
                    if expected_provider is None:
                        continue
                database.execute(
                    "UPDATE threads SET model_provider = ? "
                    "WHERE id = ? AND model_provider = ?",
                    (provider, session["id"], expected_provider),
                )
    except (KeyError, TypeError, sqlite3.Error) as exc:
        raise RuntimeError(
            f"Could not update Codex session index {database_path}: {exc}"
        ) from None


def _codex_restored_provider(root_values: dict) -> str:
    """The provider Codex answers to once Router's root keys are gone.

    An absent model_provider means Codex falls back to its built-in one, which
    is also what the threads predating Router are tagged with.
    """
    configured = root_values.get("model_provider")
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    return "openai"


def _reclaim_codex_router_sessions(
    home: Path,
    sessions: list[dict],
    provider: str,
    *,
    preexisting_router_sessions: list[str] | tuple[str, ...] = (),
) -> None:
    """Move conversations Router itself created onto the restored provider.

    Codex hides a thread whose provider is not the active one, so a session
    started while Router was configured disappears the moment Router is
    removed. The receipt cannot account for these: it lists what existed
    before configure, and these were born after it.

    A session the receipt does know about is skipped. One still on Router here
    is one whose restoration was declined because the user had changed it, and
    reclaiming it would override exactly the choice that declining protected.
    An entry recorded from the index alone never had a transcript to protect:
    a Router-tagged transcript that later appears for it was born on Router or
    already snapshotted as preexisting, so it is reclaimed like any other,
    onto the provider its index row is restored to so the two keep agreeing.
    """
    recorded: set = set(preexisting_router_sessions)
    index_only_providers: dict[str, str] = {}
    for session in sessions:
        if not isinstance(session, dict):
            continue
        identifier = session.get("id")
        if session.get("transcript_updated", True):
            recorded.add(identifier)
            continue
        index_provider = session.get("index_model_provider")
        if isinstance(identifier, str) and isinstance(index_provider, str):
            index_only_providers.setdefault(identifier, index_provider)
    for transcript in _codex_transcripts(home):
        try:
            item = _read_codex_session_meta(transcript)
        except (OSError, UnicodeError, zstandard.ZstdError):
            continue
        if item is None:
            continue
        payload = item["payload"]
        identifier = payload.get("id")
        if (
            not isinstance(identifier, str)
            or identifier in recorded
            or payload.get("model_provider") != ROUTER_PROVIDER
        ):
            continue
        _rewrite_codex_session_provider(
            home,
            {"path": str(transcript.relative_to(home)), "id": identifier},
            expected_provider=ROUTER_PROVIDER,
            provider_present=True,
            provider=index_only_providers.get(identifier, provider),
        )
    _reclaim_codex_index_rows(home, recorded, provider)


def _reclaim_codex_index_rows(home: Path, recorded: set, provider: str) -> None:
    """Point index rows Router still owns at the restored provider.

    The index is what the pickers read, and it holds rows for threads whose
    transcript is gone or unreadable, so it is swept in its own right rather
    than only alongside a rewritten file.
    """
    database_path = home / "state_5.sqlite"
    if not database_path.is_file():
        return
    with closing(sqlite3.connect(database_path, timeout=1)) as database, database:
        columns = {
            row[1] for row in database.execute("PRAGMA table_info(threads)").fetchall()
        }
        if not {"id", "model_provider"}.issubset(columns):
            return
        stranded = database.execute(
            "SELECT id FROM threads WHERE model_provider = ?", (ROUTER_PROVIDER,)
        ).fetchall()
        for (identifier,) in stranded:
            if identifier in recorded:
                continue
            database.execute(
                "UPDATE threads SET model_provider = ? "
                "WHERE id = ? AND model_provider = ?",
                (provider, identifier, ROUTER_PROVIDER),
            )


def _restore_codex_sessions(home: Path, sessions: list[dict]) -> None:
    def restore(session: dict, locate: _CodexTranscriptLocator) -> bool:
        if not session.get("transcript_updated", True):
            return True
        try:
            had_provider = session["had_model_provider"]
            provider = session.get("model_provider")
        except (KeyError, TypeError):
            raise RuntimeError(
                "Codex session setup state is invalid."
            ) from None
        return _rewrite_codex_session_provider(
            home,
            session,
            expected_provider=ROUTER_PROVIDER,
            provider_present=had_provider,
            provider=provider,
            locate=locate,
        )

    _rewrite_codex_sessions_reconciled(home, sessions, restore)
    _update_codex_session_index(home, sessions, restore=True)


def _sync_codex_sessions(home: Path, sessions: list[dict]) -> None:
    def sync(session: dict, locate: _CodexTranscriptLocator) -> bool:
        if not session.get("transcript_updated", True):
            return True
        try:
            expected_provider = session.get("model_provider")
            provider_present = session["had_model_provider"]
        except (KeyError, TypeError):
            raise RuntimeError(
                "Codex session setup state is invalid."
            ) from None
        return _rewrite_codex_session_provider(
            home,
            session,
            expected_provider=expected_provider,
            expected_present=provider_present,
            provider_present=True,
            provider=ROUTER_PROVIDER,
            locate=locate,
        )

    _rewrite_codex_sessions_reconciled(home, sessions, sync)


def _rollback_codex_sessions(home: Path, sessions: list[dict]) -> None:
    try:
        _sync_codex_sessions(home, sessions)
        _update_codex_session_index(home, sessions, restore=False)
    except (OSError, RuntimeError):
        pass


def _read_codex_session_meta(path: Path) -> dict | None:
    with _open_codex_session(path) as session:
        for line in session:
            try:
                item = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(item, dict):
                continue
            payload = item.get("payload")
            if item.get("type") == "session_meta" and isinstance(payload, dict):
                return item
    return None


def _session_path(home: Path, session: dict) -> Path:
    try:
        path = home / Path(session["path"])
        path.resolve().relative_to(home.resolve())
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("Codex session setup state is invalid.") from None
    return path


class _CodexTranscriptLocator:
    """Resolve receipt transcripts that Codex has moved since they were recorded.

    Archiving moves a transcript from sessions/ into archived_sessions/ and
    unarchiving moves it back, both keeping the file name. The receipt only
    knows where the file was at configure time, so a missing path is looked
    up by name across both directories, with or without the .zst compression
    suffix, and accepted only when the transcript still carries the recorded
    session id. Candidates come from _codex_transcripts, so they already
    resolve inside CODEX_HOME like the recorded path had to.

    The name index is built on the first stale path and shared by every lookup
    in one pass, so a teardown after a large archive sweep walks the tree once
    rather than once per moved transcript. A pass that had misses calls
    refresh() once at its end and retries only those entries, which catches a
    transcript Codex moved while the pass ran without paying a walk per file
    that is truly gone.
    """

    def __init__(self, home: Path) -> None:
        self._home = home
        self._by_name: dict[str, list[Path]] | None = None

    @staticmethod
    def _logical_name(name: str) -> str:
        return name.removesuffix(".zst")

    def refresh(self) -> None:
        by_name: dict[str, list[Path]] = {}
        for transcript in _codex_transcripts(self._home):
            by_name.setdefault(self._logical_name(transcript.name), []).append(
                transcript
            )
        self._by_name = by_name

    def __call__(self, session: dict, recorded: Path) -> Path | None:
        if self._by_name is None:
            self.refresh()
        assert self._by_name is not None
        session_id = session.get("id")
        for candidate in self._by_name.get(self._logical_name(recorded.name), ()):
            try:
                meta = _read_codex_session_meta(candidate)
            except (OSError, UnicodeError, zstandard.ZstdError):
                continue
            if meta is not None and meta["payload"].get("id") == session_id:
                return candidate
        return None


def _rewrite_codex_sessions_reconciled(
    home: Path,
    sessions: list[dict],
    rewrite: Callable[[dict, _CodexTranscriptLocator], bool],
) -> None:
    """Run one rewrite pass, then retry the entries whose transcript was missing.

    Codex may move a transcript while the pass runs; the retry sees the tree as
    it stands at the end of the pass, at the cost of one extra walk and only
    when something was missing at all.
    """
    locator = _CodexTranscriptLocator(home)
    missing = [session for session in sessions if not rewrite(session, locator)]
    if not missing:
        return
    locator.refresh()
    for session in missing:
        rewrite(session, locator)


def _rewrite_codex_session_provider(
    home: Path,
    session: dict,
    *,
    expected_provider: str | None,
    provider_present: bool,
    provider: str | None,
    expected_present: bool = True,
    locate: Callable[[dict, Path], Path | None] | None = None,
) -> bool:
    """Retag one receipt transcript; report whether its file was found at all.

    False means the recorded path is gone and no relocation matched, so the
    caller may retry after refreshing its view of the tree. Every other early
    return is a transcript that exists but needs no change.
    """
    path = _session_path(home, session)
    if not path.is_file() or path.is_symlink():
        relocated = locate(session, path) if locate is not None else None
        if relocated is None:
            return False
        path = relocated
    try:
        meta = _read_codex_session_meta(path)
    except (OSError, UnicodeError, zstandard.ZstdError) as exc:
        raise RuntimeError(
            f"Could not read Codex session {path}: {exc}"
        ) from None
    if meta is None or meta["payload"].get("id") != session.get("id"):
        return True
    payload = meta["payload"]
    current_present = "model_provider" in payload
    current_provider = payload.get("model_provider")
    if current_present == provider_present and current_provider == provider:
        return True
    if current_present != expected_present or current_provider != expected_provider:
        return True

    original = path.stat()
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with _open_codex_session(path) as source:
            if path.suffix == ".zst":
                with os.fdopen(fd, "wb") as raw_output:
                    with zstandard.ZstdFile(raw_output, "wb", level=3) as output:
                        _copy_codex_session(
                            source,
                            output.write,
                            session["id"],
                            provider_present,
                            provider,
                            encode=True,
                        )
                    raw_output.flush()
                    os.fsync(raw_output.fileno())
            else:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    _copy_codex_session(
                        source,
                        output.write,
                        session["id"],
                        provider_present,
                        provider,
                    )
                    output.flush()
                    os.fsync(output.fileno())
        os.chmod(tmp_name, 0o600)
        current = path.stat()
        if (
            current.st_dev,
            current.st_ino,
            current.st_size,
            current.st_mtime_ns,
        ) != (
            original.st_dev,
            original.st_ino,
            original.st_size,
            original.st_mtime_ns,
        ):
            raise RuntimeError(
                f"Codex session changed while updating {path}. Close Codex and try again."
            )
        os.replace(tmp_name, path)
        os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return True


def _copy_codex_session(
    source,
    write,
    session_id: str,
    provider_present: bool,
    provider: str | None,
    *,
    encode: bool = False,
) -> None:
    replaced = False
    for line in source:
        rendered = line
        if not replaced:
            try:
                item = json.loads(line)
            except (ValueError, TypeError):
                item = None
            payload = item.get("payload") if isinstance(item, dict) else None
            if (
                isinstance(payload, dict)
                and item.get("type") == "session_meta"
                and payload.get("id") == session_id
            ):
                if provider_present:
                    payload["model_provider"] = provider
                else:
                    payload.pop("model_provider", None)
                newline = "\n" if line.endswith("\n") else ""
                rendered = json.dumps(item, separators=(",", ":")) + newline
                replaced = True
        write(rendered.encode("utf-8") if encode else rendered)
