-- Subscription plan awareness. A request served by a monthly plan has no marginal
-- dollar cost, so it cannot produce a billable saving.

CREATE TABLE IF NOT EXISTS plans (
  user_id TEXT NOT NULL, provider TEXT NOT NULL,
  plan_name TEXT NOT NULL, monthly_cost_usd REAL NOT NULL,
  auth_type TEXT NOT NULL,            -- oauth_subscription | api_key
  detected_at INTEGER NOT NULL, source TEXT NOT NULL,  -- header | credential | receipt | declared
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS plan_windows (
  user_id TEXT NOT NULL, provider TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- rolling_5h | weekly | monthly
  cap_units REAL, used_units REAL NOT NULL DEFAULT 0,
  observed_max_units REAL DEFAULT 0,  -- learned cap when the provider does not report one
  resets_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider, kind)
);

CREATE TABLE IF NOT EXISTS unit_weights (
  provider TEXT NOT NULL, model_family TEXT NOT NULL,
  weight REAL NOT NULL, observations INTEGER DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY (provider, model_family)
);

-- Regime and quota columns on the savings ledger.
ALTER TABLE savings_ledger ADD COLUMN regime TEXT NOT NULL DEFAULT 'api';
ALTER TABLE savings_ledger ADD COLUMN saved_units REAL NOT NULL DEFAULT 0;
ALTER TABLE savings_ledger ADD COLUMN billable INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_savings_regime ON savings_ledger(user_id, regime, created_at);
