# OnlySkinz — Licensing & Subscription: Final Plan

Authoritative implementation plan for monetizing OnlySkinz with a PayPal
subscription, automatic provisioning, and per-device activation tracking.

Supersedes the earlier exploratory draft (`paypal-subscriptions.md`).

> **Status:** approved direction, not yet implemented.
> Anonymity is explicitly **not** a requirement for this build.

---

## 1. Confirmed decisions

| Decision | Value |
|---|---|
| Billing | **PayPal Subscriptions** (monthly, auto-renew) |
| Trial | **3-day free trial with all features**, then paywall |
| Price | **$1.99 / month** |
| Access model | **Trial → locked.** No permanent free tier. After the trial (or an inactive subscription) the app is **unusable** until an email with an active subscription is connected. |
| Backend language | **TypeScript** |
| Device limit | **1** concurrent activation per license (also one trial per device) |
| Offline mode | **None** — online verification required |
| Identity model | **Email + hardware ID** (no key string to paste) |
| Domain | Reuse **`pmvhavendownloader.com`** — already Resend-verified |
| Distribution | GitHub Releases (unchanged) |

Anything still undecided is listed in §12.

---

## 2. Architecture

Reuses the proven structure from `pmvhavendownloader`'s `pmvdl-license`
Cloudflare Worker, extended for recurring subscriptions.

```
┌────────────┐  POST /v1/checkout   ┌───────────────────────────┐
│ Desktop app│ ───────────────────► │  License Worker (CF)      │
│  (Tauri)   │ ◄── approval URL ─── │  TypeScript / Hono-less   │
│            │                      │                           │
│  poll      │  POST /v1/license/…  │  PayPal Subscriptions API │
│  status    │ ───────────────────► │  D1 (SQLite)              │
└────────────┘                      │  Cron Triggers            │
                                    │  Resend (email)           │
                                    └──────────┬────────────────┘
                                               │ webhooks (HTTPS)
                                               ▼
                                        ┌─────────────┐
                                        │   PayPal    │
                                        └─────────────┘
```

**No deep-link dependency.** PMVDL uses `pmvdl://license-success`, but OnlySkinz
**relaunches itself as root** (`src-tauri/src/lib.rs`), which makes URL-scheme
handoff to the correct process fragile. Instead the app **polls** the worker with
a `link_code` after opening checkout. More robust, works regardless of the
root/user process split.

---

## 3. Hosting decision

**Cloudflare Workers + D1 + Cron Triggers + Resend.**

Why this over the alternatives:

| Option | Verdict |
|---|---|
| **Cloudflare Workers + D1** | **Chosen.** Matches the PMVDL template, global uptime, cron built-in, free tier permits commercial use, D1 gives transactions for activation counting. |
| Vercel + Neon | Rejected: Hobby is non-commercial; Pro is $20/mo. |
| Supabase Free | Viable $0 fallback (DB + auth + edge functions + cron), but no template to reuse and pauses after 7 days idle. |
| Fly/Render/Railway | Fine, but ~$5–10/mo and more ops. |

| Need | Service |
|---|---|
| API + webhook receiver | Cloudflare Worker (`onlyskinz-license`) |
| Database | Cloudflare **D1** (SQLite, transactional) |
| Scheduled jobs | Cloudflare **Cron Triggers** |
| Email delivery | **Resend** — reuse the domain already verified for PMVDL |
| Domain | **No new domain required** — reuse `pmvhavendownloader.com` (see §3.1) |
| Marketing/success page | Worker route or Cloudflare Pages |

**Cost:** $0/mo on the free tier to start (Worker free + D1 free + Resend free
3,000/mo). PayPal webhook verification uses the **postback API call**, which is
network wait — not CPU — so the Worker free 10 ms CPU limit is unlikely to bite.
Upgrade to Workers Paid ($5/mo) only if CPU or request limits become a problem.

### 3.1 Reusing the PMVDL domain

`pmvhavendownloader.com` is already verified with Resend (PMVDL sends from
`licenses@pmvhavendownloader.com`), so **no new domain purchase is needed**:

- Email can go out from the existing domain, e.g.
  `OnlySkinz <licenses@pmvhavendownloader.com>`, or preferably from a **subdomain**
  such as `onlyskinz.pmvhavendownloader.com` (add DNS records on the parent,
  which you already control).
