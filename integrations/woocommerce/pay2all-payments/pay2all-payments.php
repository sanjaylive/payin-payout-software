<?php
/**
 * Plugin Name:       Pay2All Payments for WooCommerce
 * Description:       Accept UPI, cards, netbanking and wallets through Pay2All hosted checkout.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 7.0
 * License:           GPL-2.0-or-later
 * Text Domain:       pay2all-payments
 */

if (!defined('ABSPATH')) {
    exit;
}

define('PAY2ALL_WC_VERSION', '1.0.0');
define('PAY2ALL_WC_DIR', __DIR__);

// High-performance order storage (HPOS) compatible: orders are read and written only through WC_Order.
add_action('before_woocommerce_init', function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
    }
});

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }
    require_once PAY2ALL_WC_DIR . '/lib/Pay2All.php';
    require_once PAY2ALL_WC_DIR . '/includes/class-wc-pay2all-gateway.php';
    add_filter('woocommerce_payment_gateways', function (array $gateways) {
        $gateways[] = 'WC_Pay2All_Gateway';
        return $gateways;
    });
});
