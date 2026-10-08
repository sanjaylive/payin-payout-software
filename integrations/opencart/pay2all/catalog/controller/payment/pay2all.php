<?php
namespace Opencart\Catalog\Controller\Extension\Pay2all\Payment;

require_once DIR_EXTENSION . 'pay2all/system/library/Pay2All.php';

/**
 * Pay2All hosted checkout for OpenCart 4.0.2+. The order is marked paid only after the Pay2All API
 * (server to server) says its checkout session is PAID: on the customer's return and on the signed
 * payment.success webhook. Nothing the browser brings back is trusted.
 */
class Pay2all extends \Opencart\System\Engine\Controller
{
    private function client(): \Pay2All\Client
    {
        return new \Pay2All\Client((string) $this->config->get('payment_pay2all_key_id'), (string) $this->config->get('payment_pay2all_key_secret'), (string) $this->config->get('payment_pay2all_api_base'), 20);
    }

    /** Binds the return URL to the order so it can't be replayed for another one. */
    private function returnToken(int $orderId): string
    {
        return substr(hash_hmac('sha256', 'return:' . $orderId, (string) $this->config->get('payment_pay2all_key_secret')), 0, 32);
    }

    private function link(string $route, string $args = ''): string
    {
        return str_replace('&amp;', '&', $this->url->link($route, $args));
    }

    public function index(): string
    {
        $this->load->language('extension/pay2all/payment/pay2all');
        $data['confirm'] = $this->link('extension/pay2all/payment/pay2all.confirm', 'language=' . $this->config->get('config_language'));
        return $this->load->view('extension/pay2all/payment/pay2all', $data);
    }

    /** Create the checkout session for the order in the session and hand the customer over. */
    public function confirm(): void
    {
        $this->load->language('extension/pay2all/payment/pay2all');
        $json = [];
        $orderId = (int) ($this->session->data['order_id'] ?? 0);
        $this->load->model('checkout/order');
        $order = $orderId ? $this->model_checkout_order->getOrder($orderId) : [];
        if (!$order || ($this->session->data['payment_method']['code'] ?? '') !== 'pay2all.pay2all') {
            $json['error'] = $this->language->get('error_order');
        }
        if (!$json) {
            $reference = 'OC-' . $orderId . '-' . base_convert((string) time(), 10, 36);
            $mobile = substr(preg_replace('/\D/', '', (string) $order['telephone']), -10);
            $customer = array_filter([
                'name' => trim($order['firstname'] . ' ' . $order['lastname']) ?: null,
                'email' => $order['email'] ?: null,
                'mobile' => preg_match('/^[6-9]\d{9}$/', $mobile) ? $mobile : null,
            ]);
            try {
                $session = $this->client()->createCheckoutSession([
                    'merchant_order_id' => $reference,
                    'amount' => \Pay2All\Client::amount($this->currency->format($order['total'], 'INR', '', false)),
                    'description' => sprintf($this->language->get('text_description'), $orderId),
                    'return_url' => $this->link('extension/pay2all/payment/pay2all.callback', 'order_id=' . $orderId . '&token=' . $this->returnToken($orderId)),
                    'customer' => (object) $customer,
                    'metadata' => ['oc_order_id' => (string) $orderId],
                ], $reference);
                $this->session->data['pay2all_session_id'] = $session['id'];
                $json['redirect'] = $session['url'];
            } catch (\Pay2All\ApiException $e) {
                $this->log->write('Pay2All: could not create checkout for order ' . $orderId . ' (' . $e->errorCode . ', request ' . $e->requestId . ')');
                $json['error'] = $this->language->get('error_create');
            }
        }
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json));
    }

    /** Apply a session (fetched from the API) to its order. Returns the session status. */
    private function apply(int $orderId, array $session): string
    {
        $this->load->model('checkout/order');
        $order = $this->model_checkout_order->getOrder($orderId);
        if (!$order) {
            return 'UNKNOWN';
        }
        $paidStatus = (int) $this->config->get('payment_pay2all_order_status_id');
        if ($session['status'] === 'PAID' && (int) $order['order_status_id'] !== $paidStatus) {
            $expected = \Pay2All\Client::amount($this->currency->format($order['total'], 'INR', '', false));
            if ($session['amount'] !== $expected) {
                $this->model_checkout_order->addHistory($orderId, (int) $this->config->get('config_fraud_status_id') ?: 1, sprintf('Pay2All: paid ₹%s but the order total is ₹%s — check before shipping.', $session['amount'], $expected));
                return 'MISMATCH';
            }
            $p = is_array($session['payment'] ?? null) ? $session['payment'] : [];
            $this->model_checkout_order->addHistory($orderId, $paidStatus, sprintf('Pay2All payment %s received (%s%s).', (string) ($p['id'] ?? ''), (string) ($p['method'] ?? 'online'), !empty($p['utr']) ? ', UTR ' . $p['utr'] : ''), true);
        }
        return (string) $session['status'];
    }

    public function callback(): void
    {
        $orderId = (int) ($this->request->get['order_id'] ?? 0);
        $token = (string) ($this->request->get['token'] ?? '');
        $sessionId = (string) ($this->session->data['pay2all_session_id'] ?? '');
        if (!$orderId || !hash_equals($this->returnToken($orderId), $token) || $sessionId === '') {
            $this->response->redirect($this->link('checkout/cart'));
            return;
        }
        try {
            $session = $this->client()->getCheckoutSession($sessionId);
            $status = ($session['metadata']['oc_order_id'] ?? '') === (string) $orderId ? $this->apply($orderId, $session) : 'UNKNOWN';
        } catch (\Pay2All\ApiException $e) {
            $status = 'UNKNOWN';
        }
        if ($status === 'PAID') {
            $this->response->redirect($this->link('checkout/success'));
            return;
        }
        if ($status === 'EXPIRED' || $status === 'CANCELLED') {
            $this->load->language('extension/pay2all/payment/pay2all');
            $this->session->data['error'] = $this->language->get('error_not_completed');
            $this->response->redirect($this->link('checkout/checkout'));
            return;
        }
        // Still being confirmed by the bank: the webhook will complete the order.
        $this->load->model('checkout/order');
        $this->model_checkout_order->addHistory($orderId, (int) $this->config->get('config_order_status_id'), 'Pay2All: waiting for the bank to confirm the payment.');
        $this->response->redirect($this->link('checkout/success'));
    }

    public function webhook(): void
    {
        $raw = (string) file_get_contents('php://input');
        $header = (string) ($this->request->server['HTTP_PAY2ALL_SIGNATURE'] ?? '');
        if (!\Pay2All\Webhook::verify((string) $this->config->get('payment_pay2all_webhook_secret'), $header, $raw)) {
            http_response_code(400);
            return;
        }
        $event = \Pay2All\Webhook::parse($raw);
        $reference = (string) ($event['data']['merchant_order_id'] ?? '');
        if ($event['type'] === 'payment.success' && preg_match('/^(OC-(\d+)-[0-9a-z]+)#\d+$/', $reference, $m)) {
            try {
                $sessions = $this->client()->request('GET', '/v1/checkout/sessions?merchant_order_id=' . rawurlencode($m[1]));
                if (!empty($sessions[0])) {
                    $this->apply((int) $m[2], $sessions[0]);
                }
            } catch (\Pay2All\ApiException $e) {
                http_response_code(503); // Pay2All retries the delivery.
                return;
            }
        }
        http_response_code(200);
    }
}
