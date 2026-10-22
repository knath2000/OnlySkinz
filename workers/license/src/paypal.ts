import type { Env, PayPalSubscription } from "./types";

/** Access-token cache. Isolate-scoped; refreshed before expiry. */
let cachedToken: { value: string; expiresAt: number } | null = null;
const TOKEN_SKEW_MS = 60_000;

export function paypalBase(env: Env): string {
  return env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export async function getAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;

  const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`paypal_auth_failed:${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000 - TOKEN_SKEW_MS,
  };
  return data.access_token;
}

async function paypalFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
  requestId?: string,
): Promise<Response> {
  const token = await getAccessToken(env);
  return fetch(`${paypalBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/** Create a subscription and return its id + approval link. */
export async function createSubscription(
  env: Env,
  linkCode: string,
  email: string,
): Promise<{ id: string; approveUrl: string }> {
  const res = await paypalFetch(env, "/v1/billing/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      plan_id: env.PAYPAL_PLAN_ID,
      custom_id: linkCode,
      subscriber: { email_address: email },
      application_context: {
        brand_name: "OnlySkinz",
        user_action: "SUBSCRIBE_NOW",
        return_url: env.SUCCESS_URL,
        cancel_url: env.CANCEL_URL,
      },
    }),
  }, linkCode);

  const data = (await res.json()) as {
    id?: string;
    links?: Array<{ rel: string; href: string }>;
    message?: string;
  };
  if (!res.ok || !data.id) {
    throw new Error(`paypal_subscription_failed:${res.status}:${data.message ?? ""}`);
  }

  const approveUrl = data.links?.find((l) => l.rel === "approve")?.href ?? "";
  return { id: data.id, approveUrl };
}

/** Always prefer fresh server state over webhook payloads. */
export async function getSubscription(
  env: Env,
  subscriptionId: string,
): Promise<PayPalSubscription> {
  const res = await paypalFetch(
    env,
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  if (!res.ok) throw new Error(`paypal_get_subscription_failed:${res.status}`);
  return (await res.json()) as PayPalSubscription;
}

/**
 * Verify a webhook via PayPal's postback endpoint.
 *
 * The `webhook_event` is embedded using the *raw request bytes* rather than a
 * re-serialized object, because re-serializing can change the payload and fail
 * verification.
 */
export async function verifyWebhookSignature(
  env: Env,
  request: Request,
  rawBody: string,
): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) return false;

  const transmissionId = request.headers.get("paypal-transmission-id");
  const transmissionTime = request.headers.get("paypal-transmission-time");
  const certUrl = request.headers.get("paypal-cert-url");
  const authAlgo = request.headers.get("paypal-auth-algo");
  const transmissionSig = request.headers.get("paypal-transmission-sig");

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }

  const body =
    "{" +
    [
      `"transmission_id":${JSON.stringify(transmissionId)}`,
      `"transmission_time":${JSON.stringify(transmissionTime)}`,
      `"cert_url":${JSON.stringify(certUrl)}`,
      `"auth_algo":${JSON.stringify(authAlgo)}`,
      `"transmission_sig":${JSON.stringify(transmissionSig)}`,
      `"webhook_id":${JSON.stringify(env.PAYPAL_WEBHOOK_ID)}`,
      `"webhook_event":${rawBody}`,
    ].join(",") +
    "}";

  const res = await paypalFetch(env, "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body,
  });
  if (!res.ok) return false;

  const data = (await res.json()) as { verification_status?: string };
  return data.verification_status === "SUCCESS";
}

// ---------------------------------------------------------------------------
// One-time sandbox/live setup helpers (exposed through POST /admin/setup-paypal)
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENT_TYPES = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED",
];

export interface SetupResult {
  productId: string;
  planId: string;
  webhookId: string;
}

export async function createProduct(env: Env, name: string): Promise<string> {
  const res = await paypalFetch(env, "/v1/catalogs/products", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: "OnlySkinz Pro subscription",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  const data = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !data.id) throw new Error(`paypal_product_failed:${res.status}`);
  return data.id;
}

export async function createPlan(
  env: Env,
  opts: { productId: string; price: string; currency: string; trialDays: number },
): Promise<string> {
  const res = await paypalFetch(env, "/v1/billing/plans", {
    method: "POST",
    body: JSON.stringify({
      product_id: opts.productId,
      name: `OnlySkinz Pro Monthly (${opts.trialDays}-day trial)`,
      billing_cycles: [
        {
          frequency: { interval_unit: "DAY", interval_count: opts.trialDays },
          tenure_type: "TRIAL",
          sequence: 1,
          total_cycles: 1,
          pricing_scheme: {
            fixed_price: { value: "0", currency_code: opts.currency },
          },
        },
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 2,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: opts.price, currency_code: opts.currency },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 2,
      },
    }),
  });
  const data = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !data.id) throw new Error(`paypal_plan_failed:${res.status}:${data.message ?? ""}`);
  return data.id;
}

export async function registerWebhook(env: Env, url: string): Promise<string> {
  const res = await paypalFetch(env, "/v1/notifications/webhooks", {
    method: "POST",
    body: JSON.stringify({
      url,
      event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })),
    }),
  });
  const data = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !data.id) {
    throw new Error(`paypal_webhook_failed:${res.status}:${data.message ?? ""}`);
  }
  return data.id;
}