- The Worker/API does **not** need a custom domain — PMVDL itself runs on
  `pmvdl-license.knath2000.workers.dev`, and PayPal accepts the
  `*.workers.dev` HTTPS URL for webhooks and `return_url`.

**Recommendation:** use a subdomain (`onlyskinz.…`) rather than the apex. It
gives a little sending-reputation isolation from the other product and looks
less confusing to recipients.

**Trade-off to note:** the parent domain is tied to a different (adult)
product. Sharing it risks brand confusion and shared sender reputation. If
OnlySkinz is meant to stand alone, a dedicated ~$10/yr domain is worth it later.

---

## 4. PayPal setup

### 4.1 Product + plan (one-time)

`POST /v1/catalogs/products` then `POST /v1/billing/plans` with a 3-day trial
cycle followed by the regular monthly cycle:

```json
{
  "product_id": "PROD-XXXX",
  "name": "OnlySkinz Pro Monthly",
  "billing_cycles": [
    {
      "frequency": { "interval_unit": "DAY", "interval_count": 3 },
      "tenure_type": "TRIAL",
      "sequence": 1,
      "total_cycles": 1,
      "pricing_scheme": { "fixed_price": { "value": "0", "currency_code": "USD" } }
    },
    {
      "frequency": { "interval_unit": "MONTH", "interval_count": 1 },
      "tenure_type": "REGULAR",
      "sequence": 2,
      "total_cycles": 0,
      "pricing_scheme": { "fixed_price": { "value": "1.99", "currency_code": "USD" } }
    }
  ],
  "payment_preferences": {
    "auto_bill_outstanding": true,
    "payment_failure_threshold": 2
  }
}
```

Register a webhook (`POST /v1/notifications/webhooks`) and store `webhook_id`.

### 4.2 Checkout flow

1. App → `POST /v1/checkout` with `{ email, device_id, device_name }`.
2. Worker creates a `link_code` (32 random bytes, base64url), stores a
   `checkout_intents` row, then creates the subscription server-side:
   ```json
   POST /v1/billing/subscriptions
   {
     "plan_id": "P-XXXX",
     "custom_id": "<link_code>",
     "application_context": {
       "brand_name": "OnlySkinz",
       "user_action": "SUBSCRIBE_NOW",
       "return_url": "https://onlyskinz-license.<account>.workers.dev/checkout/success",
       "cancel_url": "https://onlyskinz-license.<account>.workers.dev/checkout/cancel"
     }
   }
   ```
3. Worker returns `links[rel=approve].href`; app opens it in the system browser.
4. User approves. PayPal sends webhooks. The app **polls**
   `POST /v1/license/status` with its `device_id` + `link_code`.
5. When the webhook activates the subscription, the poll returns `active`.

### 4.3 Webhook events

| Event | Action |
|---|---|
| `BILLING.SUBSCRIPTION.ACTIVATED` | Create subscriber + license; bind device from `checkout_intents`; status `TRIAL` or `ACTIVE` |
| `PAYMENT.SALE.COMPLETED` | Re-fetch subscription; set `current_period_end`; status `ACTIVE` |
| `BILLING.SUBSCRIPTION.UPDATED` | Re-sync plan/status |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Status `SUSPENDED`; start grace |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Status `SUSPENDED`; warn |
| `BILLING.SUBSCRIPTION.CANCELLED` | Keep active until `current_period_end`, then revoke |
| `BILLING.SUBSCRIPTION.EXPIRED` | `EXPIRED` → revoke license |
| `PAYMENT.SALE.REFUNDED` / `REVERSED` | Revoke / claw back |

**Handling rules:**
1. Verify every webhook via `POST /v1/notifications/verify-webhook-signature`,
   posting the event back **byte-for-byte as received** (do not re-serialize).
2. Idempotency: `webhook_events.paypal_event_id` PRIMARY KEY; ignore duplicates.
3. Never trust the payload as truth — re-fetch
   `GET /v1/billing/subscriptions/{id}` on state changes.
4. Return `200` quickly; do work inline but keep it short.

---

## 5. Data model (D1 schema)

