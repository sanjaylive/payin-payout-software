/**
 * Payment gateways a super admin can connect by entering credentials (docs/PAYMENT_GATEWAYS.md).
 * The UI, credential validation and adapter registry all read this one list.
 */
export interface GatewayCredentialField {
  key: string;
  label: string;
  /** Mask in the form (all values are stored encrypted either way). */
  secret: boolean;
  help?: string;
  optional?: boolean;
}

export interface GatewayDefinition {
  key: string;
  name: string;
  tagline: string;
  website: string;
  docsUrl: string;
  /** Brand colour for the card (hex). */
  color: string;
  methods: ('UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'EMI' | 'PAY_LATER')[];
  credentials: GatewayCredentialField[];
  /** What to configure in the gateway dashboard for callbacks. */
  webhookSetup: string;
  refundsByApi: boolean;
  notes: string[];
}

export const GATEWAYS: GatewayDefinition[] = [
  {
    key: 'razorpay',
    name: 'Razorpay',
    tagline: 'Cards, UPI, netbanking, wallets, EMI and pay later',
    website: 'https://razorpay.com',
    docsUrl: 'https://razorpay.com/docs/api/payments/payment-links/',
    color: '#0c2451',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'PAY_LATER'],
    credentials: [
      { key: 'key_id', label: 'Key ID', secret: false, help: 'Dashboard → Account & Settings → API keys. rzp_test_… for test mode, rzp_live_… for live.' },
      { key: 'key_secret', label: 'Key secret', secret: true },
      { key: 'webhook_secret', label: 'Webhook secret', secret: true, help: 'The secret you type when adding the webhook in Razorpay.' },
    ],
    webhookSetup: 'Razorpay Dashboard → Account & Settings → Webhooks → Add: paste the webhook URL, set the same secret, and select payment_link.paid, payment_link.expired, payment_link.cancelled, refund.processed and refund.failed.',
    refundsByApi: true,
    notes: ['Test or live is decided by the key you enter.'],
  },
  {
    key: 'cashfree',
    name: 'Cashfree Payments',
    tagline: 'UPI, cards, netbanking, wallets and pay later',
    website: 'https://www.cashfree.com',
    docsUrl: 'https://docs.cashfree.com/reference/pg-new-apis-endpoint',
    color: '#6933d3',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'PAY_LATER'],
    credentials: [
      { key: 'client_id', label: 'App ID (x-client-id)', secret: false, help: 'Merchant Dashboard → Developers → API Keys (Payment Gateway).' },
      { key: 'client_secret', label: 'Secret key (x-client-secret)', secret: true, help: 'Also used to verify webhook signatures.' },
    ],
    webhookSetup: 'Cashfree Dashboard → Developers → Webhooks → Add webhook endpoint (Payment Links, API version 2023-08-01): paste the webhook URL. Each link also carries it as notify_url.',
    refundsByApi: true,
    notes: ['The customer’s mobile number is required for every payment.', 'Sandbox and production use different keys.'],
  },
  {
    key: 'easebuzz',
    name: 'Easebuzz',
    tagline: 'UPI, cards, netbanking, wallets and EMI',
    website: 'https://easebuzz.in',
    docsUrl: 'https://docs.easebuzz.in/',
    color: '#1d4ed8',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI'],
    credentials: [
      { key: 'key', label: 'Merchant key', secret: false, help: 'Easebuzz Dashboard → Settings → API Keys.' },
      { key: 'salt', label: 'Salt', secret: true, help: 'Used to sign requests and verify every callback hash.' },
    ],
    webhookSetup: 'Easebuzz Dashboard → Settings → Webhook URL: paste the webhook URL for Transaction webhooks.',
    refundsByApi: true,
    notes: ['The customer’s name, email and mobile are required.'],
  },
  {
    key: 'ccavenue',
    name: 'CCAvenue',
    tagline: '200+ payment options including cards, netbanking, UPI and wallets',
    website: 'https://www.ccavenue.com',
    docsUrl: 'https://www.ccavenue.com/',
    color: '#e3262e',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI'],
    credentials: [
      { key: 'merchant_id', label: 'Merchant ID', secret: false },
      { key: 'access_code', label: 'Access code', secret: true, help: 'Settings → API Keys. Register this server’s domain and IP with CCAvenue.' },
      { key: 'working_key', label: 'Working key', secret: true, help: 'Encrypts requests and decrypts responses.' },
    ],
    webhookSetup: 'Ask CCAvenue to whitelist this server’s outbound IP for the API, and set the Notification URL (Settings → Dynamic Event Notification) to the webhook URL.',
    refundsByApi: true,
    notes: ['CCAvenue responses can’t be authenticated, so every outcome is confirmed with the Order Status API.', 'API calls only work from a whitelisted IP.'],
  },
  {
    key: 'hdfc',
    name: 'HDFC Bank SmartGateway',
    tagline: 'HDFC Bank’s gateway (Juspay): UPI, cards, netbanking and wallets',
    website: 'https://smartgateway.hdfcbank.com',
    docsUrl: 'https://smartgateway.hdfcbank.com/docs',
    color: '#004c8f',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI'],
    credentials: [
      { key: 'merchant_id', label: 'Merchant ID', secret: false },
      { key: 'api_key', label: 'API key', secret: true, help: 'SmartGateway dashboard → Settings → Security → API keys.' },
      { key: 'payment_page_client_id', label: 'Payment page client ID', secret: false, help: 'Usually the same as the merchant ID — HDFC shares it during onboarding.' },
      { key: 'webhook_username', label: 'Webhook username', secret: false, help: 'Set the same in SmartGateway → Settings → Webhooks.' },
      { key: 'webhook_password', label: 'Webhook password', secret: true },
    ],
    webhookSetup: 'SmartGateway dashboard → Settings → Webhooks: paste the webhook URL, enable Basic authentication with the username and password entered here, and subscribe to order and refund events.',
    refundsByApi: true,
    notes: ['Order ids sent to HDFC are a 21-character form of the payment id.'],
  },
  {
    key: 'nttdata',
    name: 'NTT DATA (Atom)',
    tagline: 'AIPAY: cards, netbanking, UPI and wallets',
    website: 'https://www.nttdatapay.com',
    docsUrl: 'https://www.nttdatapay.com/',
    color: '#0069b4',
    methods: ['UPI', 'CARD', 'NETBANKING', 'WALLET'],
    credentials: [
      { key: 'merch_id', label: 'Merchant ID', secret: false },
      { key: 'password', label: 'Transaction password', secret: true },
      { key: 'product_id', label: 'Product ID', secret: false, help: 'E.g. NSE for UAT — from your NTT DATA onboarding sheet.' },
      { key: 'req_enc_key', label: 'Request AES key', secret: true },
      { key: 'req_salt', label: 'Request salt', secret: true },
      { key: 'res_dec_key', label: 'Response AES key', secret: true },
      { key: 'res_salt', label: 'Response salt', secret: true },
      { key: 'req_hash_key', label: 'Request hash key', secret: true },
      { key: 'res_hash_key', label: 'Response hash key', secret: true },
    ],
    webhookSetup: 'Share the webhook URL with NTT DATA support as your server-to-server callback URL.',
    refundsByApi: false,
    notes: ['The customer’s email and mobile are required.', 'Checkout opens NTT DATA’s own payment window.', 'Refunds are made from the NTT DATA merchant dashboard.'],
  },
  {
    key: 'phonepe',
    name: 'PhonePe Payment Gateway',
    tagline: 'UPI, cards and netbanking (Standard Checkout v2)',
    website: 'https://www.phonepe.com/business-solutions/payment-gateway/',
    docsUrl: 'https://developer.phonepe.com/v1/reference/pg-standard-checkout-v2',
    color: '#5f259f',
    methods: ['UPI', 'CARD', 'NETBANKING'],
    credentials: [
      { key: 'client_id', label: 'Client ID', secret: false, help: 'PhonePe Business dashboard → Developer Settings.' },
      { key: 'client_secret', label: 'Client secret', secret: true },
      { key: 'client_version', label: 'Client version', secret: false, help: 'Shown next to the client id (often 1).' },
      { key: 'webhook_username', label: 'Webhook username', secret: false },
      { key: 'webhook_password', label: 'Webhook password', secret: true },
    ],
    webhookSetup: 'PhonePe Business dashboard → Developer Settings → Webhooks: paste the webhook URL, set the username and password entered here, and select checkout.order.completed, checkout.order.failed and the refund events.',
    refundsByApi: true,
    notes: [],
  },
];

export const gatewayByKey = (key: string) => GATEWAYS.find((g) => g.key === key);
