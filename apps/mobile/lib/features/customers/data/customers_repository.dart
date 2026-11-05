import '../../../core/api/api_client.dart';
import '../../../core/json.dart';
import 'customer_models.dart';

class CustomersRepository {
  CustomersRepository(this.api);
  final ApiClient api;

  Future<PageResult<Customer>> list({String? search, String? cursor, int limit = 25}) =>
      api.getPage('/v1/agent/customers', Customer.fromJson, query: {'search': search, 'cursor': cursor, 'limit': limit});

  /// Exact mobile match, or null for a new customer.
  Future<Customer?> lookup(String mobile) async {
    final j = asJson(await api.get('/v1/agent/customers/lookup', query: {'mobile': mobile.trim()}));
    final c = jObj(j, 'customer');
    return c == null ? null : Customer.fromJson(c);
  }

  Future<Customer> get(String id) async => Customer.fromJson(asJson(await api.get('/v1/agent/customers/$id')));

  Future<Customer> create(CustomerInput input) async => Customer.fromJson(asJson(await api.post('/v1/agent/customers', data: input.toJson())));

  Future<Customer> update(String id, CustomerInput input) async =>
      Customer.fromJson(asJson(await api.patch('/v1/agent/customers/$id', data: input.toJson())));

  /// Full ID number (audited on the server).
  Future<({String? idType, String? idNumber})> revealId(String id) async {
    final j = asJson(await api.get('/v1/agent/customers/$id/id-number'));
    return (idType: jText(j, 'id_type'), idNumber: jText(j, 'id_number'));
  }

  Future<Beneficiary> addBeneficiary(String customerId, BeneficiaryInput input) async =>
      Beneficiary.fromJson(asJson(await api.post('/v1/agent/customers/$customerId/beneficiaries', data: input.toJson())));

  Future<void> removeBeneficiary(String id) async {
    await api.delete('/v1/agent/beneficiaries/$id');
  }
}
