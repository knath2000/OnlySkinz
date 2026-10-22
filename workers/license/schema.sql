-- OnlySkinz license worker — D1 schema
-- Apply with:
--   npx wrangler d1 execute onlyskinz-license --local  --file=./schema.sql
--   npx wrangler d1 execute onlyskinz-license --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  email                  TEXT NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  paypal_payer_id        TEXT,
  plan_id                TEXT NOT NULL,
  status                 TEXT NOT NULL,          -- TRIAL|ACTIVE|SUSPENDED|CANCELLED|EXPIRED
  trial_end              INTEGER,                -- unix seconds
  current_period_end     INTEGER,                -- unix seconds
  status_updated_at      INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id   INTEGER NOT NULL REFERENCES subscribers(id),
  status          TEXT NOT NULL DEFAULT 'active', -- active|revoked
  max_activations INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscriber
  ON licenses(subscriber_id);

CREATE TABLE IF NOT EXISTS activations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id     INTEGER NOT NULL REFERENCES licenses(id),
  device_id      TEXT NOT NULL,       -- macOS IOPlatformUUID
  device_name    TEXT,
  app_version    TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  deactivated_at INTEGER,
  UNIQUE (license_id, device_id)
);

-- A license may be actively used on only one device at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_device_per_license
  ON activations(license_id) WHERE deactivated_at IS NULL;

CREATE TABLE IF NOT EXISTS checkout_intents (
  link_code  TEXT PRIMARY KEY,
  email      TEXT,
  device_id  TEXT,
  device_name TEXT,
  paypal_subscription_id TEXT UNIQUE,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|completed|expired
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  paypal_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  received_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subs_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subs_period ON subscribers(current_period_end);
CREATE INDEX IF NOT EXISTS idx_act_device  ON activations(device_id);
CREATE INDEX IF NOT EXISTS idx_intents_status ON checkout_intents(status);
