import type { Env, PayPalSubscription, SubscriptionStatus } from "./types";

export interface CheckoutIntent {
  link_code: string;
  email: string;
  device_id: string;
  device_name: string | null;
  paypal_subscription_id: string | null;
  status: "pending" | "completed" | "expired" | "rejected";
  created_at: number;
}

export interface EntitlementRow {
  email: string;
  subscriber_status: SubscriptionStatus;
  trial_end: number | null;
  current_period_end: number | null;
  status_updated_at: number;
  device_id: string;
  link_code?: string;
}

/** Insert a webhook once; unprocessed duplicates can safely retry handlers. */
export async function recordWebhookEvent(
  db: D1Database,
  eventId: string,
  eventType: string,
  payload: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, payload) VALUES (?, ?, ?)",
    )
    .bind(eventId, eventType, payload)
    .run();
}

export async function webhookAlreadyProcessed(
  db: D1Database,
  eventId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT processed_at FROM webhook_events WHERE paypal_event_id = ?")
    .bind(eventId)
    .first<{ processed_at: number | null }>();
  return row?.processed_at != null;
}

export async function markWebhookProcessed(db: D1Database, eventId: string): Promise<void> {
  await db
    .prepare("UPDATE webhook_events SET processed_at = unixepoch() WHERE paypal_event_id = ?")
    .bind(eventId)
    .run();
}

export async function createCheckoutIntent(
  db: D1Database,
  linkCode: string,
  email: string,
  deviceId: string,
  deviceName: string | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO checkout_intents (link_code, email, device_id, device_name, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .bind(linkCode, email, deviceId, deviceName, now)
    .run();
}

export async function deleteCheckoutIntent(db: D1Database, linkCode: string): Promise<void> {
  await db.prepare("DELETE FROM checkout_intents WHERE link_code = ? AND status = 'pending'")
    .bind(linkCode)
    .run();
}

export async function attachPaypalSubscription(
  db: D1Database,
  linkCode: string,
  subscriptionId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE checkout_intents SET paypal_subscription_id = ? WHERE link_code = ? AND status = 'pending'",
    )
    .bind(subscriptionId, linkCode)
    .run();
}

export async function getCheckoutIntent(
  db: D1Database,
  linkCode: string,
): Promise<CheckoutIntent | null> {
  return db
    .prepare("SELECT * FROM checkout_intents WHERE link_code = ?")
    .bind(linkCode)
    .first<CheckoutIntent>();
}

function paypalStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "SUSPENDED":
      return "SUSPENDED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "ACTIVE";
  }
}

/**
 * Idempotently provision a subscriber, license, and its one allowed device.
 * Each D1 batch is atomic. The upserts also make a webhook retry repair partial
 * progress safely.
 */
export async function provisionFromSubscription(
  env: Env,
  subscription: PayPalSubscription,
  now = Math.floor(Date.now() / 1000),
): Promise<{ provisioned: boolean; reason?: string }> {
  const linkCode = subscription.custom_id?.trim() ?? "";
  const subscriptionId = subscription.id;
  const intent = linkCode ? await getCheckoutIntent(env.DB, linkCode) : null;
  if (!intent || intent.status === "expired" || intent.status === "rejected") {
    return { provisioned: false, reason: "checkout_intent_missing_or_expired" };
  }
  if (intent.paypal_subscription_id && intent.paypal_subscription_id !== subscriptionId) {
    return { provisioned: false, reason: "subscription_mismatch" };
  }

  const email = normalizeEmail(subscription.subscriber?.email_address || intent.email);
  if (!email || !intent.device_id) return { provisioned: false, reason: "subscriber_details_missing" };

  const nextBillingTime = parseUnix(subscription.billing_info?.next_billing_time);
  const lastPaymentTime = parseUnix(subscription.billing_info?.last_payment?.time);
  const isTrial = subscription.status === "ACTIVE" && !lastPaymentTime && nextBillingTime !== null && nextBillingTime > now;
  const status = isTrial ? "TRIAL" : paypalStatus(subscription.status);
  const trialEnd = isTrial ? nextBillingTime : null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscribers
        (email, paypal_subscription_id, paypal_payer_id, plan_id, status, trial_end,
         current_period_end, status_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(paypal_subscription_id) DO UPDATE SET
         email = excluded.email,
         paypal_payer_id = excluded.paypal_payer_id,
         plan_id = excluded.plan_id,
         status = excluded.status,
         trial_end = excluded.trial_end,
         current_period_end = excluded.current_period_end,
         status_updated_at = excluded.status_updated_at,
         updated_at = excluded.updated_at`,
    ).bind(
      email,
      subscriptionId,
      subscription.subscriber?.payer_id ?? null,
      subscription.plan_id,
      status,
      trialEnd,
      nextBillingTime,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO licenses (subscriber_id, status, max_activations, created_at)
       SELECT id, 'active', 1, ? FROM subscribers WHERE paypal_subscription_id = ?
       ON CONFLICT DO NOTHING`,
    ).bind(now, subscriptionId),
    env.DB.prepare(
      `UPDATE checkout_intents
       SET status = 'completed', paypal_subscription_id = ?
       WHERE link_code = ? AND (paypal_subscription_id IS NULL OR paypal_subscription_id = ?)`,
    ).bind(subscriptionId, linkCode, subscriptionId),
  ]);

  const license = await env.DB
    .prepare(
      `SELECT l.id AS license_id FROM licenses l
       JOIN subscribers s ON s.id = l.subscriber_id
       WHERE s.paypal_subscription_id = ?`,
    )
    .bind(subscriptionId)
    .first<{ license_id: number }>();
  if (!license) return { provisioned: false, reason: "license_create_failed" };

  // The partial unique index enforces one active device per license. On a
  // retry, the same device refreshes its last_seen; a different device cannot
  // silently take over the activation.
  const activation = await env.DB
    .prepare(
      `INSERT INTO activations
         (license_id, device_id, device_name, app_version, first_seen, last_seen)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(license_id, device_id) DO UPDATE SET
         device_name = excluded.device_name, last_seen = excluded.last_seen,
         deactivated_at = NULL
       RETURNING id`,
    )
    .bind(license.license_id, intent.device_id, intent.device_name, now, now)
    .first<{ id: number }>();
  if (!activation) return { provisioned: false, reason: "activation_conflict" };
  return { provisioned: true };
}

