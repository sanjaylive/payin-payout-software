import '../../../core/format/money.dart';

/// `upi://pay?pa=<vpa>&pn=<payee>[&am=<amount>&tn=<note>]&cu=INR` (docs/AGENTS.md §4).
///
/// The VPA is left unescaped (its characters are URL-safe and some UPI apps reject `%40`);
/// payee and note are percent-encoded.
String buildUpiUri({required String vpa, String? payeeName, int? amountPaise, String? note}) {
  final parts = <String>['pa=${vpa.trim()}'];
  final pn = payeeName?.trim();
  if (pn != null && pn.isNotEmpty) parts.add('pn=${Uri.encodeComponent(pn)}');
  if (amountPaise != null && amountPaise > 0) parts.add('am=${Money.toApi(amountPaise)}');
  final tn = note?.trim();
  if (tn != null && tn.isNotEmpty) parts.add('tn=${Uri.encodeComponent(tn.length > 50 ? tn.substring(0, 50) : tn)}');
  parts.add('cu=INR');
  return 'upi://pay?${parts.join('&')}';
}
