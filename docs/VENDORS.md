# API vendors

An **API vendor** is a company Pay2All integrates with: a bank, a payment partner, an SMS gateway or an email service. Vendors are managed in **Admin → Settings → API Vendors** (`provider.read` / `provider.manage`, platform staff only).

| A vendor offers… | Stored as | Managed on |
| --- | --- | --- |
| Payin / payout | `providers` rows (`vendor_id`): integration, credentials, capabilities, routing, health | The vendor page → each payment service |
| SMS, WhatsApp, email | `messaging_services` rows: integration, config, encrypted credentials, priority | The vendor page → messaging services |

Example:
- **IDFC FIRST Bank:** payout service.
- **Yes Bank:** payin service.
- **SMS21:** SMS and WhatsApp.
- **Amazon Web Services:** SES email.

## 1. Payment services (banks, PSPs)

Each payment vendor needs an **integration coded from its API document**. Banks differ in authentication (often mutual TLS and IP whitelisting), request encryption, checksums and status codes. An integration lives in `packages/providers/src/<vendor>/` behind the `PayinProvider` / `PayoutProvider` interfaces, the same contract as the existing ones.

Once the integration exists:
1. **Add payment service** on the vendor page, choosing the integration. It starts disabled.
2. Set its credentials. They are encrypted and write-only.
3. Run **Test connection**.
4. Enable it.
5. Add routing rules under Settings → Routing.

A bank that offers both payin and payout keeps both services under one vendor. **Move here** regroups existing services.

Purely configurable payment integrations (pasting URLs and field mappings into a form) are deliberately not offered. For money-moving APIs, a mis-mapped status field can report a failed transfer as successful.

## 2. Messaging services and routing

| Channel | Integrations |
| --- | --- |
| Email | Amazon SES (`ses`, recommended), any SMTP server (`smtp`) |
| SMS | sms21.in (`sms21`) |
| WhatsApp | sms21.in (`sms21`) |

**Routing:** for each notification, the worker tries the **ACTIVE** services of **ACTIVE** vendors for that channel in `priority` order (lowest first):
- A send that fails for **transient** reasons falls through to the next service: vendor down, rate limited, wallet empty, network.
- If every service fails, the notification is retried later (1 min, 5 min, 15 min, 1 h), then marked FAILED.
- A **permanent** rejection of the message itself stops at once with no fallback or retry: invalid recipient, template not approved, suppressed number.
- **Test sends** go through one chosen service only, even while it is disabled.
- If no email service is active, email falls back to the server's `SMTP_URL`, which is the behaviour before vendors existed.

Settings → Routing shows the effective order per channel.

**Safety:**
- **Content:** message content is stored encrypted until it is sent, then wiped (as before).
- **Credentials:** credentials are encrypted with AES-256-GCM, bound to the service (AAD `messaging:<id>`), never returned by the API, and shown only as key name plus last 4 characters.
- **Audit:** every config change needs a reason; it and every credential rotation are audited.
- **Delivery tracking:** each sent notification records the service that sent it and the vendor's message id.

## 3. Integrations

### Amazon SES (email)
- **Config:**
  - region (e.g. `ap-south-1`);
  - from address, which must be a verified SES identity;
  - optional from name, reply-to, and a configuration set for bounce/complaint events;
  - `use_instance_role` to use the server's IAM role instead of stored keys.
- **Credentials:** access key ID and secret access key, for an IAM user limited to `ses:SendEmail`.
- **Calls:** the SES v2 `SendEmail` API, plain text.
- **Errors:** `MessageRejected` and unverified-domain errors are permanent; throttling and outages are retryable.
- **Before going live:** verify the sending domain (DKIM, SPF, DMARC), request production access (leave the SES sandbox), and set up a configuration set for bounces and complaints.

### SMTP (email)
Host, port, TLS and from address; username and password are optional. Use it for an existing mail relay or for Mailpit in development.

