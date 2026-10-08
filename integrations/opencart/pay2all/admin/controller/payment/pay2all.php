<?php
namespace Opencart\Admin\Controller\Extension\Pay2all\Payment;

/** Pay2All settings (OpenCart 4.0.2+). Secrets are stored in OpenCart settings like other gateways. */
class Pay2all extends \Opencart\System\Engine\Controller
{
    private const FIELDS = ['api_base', 'key_id', 'key_secret', 'webhook_secret', 'order_status_id', 'geo_zone_id', 'status', 'sort_order'];

    public function index(): void
    {
        $this->load->language('extension/pay2all/payment/pay2all');
        $this->document->setTitle($this->language->get('heading_title'));
        $token = 'user_token=' . $this->session->data['user_token'];
        $data['breadcrumbs'] = [
            ['text' => $this->language->get('text_home'), 'href' => $this->url->link('common/dashboard', $token)],
            ['text' => $this->language->get('text_extension'), 'href' => $this->url->link('marketplace/extension', $token . '&type=payment')],
            ['text' => $this->language->get('heading_title'), 'href' => $this->url->link('extension/pay2all/payment/pay2all', $token)],
        ];
        $data['save'] = $this->url->link('extension/pay2all/payment/pay2all.save', $token);
        $data['back'] = $this->url->link('marketplace/extension', $token . '&type=payment');
        foreach (self::FIELDS as $f) {
            $data['payment_pay2all_' . $f] = $this->config->get('payment_pay2all_' . $f);
        }
        $data['webhook_url'] = HTTP_CATALOG . 'index.php?route=extension/pay2all/payment/pay2all.webhook';
        $this->load->model('localisation/order_status');
        $data['order_statuses'] = $this->model_localisation_order_status->getOrderStatuses();
        $this->load->model('localisation/geo_zone');
        $data['geo_zones'] = $this->model_localisation_geo_zone->getGeoZones();
        $data['header'] = $this->load->controller('common/header');
        $data['column_left'] = $this->load->controller('common/column_left');
        $data['footer'] = $this->load->controller('common/footer');
        $this->response->setOutput($this->load->view('extension/pay2all/payment/pay2all', $data));
    }

    public function save(): void
    {
        $this->load->language('extension/pay2all/payment/pay2all');
        $json = [];
        if (!$this->user->hasPermission('modify', 'extension/pay2all/payment/pay2all')) {
            $json['error']['warning'] = $this->language->get('error_permission');
        }
        $post = $this->request->post;
        if (empty($post['payment_pay2all_api_base']) || !preg_match('#^https?://#', (string) $post['payment_pay2all_api_base'])) {
            $json['error']['api_base'] = $this->language->get('error_api_base');
        }
        if (empty($post['payment_pay2all_key_id']) || !preg_match('/^pk_(test|live)_/', (string) $post['payment_pay2all_key_id'])) {
            $json['error']['key_id'] = $this->language->get('error_key_id');
        }
        // A blank secret keeps the stored one (secrets are never echoed back into the form).
        foreach (['key_secret', 'webhook_secret'] as $secret) {
            if (($post['payment_pay2all_' . $secret] ?? '') === '') {
                $post['payment_pay2all_' . $secret] = (string) $this->config->get('payment_pay2all_' . $secret);
            }
        }
        if ($post['payment_pay2all_key_secret'] === '') {
            $json['error']['key_secret'] = $this->language->get('error_key_secret');
        }
        if (!$json) {
            $this->load->model('setting/setting');
            $this->model_setting_setting->editSetting('payment_pay2all', $post);
            $json['success'] = $this->language->get('text_success');
        }
        $this->response->addHeader('Content-Type: application/json');
        $this->response->setOutput(json_encode($json));
    }
}
