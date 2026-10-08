# Pay2All for OpenCart 4.0.2+

**Status: beta.** Syntax-checked and built on the same PHP client that is tested against the Pay2All API, but not yet run on a live OpenCart store. Try it on a staging store first.

## Install

1. Zip the contents of this folder as `pay2all.ocmod.zip` (the zip root holds `install.json`, `admin/`, `catalog/`, `system/`).
2. Extensions → Installer → upload; then Extensions → Extensions → Payments → Pay2All → install and edit.
3. In Pay2All: add your store under Developers → Websites (wait for approval), create an API key (create/read payments), and add the webhook URL shown on the settings page for `payment.success`.

## How it works

- "Pay securely" creates a checkout session (`OC-<order>-<attempt>`) and sends the customer to Pay2All.
- On return, the extension asks the Pay2All API whether that session is PAID before changing the order. A return URL is bound to its order with an HMAC, and the session id lives in the customer's OpenCart session.
- The signed `payment.success` webhook completes orders whose customers never came back.
- A paid amount that differs from the order total is recorded with the fraud status instead of the paid status.
- Refunds: issue them from the Pay2All dashboard (no OpenCart refund hook).
