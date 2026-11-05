import 'package:intl/intl.dart';

/// Money is kept as integer paise inside the app and exchanged with the API as rupee strings with
/// two decimals ("1500.00"). Never use doubles for amounts.
class Money {
  Money._();

  static final NumberFormat _grouping = NumberFormat.decimalPattern('en_IN');

  static final RegExp _amountRe = RegExp(r'^-?\d+(\.\d{0,2})?$');

  /// "1,500.50" / "1500.5" / "₹ 1500" → 150050 paise. Returns null when it isn't a valid amount.
  static int? tryParsePaise(String? input) {
    if (input == null) return null;
    var s = input.trim().replaceAll('₹', '').replaceAll(',', '').replaceAll(' ', '');
    if (s.startsWith('Rs.')) s = s.substring(3);
    if (s.isEmpty || s == '-' || s == '.') return null;
    if (s.startsWith('.')) s = '0$s';
    if (!_amountRe.hasMatch(s)) return null;
    final negative = s.startsWith('-');
    if (negative) s = s.substring(1);
    final parts = s.split('.');
    final rupees = int.tryParse(parts[0].isEmpty ? '0' : parts[0]);
    if (rupees == null) return null;
    var frac = parts.length > 1 ? parts[1] : '';
    frac = frac.padRight(2, '0');
    final paise = rupees * 100 + int.parse(frac);
    return negative ? -paise : paise;
  }

  /// Lenient parse for values from the API: null / garbage → 0.
  static int parsePaise(Object? value) {
    if (value == null) return 0;
    if (value is int) return value * 100;
    if (value is num) return (value * 100).round();
    return tryParsePaise(value.toString()) ?? 0;
  }

  /// 150050 → "1500.50" (the API's wire format).
  static String toApi(int paise) {
    final negative = paise < 0;
    final abs = paise.abs();
    final s = '${abs ~/ 100}.${(abs % 100).toString().padLeft(2, '0')}';
    return negative ? '-$s' : s;
  }

  /// 15000050 → "₹1,50,000.50". With [compactZeroPaise], "₹1,50,000".
  static String format(int paise, {bool symbol = true, bool compactZeroPaise = false}) {
    final negative = paise < 0;
    final abs = paise.abs();
    final rupees = _grouping.format(abs ~/ 100);
    final p = abs % 100;
    final body = (compactZeroPaise && p == 0) ? rupees : '$rupees.${p.toString().padLeft(2, '0')}';
    return '${negative ? '-' : ''}${symbol ? '₹' : ''}$body';
  }

  /// Format an API amount string ("1500.00") for display.
  static String formatApi(Object? value, {bool symbol = true, bool compactZeroPaise = false}) =>
      format(parsePaise(value), symbol: symbol, compactZeroPaise: compactZeroPaise);
}