### sms21.in (SMS and WhatsApp)
Integrated from the sms21 OpenAPI specification (`https://api.sms21.in/v1`).

- **Credentials:** the project API key (`sms21_live_…` / `sms21_test_…`), sent as `X-API-Key`.
- **Retries:** every message is sent with `Idempotency-Key: <notification id>`, so a retry after a timeout returns the original message instead of sending twice.
- **Templates:** config maps each Pay2All message key (e.g. `payout_alert`, `test`) to an sms21 template and the variable names it takes.
  - **SMS:** with a template, `POST /sms/send {to, templateId, variables}`. **Live SMS to India must use DLT-approved templates** (entity, sender header and template registered on DLT and in sms21). Without a template, the message goes as free text, which only works with test keys.
  - **WhatsApp:** with a template, `POST /whatsapp/template`. Without one, `POST /whatsapp/send` sends free text, which WhatsApp only delivers within 24 h of the customer's last message, so business-initiated messages need an approved template.
- **Errors:** sms21 codes such as `TEMPLATE_NOT_APPROVED`, `INVALID_RECIPIENT` and `RECIPIENT_SUPPRESSED` are permanent; 429, 5xx and network errors are retryable.

### Delivery receipts
"SENT" means accepted by the vendor. What happens next arrives as a receipt and is stored on the notification (`delivery_status`, `delivery_at`, `delivery_detail`). It shows under Settings → API Vendors → *Recent messages*, together with a 7-day delivered / failed / no-receipt summary.

- **sms21** (`POST /v1/webhooks/messaging/sms21/:serviceId`):
  - **Setup:** add this URL as an sms21 webhook endpoint for message events, and save its signing secret as the service's `webhook_secret` credential.
  - **Verification:** `SMS21-Signature` (`t=…,v1=HMAC-SHA256("t.raw body")`, any `v1` accepted during rotation, 5-minute window).
  - **Status mapping:** `sent` → SENT; `delivered` → DELIVERED; `failed` / `rejected` → FAILED; `expired` → EXPIRED.
- **Amazon SES** (`POST /v1/webhooks/messaging/ses/:serviceId`):
  - **Setup:** publish the identity's or configuration set's Delivery, Bounce and Complaint events to an SNS topic, subscribe this HTTPS URL, and set `sns_topic_arn` in the service's settings.
  - **Verification:** the SNS signature (v1 SHA1 or v2 SHA256), using a certificate fetched only from `https://sns.<region>.amazonaws.com/….pem` (cached 1 h). Only the configured topic is accepted, and only an SNS-hosted `SubscribeURL` is followed when confirming the subscription.
  - **Event mapping:** Delivery → DELIVERED; permanent Bounce → BOUNCED; Complaint → COMPLAINED. Transient bounces are noted only.
- **Applied once, never backwards:**
  - Receipts are applied once per vendor event id (`messaging_receipt_events`).
  - A final status is never replaced by a non-final or older one.
- **Suppression:**
  - A permanent bounce or a complaint adds the address to `email_suppressions`, stored only as a keyed blind index with a masked copy for display.
  - The worker refuses to email a suppressed address and fails the notification at once.
  - Admins see the masked list under Settings → API Vendors and can remove an entry (step-up) once the mailbox is fixed.

Saving credentials merges with the stored set: a blank field keeps its value, so adding the webhook secret doesn't need the API key again.

## 4. Setting up (per environment)

1. Settings → API Vendors → **SMS21** (seeded in development; otherwise **Add vendor**).
2. **SMS21 SMS** → Credentials: the API key. Edit → templates: map `test` and each message you send to its DLT template.
3. **Send test** to your mobile, then check **Recent messages** for the sms21 message id or error.
4. Edit → switch **Active** on, with a reason.
5. Repeat for WhatsApp, and for **Amazon Web Services → Amazon SES** with its keys and verified from address.

Development seeds create these three services switched off, with no credentials (`packages/database/prisma/seed-vendors.ts`). Production starts empty.
