/** Bindings and configuration available to the Worker. */
export interface Env {
  /** D1 database binding. */
  DB: D1Database;

  /** "sandbox" or "live". Selects the PayPal API host. */
  PAYPAL_ENV: string;
  /** PayPal billing plan id created by `npm run setup:paypal`. */
  PAYPAL_PLAN_ID: string;
  /** The webhook id returned by the PayPal webhook registration. */
  PAYPAL_WEBHOOK_ID: string;

  /** Secrets. */
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  RESEND_API_KEY?: string;
  ADMIN_SETUP_TOKEN?: string;

  /** Public vars. */
  PUBLIC_BASE_URL: string;
  SUCCESS_URL: string;
  CANCEL_URL: string;
  RESEND_FROM_EMAIL?: string;
}

export type SubscriptionStatus =
  | "TRIAL"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

/** Minimal shape of a PayPal subscription (only fields we rely on). */
export interface PayPalSubscription {
  id: string;
  plan_id: string;
  status: string;
  custom_id?: string;
  subscriber?: {
    email_address?: string;
    payer_id?: string;
  };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string };
    failed_payments_count?: number;
  };
  create_time?: string;
}

/** Shape of an incoming PayPal webhook event. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  create_time?: string;
  resource?: Record<string, unknown>;
}
