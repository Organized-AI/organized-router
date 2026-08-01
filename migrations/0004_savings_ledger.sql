-- Savings share at 5%. Subscription is billed separately through GitPaywall.

CREATE TABLE IF NOT EXISTS savings_ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
  task_class TEXT NOT NULL, baseline_model TEXT NOT NULL, selected_model TEXT NOT NULL,
  baseline_cost_usd REAL NOT NULL, selected_cost_usd REAL NOT NULL,
  probe_cost_usd REAL DEFAULT 0, saved_usd REAL NOT NULL, share_usd REAL NOT NULL,
  voided INTEGER DEFAULT 0, stripe_meter_event_id TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_savings_user ON savings_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS baselines (
  user_id TEXT NOT NULL, task_class TEXT NOT NULL, model TEXT NOT NULL,
  frozen_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'receipt',
  PRIMARY KEY (user_id, task_class)
);
