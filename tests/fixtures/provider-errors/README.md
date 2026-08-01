# Provider error fixtures

Real 4xx responses captured from providers, used to prove the normalizer and signature are correct.

## Shape

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "status": 400,
  "request_body": { "model": "...", "messages": [], "frequency_penalty": 0.5 },
  "error_body": { "type": "error", "error": { "type": "invalid_request_error", "message": "..." } },
  "expect": { "ofCode": "OF400", "param": "frequency_penalty", "repairable": true }
}
```

## Rules

- `messages` content is replaced with a placeholder. No real prompts, ever.
- One file per distinct failure cause, not per occurrence.
- If a provider changes an error shape, add a new fixture rather than editing the old one. The
  old shape is still in the wild and the normalizer has to keep handling it.
