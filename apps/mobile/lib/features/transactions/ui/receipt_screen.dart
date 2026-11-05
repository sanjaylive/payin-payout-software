import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config.dart';
import '../../../core/format/money.dart';
import '../../../core/widgets/common.dart';
import '../data/receipt_pdf.dart';
import '../data/transaction_models.dart';
import 'receipt_actions.dart';

/// The receipt as the customer sees it, plus share / print / send actions.
/// After recording ([justRecorded]) it doubles as the success screen.
class ReceiptScreen extends ConsumerWidget {
  const ReceiptScreen({super.key, required this.id, this.justRecorded = false});
  final String id;
  final bool justRecorded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(receiptProvider(id));
    return Scaffold(
      appBar: AppBar(
        title: Text(justRecorded ? 'Recorded' : 'Receipt'),
        automaticallyImplyLeading: !justRecorded,
        actions: [if (justRecorded) TextButton(onPressed: () => context.go('/home'), child: const Text('Done'))],
      ),
      body: AsyncBody<Receipt>(
        value: value,
        onRetry: () => ref.invalidate(receiptProvider(id)),
        data: (r) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            if (justRecorded) _SuccessHeader(receipt: r),
            ReceiptCard(receipt: r),
            const SizedBox(height: 16),
            ReceiptActions(receipt: r),
            if (justRecorded) ...[
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => context.pushReplacement('/txn/new?type=${r.transaction.type}'),
                icon: const Icon(Icons.add),
                label: const Text('New entry'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(onPressed: () => context.go('/home'), child: const Text('Back to home')),
            ],
          ],
        ),
      ),
    );
  }
}

class _SuccessHeader extends StatelessWidget {
  const _SuccessHeader({required this.receipt});
  final Receipt receipt;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final pending = receipt.transaction.status == 'PENDING';
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(children: [
        Icon(pending ? Icons.hourglass_top_rounded : Icons.check_circle_rounded, size: 64, color: pending ? Colors.amber.shade700 : Colors.green.shade600),
        const SizedBox(height: 8),
        Text(pending ? 'Saved as pending' : 'Transaction recorded', style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
        Text('${receipt.transaction.receiptNo} · ${Money.format(receipt.transaction.totalPaise)}', style: t.textTheme.bodyLarge),
      ]),
    );
  }
}

/// On-screen receipt (same lines as the PDF).
class ReceiptCard extends StatelessWidget {
  const ReceiptCard({super.key, required this.receipt});
  final Receipt receipt;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final r = receipt;
    final txn = r.transaction;
    final logo = r.branded ? r.shop.logoUrl : null;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (logo != null)
              Padding(
                padding: const EdgeInsets.only(right: 12),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.network(
                    AppConfig.apiUrl(logo),
                    width: 52,
                    height: 52,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => const SizedBox(width: 52, height: 52, child: Icon(Icons.storefront)),
                  ),
                ),
              ),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(r.shop.name, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                if (r.shop.address != null) Text(r.shop.address!, style: t.textTheme.bodySmall),
                if (r.shop.mobile != null) Text('Mobile: ${r.shop.mobile}', style: t.textTheme.bodySmall),
              ]),
            ),
          ]),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(color: t.colorScheme.primaryContainer.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(10)),
            child: Row(children: [
              Expanded(child: Text('${r.typeLabel} receipt', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
              StatusChip(txn.status),
            ]),
          ),
          const SizedBox(height: 8),
          for (final (k, v) in receiptLines(r))
            if (k != 'Status') KeyValueRow(k, v),
          const Divider(height: 20),
          KeyValueRow('Amount', Money.format(txn.amountPaise)),
          KeyValueRow('Service charge', Money.format(txn.feePaise)),
          const Divider(height: 20),
          KeyValueRow(totalLabel(txn), Money.format(txn.totalPaise), bold: true),
          if (r.shop.footer != null) ...[const SizedBox(height: 12), Text(r.shop.footer!, textAlign: TextAlign.center, style: t.textTheme.bodySmall)],
          if (!r.branded && r.poweredBy != null) ...[
            const SizedBox(height: 12),
            Text('Powered by ${r.poweredBy}', textAlign: TextAlign.center, style: t.textTheme.labelSmall?.copyWith(color: t.colorScheme.outline)),
          ],
        ]),
      ),
    );
  }
}
