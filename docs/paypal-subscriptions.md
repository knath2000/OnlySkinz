# OnlySkinz — PayPal Subscription + License System

> ⚠️ **Superseded.** This is the exploratory design draft. See
> [`licensing-plan.md`](./licensing-plan.md) for the final, authoritative plan.

Design for a paid monthly subscription, automatic license‑key delivery, and
per‑device activation tracking, integrated with the existing Tauri 2 app.

> Status: design proposal. No code exists yet.
> Scope decision: **anonymity is not a requirement here** — this is a normal
> KYC'd PayPal Business setup.

---

## 1. Why a backend is required

The app is currently fully client‑side: Tauri 2 + React, no server, no accounts,
no updater. A *subscription* implies recurring money and *activation tracking*
implies knowing which devices a key is used on. Both require state that survives
outside the user's machine, so this adds a small **License/Subscription API**.

The split of responsibility:

| Concern | Where |
|---|---|
| Taking money, renewals, dunning, receipts | PayPal |
| Mapping PayPal subscription → our license | Backend |
| Issuing / revoking keys | Backend |
| Counting and limiting activations | Backend |
| Offline entitlement check (grace period) | Signed token verified in the app |
| Gating premium features | Rust commands in `src-tauri` |

---

## 2. Architecture

```
┌────────────┐   create subscription    ┌──────────────────────┐
│  Web site  │ ───────────────────────► │      PayPal          │
│ (marketing │ ◄─── approval URL ────── │  Subscriptions API    │
│  + portal) │                          │  + webhooks           │
└────────────┘                          └──────────┬───────────┘
                                                   │ webhooks (signed)
                                                   ▼
┌────────────┐  activate/refresh/   ┌──────────────────────────┐
│ Desktop app│  deactivate          │  License API (backend)   │
│  (Tauri)   │ ───────────────────► │  - webhook receiver      │
│            │ ◄── signed token ─── │  - license issuance      │
└────────────┘                      │  - activation tracking   │
                                    │  - email delivery        │
                                    └───────────┬──────────────┘
                                                │
                                       ┌────────▼────────┐
                                       │  Postgres/SQLite │
                                       └─────────────────┘
```

Suggested backend stack (any is fine):
- **Hono / Fastify on Node 20** (fast to build), or **Axum (Rust)** to match
  `src-tauri`.
- Postgres (managed) or SQLite for a single‑instance deploy.
- Deploy on Fly.io / Railway / Render / a small VPS.
- Transactional email via Postmark / Resend / SendGrid (needs a domain + SPF/DKIM).

Naming convention for REST endpoints below: `/v1/...`.

---

## 3. PayPal setup

### 3.1 Objects to create (one‑time, via API or dashboard)

1. **Product** — `POST /v1/catalogs/products`
   ```json
   { "name": "OnlySkinz Pro", "type": "SERVICE", "category": "SOFTWARE" }
   ```
2. **Plan** — `POST /v1/billing/plans`
   ```json
   {
     "product_id": "PROD-XXXX",
     "name": "OnlySkinz Pro Monthly",
     "billing_cycles": [{
       "frequency": { "interval_unit": "MONTH", "interval_count": 1 },
       "tenure_type": "REGULAR",
       "sequence": 1,
       "total_cycles": 0
     }],
     "payment_preferences": {
       "auto_bill_outstanding": true,
       "payment_failure_threshold": 2
     }
   }
   ```
3. **Webhook** — `POST /v1/notifications/webhooks`, subscribe to the events in §3.4.
   Store the returned `webhook_id`; it is needed for signature verification.

### 3.2 Buyer flow

Recommended: create the subscription **server‑side** so we can attach our own
`custom_id` (a correlation id) to it.

```
POST /v1/billing/subscriptions
{
  "plan_id": "P-XXXX",
  "custom_id": "<our checkout session id>",
  "application_context": {
    "brand_name": "OnlySkinz",
    "user_action": "SUBSCRIBE_NOW",
    "return_url": "https://onlyskinz.app/checkout/success",
    "cancel_url": "https://onlyskinz.app/checkout/cancel"
  }
}
```

The response contains an approval link (`links[rel=approve].href`). Send the
user there. After approval PayPal redirects to `return_url`.

> PayPal does not pass arbitrary data through the approval redirect reliably, so
> the `custom_id` set at creation is the authoritative correlation handle.

### 3.3 Linking payment to a user

There are no user accounts in the app. We identify a subscriber by:
- `paypal_subscription_id` (authoritative), and
- the **email on the PayPal account** (used for key delivery and lookup).

`custom_id` links the pre‑checkout intent to the eventual PayPal subscription.

### 3.4 Webhook events that matter

