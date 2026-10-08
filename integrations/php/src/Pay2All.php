<?php
/**
 * Pay2All PHP client — single file, no dependencies (PHP 7.4+, ext-curl, ext-json).
 *
 *   $p2a = new Pay2All\Client('pk_test_…', getenv('PAY2ALL_SECRET'), 'https://api.example.com');
 *   $session = $p2a->createCheckoutSession([...], 'order-1042');   // Idempotency-Key
 *   Pay2All\Webhook::verify($webhookSecret, $_SERVER['HTTP_PAY2ALL_SIGNATURE'] ?? '', $rawBody);
 *
 * Requests are signed exactly as docs/API.md §2 describes. Amounts are decimal rupee strings.
 */

namespace Pay2All;

final class ApiException extends \RuntimeException
{
    /** @var string */
    public $errorCode;
    /** @var int */
    public $httpStatus;
    /** @var string|null */
    public $requestId;

    public function __construct(string $code, string $message, int $httpStatus, ?string $requestId)
    {
        parent::__construct($message, $httpStatus);
        $this->errorCode = $code;
        $this->httpStatus = $httpStatus;
        $this->requestId = $requestId;
    }
}

final class Client
{
    const VERSION = '1.0.0';

    /** @var string */
    private $keyId;
    /** @var string */
    private $secret;
    /** @var string */
    private $baseUrl;
    /** @var int */
    private $timeout;

    public function __construct(string $keyId, string $secret, string $baseUrl, int $timeoutSeconds = 30)
    {
        if (!preg_match('/^pk_(test|live)_/', $keyId)) {
            throw new \InvalidArgumentException('Pay2All: the key id starts with pk_test_ or pk_live_');
        }
        if ($secret === '') {
            throw new \InvalidArgumentException('Pay2All: the API secret is required');
        }
        $this->keyId = $keyId;
        $this->secret = $secret;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeoutSeconds;
    }

    /**
     * One signed request. POSTs carry an Idempotency-Key (pass a stable one, e.g. your order id, so a
     * retry can never create a second payment).
     *
     * @return array the response `data`
     */
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        $method = strtoupper($method);
        $raw = $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $ts = (string) time();
        $nonce = bin2hex(random_bytes(16));
        $signature = hash_hmac('sha256', $ts . '.' . $nonce . '.' . $method . '.' . $path . '.' . hash('sha256', $raw), $this->secret);
        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
            'User-Agent: pay2all-php/' . self::VERSION,
            'X-Pay2All-Key: ' . $this->keyId,
            'X-Pay2All-Timestamp: ' . $ts,
            'X-Pay2All-Nonce: ' . $nonce,
            'X-Pay2All-Signature: v1=' . $signature,
        ];
        if ($method === 'POST') {
            $key = $idempotencyKey !== null ? preg_replace('/[^A-Za-z0-9_-]/', '_', $idempotencyKey) : bin2hex(random_bytes(16));
            $headers[] = 'Idempotency-Key: ' . substr($key, 0, 64);
        }
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($raw !== '') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $raw);
        }
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($response === false) {
            throw new ApiException('NETWORK_ERROR', 'Pay2All: could not reach the API (' . $error . ')', 0, null);
        }
        $json = json_decode((string) $response, true);
        if (!is_array($json)) {
            throw new ApiException('INVALID_RESPONSE', 'Pay2All: unexpected response (HTTP ' . $status . ')', $status, null);
        }
        if (empty($json['success'])) {
            $e = isset($json['error']) && is_array($json['error']) ? $json['error'] : [];
            throw new ApiException((string) ($e['code'] ?? 'UNKNOWN'), (string) ($e['message'] ?? 'Request failed'), $status, isset($e['request_id']) ? (string) $e['request_id'] : null);
        }
        return is_array($json['data'] ?? null) ? $json['data'] : [];
    }

    public function createCheckoutSession(array $params, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/checkout/sessions', $params, $idempotencyKey);
    }

    public function getCheckoutSession(string $id): array
    {
        return $this->request('GET', '/v1/checkout/sessions/' . rawurlencode($id));
    }

    public function createPaymentLink(array $params, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/v1/payment-links', $params, $idempotencyKey);
    }

    public function getPayment(string $paymentId): array
    {
        return $this->request('GET', '/v1/payments/' . rawurlencode($paymentId));
    }

    public function refund(string $paymentId, string $amount, string $merchantRefundId, ?string $reason = null): array
    {
        $body = ['amount' => $amount, 'merchant_refund_id' => $merchantRefundId];
        if ($reason !== null && $reason !== '') {
            $body['reason'] = mb_substr($reason, 0, 200);
        }
        return $this->request('POST', '/v1/payments/' . rawurlencode($paymentId) . '/refunds', $body, 'refund_' . $merchantRefundId);
    }

    /** Format a number as the API's rupee string ("1499.00"). */
    public static function amount($value): string
    {
        return number_format((float) $value, 2, '.', '');
    }
}

final class Webhook
{
    /**
     * Verify the `Pay2All-Signature: t=…,v1=…` header over the raw request body (constant time,
     * 5-minute tolerance). Accepts any v1 (secret rotation sends two).
     */
    public static function verify(string $secret, string $header, string $rawBody, int $toleranceSeconds = 300, ?int $now = null): bool
    {
        $t = null;
        $signatures = [];
        foreach (explode(',', $header) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) !== 2) {
                continue;
            }
            if ($kv[0] === 't') {
                $t = (int) $kv[1];
            } elseif ($kv[0] === 'v1') {
                $signatures[] = $kv[1];
            }
        }
        if (!$t || abs(($now ?? time()) - $t) > $toleranceSeconds || $secret === '') {
            return false;
        }
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        foreach ($signatures as $s) {
            if (hash_equals($expected, $s)) {
                return true;
            }
        }
        return false;
    }

    /** Decode a verified body. */
    public static function parse(string $rawBody): array
    {
        $event = json_decode($rawBody, true);
        if (!is_array($event) || !isset($event['id'], $event['type'])) {
            throw new \UnexpectedValueException('Pay2All: not a webhook event');
        }
        return $event;
    }
}
