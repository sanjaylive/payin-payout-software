import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/format/money.dart';
import '../data/agent_models.dart';

/// One plan: price, limits, features.
class PlanCard extends StatelessWidget {
  const PlanCard({super.key, required this.plan, required this.yearly, this.current = false, this.compact = false, this.action});
  final Plan plan;
  final bool yearly;
  final bool current;
  final bool compact;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final scheme = t.colorScheme;
    final price = yearly ? plan.priceYearlyPaise : plan.priceMonthlyPaise;
    final features = <(bool, String)>[
      (true, plan.txnLimitLabel),
      (true, plan.staffLimit == 1 ? '1 login' : '${plan.staffLimit} logins (owner included)'),
      (plan.driveBackup, 'Google Drive backup'),
      (plan.brandedReceipts, 'Branded receipts (logo, footer)'),
      (plan.messaging, 'SMS / WhatsApp receipts'),
    ];
    return Card(
      shape: current
          ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: scheme.primary, width: 2))
          : null,
      child: Padding(
        padding: EdgeInsets.all(compact ? 14 : 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Row(children: [
            Expanded(child: Text(plan.name, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800))),
            if (current)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: scheme.primaryContainer, borderRadius: BorderRadius.circular(20)),
                child: Text('Current', style: TextStyle(color: scheme.onPrimaryContainer, fontSize: 12, fontWeight: FontWeight.w600)),
              ),
          ]),
          const SizedBox(height: 4),
          Text.rich(TextSpan(children: [
            TextSpan(text: price == 0 ? 'Free' : Money.format(price, compactZeroPaise: true), style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            if (price > 0) TextSpan(text: yearly ? ' / year' : ' / month', style: t.textTheme.bodyMedium),
          ])),
          if (!compact && plan.description != null) ...[
            const SizedBox(height: 6),
            Text(plan.description!, style: t.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
          ],
          const SizedBox(height: 10),
          for (final (on, label) in features)
            if (on || !compact)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(children: [
                  Icon(on ? Icons.check_circle_rounded : Icons.remove_circle_outline, size: 18, color: on ? scheme.primary : scheme.outline),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.textTheme.bodyMedium?.copyWith(color: on ? null : scheme.outline, decoration: on ? null : TextDecoration.lineThrough)),
                  ),
                ]),
              ),
          if (action != null) ...[const SizedBox(height: 12), action!],
        ]),
      ),
    );
  }
}

/// Shown when the monthly transaction limit is reached (422 LIMIT_EXCEEDED) or a paid feature is tapped.
Future<void> showUpgradeSheet(BuildContext context, {required String message, String title = 'Upgrade your plan'}) {
  return showModalBottomSheet<void>(
    context: context,
    builder: (ctx) {
      final t = Theme.of(ctx);
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Icon(Icons.rocket_launch_rounded, size: 48, color: t.colorScheme.primary),
            const SizedBox(height: 12),
            Text(title, textAlign: TextAlign.center, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                context.push('/settings/billing');
              },
              child: const Text('See plans'),
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Not now')),
          ]),
        ),
      );
    },
  );
}