| Event | Action |
|---|---|
| `BILLING.SUBSCRIPTION.ACTIVATED` | Create subscriber + generate + email license key |
| `PAYMENT.SALE.COMPLETED` | Extend `current_period_end`, refresh entitlements |
| `BILLING.SUBSCRIPTION.UPDATED` | Re‑sync plan / status |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Enter grace period, warn user |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Start dunning/grace |
| `BILLING.SUBSCRIPTION.CANCELLED` | Revoke at end of paid period (not immediately) |
| `BILLING.SUBSCRIPTION.EXPIRED` | Revoke license |
| `PAYMENT.SALE.REFUNDED` / `REVERSED` | Revoke / claw back |

### 3.5 Webhook handling rules

1. **Verify** every request with
   `POST /v1/notifications/verify-webhook-signature` (send the event back
   **byte‑for‑byte as received** — do not re‑serialize).
2. **Idempotency**: store `event.id` in `webhook_events` with a UNIQUE
   constraint; ignore duplicates.
3. **Do not trust the event payload alone.** Webhooks can arrive out of order or
   late. On any state‑changing event, re‑fetch the subscription with
   `GET /v1/billing/subscriptions/{id}` and use that as the source of truth.
4. Always return `200` quickly; process asynchronously.

---

## 4. Data model

