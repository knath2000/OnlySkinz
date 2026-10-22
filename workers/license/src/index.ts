import type { Env, PayPalWebhookEvent } from "./types";
import {
  createProduct,
  createPlan,
  createSubscription,
  getSubscription,
  registerWebhook,
  verifyWebhookSignature,
} from "./paypal";
import {
  attachPaypalSubscription,
  createCheckoutIntent,
  deleteCheckoutIntent,
  getEntitlementForCheckout,
  getEntitlementForDevice,
  hasEntitlement,
  markWebhookProcessed,
  normalizeEmail,
  provisionFromSubscription,
  recordWebhookEvent,
  updateSubscriptionState,
  webhookAlreadyProcessed,
} from "./db";
import { sendEmail } from "./email";
import { runDaily } from "./cron";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, ts: Date.now() });
      }

      if (request.method === "GET" && url.pathname === "/checkout/success") {
        return checkoutResultPage(
          "PayPal approval received",
          "Return to OnlySkinz. The app will unlock after PayPal confirms the subscription.",
        );
      }

      if (request.method === "GET" && url.pathname === "/checkout/cancel") {
        return checkoutResultPage(
          "Checkout cancelled",
          "No subscription was activated. You can return to OnlySkinz and try again.",
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/checkout") {
        return createCheckout(request, env);
      }

      if (request.method === "POST" && url.pathname === "/v1/license/status") {
        return getLicenseStatus(request, env);
      }

      if (request.method === "POST" && url.pathname === "/v1/webhooks/paypal") {
        return handlePaypalWebhook(request, env);
      }

      if (request.method === "POST" && url.pathname === "/admin/setup-paypal") {
        return handleAdminSetup(request, env);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("unhandled_error", err);
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDaily(env));
  },
};

// ---------------------------------------------------------------------------
// PayPal webhook receiver
// ---------------------------------------------------------------------------

async function handlePaypalWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const verified = await verifyWebhookSignature(env, request, rawBody);
  if (!verified) {
    return json({ error: "invalid_signature" }, 400);
  }

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!event?.id || !event?.event_type) {
    return json({ error: "invalid_event" }, 400);
  }

  await recordWebhookEvent(env.DB, event.id, event.event_type, rawBody);
  if (await webhookAlreadyProcessed(env.DB, event.id)) {
    return json({ received: true, duplicate: true });
  }

  await dispatchEvent(env, event);
  await markWebhookProcessed(env.DB, event.id);

  return json({ received: true });
}

/**
 * Route subscription lifecycle events. Handlers re-fetch PayPal state because
 * webhook delivery can be delayed or out of order.
 */
async function dispatchEvent(env: Env, event: PayPalWebhookEvent): Promise<void> {
  switch (event.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      await processSubscription(env, resourceId(event), undefined, true);
      break;
    case "PAYMENT.SALE.COMPLETED":
      await processSubscription(env, billingAgreementId(event), "ACTIVE");
      break;
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.SUSPENDED": {
      const subscription = await getSubscription(env, resourceId(event));
      const status = mapPaypalStatus(subscription.status);
      await updateSubscriptionState(env.DB, subscription, status);
      break;
    }
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const subscription = await getSubscription(env, resourceId(event));
      await updateSubscriptionState(env.DB, subscription, "SUSPENDED");
      break;
    }
    case "PAYMENT.SALE.REFUNDED":
    case "PAYMENT.SALE.REVERSED": {
      const subscriptionId = billingAgreementId(event);
      if (subscriptionId) {
        const subscription = await getSubscription(env, subscriptionId);
        await updateSubscriptionState(env.DB, subscription, "EXPIRED");
      }
      break;
    }
    default:
      console.log("[webhook] ignored", event.event_type);
  }
}

async function processSubscription(
  env: Env,
  subscriptionId: string,
  forcedStatus?: "ACTIVE",
  sendActivationEmail = false,
): Promise<void> {
  if (!subscriptionId) throw new Error("paypal_subscription_id_missing");
  const subscription = await getSubscription(env, subscriptionId);
  const outcome = await provisionFromSubscription(env, subscription);
  if (!outcome.provisioned) {
    // A known cancelled/expired subscription is not a fulfillment failure.
    if (["CANCELLED", "EXPIRED", "SUSPENDED"].includes(subscription.status)) {
      await updateSubscriptionState(env.DB, subscription, mapPaypalStatus(subscription.status));
      return;
    }
    throw new Error(`license_provision_failed:${outcome.reason ?? "unknown"}`);
  }
  if (forcedStatus) await updateSubscriptionState(env.DB, subscription, forcedStatus);

  const intent = subscription.custom_id
    ? await env.DB.prepare("SELECT email FROM checkout_intents WHERE link_code = ?")
        .bind(subscription.custom_id)
        .first<{ email: string }>()
    : null;
  const email = normalizeEmail(subscription.subscriber?.email_address || intent?.email);
  if (email && sendActivationEmail) {
    await sendEmail(
      env,
      email,
      "OnlySkinz subscription activated",
      `<p>Your OnlySkinz subscription is ready on this Mac.</p><p>The 3-day trial is included; after that, the subscription renews at $1.99 per month unless cancelled.</p>`,
    );
  }
}

function billingAgreementId(event: PayPalWebhookEvent): string {
  const resource = event.resource as { billing_agreement_id?: unknown; id?: unknown } | undefined;
  const id = resource?.billing_agreement_id ?? resource?.id;
  return typeof id === "string" ? id : "";
}

