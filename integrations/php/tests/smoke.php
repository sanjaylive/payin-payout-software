<?php
// Exercises the PHP client against a running API (used by apps/api/test/php-sdk.e2e-spec.ts).
// Usage: php smoke.php <base_url> <key_id> <secret> <return_url>
require __DIR__ . '/../src/Pay2All.php';

use Pay2All\ApiException;
use Pay2All\Client;
use Pay2All\Webhook;

[$_, $base, $key, $secret, $returnUrl] = $argv;
$out = [];
$p2a = new Client($key, $secret, $base, 10);
$order = 'PHP-' . bin2hex(random_bytes(4));

$session = $p2a->createCheckoutSession([
    'merchant_order_id' => $order,
    'amount' => Client::amount(1499),
    'description' => 'PHP SDK smoke',
    'return_url' => $returnUrl,
], $order);
$out['session_status'] = $session['status'];
$out['session_amount'] = $session['amount'];
// Same idempotency key: same session, not a second one.
$out['replay_same_id'] = $p2a->createCheckoutSession(['merchant_order_id' => $order, 'amount' => '1499.00', 'description' => 'PHP SDK smoke', 'return_url' => $returnUrl], $order)['id'] === $session['id'];
$out['retrieved'] = $p2a->getCheckoutSession($session['id'])['merchant_order_id'] === $order;

$link = $p2a->createPaymentLink(['amount' => '250.00', 'description' => 'PHP link'], 'link-' . $order);
$out['link_object'] = $link['object'];

try {
    $p2a->getCheckoutSession('cs_00000000000000000000000000');
} catch (ApiException $e) {
    $out['not_found'] = [$e->errorCode, $e->httpStatus];
}
try {
    (new Client($key, 'wrong-secret', $base, 10))->getCheckoutSession($session['id']);
} catch (ApiException $e) {
    $out['bad_secret'] = [$e->errorCode, $e->httpStatus];
}

$body = '{"id":"evt_1","type":"payment.success","data":{}}';
$t = time();
$sig = hash_hmac('sha256', $t . '.' . $body, 'whsec_test');
$out['webhook_ok'] = Webhook::verify('whsec_test', "t=$t,v1=$sig", $body);
$out['webhook_tampered'] = Webhook::verify('whsec_test', "t=$t,v1=$sig", $body . ' ');
$out['webhook_stale'] = Webhook::verify('whsec_test', "t=" . ($t - 3600) . ",v1=" . hash_hmac('sha256', ($t - 3600) . '.' . $body, 'whsec_test'), $body);
$out['webhook_rotated'] = Webhook::verify('whsec_test', "t=$t,v1=deadbeef,v1=$sig", $body);
echo json_encode($out), "\n";