```sql
CREATE TABLE subscribers (
  id                     BIGSERIAL PRIMARY KEY,
  email                  TEXT NOT NULL,
  paypal_subscription_id TEXT UNIQUE,
  paypal_payer_id        TEXT,
  plan_id                TEXT NOT NULL,
  status                 TEXT NOT NULL,      -- ACTIVE|SUSPENDED|CANCELLED|EXPIRED
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE licenses (
  id             BIGSERIAL PRIMARY KEY,
  subscriber_id  BIGINT NOT NULL REFERENCES subscribers(id),
  license_key    TEXT UNIQUE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active', -- active|revoked
  max_activations INTEGER NOT NULL DEFAULT 2,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE activations (
  id           BIGSERIAL PRIMARY KEY,
  license_id   BIGINT NOT NULL REFERENCES licenses(id),
  device_id    TEXT NOT NULL,          -- stable per-install id from the app
  device_name  TEXT,
  app_version  TEXT,
  first_seen   TIMESTAMPTZ DEFAULT now(),
  last_seen    TIMESTAMPTZ DEFAULT now(),
  deactivated_at TIMESTAMPTZ,
  UNIQUE (license_id, device_id)
);

CREATE TABLE webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  paypal_event_id TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ
);

CREATE TABLE checkout_intents (
  id          TEXT PRIMARY KEY,        -- becomes custom_id
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. License key generation & auto‑distribution

### 5.1 Key format

`OSK-XXXXX-XXXXX-XXXXX-XXXXX` using Crockford Base32 over ~100 bits of CSPRNG
entropy plus a checksum symbol. Store only a **hash** of the key if you want
defence‑in‑depth against DB leaks; keep the plaintext only long enough to email.

### 5.2 When a key is issued

Triggered by `BILLING.SUBSCRIPTION.ACTIVATED`:

1. Upsert `subscribers` from the PayPal subscription + payer email.
2. If no license exists, generate a key and insert into `licenses`.
3. Email the key to the PayPal email address.
4. Record the event in `webhook_events`.

### 5.3 Delivery channels

| Channel | Notes |
|---|---|
| **Email** | Primary. Sent from a no‑reply address on your domain. |
| **Success page** | `return_url` renders the key with a Copy button, looked up by subscription id (requires a short‑lived signed URL). |
| **Portal** | `POST /v1/portal/login` → email OTP/magic link → lists keys, devices, next billing date, cancel link. |

Recovery path is important: buyers lose emails. The portal + "resend key"
endpoint handle this.

---

## 6. Activation & tracking API

All app→server traffic goes **through Rust (`ureq`)**, not the webview, to avoid
CORS and to keep tokens out of JS.

### `POST /v1/license/activate`
```json
{ "license_key": "OSK-...", "device_id": "...", "device_name": "Kalyans-MBP", "app_version": "0.2.0" }
```
Behaviour:
1. Look up license; check `status='active'` and subscriber
   `status ∈ {ACTIVE, SUSPENDED}` and `current_period_end > now` (or grace).
2. Count active activations. If `< max_activations`, insert/refresh this device.
   Otherwise return `409 activation_limit_reached` with the device list.
3. Return a **signed token**.

### `POST /v1/license/refresh`
Same body; updates `last_seen`, re‑evaluates subscription, returns a fresh token.

### `POST /v1/license/deactivate`
Releases the device (`deactivated_at = now`), freeing a slot.

### `GET /v1/portal/...`
Authenticated by email OTP; lists/removes devices, resends keys, opens the
PayPal cancel URL.

### 6.1 Device identity

- `device_id` = a random UUID generated on first run and stored in the **macOS
  Keychain** (survives app‑data deletion; better than a plain file).
- Optionally combine with the hardware `IOPlatformUUID` for extra stability.
- Note: the app relaunches as **root**, so Keychain access must use the right
  keychain and run for the console user, not as root. Decide deliberately
  whether device identity lives in user scope (recommended) or root scope.

### 6.2 Signed token (offline grace)

Use a compact **Ed25519‑signed** token (PASETO or a JWT with `alg=EdDSA`):

```json
{
  "sub": "lic_123",
  "dev": "sha256(device_id)[:16]",
  "ent": ["pro"],
  "iat": 1750000000,
  "exp": 1750604800,
  "ver": 1
}
```

- Public key embedded in the app; private key on the server only.
- Short expiry (e.g., **7 days**), refreshed on launch/at most daily.
- **Offline grace**: the app keeps working for up to N days (e.g., 14) past
  token expiry when it cannot reach the server, then degrades to free. This
  keeps paying users happy on planes/offline and avoids hard lockouts.

Rust crates: `ed25519-dalek`, `base64`, `serde_json` (add to
`src-tauri/Cargo.toml`).

---

## 7. App integration (`src-tauri` + `src`)

### 7.1 New Rust module

`src-tauri/src/commands/license.rs`:
- `activate_license(key, device_name) -> LicenseStatus`
- `refresh_license() -> LicenseStatus`
- `deactivate_license() -> ()`
- `get_license_status() -> LicenseStatus` (reads cached token, offline verify)
- `license.rs` also owns device‑id generation + Keychain storage.

Register the commands in `src-tauri/src/lib.rs` alongside the existing handlers.

### 7.2 Gating points

Entitlement checks belong in Rust, not just the React UI:

| Feature | File | Gate |
|---|---|---|
| Apply skins / patcher | `commands/patcher.rs` | `pro` |
| Batch download all | `commands/skins.rs` (`download_multiple_skins`) | `pro` |
| Custom mod import | `commands/customs.rs` (`import_custom`) | `pro` |
| Browsing / single apply | elsewhere | free tier |

A single `require_entitlement("pro")?` helper keeps this consistent.

### 7.3 Frontend

- `src/hooks/useLicense.ts` — wraps `invoke` calls, caches status.
- Activation modal: paste key → `activate_license`.
- Account panel: status, next billing date, devices, "Manage subscription"
  (opens the PayPal portal link), "Deactivate this device".
- Replace the current `src/hooks/useVersionCheck.ts` panel location (or add
  alongside it) with subscription status.

### 7.4 Not a security boundary

Because the app runs locally, a determined user can patch the binary. Signed
tokens + server activation raise the effort enough to matter; they are not
DRM. Accept this and design for honest‑user conversion.

---

## 8. Web portal (small, but expected)

- Landing/pricing page with the PayPal subscribe button.
- `/checkout/success` — shows the issued key (copy button) and setup steps.
- `/account` — email OTP login → keys, devices (remove), next billing, cancel.
- Cancellation can simply deep‑link to PayPal's subscription management.

---

## 9. Operations & security

- **Secrets**: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
  `PAYPAL_ENV`, Ed25519 private key, email provider key. Store in the host's
  secret manager; never in the repo.
- **Sandbox first**: PayPal sandbox buyer + business accounts; repeat with live.
- **Rate limit** `/license/activate` and OTP endpoints; log device id only,
  never the license key in plaintext.
- **Grace/dunning**: `payment_failure_threshold` on the plan + a grace window
  before revocation, so failed cards don't instantly lock users out.
- **Backups** of the DB; it is the record of who paid.
- **Monitoring** for webhook failures (PayPal will retry, but alert anyway).

---

## 10. Phased implementation plan

| Phase | Deliverable |
|---|---|
| 0 | PayPal sandbox: product, plan, webhook → backend that verifies + logs events |
| 1 | DB + `BILLING.SUBSCRIPTION.ACTIVATED` → subscriber + license + email delivery |
| 2 | `activate` / `refresh` / `deactivate` + device tracking + signed tokens |
| 3 | App integration: license module, gating, activation UI, offline grace |
| 4 | Portal: key retrieval, device management, cancel |
| 5 | Hardening: rate limits, dunning, monitoring, key hashing |

---

## 11. Open decisions

1. **Backend language** — TypeScript (fastest) vs Rust/Axum (consistency).
2. **Device limit** — 1, 2, or 3 concurrent activations.
3. **Trial** — none, 3‑day, or 7‑day (PayPal supports a `TRIAL` billing cycle).
4. **Offline grace length** — 7 / 14 / 30 days.
5. **Free tier split** — which exact features stay free (drives conversion).
6. **Legal/licensing** — resolve the `LICENSE` (MIT) vs `src-tauri/Cargo.toml`
   (`GPL-3.0`) conflict before shipping a closed premium tier. Also weigh the
   Riot ToS / DMCA exposure and PayPal's willingness to freeze on complaint.