export async function updateSubscriptionState(
  db: D1Database,
  subscription: PayPalSubscription,
  status: SubscriptionStatus,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const nextBillingTime = parseUnix(subscription.billing_info?.next_billing_time);
  const lastPaymentTime = parseUnix(subscription.billing_info?.last_payment?.time);
  const derivedStatus: SubscriptionStatus =
    status === "ACTIVE" && !lastPaymentTime && nextBillingTime !== null && nextBillingTime > now
      ? "TRIAL"
      : status;

  await db
    .prepare(
      `UPDATE subscribers SET status = ?, trial_end = ?, current_period_end = COALESCE(?, current_period_end),
         status_updated_at = ?, updated_at = ? WHERE paypal_subscription_id = ?`,
    )
    .bind(
      derivedStatus,
      derivedStatus === "TRIAL" ? nextBillingTime : null,
      nextBillingTime,
      now,
      now,
      subscription.id,
    )
    .run();

  if (derivedStatus === "EXPIRED") {
    await db
      .prepare(
        `UPDATE licenses SET status = 'revoked', revoked_at = ?
         WHERE subscriber_id = (SELECT id FROM subscribers WHERE paypal_subscription_id = ?)`,
      )
      .bind(now, subscription.id)
      .run();
  }
}

export async function getEntitlementForDevice(
  db: D1Database,
  deviceId: string,
): Promise<EntitlementRow | null> {
  return db
    .prepare(
      `SELECT s.email, s.status AS subscriber_status, s.trial_end,
              s.current_period_end, s.status_updated_at, a.device_id
       FROM activations a
       JOIN licenses l ON l.id = a.license_id
       JOIN subscribers s ON s.id = l.subscriber_id
       WHERE a.device_id = ? AND a.deactivated_at IS NULL AND l.status = 'active'
       ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .bind(deviceId)
    .first<EntitlementRow>();
}

export async function getEntitlementForCheckout(
  db: D1Database,
  linkCode: string,
  deviceId: string,
): Promise<EntitlementRow | null> {
  return db
    .prepare(
      `SELECT s.email, s.status AS subscriber_status, s.trial_end,
              s.current_period_end, s.status_updated_at, a.device_id,
              ci.link_code
       FROM checkout_intents ci
       JOIN subscribers s ON s.paypal_subscription_id = ci.paypal_subscription_id
       JOIN licenses l ON l.subscriber_id = s.id
       JOIN activations a ON a.license_id = l.id
       WHERE ci.link_code = ? AND ci.device_id = ? AND a.device_id = ?
         AND a.deactivated_at IS NULL AND l.status = 'active'
       LIMIT 1`,
    )
    .bind(linkCode, deviceId, deviceId)
    .first<EntitlementRow>();
}

export function hasEntitlement(row: EntitlementRow, now = Math.floor(Date.now() / 1000)): boolean {
  if (row.subscriber_status === "TRIAL") return row.trial_end !== null && row.trial_end > now;
  if (row.subscriber_status === "ACTIVE" || row.subscriber_status === "CANCELLED") {
    return row.current_period_end !== null && row.current_period_end > now;
  }
  if (row.subscriber_status === "SUSPENDED") {
    const graceSeconds = 7 * 24 * 60 * 60;
    return row.current_period_end !== null &&
      row.status_updated_at + graceSeconds > now &&
      row.current_period_end + graceSeconds > now;
  }
  return false;
}

export function normalizeEmail(value: string | undefined): string {
  const email = (value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function parseUnix(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}
