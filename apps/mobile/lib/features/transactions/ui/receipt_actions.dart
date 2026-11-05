import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:printing/printing.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../../more/ui/plan_card.dart';
import '../data/receipt_pdf.dart';
import '../data/transaction_models.dart';

final receiptProvider = FutureProvider.autoDispose.family<Receipt, String>((ref, id) => ref.watch(transactionsRepositoryProvider).receipt(id));

/// Build the PDF (with the logo when branded; falls back to no logo if the image can't be embedded).
Future<Uint8List> receiptPdfBytes(WidgetRef ref, Receipt r) async {
  final fonts = await ReceiptFonts.load();
  Uint8List? logo;
  if (r.branded && r.shop.logoUrl != null) {
    try {
      logo = await ref.read(apiClientProvider).getBytes(r.shop.logoUrl!, auth: false);
    } catch (_) {
      logo = null;
    }
  }
  try {
    return await buildReceiptPdf(r, fonts: fonts, logo: logo);
  } catch (_) {
    if (logo == null) rethrow;
    return buildReceiptPdf(r, fonts: fonts);
  }
}

/// "+91 98765 43210" → "919876543210" for wa.me, or null.
String? waNumber(String? mobile) {
  final ten = V.tenDigitMobile(mobile);
  return ten == null ? null : '91$ten';
}

String receiptShareText(Receipt r) {
  final t = r.transaction;
  final buf = StringBuffer('${r.shop.name}: ${r.typeLabel} of ${Money.format(t.amountPaise)}');
  if (t.feePaise > 0) buf.write(' + fee ${Money.format(t.feePaise)}');
  buf.write(' (receipt ${t.receiptNo}, ${TxnStatus.label(t.status).toLowerCase()}).');
  if (r.publicUrl != null) buf.write(' View: ${r.publicUrl}');
  return buf.toString();
}

/// Share PDF · Print · WhatsApp (free) · Copy link · Send SMS / WhatsApp via the API (Business plan).
class ReceiptActions extends ConsumerStatefulWidget {
  const ReceiptActions({super.key, required this.receipt});
  final Receipt receipt;

  @override
  ConsumerState<ReceiptActions> createState() => _ReceiptActionsState();
}

class _ReceiptActionsState extends ConsumerState<ReceiptActions> {
  String? _busy;

  Receipt get r => widget.receipt;

  Future<void> _run(String key, Future<void> Function() f) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await f();
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _sharePdf() => _run('pdf', () async {
        final bytes = await receiptPdfBytes(ref, r);
        await Printing.sharePdf(bytes: bytes, filename: receiptFileName(r), subject: 'Receipt ${r.transaction.receiptNo}', body: receiptShareText(r));
      });

  Future<void> _print() => _run('print', () async {
        final bytes = await receiptPdfBytes(ref, r);
        await Printing.layoutPdf(onLayout: (_) async => bytes, name: receiptFileName(r));
      });

  Future<void> _whatsApp() => _run('wa', () async {
        final n = waNumber(r.transaction.customer?.mobile);
        final uri = Uri.parse('https://wa.me/${n ?? ''}?text=${Uri.encodeComponent(receiptShareText(r))}');
        if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
          throw ApiException(code: 'NO_APP', message: 'Couldn’t open WhatsApp.');
        }
      });

  Future<void> _copy() async {
    final url = r.publicUrl;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) showSnack(context, 'Receipt link copied');
  }

  Future<void> _send(String channel) async {
    final bool messaging;
    try {
      messaging = (await ref.read(profileProvider.future)).plan.messaging;
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
      return;
    }
    if (!mounted) return;
    if (!messaging) {
      await showUpgradeSheet(context,
          title: 'Business plan feature', message: 'Sending receipts by SMS or WhatsApp from Pay2All is part of the Business plan. You can still share on WhatsApp from your phone for free.');
      return;
    }
    String? mobile = r.transaction.customer?.mobile;
    if (mobile == null) {
      mobile = await _askMobile();
      if (mobile == null) return;
    }
    await _run(channel, () async {
      await ref.read(transactionsRepositoryProvider).sendReceipt(r.transaction.id, channel, mobile: r.transaction.customer?.mobile == null ? mobile : null);
      if (mounted) showSnack(context, channel == 'SMS' ? 'Receipt SMS queued' : 'Receipt WhatsApp queued');
      ref.invalidate(receiptProvider(r.transaction.id));
    });
  }

  Future<String?> _askMobile() async {
    final c = TextEditingController();
    final key = GlobalKey<FormState>();
    final res = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Customer’s mobile'),
        content: Form(
          key: key,
          child: TextFormField(
            controller: c,
            autofocus: true,
            keyboardType: TextInputType.phone,
            inputFormatters: mobileInputFormatters,
            decoration: const InputDecoration(prefixText: '+91 ', labelText: 'Mobile number'),
            validator: V.mobile,
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => key.currentState!.validate() ? Navigator.pop(ctx, c.text.trim()) : null, child: const Text('Send')),
        ],
      ),
    );
    c.dispose();
    return res;
  }

  @override
  Widget build(BuildContext context) {
    final canWrite = ref.watch(sessionProvider).can(Perm.deskWrite);
    final messaging = ref.watch(profileProvider).value?.plan.messaging ?? false;
    Widget action(String key, IconData icon, String label, VoidCallback? onTap, {String? badge, bool dimmed = false}) {
      final busy = _busy == key;
      return SizedBox(
        width: 100,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: _busy == null ? onTap : null,
          child: Opacity(
            opacity: (onTap == null || dimmed) ? 0.5 : 1,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: Theme.of(context).colorScheme.secondaryContainer,
                  child: busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(icon),
                ),
                const SizedBox(height: 6),
                Text(label, textAlign: TextAlign.center, style: Theme.of(context).textTheme.labelMedium),
                if (badge != null) Text(badge, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Theme.of(context).colorScheme.outline)),
              ]),
            ),
          ),
        ),
      );
    }

    return Wrap(alignment: WrapAlignment.center, spacing: 4, runSpacing: 4, children: [
      action('pdf', Icons.picture_as_pdf_outlined, 'Share PDF', _sharePdf),
      action('print', Icons.print_outlined, 'Print', _print),
      action('wa', Icons.chat_outlined, 'WhatsApp share', _whatsApp),
      if (r.publicUrl != null) action('copy', Icons.link_rounded, 'Copy link', _copy),
      if (canWrite) ...[
        action('SMS', Icons.sms_outlined, 'Send SMS', () => _send('SMS'), badge: messaging ? null : 'Business plan', dimmed: !messaging),
        action('WHATSAPP', Icons.mark_chat_read_outlined, 'Send WhatsApp', () => _send('WHATSAPP'), badge: messaging ? null : 'Business plan', dimmed: !messaging),
      ],
    ]);
  }
}
