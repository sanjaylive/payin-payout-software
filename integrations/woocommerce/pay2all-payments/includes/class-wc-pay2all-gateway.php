<?php
/**
 * Pay2All hosted checkout for WooCommerce.
 *
 * Flow: place order → a Pay2All checkout session for it (Idempotency-Key = order + attempt) → the
 * customer pays on Pay2All → comes back to the return endpoint, where the plugin asks the Pay2All
 * API (server to server) whether the session is PAID. The signed `payment.success` webhook marks the
 * order paid even if the customer never comes back. Nothing in the return URL is trusted.
 */

if (!defined('ABSPATH')) {
    exit;
}

class WC_Pay2All_Gateway extends WC_Payment_Gateway
{
    const META_SESSION = '_pay2all_session_id';
    const META_ATTEMPT = '_pay2all_attempt';

    public function __construct()
    {
        $this->id = 'pay2all';
        $this->method_title = 'Pay2All';
        $this->method_description = 'UPI, cards, netbanking and wallets on Pay2All’s secure hosted checkout.';
        $this->has_fields = false;
        $this->supports = ['products', 'refunds'];
        $this->init_form_fields();
        $this->init_settings();
        $this->title = $this->get_option('title');
        $this->description = $this->get_option('description');
        $this->enabled = $this->get_option('enabled');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
        add_action('woocommerce_api_pay2all_return', [$this, 'handle_return']);
        add_action('woocommerce_api_pay2all_webhook', [$this, 'handle_webhook']);
    }

    public function init_form_fields()
    {
        $this->form_fields = [
            'enabled' => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable Pay2All', 'default' => 'no'],
            'title' => ['title' => 'Title', 'type' => 'text', 'default' => 'UPI, cards & netbanking'],
            'description' => ['title' => 'Description', 'type' => 'textarea', 'default' => 'Pay securely with any UPI app, debit/credit card or netbanking.'],
            'api_base' => ['title' => 'API URL', 'type' => 'text', 'description' => 'Your Pay2All API address, e.g. https://api.example.com', 'default' => ''],
            'key_id' => ['title' => 'API key id', 'type' => 'text', 'description' => 'pk_test_… or pk_live_… (Developers → API keys). Give it the "Create payments" and "Read payments" permissions, plus "Refund payments" for refunds.', 'default' => ''],
            'key_secret' => ['title' => 'API secret', 'type' => 'password', 'default' => ''],
            'webhook_secret' => ['title' => 'Webhook signing secret', 'type' => 'password', 'description' => 'Add a webhook endpoint for ' . esc_html(WC()->api_request_url('pay2all_webhook')) . ' (Developers → Webhooks, event payment.success) and paste its whsec_… secret here.', 'default' => ''],
        ];
    }

    private function client()
    {
        return new \Pay2All\Client((string) $this->get_option('key_id'), (string) $this->get_option('key_secret'), (string) $this->get_option('api_base'), 20);
    }

    public function is_available()
    {
        return parent::is_available() && $this->get_option('key_id') && $this->get_option('key_secret') && $this->get_option('api_base') && get_woocommerce_currency() === 'INR';
    }

