<?php
namespace Opencart\Catalog\Model\Extension\Pay2all\Payment;

class Pay2all extends \Opencart\System\Engine\Model
{
    public function getMethods(array $address = []): array
    {
        $this->load->language('extension/pay2all/payment/pay2all');
        if (!$this->config->get('payment_pay2all_status') || $this->session->data['currency'] !== 'INR') {
            return [];
        }
        $zone = (int) $this->config->get('payment_pay2all_geo_zone_id');
        if ($zone && $address) {
            $query = $this->db->query("SELECT 1 FROM `" . DB_PREFIX . "zone_to_geo_zone` WHERE `geo_zone_id` = '" . $zone . "' AND `country_id` = '" . (int) $address['country_id'] . "' AND (`zone_id` = '" . (int) $address['zone_id'] . "' OR `zone_id` = '0')");
            if (!$query->num_rows) {
                return [];
            }
        }
        return [
            'code' => 'pay2all',
            'name' => $this->language->get('heading_title'),
            'option' => ['pay2all' => ['code' => 'pay2all.pay2all', 'name' => $this->language->get('text_title')]],
            'sort_order' => (int) $this->config->get('payment_pay2all_sort_order'),
        ];
    }
}
