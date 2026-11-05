import 'package:flutter/services.dart';

import 'money.dart';

/// Client-side checks mirroring packages/validation (the server re-checks everything).
class V {
  V._();

  static final _mobile = RegExp(r'^(?:\+?91|0)?[6-9]\d{9}$');
  static final _email = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
  static final _ifsc = RegExp(r'^[A-Z]{4}0[A-Z0-9]{6}$');
  static final _upi = RegExp(r'^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$');
  static final _pin = RegExp(r'^[1-9]\d{5}$');
  static final _account = RegExp(r'^\d{9,18}$');
  static final _idNumber = RegExp(r'^[A-Z0-9 -]{4,20}$');

  static String _clean(String v) => v.replaceAll(RegExp(r'[\s-]'), '');

  static bool isMobile(String? v) => v != null && _mobile.hasMatch(_clean(v.trim()));

  /// "+91 98765-43210" → "9876543210" (or null when invalid).
  static String? tenDigitMobile(String? v) {
    if (!isMobile(v)) return null;
    final c = _clean(v!.trim());
    return c.substring(c.length - 10);
  }

  static String? required(String? v, [String message = 'Required']) => (v == null || v.trim().isEmpty) ? message : null;

  static String? name(String? v, [String what = 'the name']) {
    final s = v?.trim() ?? '';
    if (s.isEmpty) return 'Enter $what';
    if (s.length < 2) return 'Too short';
    if (s.length > 120) return 'Too long';
    return null;
  }

  static String? mobile(String? v) {
    if (v == null || v.trim().isEmpty) return 'Enter the mobile number';
    return isMobile(v) ? null : 'Enter a valid 10-digit Indian mobile number';
  }

  static String? optionalMobile(String? v) => (v == null || v.trim().isEmpty) ? null : mobile(v);

  static String? email(String? v) {
    if (v == null || v.trim().isEmpty) return 'Enter the email address';
    return _email.hasMatch(v.trim()) ? null : 'Enter a valid email address';
  }

  static String? optionalEmail(String? v) => (v == null || v.trim().isEmpty) ? null : email(v);

  static String? identifier(String? v) {
    final s = v?.trim() ?? '';
    if (s.length < 3) return 'Enter your email or mobile number';
    if (s.contains('@')) return _email.hasMatch(s) ? null : 'Enter a valid email address';
    return isMobile(s) ? null : 'Enter a valid email or 10-digit mobile number';
  }

  static String? newPassword(String? v) {
    final s = v ?? '';
    if (s.isEmpty) return 'Choose a password';
    if (s.length < 12) return 'At least 12 characters';
    if (s.length > 128) return 'At most 128 characters';
    return null;
  }

  static String? optionalPincode(String? v) => (v == null || v.trim().isEmpty) ? null : (_pin.hasMatch(v.trim()) ? null : 'Enter a valid 6-digit PIN code');

  static String? optionalIfsc(String? v) =>
      (v == null || v.trim().isEmpty) ? null : (_ifsc.hasMatch(v.trim().toUpperCase()) ? null : 'Enter a valid IFSC, e.g. SBIN0001234');

  static String? optionalUpi(String? v) => (v == null || v.trim().isEmpty) ? null : (_upi.hasMatch(v.trim()) ? null : 'Enter a valid UPI id, e.g. name@okaxis');

  static bool isUpi(String? v) => v != null && _upi.hasMatch(v.trim());

  static String? optionalAccount(String? v) =>
      (v == null || v.trim().isEmpty) ? null : (_account.hasMatch(v.replaceAll(' ', '')) ? null : 'Account number is 9 to 18 digits');

  static String? optionalIdNumber(String? v) =>
      (v == null || v.trim().isEmpty) ? null : (_idNumber.hasMatch(v.trim().toUpperCase()) ? null : 'Enter a valid ID number');

  static String? code6(String? v) => RegExp(r'^\d{6}$').hasMatch(v?.trim() ?? '') ? null : 'Enter the 6-digit code';

  /// Amount ≥ ₹1 and ≤ ₹10 crore.
  static String? amount(String? v) {
    final p = Money.tryParsePaise(v);
    if (p == null) return 'Enter the amount';
    if (p < 100) return 'Minimum amount is ₹1.00';
    if (p > 100000000 * 100) return 'Maximum amount is ₹10,00,00,000';
    return null;
  }

  static String? fee(String? v) {
    if (v == null || v.trim().isEmpty) return null;
    final p = Money.tryParsePaise(v);
    if (p == null) return 'Enter a valid fee';
    if (p < 0) return 'Fee cannot be negative';
    if (p > 1000000 * 100) return 'Fee is too large';
    return null;
  }
}

/// Digits with at most two decimals.
final amountInputFormatters = <TextInputFormatter>[
  FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
  TextInputFormatter.withFunction((oldValue, newValue) => RegExp(r'^\d{0,10}(\.\d{0,2})?$').hasMatch(newValue.text) ? newValue : oldValue),
];

final mobileInputFormatters = <TextInputFormatter>[
  FilteringTextInputFormatter.allow(RegExp(r'[\d+ ]')),
  LengthLimitingTextInputFormatter(14),
];

class UpperCaseFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) =>
      newValue.copyWith(text: newValue.text.toUpperCase());
}
