# Healer Protocol

The contract a healing service implements. Compatible with Manifest's `AUTOFIX_HEALING_URL`.

## Request

```
POST /heal
x-api-key: <key>
content-type: application/json
```

```json
{
  "signature": "a3f9...",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "error": {
    "ofCode": "OF400",
    "status": 400,
    "type": "invalid_request_error",
    "param": "frequency_penalty",
    "message": "unsupported parameter: frequency_penalty"
  },
  "body": { "model": "...", "messages": [], "frequency_penalty": 0.5 }
}
```

The caller scrubs secrets from `body` before sending. Keys matching `api_key`, `authorization`, `token`, `secret`, `password`, or `bearer` are replaced with `[redacted]`.

## Response

```json
{
  "ops": [ { "op": "delete", "path": "frequency_penalty" } ],
  "cost_usd": 0.0004,
  "tier": 2
}
```

## Patch operations

| op | Fields | Effect |
|---|---|---|
| `delete` | `path` | remove the key |
| `set` | `path`, `value` | set the key |
| `rename` | `path`, `to` | move the key |
| `clamp` | `path`, `max`, `min` | bound a number |
| `wrap` | `path`, `as` | wrap in an array or object |

`path` is dot-delimited. Ops apply in order. The caller rejects a patched body exceeding its own size ceiling.

## Caller obligations

- Send only 400, 404, 422, and the caller's own model-not-available code.
- Apply the patch and retry exactly once.
- On any healer error, timeout, or malformed response, return the original provider error to the client.
- Open a circuit breaker after 3 consecutive transport failures. Close it on one success.

## Returning a patch you did not generate

A healer may serve a cached or catalogued patch and report `tier: 0`. Callers should treat tier as advisory telemetry, not as a correctness signal.
