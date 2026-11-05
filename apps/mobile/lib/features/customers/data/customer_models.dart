import '../../../core/json.dart';

class IdTypes {
  IdTypes._();
  static const all = ['AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT', 'OTHER'];
  static String label(String? t) => switch (t) {
        'AADHAAR' => 'Aadhaar',
        'PAN' => 'PAN',
        'VOTER_ID' => 'Voter ID',
        'DRIVING_LICENCE' => 'Driving licence',
        'PASSPORT' => 'Passport',
        'OTHER' => 'Other',
        _ => t ?? '—',
      };
}

class Beneficiary {
  const Beneficiary({
    required this.id,
    required this.customerId,
    required this.name,
    this.bankName,
    this.accountNumber,
    this.accountMasked,
    this.ifsc,
    this.upiId,
    this.relation,
    required this.active,
  });

  final String id;
  final String customerId;
  final String name;
  final String? bankName;

  /// Full number (the agent types it into the bank portal).
  final String? accountNumber;
  final String? accountMasked;
  final String? ifsc;
  final String? upiId;
  final String? relation;
  final bool active;

  String get subtitle {
    final parts = <String>[];
    if (accountNumber != null || accountMasked != null) {
      parts.add([bankName, accountNumber ?? accountMasked].whereType<String>().join(' · '));
      if (ifsc != null) parts.add(ifsc!);
    }
    if (upiId != null) parts.add(upiId!);
    return parts.join('  •  ');
  }

  factory Beneficiary.fromJson(Json j) => Beneficiary(
        id: jStr(j, 'id'),
        customerId: jStr(j, 'customer_id'),
        name: jStr(j, 'name'),
        bankName: jText(j, 'bank_name'),
        accountNumber: jText(j, 'account_number'),
        accountMasked: jText(j, 'account_masked'),
        ifsc: jText(j, 'ifsc'),
        upiId: jText(j, 'upi_id'),
        relation: jText(j, 'relation'),
        active: jBool(j, 'active', true),
      );
}

/// Customer (list) and CustomerDetail (adds transactions, last_transaction_at, beneficiaries).
class Customer {
  const Customer({
    required this.id,
    required this.name,
    required this.mobile,
    this.email,
    this.addressLine,
    this.city,
    this.pincode,
    this.dateOfBirth,
    this.idType,
    this.idNumberMasked,
    this.note,
    this.createdAt,
    this.transactions,
    this.lastTransactionAt,
    this.beneficiaries = const [],
  });

  final String id;
  final String name;
  final String mobile;
  final String? email;
  final String? addressLine;
  final String? city;
  final String? pincode;

  /// YYYY-MM-DD
  final String? dateOfBirth;
  final String? idType;
  final String? idNumberMasked;
  final String? note;
  final DateTime? createdAt;
  final int? transactions;
  final DateTime? lastTransactionAt;
  final List<Beneficiary> beneficiaries;

  List<Beneficiary> get activeBeneficiaries => beneficiaries.where((b) => b.active).toList();

  String get initials {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  factory Customer.fromJson(Json j) => Customer(
        id: jStr(j, 'id'),
        name: jStr(j, 'name'),
        mobile: jStr(j, 'mobile'),
        email: jText(j, 'email'),
        addressLine: jText(j, 'address_line'),
        city: jText(j, 'city'),
        pincode: jText(j, 'pincode'),
        dateOfBirth: jText(j, 'date_of_birth'),
        idType: jText(j, 'id_type'),
        idNumberMasked: jText(j, 'id_number_masked'),
        note: jText(j, 'note'),
        createdAt: jDate(j, 'created_at'),
        transactions: jIntOrNull(j, 'transactions'),
        lastTransactionAt: jDate(j, 'last_transaction_at'),
        beneficiaries: jList(j, 'beneficiaries', Beneficiary.fromJson),
      );
}

/// Fields for create / update. Empty strings are sent as null so the API clears them on edit.
class CustomerInput {
  const CustomerInput({
    required this.name,
    required this.mobile,
    this.email,
    this.addressLine,
    this.city,
    this.pincode,
    this.dateOfBirth,
    this.idType,
    this.idNumber,
    this.note,
  });

  final String name;
  final String mobile;
  final String? email;
  final String? addressLine;
  final String? city;
  final String? pincode;
  final String? dateOfBirth;
  final String? idType;

  /// Sent when non-empty (an edit without a new number keeps the stored one); cleared with the ID type.
  final String? idNumber;
  final String? note;

  static String? _n(String? v) => (v == null || v.trim().isEmpty) ? null : v.trim();

  Map<String, Object?> toJson() => {
        'name': name.trim(),
        'mobile': mobile.trim(),
        'email': _n(email),
        'address_line': _n(addressLine),
        'city': _n(city),
        'pincode': _n(pincode),
        'date_of_birth': _n(dateOfBirth),
        'id_type': _n(idType),
        if (_n(idType) == null)
          'id_number': null
        else if (_n(idNumber) != null)
          'id_number': _n(idNumber)!.toUpperCase(),
        'note': _n(note),
      };
}

class BeneficiaryInput {
  const BeneficiaryInput({required this.name, this.bankName, this.accountNumber, this.ifsc, this.upiId, this.relation});
  final String name;
  final String? bankName;
  final String? accountNumber;
  final String? ifsc;
  final String? upiId;
  final String? relation;

  static String? _n(String? v) => (v == null || v.trim().isEmpty) ? null : v.trim();

  Map<String, Object?> toJson() => {
        'name': name.trim(),
        'bank_name': _n(bankName),
        'account_number': _n(accountNumber)?.replaceAll(' ', ''),
        'ifsc': _n(ifsc)?.toUpperCase(),
        'upi_id': _n(upiId),
        'relation': _n(relation),
      };
}
