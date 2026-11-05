import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/providers.dart';
import '../../../core/theme.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../../more/data/agent_models.dart';
import '../../transactions/data/transaction_models.dart';
import '../../transactions/ui/txn_tile.dart';
import '../data/dashboard.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dash = ref.watch(dashboardProvider);
    final me = ref.watch(sessionProvider).me;
    Future<void> refresh() async {
      ref.invalidate(profileProvider);
      return ref.refresh(dashboardProvider.future).then((_) {}, onError: (_) {});
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(dash.value?.profile.shopName ?? me?.orgName ?? 'Home', maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(
            'Hello${me?.name.isNotEmpty == true ? ', ${me!.name.split(' ').first}' : ''} · ${Ist.formatDate(DateTime.now())}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ]),
        actions: [
          IconButton(tooltip: 'My QR', onPressed: () => context.push('/settings/qr'), icon: const Icon(Icons.qr_code_2_rounded)),
        ],
      ),
      floatingActionButton: me?.can(Perm.deskWrite) == true
          ? FloatingActionButton.extended(
              onPressed: () => context.push('/txn/new?type=MONEY_TRANSFER'),
              icon: const Icon(Icons.add),
              label: const Text('New entry'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: refresh,
        child: AsyncBody<Dashboard>(
          value: dash,
          onRetry: () => ref.invalidate(dashboardProvider),
          data: (d) => _HomeBody(d: d, canWrite: me?.can(Perm.deskWrite) ?? false),
        ),
      ),
    );
  }
}

class _HomeBody extends StatelessWidget {
  const _HomeBody({required this.d, required this.canWrite});
  final Dashboard d;
  final bool canWrite;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 96),
      children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: _TodayCard(d: d)),
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: _MonthRow(d: d)),
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: PlanUsageCard(profile: d.profile)),
        if (canWrite) ...[
          const SectionHeader('Quick actions'),
          const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: _QuickActions()),
        ],
        SectionHeader('Recent transactions', trailing: TextButton(onPressed: () => context.go('/transactions'), child: const Text('See all'))),
        if (d.recent.isEmpty)
          const EmptyView(icon: Icons.receipt_long_outlined, title: 'No transactions yet', message: 'Tap “New entry” to record the first one.')
        else
          for (final t in d.recent) TxnTile(txn: t),
      ],
    );
  }
}

class _TodayCard extends StatelessWidget {
  const _TodayCard({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final scheme = t.colorScheme;
    final b = t.brightness;
    Widget stat(String label, int paise, Color color, IconData icon) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(icon, size: 16, color: color),
              const SizedBox(width: 4),
              Text(label, style: t.textTheme.labelMedium?.copyWith(color: scheme.onPrimaryContainer.withValues(alpha: 0.8))),
            ]),
            const SizedBox(height: 4),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(Money.format(paise), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700, color: scheme.onPrimaryContainer)),
            ),
          ]),
        );
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(color: scheme.primaryContainer, borderRadius: BorderRadius.circular(20)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Today’s counter', style: t.textTheme.titleSmall?.copyWith(color: scheme.onPrimaryContainer)),
          const Spacer(),
          Text('${d.todayCount} entries', style: t.textTheme.labelMedium?.copyWith(color: scheme.onPrimaryContainer)),
        ]),
        const SizedBox(height: 6),
        Text('Net', style: t.textTheme.labelMedium?.copyWith(color: scheme.onPrimaryContainer.withValues(alpha: 0.8))),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(Money.format(d.todayNet), style: t.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: scheme.onPrimaryContainer)),
        ),
        const SizedBox(height: 14),
        Row(children: [
          stat('Money in', d.todayIn, AppColors.moneyInOn(b), Icons.south_west_rounded),
          stat('Money out', d.todayOut, AppColors.moneyOutOn(b), Icons.north_east_rounded),
          stat('Fees', d.todayFees, AppColors.feeOn(b), Icons.savings_outlined),
        ]),
      ]),
    );
  }
}

class _MonthRow extends StatelessWidget {
  const _MonthRow({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget tile(String label, String value) => Expanded(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(value, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
              ]),
            ),
          ),
        );
    return Row(children: [
      tile('This month', Money.format(d.monthVolume, compactZeroPaise: true)),
      const SizedBox(width: 8),
      tile('Fees earned', Money.format(d.monthFees, compactZeroPaise: true)),
      const SizedBox(width: 8),
      tile('Entries', '${d.monthCount}'),
    ]);
  }
}

/// Plan name, this month's usage bar, upgrade CTA near the limit.
class PlanUsageCard extends StatelessWidget {
  const PlanUsageCard({super.key, required this.profile});
  final AgentProfile profile;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final plan = profile.plan;
    final used = profile.usage.transactionsThisMonth;
    final fraction = profile.usage.fraction(plan);
    final near = fraction != null && fraction >= 0.8;
    final full = fraction != null && fraction >= 1;
    final barColor = full ? t.colorScheme.error : (near ? AppColors.pending : t.colorScheme.primary);
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => context.push('/settings/billing'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(Icons.workspace_premium_outlined, size: 20, color: t.colorScheme.primary),
              const SizedBox(width: 8),
              Expanded(child: Text('${plan.name} plan', style: t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
              Text(
                plan.unlimited ? '$used this month · Unlimited' : '$used / ${plan.monthlyTxnLimit} this month',
                style: t.textTheme.labelMedium,
              ),
            ]),
            if (fraction != null) ...[
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(value: fraction, minHeight: 8, color: barColor, backgroundColor: t.colorScheme.surfaceContainerHighest),
              ),
            ],
            if (plan.lapsedFrom != null) ...[
              const SizedBox(height: 8),
              Text('Your paid plan has ended. Renew to get its limits back.', style: TextStyle(color: t.colorScheme.error)),
            ] else if (plan.expiresAt != null && !plan.isFree) ...[
              const SizedBox(height: 8),
              Text('Renews / ends on ${Ist.formatDate(plan.expiresAt)}', style: t.textTheme.bodySmall),
            ],
            if (near) ...[
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  child: Text(
                    full ? 'You’ve used this month’s transactions.' : 'You’re close to this month’s limit.',
                    style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                FilledButton.tonal(onPressed: () => context.push('/settings/billing'), child: const Text('Upgrade')),
              ]),
            ],
          ]),
        ),
      ),
    );
  }
}

class _QuickActions extends StatelessWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final items = TxnType.values;
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: items.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, mainAxisSpacing: 8, crossAxisSpacing: 8, childAspectRatio: 1.15),
      itemBuilder: (context, i) {
        final type = items[i];
        return Card(
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => context.push('/txn/new?type=${type.code}'),
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                CircleAvatar(
                  radius: 22,
                  backgroundColor: t.colorScheme.secondaryContainer,
                  child: Icon(txnIcon(type.code), color: t.colorScheme.onSecondaryContainer),
                ),
                const SizedBox(height: 8),
                Text(type.label, textAlign: TextAlign.center, maxLines: 2, style: t.textTheme.labelLarge),
              ]),
            ),
          ),
        );
      },
    );
  }
}
