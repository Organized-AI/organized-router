-- Organized Fix: attempts, repairs, catalog

CREATE TABLE IF NOT EXISTS provider_attempts (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  provider TEXT, model TEXT, status INTEGER, error_code TEXT, error_param TEXT,
  latency_ms INTEGER, was_patched INTEGER DEFAULT 0, patch_tier INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON provider_attempts(request_id);

CREATE TABLE IF NOT EXISTS repairs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL,
  signature TEXT NOT NULL, tier INTEGER NOT NULL, patch_json TEXT NOT NULL,
  outcome TEXT NOT NULL, healer_cost_usd REAL DEFAULT 0, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_repairs_sig ON repairs(signature);

CREATE TABLE IF NOT EXISTS patch_catalog (
  signature TEXT PRIMARY KEY, provider TEXT, status INTEGER, error_type TEXT,
  error_param TEXT, of_code TEXT, patch_json TEXT NOT NULL,
  success_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0,
  distinct_users INTEGER DEFAULT 0, promoted_at INTEGER, published INTEGER DEFAULT 0
);
