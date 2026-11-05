import '../../../core/api/api_client.dart';
import '../../../core/format/money.dart';
import '../../../core/json.dart';
import 'transaction_models.dart';

/// What the counter records (`POST /v1/agent/transactions`).
class NewTransaction {
  const NewTransaction({
    required this.type,
    this.direction,
    required this.mode,
    required this.status,
    required this.amountPaise,
    required this.feePaise,
    this.reference,
    this.description,
    this.customerId,
    this.beneficiaryId,
    this.customerName,
    this.customerMobile,
    this.occurredAt,
  });

  final TxnType type;
  final String? direction;
  final String mode;
  final String status;
  final int amountPaise;
  final int feePaise;
  final String? reference;
  final String? description;
  final String? customerId;
  final String? beneficiaryId;
  final String? customerName;
  final String? customerMobile;

  /// UTC instant; null = now.
  final DateTime? occurredAt;

  /// The counter's direction for this entry.
  String get effectiveDirection => type.direction ?? direction ?? 'IN';

  /// What the customer pays (IN) or receives (OUT).
  int get totalPaise => effectiveDirection == 'IN' ? amountPaise + feePaise : amountPaise - feePaise;

  static String? _n(String? v) => (v == null || v.trim().isEmpty) ? null : v.trim();

  Map<String, Object?> toJson() => {
        'type': type.code,
        if (type == TxnType.other) 'direction': direction,
        'mode': mode,
        'status': status,
        'amount': Money.toApi(amountPaise),
        'fee': Money.toApi(feePaise),
        if (_n(reference) != null) 'reference': _n(reference),
        if (_n(description) != null) 'description': _n(description),
        if (customerId != null) 'customer_id': customerId,
        if (beneficiaryId != null) 'beneficiary_id': beneficiaryId,
        if (customerId == null && _n(customerName) != null) 'customer_name': _n(customerName),
        if (customerId == null && _n(customerMobile) != null) 'customer_mobile': _n(customerMobile),
        if (occurredAt != null) 'occurred_at': occurredAt!.toUtc().toIso8601String(),
      };
}

class TransactionsRepository {
  TransactionsRepository(this.api);
  final ApiClient api;

  Future<PageResult<AgentTransaction>> list(TxnFilter filter, {String? cursor, int limit = 25}) => api.getPage(
        '/v1/agent/transactions',
        AgentTransaction.fromJson,
        query: {...filter.toQuery(), 'cursor': cursor, 'limit': limit},
      );

  Future<AgentTransaction> get(String id) async => AgentTransaction.fromJson(asJson(await api.get('/v1/agent/transactions/$id')));

  /// [idempotencyKey]: generated once per entry flow and re-sent on every retry of the same submit.
  Future<AgentTransaction> create(NewTransaction t, {required String idempotencyKey}) async {
    final data = await api.post('/v1/agent/transactions', data: t.toJson(), headers: {'Idempotency-Key': idempotencyKey});
    return AgentTransaction.fromJson(asJson(data));
  }

  Future<AgentTransaction> changeStatus(String id, String status, {String? reference, String? note}) async {
    final data = await api.post('/v1/agent/transactions/$id/status', data: {
      'status': status,
      if (reference != null && reference.trim().isNotEmpty) 'reference': reference.trim(),
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
    return AgentTransaction.fromJson(asJson(data));
  }

  Future<Receipt> receipt(String id) async => Receipt.fromJson(asJson(await api.get('/v1/agent/transactions/$id/receipt')));

  /// channel: SMS | WHATSAPP (Business plan).
  Future<void> sendReceipt(String id, String channel, {String? mobile}) async {
    await api.post('/v1/agent/transactions/$id/send-receipt', data: {
      'channel': channel,
      if (mobile != null && mobile.trim().isNotEmpty) 'mobile': mobile.trim(),
    });
  }
}