```sql
CREATE TABLE subscribers (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  email                  TEXT NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  paypal_payer_id        TEXT,
  plan_id                TEXT NOT NULL,
  status                 TEXT NOT NULL,          -- TRIAL|ACTIVE|SUSPENDED|CANCELLED|EXPIRED
  trial_end              INTEGER,                -- unix seconds
  current_period_end     INTEGER,                -- unix seconds
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE licenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id   INTEGER NOT NULL REFERENCES subscribers(id),
  status          TEXT NOT NULL DEFAULT 'active', -- active|revoked
  max_activations INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE TABLE activations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id     INTEGER NOT NULL REFERENCES licenses(id),
  device_id      TEXT NOT NULL,       -- IOPlatformUUID
  device_name    TEXT,
  app_version    TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  deactivated_at INTEGER,
  UNIQUE (license_id, device_id)
);

CREATE TABLE checkout_intents (
  link_code  TEXT PRIMARY KEY,
  email      TEXT,
  device_id  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|completed|expired
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  paypal_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  processed_at    INTEGER
);

CREATE INDEX idx_subs_status ON subscribers(status);
CREATE INDEX idx_subs_period ON subscribers(current_period_end);
CREATE INDEX idx_act_device  ON activations(device_id);
```

D1 is transactional, so the "check count then insert activation" step is safe
(unlike KV's eventual consistency in PMVDL).

---

## 6. Worker endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/checkout` | Create `link_code` + PayPal subscription; return approval URL |
| POST | `/v1/license/status` | `{device_id, link_code?}` → `{active, status, trialEndsAt, periodEndsAt, email}` |
| POST | `/v1/license/deactivate` | Release the device so it can be moved |
| POST | `/v1/webhooks/paypal` | Verify + process PayPal events |
| GET | `/checkout/success` | Hosted "return to OnlySkinz" page |
| GET | `/checkout/cancel` | Cancellation page |
| GET | `/health` | Uptime / keep-alive probe |

Optional later: `/account` portal (email OTP via Resend) to view status, release
the device, and open PayPal's cancel link.

### Project layout

```
workers/license/
  src/
    index.ts        # router (matches PMVDL's single-dispatcher style)
    paypal.ts       # token cache, subscription create/fetch, webhook verify
    db.ts           # D1 queries + transaction helpers
    email.ts        # Resend
    cron.ts         # trial expiry / lapse revocation / reminders
  schema.sql
  wrangler.toml
  package.json
```

---

## 7. Identity & activation model

**No key string.** Identity = normalized **email** from PayPal, bound to a
**device ID** = macOS `IOPlatformUUID`.

- **Device limit 1**: `activations` UNIQUE(license_id, device_id); a different
  device is rejected with `409 activation_limit_reached`.
- **Moving Macs**: user clicks "Deactivate this device" (or the portal), freeing
  the slot; then activates on the new machine.
- **One trial per device**: because there is no permanent free tier, the 3-day
  trial is keyed to `device_id` as well as the PayPal account, so a new email
  does not grant a fresh trial on the same Mac.
- **Device ID source**: `IOPlatformUUID` (IOKit), same as PMVDL's `HardwareID`.
  It is stable across reinstalls and requires **no Keychain storage** — which
  sidesteps the root-process Keychain problem created by OnlySkinz's admin
  relaunch.

**No offline mode**: the app calls the worker on launch and before gated
actions. Nothing durable is written to disk. If the network is unavailable, the
app shows the lock/connection-required screen and gated commands are refused.

> ⚠️ **Availability risk:** online-only means the worker is a hard dependency;
> an outage locks out paying users. Mitigation: a short **in-memory** cached
> entitlement (valid for the session, e.g. ~15 minutes) so brief blips do not
> interrupt an active session, while still requiring a periodic online check.

---

## 8. App integration (`src-tauri` + `src`)

### 8.1 Rust

New `src-tauri/src/commands/license.rs`:

- `get_device_id()` → `IOPlatformUUID` via IOKit/`ioreg`; fallback to a stored
  random UUID in app data.
- `start_checkout(email)` → `POST /v1/checkout`; open approval URL with
  `tauri-plugin-shell` (`open`).
- `refresh_license()` → `POST /v1/license/status`.
- `deactivate_license()` → `POST /v1/license/deactivate`.
- `require_entitlement()` → shared guard used by gated commands.

HTTP via `ureq` (already a dependency). Calls run in **Rust, not the webview**,
to avoid CORS and keep state native. Register the commands in
`src-tauri/src/lib.rs`.

### 8.2 Gating

This is a **trial-then-lock** model, not freemium. During the 3-day trial and
while a subscription is active, **every feature is available**. Once the trial
ends (or the subscription lapses) and no active email is connected, the app is
**locked**.

Enforce in Rust so the UI cannot be bypassed:

| State | Behaviour |
|---|---|
| Trial active (`TRIAL`, before `trial_end`) | All features available |
| Subscription active (`ACTIVE`) | All features available |
| `SUSPENDED` within grace | All features available + warning |
| Expired / cancelled past period / no email | **App locked** — a full-window "Activate to continue" screen; **all** gated commands (`patcher.rs` apply, `skins.rs` download/batch, `customs.rs` import) return `entitlement_required` |

A single `require_entitlement()` guard is called at the top of every
feature-bearing command; the frontend shows the lock screen when
`useLicense().locked` is true.

### 8.3 Frontend

- `src/hooks/useLicense.ts` — wraps `invoke` calls, exposes `locked` status.
- **Lock screen** shown whenever entitlement is inactive: a single field to
  connect an email, a "Start 3-day free trial" / "Subscribe — $1.99/mo" button,
  and a status line.
- After checkout, poll via `link_code`; no URL-scheme handling needed.
- "Deactivate this device" button; renewal date and status for active users.

---

## 9. Scheduled jobs (Cron Triggers)

`wrangler.toml`:

```toml
[triggers]
crons = ["0 3 * * *"]
```

Daily job:
1. Mark trials past `trial_end` without payment as `EXPIRED` and revoke.
2. Revoke licenses whose `current_period_end` passed and status is
   `CANCELLED` / `SUSPENDED` beyond grace.
3. Email renewal/failure reminders.

---

## 10. Operations & security

- **Secrets** (Worker secrets, never in git): `PAYPAL_CLIENT_ID`,
  `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV`, `RESEND_API_KEY`.
- **Vars** (`wrangler.toml`): `PAYPAL_PLAN_ID`, `RESEND_FROM_EMAIL`,
  `SUCCESS_URL`, `CANCEL_URL`.
- **Sandbox first**, then live. PayPal Business account required.
- **Rate-limit** `/v1/checkout` and `/v1/license/status`.
- **Never log** license/device secrets in plaintext; log device id only.
- D1 has automatic backups; still export periodically — it is the revenue record.
- Add a `/health` keep-alive probe if any free-tier pausing applies.

---

## 11. Legal / licensing blockers (resolve before shipping)

1. **`LICENSE` (MIT) vs `src-tauri/Cargo.toml` (`GPL-3.0`) conflict.** You cannot
   ship a closed premium tier over an accidental GPL declaration.
2. **Riot IP / ToS.** The app modifies the game and loads Riot-owned assets.
   Monetizing increases DMCA/legal exposure.
3. **PayPal freeze risk.** A complaint can freeze the account balance; keep
   records and don't rely on PayPal as the only rail long-term.

---

## 12. Open decisions

1. ~~Free vs paid split~~ — **resolved:** 3-day full-feature trial, then the app
   locks until an active subscription is connected. No permanent free tier.
2. ~~Price~~ — **resolved:** `$1.99`/month (set in the plan JSON; PayPal prices
   are immutable, so create a new plan to change it later).
3. ~~Domain~~ — **resolved:** reuse `pmvhavendownloader.com` (see §3.1).
4. **Suspended grace length** before revocation (proposed: 7 days).
5. **Refund policy** for a locked app after cancellation — decide a fair window.

> **Payment economics note:** at `$1.99`, PayPal's per-transaction fee
> (~2.99% + a small fixed amount) takes a meaningful share of each charge. That
> is inherent to low-ticket billing — worth modeling before launch, but not a
> blocker.

---

## 13. Phased implementation

| Phase | Deliverable |
|---|---|
| 0 | ✅ Worker scaffold + `wrangler.toml` + D1 schema + PayPal sandbox setup endpoint |
| 1 | ✅ `POST /v1/checkout` + verified/idempotent lifecycle webhooks → subscriber/license/device + `POST /v1/license/status` |
| 2 | Device deactivation / transfer and trial-reuse enforcement |
| 3 | Cron trial expiry / lapse revocation + Resend emails |
| 4 | Rust `license.rs` + gating in `patcher.rs` / `skins.rs` / `customs.rs` |
| 5 | React upgrade UI + checkout polling + deactivate |
| 6 | Account portal (optional) + hardening (rate limits, key/secret hygiene) |
