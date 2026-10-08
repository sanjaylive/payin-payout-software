<?php
// Drives the real WC_Pay2All_Gateway against a running Pay2All API with minimal WordPress /
// WooCommerce stand-ins (used by apps/api/test/php-integrations.e2e-spec.ts). Not a WordPress test:
// it checks the plugin's API usage, signature checks and order decisions.
//
// Usage: php harness.php <api_base> <key_id> <secret> <webhook_secret> <step> [json-state]
define('ABSPATH', __DIR__);

final class Stopped extends Exception {}
$GLOBALS['log'] = ['notices' => [], 'redirect' => null, 'status' => null];

class WC_Payment_Gateway
{
    public $id; public $method_title; public $method_description; public $has_fields; public $supports = []; public $title; public $description; public $enabled; public $form_fields = [];
    public $settings = [];
    public function init_settings() {}
    public function get_option($k) { return $this->settings[$k] ?? ''; }
    public function is_available() { return true; }
    public function get_return_url($order) { return 'https://shop.example.com/checkout/order-received/' . $order->get_id(); }
}
class WP_Error { public $code; public $message; public function __construct($c, $m) { $this->code = $c; $this->message = $m; } }
class WC_Order
{
    public $id; public $total; public $meta = []; public $paid = false; public $txn = ''; public $notes = []; public $status = 'pending';
    public function __construct($id, $total, $meta = []) { $this->id = $id; $this->total = $total; $this->meta = $meta; }
    public function get_id() { return $this->id; }
    public function get_order_number() { return (string) $this->id; }
    public function get_total() { return $this->total; }
    public function get_order_key() { return 'wc_order_key_' . $this->id; }
    public function get_billing_first_name() { return 'Asha'; }
    public function get_billing_last_name() { return 'Rao'; }
    public function get_billing_email() { return 'asha@example.com'; }
    public function get_billing_phone() { return '+91 98765 43210'; }
    public function get_meta($k) { return $this->meta[$k] ?? ''; }
    public function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    public function save() {}
    public function is_paid() { return $this->paid; }
    public function payment_complete($txn) { $this->paid = true; $this->txn = $txn; $this->status = 'processing'; }
    public function update_status($s, $note) { $this->status = $s; $this->notes[] = $note; }
    public function add_order_note($n) { $this->notes[] = $n; }
    public function get_checkout_payment_url() { return 'https://shop.example.com/checkout/order-pay/' . $this->id; }
    public function get_payment_method() { return 'pay2all'; }
    public function get_transaction_id() { return $this->txn; }
    public function get_refunds() { return []; }
}
function add_action() {}
function add_filter() {}
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function absint($v) { return abs((int) $v); }
function add_query_arg(array $args, $url) { return $url . (strpos($url, '?') === false ? '?' : '&') . http_build_query($args); }
function wc_add_notice($m, $t) { $GLOBALS['log']['notices'][] = [$t, $m]; }
function wc_get_cart_url() { return 'https://shop.example.com/cart'; }
function wp_safe_redirect($u) { $GLOBALS['log']['redirect'] = $u; }
function status_header($c) { $GLOBALS['log']['status'] = $c; }
function get_woocommerce_currency() { return 'INR'; }
function WC() { return new class { public function api_request_url($n) { return 'https://shop.example.com/?wc-api=' . $n; } }; }
function wc_get_order($id) { return $GLOBALS['orders'][(int) $id] ?? false; }

require __DIR__ . '/../pay2all-payments/lib/Pay2All.php';
require __DIR__ . '/../pay2all-payments/includes/class-wc-pay2all-gateway.php';

final class TestGateway extends WC_Pay2All_Gateway
{
    public $raw = '';
    protected function raw_body() { return $this->raw; }
    protected function stop() { throw new Stopped(); }
}

[$_, $base, $key, $secret, $whsec, $step] = $argv;
$state = isset($argv[6]) ? json_decode($argv[6], true) : [];
$gw = new TestGateway();
$gw->settings = ['enabled' => 'yes', 'api_base' => $base, 'key_id' => $key, 'key_secret' => $secret, 'webhook_secret' => $whsec];
$order = new WC_Order((int) ($state['order_id'] ?? random_int(100000, 999999)), $state['total'] ?? '1499.00', $state['meta'] ?? []);
$order->txn = $state['txn'] ?? '';
$order->paid = !empty($state['paid']);
$GLOBALS['orders'][$order->get_id()] = $order;
$out = ['step' => $step];

try {
    switch ($step) {
        case 'pay':
            $out['result'] = $gw->process_payment($order->get_id());
            break;
        case 'return':
            $_GET = ['order_id' => $order->get_id(), 'key' => $state['key'] ?? $order->get_order_key()];
            $gw->handle_return();
            break;
        case 'webhook':
            $gw->raw = $state['body'];
            $_SERVER['HTTP_PAY2ALL_SIGNATURE'] = $state['signature'];
            $gw->handle_webhook();
            break;
        case 'refund':
            $r = $gw->process_refund($order->get_id(), $state['amount'], 'Customer returned the item');
            $out['refund'] = $r === true ? true : ($r instanceof WP_Error ? $r->message : $r);
            break;
    }
} catch (Stopped $e) {
    $out['stopped'] = true;
}
$out['order'] = ['id' => $order->id, 'paid' => $order->paid, 'txn' => $order->txn, 'status' => $order->status, 'notes' => $order->notes, 'meta' => $order->meta];
$out['log'] = $GLOBALS['log'];
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
