=== Pay2All Payments for WooCommerce ===
Requires at least: 6.0
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Accept UPI, cards, netbanking and wallets through Pay2All hosted checkout.

== Installation ==
1. Upload the `pay2all-payments` folder to `wp-content/plugins/` and activate it.
2. In your Pay2All dashboard:
   * Developers → Websites: add your shop's address (e.g. https://shop.example.com) and wait for approval.
   * Developers → API keys: create a key with "Create payments", "Read payments" and "Refund payments".
   * Developers → Webhooks: add `https://<your shop>/?wc-api=pay2all_webhook` for `payment.success`.
3. WooCommerce → Settings → Payments → Pay2All: enter the API URL, key id, secret and webhook secret; enable.

The store currency must be INR.

== How it works ==
* Placing an order opens Pay2All's secure checkout. The customer returns to the order confirmation.
* The order is marked paid only after the plugin confirms it with the Pay2All API (on return, and when the signed webhook arrives) — never from the browser alone.
* If the paid amount differs from the order total, the order is put on hold.
* Refunds from the order screen are sent to Pay2All.