function mapPaypalStatus(status: string): "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" {
  if (status === "SUSPENDED") return "SUSPENDED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "EXPIRED") return "EXPIRED";
  return "ACTIVE";
}

function resourceId(event: PayPalWebhookEvent): string {
  const resource = event.resource ?? {};
  const id = (resource as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

// ---------------------------------------------------------------------------
// One-time PayPal setup (create product + plan + webhook)
// ---------------------------------------------------------------------------

async function handleAdminSetup(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SETUP_TOKEN) {
    return json({ error: "setup_disabled" }, 403);
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SETUP_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = (await request.json().catch(() => ({}))) as {
    price?: string;
    currency?: string;
    trialDays?: number;
    productName?: string;
    webhookUrl?: string;
  };

  const price = body.price ?? "1.99";
  const currency = body.currency ?? "USD";
  const trialDays = body.trialDays ?? 3;
  const productName = body.productName ?? "OnlySkinz Pro";
  const webhookUrl = body.webhookUrl ?? `${env.PUBLIC_BASE_URL}/v1/webhooks/paypal`;

  const productId = await createProduct(env, productName);
  const planId = await createPlan(env, { productId, price, currency, trialDays });
  const webhookId = await registerWebhook(env, webhookUrl);

  return json({
    productId,
    planId,
    webhookId,
    next: [
      `Set PAYPAL_PLAN_ID = "${planId}" in wrangler.toml`,
      "wrangler secret put PAYPAL_WEBHOOK_ID  # paste webhookId",
    ],
  });
}

async function createCheckout(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { email?: string; device_id?: string; device_name?: string }
    | null;
  const email = normalizeEmail(body?.email);
  const deviceId = normalizeDeviceId(body?.device_id);
  const deviceName = normalizeDeviceName(body?.device_name);
  if (!email || !deviceId) return json({ error: "valid_email_and_device_id_required" }, 400);
  if (!env.PAYPAL_PLAN_ID || env.PAYPAL_PLAN_ID.startsWith("REPLACE_")) {
    return json({ error: "paypal_plan_not_configured" }, 503);
  }

  const linkCode = randomLinkCode();
  await createCheckoutIntent(
    env.DB,
    linkCode,
    email,
    deviceId,
    deviceName,
    Math.floor(Date.now() / 1000),
  );
  let paypalSubscriptionCreated = false;
  try {
    const subscription = await createSubscription(env, linkCode, email);
    paypalSubscriptionCreated = true;
    if (!subscription.approveUrl || !isPayPalApprovalUrl(subscription.approveUrl, env.PAYPAL_ENV)) {
      throw new Error("paypal_approval_url_invalid");
    }
    await attachPaypalSubscription(env.DB, linkCode, subscription.id);
    return json({ approval_url: subscription.approveUrl, link_code: linkCode });
  } catch (error) {
    // Keep the intent if PayPal created a subscription: a webhook can still
    // arrive if the response was lost or attaching its id transiently failed.
    if (!paypalSubscriptionCreated) await deleteCheckoutIntent(env.DB, linkCode);
    console.error("checkout_creation_failed", error);
    return json({ error: "checkout_creation_failed" }, 502);
  }
}

async function getLicenseStatus(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { device_id?: string; link_code?: string }
    | null;
  const deviceId = normalizeDeviceId(body?.device_id);
  const linkCode = body?.link_code ?? "";
  if (!deviceId) return json({ error: "valid_device_id_required" }, 400);
  if (linkCode && !/^[A-Za-z0-9_-]{32,80}$/.test(linkCode)) {
    return json({ error: "invalid_link_code" }, 400);
  }

  const entitlement = linkCode
    ? await getEntitlementForCheckout(env.DB, linkCode, deviceId)
    : await getEntitlementForDevice(env.DB, deviceId);
  if (!entitlement) {
    return json({ active: false, status: "inactive", email: null, trial_ends_at: null, period_ends_at: null });
  }

  const active = hasEntitlement(entitlement);
  return json({
    active,
    status: active ? entitlement.subscriber_status.toLowerCase() : "inactive",
    email: active ? entitlement.email : null,
    trial_ends_at: active ? entitlement.trial_end : null,
    period_ends_at: active ? entitlement.current_period_end : null,
  });
}

function normalizeDeviceId(value: string | undefined): string {
  const id = (value ?? "").trim();
  return id.length >= 8 && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : "";
}

function normalizeDeviceName(value: string | undefined): string | null {
  const name = (value ?? "").trim().replace(/[\r\n\0]/g, "").slice(0, 80);
  return name || null;
}

function randomLinkCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isPayPalApprovalUrl(value: string, environment: string): boolean {
  try {
    const url = new URL(value);
    const expected = environment === "live" ? "paypal.com" : "sandbox.paypal.com";
    return url.protocol === "https:" && (url.hostname === expected || url.hostname.endsWith(`.${expected}`));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function checkoutResultPage(title: string, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — OnlySkinz</title><style>body{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111827;color:#f9fafb;display:grid;min-height:100vh;place-items:center;margin:0}main{max-width:520px;margin:24px;padding:32px;background:#1f2937;border:1px solid #374151;border-radius:16px}p{color:#d1d5db;line-height:1.6}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
