# OnlySkinz License Worker

Cloudflare Worker that backs OnlySkinz subscriptions: PayPal billing, license
issuance, and per-device activation tracking.

Phase 0 and **Phase 1** are implemented: worker scaffold, D1 schema, PayPal
client, signed webhook receiver, checkout creation, activation provisioning,
and online entitlement status. Device deactivation, stricter trial-reuse
handling, UI/Rust integration, and complete scheduled reconciliation remain
later work (see `docs/licensing-plan.md`).

```
workers/license/
  src/
    index.ts    # router: checkout, status, webhooks, admin setup, health
    paypal.ts   # OAuth token cache, subscription + setup API, webhook verify
    db.ts       # subscriber/license/device persistence + webhook idempotency
    email.ts    # Resend
    cron.ts     # scheduled maintenance stub (Phase 3)
    types.ts    # Env bindings + PayPal shapes
  schema.sql
  wrangler.toml
```

## Setup

### 1. Install

```sh
cd workers/license
npm install
```

### 2. Create the D1 database

```sh
npx wrangler d1 create onlyskinz-license
```

Paste the returned `database_id` into `wrangler.toml`, then apply the complete
schema (both local, for `wrangler dev`, and remote):

```sh
npm run db:local
npm run db:remote
```

If you already applied the earlier Phase 0 schema to this D1 database, apply
the additive Phase 1 migration **instead of re-running `schema.sql`**:

```sh
npx wrangler d1 execute onlyskinz-license --remote --file=./migrations/0002_phase1.sql
```

### 3. Set secrets

PayPal credentials come from a **PayPal Business** app (start in Sandbox):

```sh
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY          # optional for Phase 0
npx wrangler secret put ADMIN_SETUP_TOKEN       # any long random string
```

`PAYPAL_WEBHOOK_ID` is set in step 5, after the webhook is registered.

### 4. Configure public vars

Edit `[vars]` in `wrangler.toml`:

- `PAYPAL_ENV` = `sandbox` (or `live`)
- `PUBLIC_BASE_URL`, `SUCCESS_URL`, `CANCEL_URL` — your
  `https://onlyskinz-license.<account>.workers.dev` URLs (no custom domain
  needed; PMVDL runs the same way)
- `RESEND_FROM_EMAIL` — reuses the Resend-verified
  `pmvhavendownloader.com` domain

### 5. Create the PayPal product, plan, and webhook

Deploy first, then run setup once:

```sh
npm run deploy

curl -sS -X POST "https://onlyskinz-license.<account>.workers.dev/admin/setup-paypal" \
  -H "Authorization: Bearer $ADMIN_SETUP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"price":"1.99","currency":"USD","trialDays":3}'
```

It returns `productId`, `planId`, and `webhookId`:

- Put `planId` in `wrangler.toml` as `PAYPAL_PLAN_ID`
- `npx wrangler secret put PAYPAL_WEBHOOK_ID` and paste `webhookId`
- Redeploy so the new `PAYPAL_PLAN_ID` var is live

The plan is **3-day trial, then $1.99/month**. PayPal plan prices are
immutable — to change price later, create a new plan and update `PAYPAL_PLAN_ID`.

### 6. Deploy/verify the Phase 1 worker

```sh
curl -sS "https://onlyskinz-license.<account>.workers.dev/health"
# {"ok":true,"ts":...}

curl -sS -X POST "https://onlyskinz-license.<account>.workers.dev/v1/webhooks/paypal" \
  -H "content-type: application/json" -d '{}'
# {"error":"invalid_signature"}  <- signature verification is active
```

The unsigned request should be rejected. Use the PayPal **Webhooks Simulator**
(Developer Dashboard) to send a sandbox event and confirm it is verified and
stored in `webhook_events`:

```sh
npx wrangler d1 execute onlyskinz-license --remote \
  --command "SELECT paypal_event_id, event_type, processed_at FROM webhook_events"
```

## Notes

- Webhook signatures are verified via PayPal's **postback** endpoint, embedding
  the raw request bytes (never a re-serialized object).
- Duplicate deliveries are ignored by `webhook_events.paypal_event_id` PRIMARY KEY.
- `POST /v1/checkout` accepts `{ "email", "device_id", "device_name" }` and
  returns `{ "approval_url", "link_code" }`. The link code is a random
  checkout capability; retain it while polling status.
- `POST /v1/license/status` accepts `{ "device_id", "link_code?" }`. It returns
  active/trial/subscription state only when PayPal activation has been
  provisioned for that device.
- On `BILLING.SUBSCRIPTION.ACTIVATED`, the worker re-fetches the PayPal
  subscription, creates subscriber/license rows idempotently, and binds the
  device from the matching checkout intent. An active license is unique to one
  device.
- A 3-day trial is detected from PayPal's `next_billing_time` before the first
  successful payment; a `PAYMENT.SALE.COMPLETED` refresh makes it paid/active.
- Keep `ADMIN_SETUP_TOKEN` set only while needed; setup is idempotent in the
  sense that each call creates a new product/plan/webhook.
- The desktop release workflow triggers on every push to `main`. Because this
  worker lives in the same repo, add a path filter to
  `.github/workflows/release.yaml` (or move the worker to its own repo) so
  backend changes don't cut a new app release.
