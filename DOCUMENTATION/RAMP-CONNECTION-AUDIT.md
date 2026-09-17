# Ramp connection audit

Audited 2026-09-17. User requirements: reproduce Ramp's Codex connection pattern;
make both subscription and API authentication available; retain the existing
subscription as the active mode; focus on observed native caching. The earlier
per-process CLI launcher is a verified transport probe, not this complete setup.

## Primary evidence

The public connector is [ramp-public/ramp-cli](https://github.com/ramp-public/ramp-cli),
MIT licensed. This audit pins release v0.2.37, commit
`707b8e414c90c7b961f4aaf74e0a737e08d0de6e` (2026-09-16).
The private routing backend is outside the publicly inspected source.

- [Connector and rollback source](https://github.com/ramp-public/ramp-cli/blob/707b8e414c90c7b961f4aaf74e0a737e08d0de6e/src/ramp_cli/commands/router.py):
  `_codex_provider`, `_configure_codex`, `_unconfigure_codex`, catalog, prompt,
  profile and session helpers.
- [Browser key handoff](https://github.com/ramp-public/ramp-cli/blob/707b8e414c90c7b961f4aaf74e0a737e08d0de6e/src/ramp_cli/router_setup.py):
  authenticated Router page, temporary loopback callback, random state, S256
  challenge/handshake, single-use form POST, timeouts and no callback logging.
  This acquires a Router API key; it is not ChatGPT OAuth.
- [Connector tests](https://github.com/ramp-public/ramp-cli/blob/707b8e414c90c7b961f4aaf74e0a737e08d0de6e/tests/test_router.py):
  exact provider TOML, discovery, idempotency, rollback, archived/compressed history,
  disk failures and preservation of later user changes.
- [Public quickstart](https://docs.router.com/getting-started/quickstart): install
  the CLI, configure agents with a Router key, discover models, send Responses,
  inspect usage. [Coding-agent guide](https://docs.router.com/getting-started/coding-agents)
  documents configure/unconfigure.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
  documents custom providers, command auth, native OpenAI auth and catalog overrides.

## Observed Ramp flow and required parity

| Stage | Ramp source behavior | Organized Router requirement |
|---|---|---|
| Select client | Configure Codex CLI and desktop via the shared Codex home | Explicit Codex configuration command |
| Acquire credential | Supplied key, setup file, stored key, or browser key handoff | API gateway key for API mode; existing native ChatGPT login for subscription mode |
| Discover | Authenticated model listing before local writes; Codex-specific catalog with `X-Gateway-Client: codex` | Validate a native catalog and the selected model before activation |
| Register provider | Named provider, Responses wire API, WebSockets off | Same native custom-provider mechanism in both modes |
| API authentication | Private key file read by `auth.command`; no inline bearer | Same command-based gateway authentication in API mode |
| Subscription authentication | Not implemented by this Ramp connector | Explicit extension: `requires_openai_auth=true`; native Codex owns OAuth refresh |
| Activate | Set root model/provider/catalog in `config.toml` | Persistent default, preserving the user's model and unrelated configuration |
| Preserve agent behavior | Recover installed Codex harness where Router's catalog omits it | Keep native model instructions and capability metadata; never synthesize a weaker prompt |
| Keep history visible | Update session metadata and SQLite provider indexes, including archives | Reversible migration, with concurrent-writer protection and no prompt edits |
| Escape | Save original-provider profile and isolated catalog | Working original-provider escape profile |
| Refresh | Re-fetch catalog, preserve current selection, repair owned setup | Idempotent refresh with validation before writes |
| Undo | Restore original settings/history, reclaim newly created router sessions, preserve user edits | Receipt-based rollback and owned-artifact cleanup |
| Observe | Gateway logs and cost integration | Cache-token receipts; no invented dollar or subscription-quota savings |

Ramp's published CLI default is `https://router-api.ramp.com/v1`; its public
quickstart uses `https://api.router.com/v1`. Both are source facts, not grounds to
silently conflate the two. Organized Router uses its own endpoint with `/v1` and
the same Responses contract.

## Authentication boundary

The user's clarification is **both modes available**. API mode follows Ramp's
key-to-gateway connection. Subscription mode deliberately changes authentication
and the upstream to preserve the user's existing Codex plan. It is inaccurate to
call the latter Ramp's exact authentication flow. Neither mode silently falls
back into the other, and configuring a connection is not permission to incur API
charges for a live billing test.

Ramp's optional browser key-issuance flow is unnecessary when a key already exists;
its own `--api-key` path bypasses it. Organized Router's local gateway generates
its own private key. No Router.com account, hosted key-issuance service, or browser
OAuth clone is required for this local installation.

## Completion evidence required

1. Both authentication configurations are accepted by installed Codex 0.154.0.
2. Discovery, model selection, prompt preservation and native API request behavior
   are verified against real Codex, not only hand-built fixtures.
3. Configure/refresh/unconfigure cover preservation, failure rollback, private
   file permissions, archive/compression handling and conversation indexes.
4. The real default is activated in subscription mode, with a reliable local
   router process and an inspected rollback receipt.
5. A request made without per-process provider overrides reaches Organized Router
   and reconciles native usage with the router's observed cache counters.
6. The desktop/native-app-server configuration and conversation visibility are
   checked separately from CLI success. A running chat is not claimed rerouted
   merely because config.toml changed.
7. Any required app restart or user-provided API credential is recorded as an
   outstanding dependency, not hidden behind passing fixture tests.

## Current evidence

The [verification record](VERIFICATION.md) and
[native connection fixture](../artifacts/connection-runtime-report.json) verify
saved API-mode configuration in installed Codex CLI and app-server, command
authentication, model visibility and conversation visibility through undo.
The [live subscription probe](../artifacts/subscription-report.json) separately
verifies the subscription transport with native credentials. Configuration and
migration behavior has 18 passing tests.

Activation gates 4–6 remain open for the real desktop installation. The local
subscription launchd service is installed, but the latest real configuration
status reports `connected: false`, provider `openai`, and no migration receipt.
The active desktop transcript writer must close before the connector can migrate
history. Finish from a separate terminal after closing Codex, then reopen and
verify a request through the saved default. Do not bypass the writer guard or
describe this running chat as already routed through Organized Router.
