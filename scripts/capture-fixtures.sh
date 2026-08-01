#!/usr/bin/env bash
# Phase F1 fixture capture.
# Fires deliberately malformed requests at each provider and records the real 4xx response.
# Prompts are always the literal string "ping", so no user content can ever land in a fixture.
#
# Requires: curl, jq. Keys from env, never hardcoded:
#   ANTHROPIC_API_KEY  OPENAI_API_KEY  GEMINI_API_KEY  OPENROUTER_API_KEY
# Missing keys skip that provider rather than failing the run.

set -uo pipefail
OUT="tests/fixtures/provider-errors"
mkdir -p "$OUT"/{anthropic,openai,gemini,openrouter}

capture() {
  local provider="$1" name="$2" url="$3" body="$4"; shift 4
  local out="$OUT/$provider/$name.json"
  local resp status err
  resp=$(curl -s -w '\n%{http_code}' -X POST "$url" \
    -H "content-type: application/json" "$@" -d "$body")
  status=$(echo "$resp" | tail -1)
  err=$(echo "$resp" | sed '$d')

  if [ "$status" -lt 400 ] || [ "$status" -ge 500 ]; then
    printf '  SKIP  %-14s %-28s (got %s, wanted 4xx)\n' "$provider" "$name" "$status"
    return
  fi

  jq -n --arg p "$provider" --argjson s "$status" \
        --argjson req "$body" --argjson e "$err" \
    '{provider:$p, status:$s, request_body:$req, error_body:$e,
      expect:{ofCode:"TODO", param:"TODO", repairable:true}}' > "$out"
  printf '  OK    %-14s %-28s %s\n' "$provider" "$name" "$status"
}

echo "== anthropic =="
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  A=(-H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01")
  M='claude-haiku-4-5-20251001'
  capture anthropic unsupported-param https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":16,\"frequency_penalty\":0.5,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic model-not-found https://api.anthropic.com/v1/messages \
    "{\"model\":\"claude-sonnet-9-9\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic max-tokens-ceiling https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":99999999,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic system-in-messages https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":16,\"messages\":[{\"role\":\"system\",\"content\":\"be terse\"},{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic response-format https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":16,\"response_format\":{\"type\":\"json_object\"},\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic tool-schema-shape https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":16,\"tools\":[{\"name\":\"f\",\"parameters\":{\"type\":\"object\"}}],\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "${A[@]}"
  capture anthropic missing-messages https://api.anthropic.com/v1/messages \
    "{\"model\":\"$M\",\"max_tokens\":16}" "${A[@]}"
else echo "  (no ANTHROPIC_API_KEY, skipped)"; fi

echo "== openai =="
if [ -n "${OPENAI_API_KEY:-}" ]; then
  O=(-H "authorization: Bearer $OPENAI_API_KEY")
  capture openai unknown-param https://api.openai.com/v1/chat/completions \
    '{"model":"gpt-4o-mini","anthropic_version":"2023-06-01","messages":[{"role":"user","content":"ping"}]}' "${O[@]}"
  capture openai model-not-found https://api.openai.com/v1/chat/completions \
    '{"model":"gpt-9o-ultra","messages":[{"role":"user","content":"ping"}]}' "${O[@]}"
  capture openai max-tokens-moved https://api.openai.com/v1/chat/completions \
    '{"model":"o3-mini","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' "${O[@]}"
  capture openai tool-schema-shape https://api.openai.com/v1/chat/completions \
    '{"model":"gpt-4o-mini","tools":[{"type":"function","function":{"name":"f","parameters":"not-an-object"}}],"messages":[{"role":"user","content":"ping"}]}' "${O[@]}"
  capture openai missing-messages https://api.openai.com/v1/chat/completions \
    '{"model":"gpt-4o-mini"}' "${O[@]}"
  capture openai temperature-range https://api.openai.com/v1/chat/completions \
    '{"model":"gpt-4o-mini","temperature":9,"messages":[{"role":"user","content":"ping"}]}' "${O[@]}"
else echo "  (no OPENAI_API_KEY, skipped)"; fi

echo "== gemini (openai-compatible) =="
if [ -n "${GEMINI_API_KEY:-}" ]; then
  G=(-H "authorization: Bearer $GEMINI_API_KEY")
  U=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
  capture gemini model-not-found "$U" \
    '{"model":"gemini-99-pro","messages":[{"role":"user","content":"ping"}]}' "${G[@]}"
  capture gemini unknown-param "$U" \
    '{"model":"gemini-2.0-flash","frequency_penalty_x":1,"messages":[{"role":"user","content":"ping"}]}' "${G[@]}"
  capture gemini missing-messages "$U" '{"model":"gemini-2.0-flash"}' "${G[@]}"
else echo "  (no GEMINI_API_KEY, skipped)"; fi

echo "== openrouter =="
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  R=(-H "authorization: Bearer $OPENROUTER_API_KEY")
  U=https://openrouter.ai/api/v1/chat/completions
  capture openrouter model-not-found "$U" \
    '{"model":"nonexistent/model-x","messages":[{"role":"user","content":"ping"}]}' "${R[@]}"
  capture openrouter missing-messages "$U" '{"model":"openai/gpt-4o-mini"}' "${R[@]}"
else echo "  (no OPENROUTER_API_KEY, skipped)"; fi

echo
echo "captured: $(find "$OUT" -name '*.json' | wc -l | tr -d ' ') fixtures"
echo "next: fill the \"expect\" block in each fixture, then write tests/normalize.test.ts"
