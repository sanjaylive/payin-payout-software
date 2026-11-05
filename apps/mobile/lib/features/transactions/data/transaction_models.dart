import '../../../core/format/money.dart';
import '../../../core/json.dart';

/// Transaction types and their counter direction (docs/AGENTS.md §3).
enum TxnType {
  moneyTransfer('MONEY_TRANSFER', 'Money transfer', 'IN'),
  cashWithdrawal('CASH_WITHDRAWAL', 'Cash withdrawal', 'OUT'),
  cashDeposit('CASH_DEPOSIT', 'Cash deposit', 'IN'),
  billPayment('BILL_PAYMENT', 'Bill payment', 'IN'),
  recharge('RECHARGE', 'Recharge', 'IN'),
  other('OTHER', 'Other', null);

  const TxnType(this.code, this.label, this.direction);
  final String code;
  final String label;

  /// Fixed direction, or null when the agent chooses (OTHER).
  final String? direction;

  static TxnType? fromCode(String? code) {
    for (final t in values) {
      if (t.code == code) return t;
    }
    return null;
  }

  static String labelFor(String? code) => fromCode(code)?.label ?? (code ?? '—');
}

class PayMode {
  PayMode._();
  static const all = ['CASH', 'UPI', 'BANK', 'OTHER'];
  static String label(String? m) => switch (m) {
        'CASH' => 'Cash',
        'UPI' => 'UPI',
        'BANK' => 'Bank',
        'OTHER' => 'Other',
        _ => m ?? '—',
      };
}

class TxnStatus {
  TxnStatus._();
  static const all = ['SUCCESS', 'PENDING', 'FAILED', 'REFUNDED'];
  static String label(String? s) => switch (s) {
        'SUCCESS' => 'Success',
        'PENDING' => 'Pending',
        'FAILED' => 'Failed',
        'REFUNDED' => 'Refunded',
        _ => s ?? '—',
      };

  /// Owner status changes allowed from [from].
  static List<String> nextFrom(String from) => switch (from) {
        'PENDING' => const ['SUCCESS', 'FAILED'],
        'SUCCESS' => const ['FAILED', 'REFUNDED'],
        _ => const [],
      };
}

class TxnCustomer {
  const TxnCustomer({this.id, this.name, this.mobile});
  final String? id;
  final String? name;
  final String? mobile;

  factory TxnCustomer.fromJson(Json j) => TxnCustomer(id: jText(j, 'id'), name: jText(j, 'name'), mobile: jText(j, 'mobile'));
}

class TxnBeneficiary {
  const TxnBeneficiary({this.id, this.name, this.bankName, this.accountMasked, this.ifsc, this.upiId});
  final String? id;
  final String? name;
  final String? bankName;
  final String? accountMasked;
  final String? ifsc;
  final String? upiId;

  factory TxnBeneficiary.fromJson(Json j) => TxnBeneficiary(
        id: jText(j, 'id'),
        name: jText(j, 'name'),
        bankName: jText(j, 'bank_name'),
        accountMasked: jText(j, 'account_masked'),
        ifsc: jText(j, 'ifsc'),
        upiId: jText(j, 'upi_id'),
      );
}

class AgentTransaction {
  const AgentTransaction({
    required this.id,
    required this.receiptNo,
    required this.type,
    required this.direction,
    required this.mode,
    required this.status,
    required this.amountPaise,
    required this.feePaise,
    required this.totalPaise,
    this.reference,
    this.description,
    this.customer,
    this.beneficiary,
    this.occurredAt,
    this.createdBy,
    this.statusNote,
    this.statusChangedAt,
    this.receiptSentAt,
    this.receiptToken,
    this.createdAt,
  });

  final String id;
  final String receiptNo;
  final String type;
  final String direction;
  final String mode;
  final String status;
  final int amountPaise;
  final int feePaise;
  final int totalPaise;
  final String? reference;
  final String? description;
  final TxnCustomer? customer;
  final TxnBeneficiary? beneficiary;
  final DateTime? occurredAt;
  final String? createdBy;
  final String? statusNote;
  final DateTime? statusChangedAt;
  final DateTime? receiptSentAt;
  final String? receiptToken;
  final DateTime? createdAt;

  bool get isIn => direction == 'IN';
  String get typeLabel => TxnType.labelFor(type);
  bool get countsInTotals => status == 'SUCCESS' || status == 'PENDING';

