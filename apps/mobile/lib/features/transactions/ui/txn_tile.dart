import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/format/dates.dart';
import '../../../core/theme.dart';
import '../../../core/widgets/common.dart';
import '../data/transaction_models.dart';

IconData txnIcon(String type) => switch (type) {
      'MONEY_TRANSFER' => Icons.send_rounded,
      'CASH_WITHDRAWAL' => Icons.payments_outlined,
      'CASH_DEPOSIT' => Icons.account_balance_outlined,
      'BILL_PAYMENT' => Icons.receipt_long_outlined,
      'RECHARGE' => Icons.phone_android_rounded,
      _ => Icons.more_horiz_rounded,
    };

class TxnTile extends StatelessWidget {
  const TxnTile({super.key, required this.txn, this.onTap});
  final AgentTransaction txn;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final b = t.brightness;
    final color = txn.isIn ? AppColors.moneyInOn(b) : AppColors.moneyOutOn(b);
    final inactive = !txn.countsInTotals;
    return ListTile(
      onTap: onTap ?? () => context.push('/txn/${txn.id}'),
      leading: CircleAvatar(
        backgroundColor: color.withValues(alpha: 0.12),
        child: Icon(txnIcon(txn.type), color: color, size: 22),
      ),
      title: Text(txn.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text(
        '${txn.typeLabel} · ${txn.receiptNo} · ${Ist.formatRelative(txn.occurredAt)}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
        AmountText(txn.amountPaise, direction: txn.direction, style: t.textTheme.titleSmall, strike: inactive),
        if (txn.status != 'SUCCESS') ...[const SizedBox(height: 4), StatusChip(txn.status)],
      ]),
    );
  }
}
