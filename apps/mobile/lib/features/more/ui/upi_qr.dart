import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/format/money.dart';
import '../../../core/widgets/common.dart';
import '../../transactions/data/upi.dart';

/// A scannable UPI QR (always black on white so every camera reads it, also in dark mode).
class UpiQrCard extends StatelessWidget {
  const UpiQrCard({super.key, required this.vpa, this.payeeName, this.amountPaise, this.note, this.size = 240});
  final String vpa;
  final String? payeeName;
  final int? amountPaise;
  final String? note;
  final double size;

  @override
  Widget build(BuildContext context) {
    final uri = buildUpiUri(vpa: vpa, payeeName: payeeName, amountPaise: amountPaise, note: note);
    final t = Theme.of(context);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), border: Border.all(color: t.colorScheme.outlineVariant)),
        child: QrImageView(
          data: uri,
          size: size,
          backgroundColor: Colors.white,
          eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: Colors.black),
          dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: Colors.black),
          semanticsLabel: 'UPI QR code for $vpa',
        ),
      ),
      const SizedBox(height: 12),
      if (payeeName != null) Text(payeeName!, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
      InkWell(
        onTap: () {
          Clipboard.setData(ClipboardData(text: vpa));
          showSnack(context, 'UPI id copied');
        },
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Row(mainAxisSize: MainAxisSize.min, children: [Text(vpa, style: t.textTheme.bodyLarge), const SizedBox(width: 6), const Icon(Icons.copy, size: 16)]),
        ),
      ),
      if (amountPaise != null && amountPaise! > 0) ...[
        const SizedBox(height: 4),
        Text(Money.format(amountPaise!), style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      ],
    ]);
  }
}

Future<void> showUpiQrSheet(BuildContext context, {required String vpa, String? payeeName, int? amountPaise, String? note}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('Collect via UPI', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 4),
          const Text('Ask the customer to scan with any UPI app.'),
          const SizedBox(height: 16),
          UpiQrCard(vpa: vpa, payeeName: payeeName, amountPaise: amountPaise, note: note),
          const SizedBox(height: 16),
          SizedBox(width: double.infinity, child: FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done'))),
        ]),
      ),
    ),
  );
}