  /// "Ramesh Kumar → Suresh (SBI)" / "Walk-in".
  String get title {
    final c = customer?.name ?? customer?.mobile;
    final b = beneficiary?.name;
    if (c != null && b != null) return '$c → $b';
    return c ?? b ?? typeLabel;
  }

  factory AgentTransaction.fromJson(Json j) {
    final c = jObj(j, 'customer');
    final b = jObj(j, 'beneficiary');
    return AgentTransaction(
      id: jStr(j, 'id'),
      receiptNo: jStr(j, 'receipt_no'),
      type: jStr(j, 'type', 'OTHER'),
      direction: jStr(j, 'direction', 'IN'),
      mode: jStr(j, 'mode', 'CASH'),
      status: jStr(j, 'status', 'SUCCESS'),
      amountPaise: Money.parsePaise(j['amount']),
      feePaise: Money.parsePaise(j['fee']),
      totalPaise: Money.parsePaise(j['total']),
      reference: jText(j, 'reference'),
      description: jText(j, 'description'),
      customer: c == null ? null : TxnCustomer.fromJson(c),
      beneficiary: b == null ? null : TxnBeneficiary.fromJson(b),
      occurredAt: jDate(j, 'occurred_at'),
      createdBy: jText(j, 'created_by'),
      statusNote: jText(j, 'status_note'),
      statusChangedAt: jDate(j, 'status_changed_at'),
      receiptSentAt: jDate(j, 'receipt_sent_at'),
      receiptToken: jText(j, 'receipt_token'),
      createdAt: jDate(j, 'created_at'),
    );
  }
}

class ReceiptShop {
  const ReceiptShop({required this.name, this.mobile, this.address, this.upiVpa, this.logoUrl, this.footer});
  final String name;
  final String? mobile;
  final String? address;
  final String? upiVpa;

  /// An API path (public), e.g. `/v1/public/agent-receipts/<token>/logo`.
  final String? logoUrl;
  final String? footer;

  factory ReceiptShop.fromJson(Json j) => ReceiptShop(
        name: jStr(j, 'name', 'Shop'),
        mobile: jText(j, 'mobile'),
        address: jText(j, 'address'),
        upiVpa: jText(j, 'upi_vpa'),
        logoUrl: jText(j, 'logo_url'),
        footer: jText(j, 'footer'),
      );
}

/// `GET /v1/agent/transactions/:id/receipt`.
class Receipt {
  const Receipt({required this.transaction, required this.typeLabel, required this.shop, required this.branded, this.poweredBy, this.publicUrl});
  final AgentTransaction transaction;
  final String typeLabel;
  final ReceiptShop shop;
  final bool branded;
  final String? poweredBy;
  final String? publicUrl;

  factory Receipt.fromJson(Json j) {
    final t = AgentTransaction.fromJson(jObj(j, 'transaction') ?? const {});
    return Receipt(
      transaction: t,
      typeLabel: jText(j, 'type_label') ?? t.typeLabel,
      shop: ReceiptShop.fromJson(jObj(j, 'shop') ?? const {}),
      branded: jBool(j, 'branded'),
      poweredBy: jText(j, 'powered_by'),
      publicUrl: jText(j, 'public_url'),
    );
  }
}

/// Filters for the transactions list.
class TxnFilter {
  const TxnFilter({this.from, this.to, this.type, this.direction, this.status, this.search, this.customerId});
  final String? from;
  final String? to;
  final String? type;
  final String? direction;
  final String? status;
  final String? search;
  final String? customerId;

  bool get isEmpty => from == null && to == null && type == null && direction == null && status == null && (search == null || search!.isEmpty);

  int get activeCount => [from ?? to, type, direction, status].where((e) => e != null).length;

  Map<String, Object?> toQuery() => {
        'from': from,
        'to': to,
        'type': type,
        'direction': direction,
        'status': status,
        'search': search,
        'customer_id': customerId,
      };

  TxnFilter copyWith({String? search}) =>
      TxnFilter(from: from, to: to, type: type, direction: direction, status: status, search: search ?? this.search, customerId: customerId);

  @override
  bool operator ==(Object other) =>
      other is TxnFilter &&
      other.from == from &&
      other.to == to &&
      other.type == type &&
      other.direction == direction &&
      other.status == status &&
      other.search == search &&
      other.customerId == customerId;

  @override
  int get hashCode => Object.hash(from, to, type, direction, status, search, customerId);
}