    /** 10-digit Indian mobile from the billing phone, or null. */
    private static function mobile($phone)
    {
        $digits = preg_replace('/\D/', '', (string) $phone);
        $ten = substr($digits, -10);
        return preg_match('/^[6-9]\d{9}$/', $ten) ? $ten : null;
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        // A new attempt after an expired / cancelled checkout gets its own reference.
        $attempt = (int) $order->get_meta(self::META_ATTEMPT) + 1;
        $reference = 'WC-' . $order->get_id() . '-' . $attempt;
        $customer = array_filter([
            'name' => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()) ?: null,
            'email' => $order->get_billing_email() ?: null,
            'mobile' => self::mobile($order->get_billing_phone()),
        ]);
        $returnUrl = add_query_arg(['order_id' => $order->get_id(), 'key' => $order->get_order_key()], WC()->api_request_url('pay2all_return'));
        try {
            $session = $this->client()->createCheckoutSession([
                'merchant_order_id' => $reference,
                'amount' => \Pay2All\Client::amount($order->get_total()),
                'description' => sprintf('Order #%s', $order->get_order_number()),
                'return_url' => $returnUrl,
                'customer' => (object) $customer,
                'metadata' => ['wc_order_id' => (string) $order->get_id()],
            ], $reference);
        } catch (\Pay2All\ApiException $e) {
            wc_add_notice('Payment could not be started: ' . esc_html($e->getMessage()), 'error');
            $order->add_order_note(sprintf('Pay2All: could not create checkout (%s, request %s).', $e->errorCode, (string) $e->requestId));
            return ['result' => 'failure'];
        }
        $order->update_meta_data(self::META_ATTEMPT, $attempt);
        $order->update_meta_data(self::META_SESSION, $session['id']);
        $order->save();
        return ['result' => 'success', 'redirect' => $session['url']];
    }

    /**
     * Apply a Pay2All session to the order. The session is always fetched from the API: the browser
     * or a webhook only tells us which one to look at.
     */
    public function sync_order($order)
    {
        $sessionId = (string) $order->get_meta(self::META_SESSION);
        if ($sessionId === '') {
            return 'UNKNOWN';
        }
        $session = $this->client()->getCheckoutSession($sessionId);
        if ($session['status'] === 'PAID' && !$order->is_paid()) {
            if ($session['amount'] !== \Pay2All\Client::amount($order->get_total())) {
                $order->update_status('on-hold', sprintf('Pay2All: paid ₹%s but the order total is ₹%s — check before shipping.', $session['amount'], \Pay2All\Client::amount($order->get_total())));
                return 'MISMATCH';
            }
            $payment = isset($session['payment']) && is_array($session['payment']) ? $session['payment'] : [];
            $order->payment_complete((string) ($payment['id'] ?? $session['payment_id'] ?? ''));
            $order->add_order_note(sprintf('Pay2All payment received (%s%s).', (string) ($payment['method'] ?? 'online'), !empty($payment['utr']) ? ', UTR ' . $payment['utr'] : ''));
        }
        return (string) $session['status'];
    }

    public function handle_return()
    {
        $order = wc_get_order(absint($_GET['order_id'] ?? 0));
        if (!$order || !hash_equals($order->get_order_key(), (string) ($_GET['key'] ?? ''))) {
            wp_safe_redirect(wc_get_cart_url());
            $this->stop();
            return;
        }
        try {
            $status = $this->sync_order($order);
        } catch (\Pay2All\ApiException $e) {
            $status = 'UNKNOWN';
        }
        if ($status === 'EXPIRED' || $status === 'CANCELLED') {
            wc_add_notice('The payment was not completed. You can try again.', 'notice');
            wp_safe_redirect($order->get_checkout_payment_url());
            $this->stop();
            return;
        }
        // PAID, or still being confirmed: the thank-you page shows the order's current state.
        wp_safe_redirect($this->get_return_url($order));
        $this->stop();
    }

    public function handle_webhook()
    {
        $raw = $this->raw_body();
        $header = (string) ($_SERVER['HTTP_PAY2ALL_SIGNATURE'] ?? '');
        if (!\Pay2All\Webhook::verify((string) $this->get_option('webhook_secret'), $header, $raw)) {
            status_header(400);
            $this->stop();
            return;
        }
        $event = \Pay2All\Webhook::parse($raw);
        if ($event['type'] === 'payment.success' && !empty($event['data']['merchant_order_id']) && preg_match('/^WC-(\d+)-\d+#\d+$/', (string) $event['data']['merchant_order_id'], $m)) {
            $order = wc_get_order((int) $m[1]);
            if ($order && $order->get_payment_method() === $this->id) {
                try {
                    $this->sync_order($order);
                } catch (\Pay2All\ApiException $e) {
                    status_header(503); // Pay2All retries the delivery.
                    $this->stop();
                    return;
                }
            }
        }
        status_header(200);
        $this->stop();
    }

    /** The webhook's raw bytes (the signature covers them exactly). */
    protected function raw_body()
    {
        return (string) file_get_contents('php://input');
    }

    /** End the request after a redirect or webhook answer (overridable for tests). */
    protected function stop()
    {
        exit;
    }

    public function process_refund($order_id, $amount = null, $reason = '')
    {
        $order = wc_get_order($order_id);
        $paymentId = (string) $order->get_transaction_id();
        if ($paymentId === '' || $amount === null || (float) $amount <= 0) {
            return new WP_Error('pay2all_refund', 'Nothing to refund through Pay2All for this order.');
        }
        try {
            $refund = $this->client()->refund($paymentId, \Pay2All\Client::amount($amount), 'WC-' . $order->get_id() . '-R' . count($order->get_refunds()), $reason);
        } catch (\Pay2All\ApiException $e) {
            return new WP_Error('pay2all_refund', 'Pay2All refund failed: ' . $e->getMessage());
        }
        $order->add_order_note(sprintf('Pay2All refund %s for ₹%s (%s).', (string) $refund['refund_id'], \Pay2All\Client::amount($amount), (string) $refund['status']));
        return true;
    }
}
