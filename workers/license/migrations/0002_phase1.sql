-- Apply ONLY when the older Phase 0 schema has already been applied.
-- Fresh databases should use schema.sql instead.

ALTER TABLE subscribers
  ADD COLUMN status_updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE checkout_intents
  ADD COLUMN device_name TEXT;

ALTER TABLE checkout_intents
  ADD COLUMN paypal_subscription_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_subscription
  ON checkout_intents(paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscriber
  ON licenses(subscriber_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_device_per_license
  ON activations(license_id)
  WHERE deactivated_at IS NULL;
