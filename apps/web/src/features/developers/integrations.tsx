'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Code2, Download, ExternalLink, Info, ShoppingBag, ShoppingCart, SquareTerminal } from 'lucide-react';
import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { CodePanel, popupSnippet } from '@/features/docs/api-reference';
import { api, API_URL } from '@/lib/api/client';
import type { MerchantWebsite } from '@/lib/api/types';

const noop = () => () => undefined;
/** The web app's origin; empty during server rendering. */
const useOrigin = () => useSyncExternalStore(noop, () => window.location.origin, () => '');

/** The three things every integration needs, with live status for the websites step. */
function Prerequisites({ webhook }: { webhook?: string }) {
  const sites = useQuery({ queryKey: ['checkout-websites'], queryFn: () => api.get<MerchantWebsite[]>('/v1/checkout/websites') });
  const approved = (sites.data ?? []).some((w) => w.status === 'APPROVED');
  const steps = [
    { done: approved, title: 'Your website is approved', text: 'Add your shop’s address. Customers return only to approved websites.', href: '/developers/websites', cta: 'Websites' },
    { done: null, title: 'An API key', text: 'Create a key with Create payments and Read payments (plus Refund payments for refunds).', href: '/developers/api-keys', cta: 'API keys' },
    { done: null, title: 'A webhook endpoint', text: webhook ? `Add ${webhook} for payment.success, and copy its signing secret.` : 'Add your endpoint for payment.success, and copy its signing secret.', href: '/developers/webhooks', cta: 'Webhooks' },
  ];
  return (
    <ol className="divide-y rounded-xl border">
      {steps.map((s, i) => (
        <li key={s.title} className="flex flex-wrap items-center gap-3 p-4">
          {s.done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : <Circle className="text-muted-foreground size-5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {i + 1}. {s.title}
            </p>
            <p className="text-muted-foreground text-xs break-words">{s.text}</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={s.href}>{s.cta}</Link>
          </Button>
        </li>
      ))}
    </ol>
  );
}

function DownloadCard({ title, version, href, note }: { title: string; version: string; href: string; note: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-gradient-to-r from-sky-500/5 to-transparent p-4">
      <div>
        <p className="font-medium">
          {title} <span className="text-muted-foreground text-xs">v{version}</span>
        </p>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
      <Button asChild>
        <a href={href} download>
          <Download /> Download
        </a>
      </Button>
    </div>
  );
}

/** Developers → Integrations: popup checkout, store plugins and the PHP SDK. */
export function Integrations() {
  const origin = useOrigin();
  const api = API_URL.replace(/\/$/, '');
  return (
    <Tabs defaultValue="popup">
      <TabsList className="mb-5 flex h-auto flex-wrap justify-start">
        <TabsTrigger value="popup">
          <Code2 className="size-4" /> Popup checkout
        </TabsTrigger>
        <TabsTrigger value="woocommerce">
          <ShoppingCart className="size-4" /> WooCommerce
        </TabsTrigger>
        <TabsTrigger value="opencart">
          <ShoppingBag className="size-4" /> OpenCart
        </TabsTrigger>
        <TabsTrigger value="php">
          <SquareTerminal className="size-4" /> PHP SDK
        </TabsTrigger>
        <TabsTrigger value="shopify">Shopify</TabsTrigger>
      </TabsList>

      <TabsContent value="popup" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <p className="text-sm">
            Add one script to your site and customers pay in a secure popup without leaving your page. Your server creates the checkout session; <code className="bg-muted rounded px-1">Pay2All.checkout()</code> shows it and tells your page how it ended.
          </p>
          <Prerequisites />
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>Call it straight from a click handler; if the browser blocks popups the customer is redirected instead.</li>
            <li>Results are posted only to your approved website — still confirm the order on your server before fulfilling it.</li>
          </ul>
          <Button asChild variant="outline" size="sm">
            <Link href="/developers/docs#checkout-popup">
              Full reference <ExternalLink className="size-3.5" />
            </Link>
          </Button>
        </div>
        <CodePanel title="Your checkout page" single={{ label: 'HTML', code: popupSnippet(origin || 'https://pay.example.com') }} />
      </TabsContent>

      <TabsContent value="woocommerce" className="space-y-4">
        <DownloadCard title="Pay2All for WooCommerce" version="1.0.0" href="/downloads/pay2all-woocommerce-1.0.0.zip" note="WordPress 6+, WooCommerce 7+, PHP 7.4+. HPOS compatible. Store currency INR." />
        <Prerequisites webhook="https://<your-shop>/?wc-api=pay2all_webhook" />
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>WordPress → Plugins → Add New → Upload Plugin → choose the zip → Activate.</li>
          <li>
            WooCommerce → Settings → Payments → Pay2All: API URL <code className="bg-muted rounded px-1">{api}</code>, key id, secret and webhook secret. Enable.
          </li>
          <li>Place a test order with a pk_test_ key; pay it in the sandbox; the order moves to Processing.</li>
        </ol>
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Orders are marked paid only after the plugin confirms with the Pay2All API; a paid amount that differs from the order total puts the order on hold. Refunds from the order screen go to Pay2All.
        </p>
      </TabsContent>

      <TabsContent value="opencart" className="space-y-4">
        <DownloadCard title="Pay2All for OpenCart (beta)" version="1.0.0" href="/downloads/pay2all-opencart-1.0.0.ocmod.zip" note="OpenCart 4.0.2+. Try it on a staging store first." />
        <Prerequisites webhook="https://<your-store>/index.php?route=extension/pay2all/payment/pay2all.webhook" />
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>Extensions → Installer → upload the .ocmod.zip.</li>
          <li>Extensions → Extensions → Payments → Pay2All → Install, then Edit.</li>
          <li>
            Enter API URL <code className="bg-muted rounded px-1">{api}</code>, key id, secret, webhook secret and the order status for paid orders. Enable.
          </li>
        </ol>
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" /> Issue refunds from the Pay2All dashboard (Payin → Transactions).
        </p>
      </TabsContent>

      <TabsContent value="php" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <DownloadCard title="Pay2All PHP SDK" version="1.0.0" href="/downloads/pay2all-php-1.0.0.zip" note="One file, PHP 7.4+ with curl. Signing, idempotency keys, errors, webhook verification." />
          <p className="text-muted-foreground text-sm">For custom PHP shops and frameworks (Laravel, CodeIgniter…). Other languages: copy the signing helper from the documentation.</p>
        </div>
        <CodePanel
          title="checkout.php"
          single={{
            label: 'PHP',
            code: `<?php
require 'pay2all-php/src/Pay2All.php';

$p2a = new Pay2All\\Client(getenv('PAY2ALL_KEY'), getenv('PAY2ALL_SECRET'), '${api}');
$session = $p2a->createCheckoutSession([
    'merchant_order_id' => 'ORD-1042',
    'amount' => Pay2All\\Client::amount(2499),
    'return_url' => 'https://shop.example.com/orders/1042',
], 'ORD-1042'); // Idempotency-Key: a retry never creates a second checkout
header('Location: ' . $session['url']);

// webhook.php
$raw = file_get_contents('php://input');
if (!Pay2All\\Webhook::verify(getenv('PAY2ALL_WEBHOOK_SECRET'), $_SERVER['HTTP_PAY2ALL_SIGNATURE'] ?? '', $raw)) {
    http_response_code(400);
    exit;
}
$event = Pay2All\\Webhook::parse($raw); // payment.success → mark the order paid (idempotently)`,
          }}
        />
      </TabsContent>

      <TabsContent value="shopify" className="max-w-2xl space-y-3 text-sm">
        <p>
          Shopify allows only its approved payment partners to add a payment method to Shopify checkout, so there is no Pay2All app for it. You can still collect for Shopify orders:
        </p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>In Shopify, add a manual payment method such as “Pay by UPI / card (link sent after ordering)”.</li>
          <li>
            For each order, create a{' '}
            <Link href="/payin/payment-links" className="text-primary hover:underline">
              payment link
            </Link>{' '}
            with the order number as its reference, and send it by WhatsApp, SMS or email.
          </li>
          <li>Mark the Shopify order paid when the link shows Paid (or automate it with the payment.success webhook and the Shopify Admin API).</li>
        </ol>
      </TabsContent>
    </Tabs>
  );
}
