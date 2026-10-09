# Merchant onboarding

How a business goes from "visitor" to an approved merchant: self sign-up, the guided onboarding wizard, and compliance review. The review side (queue, document verification, four-eyes approval) is described in ROADMAP Phase 2 and `apps/api/src/modules/merchants`.

```
/signup ─▶ email code ─▶ /setup-mfa ─▶ /onboarding (wizard) ─▶ submit ─▶ compliance review ─▶ APPROVED
           (DRAFT merchant + owner created here)
```

## 1. Self sign-up (`/signup`)

| Step | API | Notes |
| --- | --- | --- |
| Open the page | `GET /v1/signup?ref=` | `{ enabled, referrer }`. The referrer comes from `?ref=` or from a partner's verified custom domain. |
| Details | `POST /v1/signup` | Takes name, business name, email, mobile, password, an optional `referral_code`, and `accept_terms: true`. Emails a 6-digit code. |
| Code | `POST /v1/signup/verify` | Creates the user, the DRAFT merchant and the `MERCHANT_OWNER` membership in one transaction. Signs in and sets the refresh cookie. |
| Resend | `POST /v1/signup/resend` | 30 s cooldown and at most 5 codes per sign-up. A new code resets the attempt count. |

**Security**
- A started sign-up lives only in Redis, for 15 minutes. Redis holds the argon2id password hash and a SHA-256 of the code, never the plaintext. The code itself expires after 10 minutes.
- **No account enumeration.**
  - A registered email gets an "you already have an account" email instead of a code, and the API response is identical.
  - Verifying such a sign-up fails exactly like a wrong code.
  - A taken mobile number is reported only after the email is proven, as `409`.
- Each sign-up allows 5 wrong codes. After that it is locked until a new code is sent.
- Rate limits:
  - `POST /v1/signup`: 10 per IP per hour and 5 per email per hour;
  - verify and resend: 30 per IP per 5 minutes.
- Password policy: the server-side `checkPasswordPolicy` (12+ characters, not the email name or mobile).
- The company and merchant ids are never taken from input. The owner's role is fixed at `MERCHANT_OWNER`.
- **Referrals.** The referrer must be an ACTIVE reseller or API partner.
  - `referral_code` is that organization's slug.
  - Without a code, a partner's verified custom domain counts as the referral. It is read from the browser-set `Origin` header.
  - Resellers become `reseller_id` (commission); API partners become the parent organization.
- `MERCHANT_OWNER` requires two-factor, so the first session is restricted to `/setup-mfa`.
- Audit: `merchant.created` (SYSTEM) and `merchant.signed_up` (the new user), with a masked email. Login history records the first sign-in.
- Emails sent: `signup_otp`, `signup_existing_account` and `signup_welcome`. Their content is encrypted at rest like all notifications.
- **Off switch:** `SIGNUP_ENABLED=false`. The API then answers `403`, and `/signup` shows "Sign-up is by invitation". Staff-created and reseller-created merchants are unaffected.

## 2. Onboarding wizard (`/onboarding`)

Merchants whose status is `DRAFT` or `MORE_INFORMATION_REQUIRED` land here after sign-in (`homePathFor` reads `onboarding.status` from `/v1/auth/me`).

| Step | Saves with | Requirements it covers |
| --- | --- | --- |
| 1. Business identity | `PATCH …/profile` (identity and address) | `profile.identity`, `pan`, `gstin_pan`, `cin`, `llpin`, `address` |
| 2. What you sell | `PATCH …/profile` (business, volumes, contact) | `profile.online_presence`, `business`, `volumes`, `services`, `contact` |
| 3. Directors and owners | `…/persons` | `persons.*` |
| 4. Settlement account | `…/bank-accounts` | `bank.primary` |
| 5. KYC documents | `…/documents` | `documents.*.uploaded` |
| 6. Review and submit | `POST …/submit` | All of the above, plus the declaration |

- Progress comes from the server's requirements engine (`compliance-requirements.ts`). The wizard never decides on its own what is required.
- The current step is kept in `?step=`. A fresh visit opens the first incomplete step. Steps can be skipped and revisited, and every save is immediate.
- Document uploads are per required type, with drag-and-drop. A rejected document shows the reviewer's reason and can be replaced.
- When compliance asks for more information, the wizard shows the request and the merchant resubmits from step 6.
- After submission the page becomes a status view:
  - a tracker (Application → Submitted → In review → Approved);
  - the approval-stage checks, such as document verification, the agreement and screening;
  - the review history.
- Once approved, it shows the next steps instead: first payment, API keys, team and balances.
- The dashboard shows an onboarding banner until approval. The individual Compliance pages (Business Profile, Documents and so on) remain for later edits.

## 3. Not yet included

- Verifying the mobile number by SMS (only the email is verified at sign-up).
- Automatic PAN, GSTIN and bank (penny-drop) verification; compliance verifies these by hand today.
- E-signing the merchant agreement.
- CAPTCHA on `/signup`. Rate limits are the current protection. Add one if bot sign-ups appear.
