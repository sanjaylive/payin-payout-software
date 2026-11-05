import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../../home/ui/home_screen.dart';
import '../data/agent_models.dart';
import 'plan_card.dart';

final billingProvider = FutureProvider.autoDispose<BillingOverview>((ref) => ref.watch(agentRepositoryProvider).billing());

/// Current plan, usage, plan comparison, checkout (external browser) and order history.
class BillingScreen extends ConsumerStatefulWidget {
  const BillingScreen({super.key});

  @override
  ConsumerState<BillingScreen> createState() => _BillingScreenState();
}

class _BillingScreenState extends ConsumerState<BillingScreen> {
  bool _yearly = false;
  String? _busyPlan;
  String? _awaitingOrderId;
  bool _polling = false;
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: () {
      if (_awaitingOrderId != null) _poll(_awaitingOrderId!);
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  void _refreshAll() {
    ref.invalidate(billingProvider);
    ref.invalidate(profileProvider);
    ref.invalidate(dashboardProvider);
  }

  Future<void> _checkout(Plan plan) async {
    setState(() => _busyPlan = plan.code);
    try {
      final order = await ref.read(agentRepositoryProvider).checkout(plan.code, _yearly ? 'YEARLY' : 'MONTHLY');
      await _openCheckout(order);
    } on ApiException catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _busyPlan = null);
    }
  }

  Future<void> _openCheckout(PlanOrder order) async {
    final url = order.checkoutUrl;
    if (url == null) {
      if (order.isFinal) return _poll(order.id);
      if (mounted) showSnack(context, 'This order has no payment link. Try again.', error: true);
      return;
    }
    _awaitingOrderId = order.id;
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      _awaitingOrderId = null;
      showSnack(context, 'Couldn’t open the browser.', error: true);
    }
  }

  /// After returning from the browser: check the order until it is paid / expired / cancelled.
  Future<void> _poll(String orderId) async {
    if (_polling) return;
    setState(() => _polling = true);
    PlanOrder? last;
    try {
      for (var i = 0; i < 20 && mounted; i++) {
        try {
          last = await ref.read(agentRepositoryProvider).order(orderId);
        } on ApiException catch (e) {
          if (!e.isNetwork) rethrow;
        }
        if (last != null && last.isFinal) break;
        await Future<void>.delayed(const Duration(seconds: 3));
      }
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _polling = false);
    }
    if (!mounted) return;
    _refreshAll();
    if (last == null) return;
    if (last.status == 'PAID') {
      _awaitingOrderId = null;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          icon: const Icon(Icons.celebration_rounded, size: 40),
          title: Text('${last!.planName} plan active'),
          content: Text(last.periodEnd != null ? 'Thank you! Your plan runs until ${Ist.formatDate(last.periodEnd)}.' : 'Thank you! Your plan is active.'),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
        ),
      );
    } else if (last.isFinal) {
      _awaitingOrderId = null;
      showSnack(context, 'Payment ${StatusChip.labelFor(last.status).toLowerCase()}. No money was taken for this order.', error: true);
    } else {
      showSnack(context, 'Payment not confirmed yet. It can take a minute — pull down to refresh.');
    }
  }

  Future<void> _cancel(PlanOrder o) async {
    final ok = await confirmDialog(context, title: 'Cancel this order?', message: 'The payment link stops working.', confirmLabel: 'Cancel order', destructive: true);
    if (!ok) return;
    try {
      await ref.read(agentRepositoryProvider).cancelOrder(o.id);
      if (_awaitingOrderId == o.id) _awaitingOrderId = null;
      ref.invalidate(billingProvider);
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    }
  }

  void _contactSupport() {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Contact support to upgrade'),
        content: const Text('Online payment for plans isn’t available yet. Contact your Pay2All support or account manager and they can switch your plan.'),
        actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(billingProvider);
    final canBuy = ref.watch(sessionProvider).can(Perm.billingManage);
    return Scaffold(
      appBar: AppBar(title: const Text('Plan & billing')),
      body: AsyncBody<BillingOverview>(
        value: value,
        onRetry: () => ref.invalidate(billingProvider),
        data: (b) {
          final profile = ref.watch(profileProvider).value;
          final paidPlans = b.plans.where((p) => !p.isFree && p.active).toList();
          final pending = b.orders.where((o) => o.isPending && o.checkoutUrl != null).toList();
          return RefreshIndicator(
            onRefresh: () async => _refreshAll(),
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
              if (_polling) ...[
                const InfoBanner('Checking your payment…', icon: Icons.hourglass_top_rounded),
                const SizedBox(height: 12),
              ],
              if (profile != null) PlanUsageCard(profile: profile),
              const SizedBox(height: 12),
              _CurrentPlan(current: b.current, usage: b.usage),
              for (final o in pending) ...[
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Unpaid order: ${o.planName} (${o.periodLabel}) · ${Money.format(o.amountPaise)}', style: Theme.of(context).textTheme.titleSmall),
                      const SizedBox(height: 8),
                      if (canBuy)
                        Row(children: [
                          Expanded(child: FilledButton(onPressed: () => _openCheckout(o), child: const Text('Pay now'))),
                          const SizedBox(width: 8),
                          OutlinedButton(onPressed: () => _cancel(o), child: const Text('Cancel')),
                        ])
                      else
                        const Text('Ask the shop owner to complete the payment.'),
                    ]),
                  ),
                ),
              ],
              SectionHeader(
                'Compare plans',
                padding: const EdgeInsets.fromLTRB(0, 24, 0, 8),
                trailing: SegmentedButton<bool>(
                  showSelectedIcon: false,
                  segments: const [ButtonSegment(value: false, label: Text('Monthly')), ButtonSegment(value: true, label: Text('Yearly'))],
                  selected: {_yearly},
                  onSelectionChanged: (v) => setState(() => _yearly = v.first),
                ),
              ),
              for (final p in b.plans.where((p) => p.active)) ...[
                PlanCard(
                  plan: p,
                  yearly: _yearly,
                  current: p.code == b.current.code,
                  action: p.isFree || !canBuy
                      ? null
                      : !b.onlinePaymentAvailable
                          ? OutlinedButton(onPressed: _contactSupport, child: const Text('Contact support'))
                          : SizedBox(
                              width: double.infinity,
                              child: FilledButton(
                                onPressed: _busyPlan != null ? null : () => _checkout(p),
                                child: _busyPlan == p.code
                                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                                    : Text(p.code == b.current.code ? 'Renew ${_yearly ? '1 year' : '1 month'}' : 'Upgrade to ${p.name}'),
                              ),
                            ),
                ),
                const SizedBox(height: 12),
              ],
              if (!canBuy && paidPlans.isNotEmpty) const InfoBanner('Only the shop owner can buy or renew a plan.'),
              if (b.orders.isNotEmpty) ...[
                const SectionHeader('Order history', padding: EdgeInsets.fromLTRB(0, 20, 0, 8)),
                Card(
                  child: Column(children: [
                    for (final o in b.orders)
                      ListTile(
                        title: Text('${o.planName} · ${o.periodLabel}${o.granted ? ' (granted)' : ''}'),
                        subtitle: Text([
                          Ist.formatDate(o.createdAt),
                          if (o.periodStart != null && o.periodEnd != null) '${Ist.formatDate(o.periodStart)} – ${Ist.formatDate(o.periodEnd)}',
                        ].join(' · ')),
                        trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                          Text(Money.format(o.amountPaise, compactZeroPaise: true), style: const TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          StatusChip(o.status),
                        ]),
                      ),
                  ]),
                ),
              ],
            ]),
          );
        },
      ),
    );
  }
}

class _CurrentPlan extends StatelessWidget {
  const _CurrentPlan({required this.current, required this.usage});
  final Plan current;
  final Usage usage;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Current plan', style: t.textTheme.labelLarge?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          Text(current.name, style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          if (current.lapsedFrom != null)
            Text('Your ${current.lapsedFrom!.toLowerCase()} plan has ended — you are on Free limits until you renew.', style: TextStyle(color: t.colorScheme.error))
          else if (current.expiresAt != null)
            Text('Valid until ${Ist.formatDate(current.expiresAt)}'),
          const SizedBox(height: 8),
          KeyValueRow('Transactions this month', current.unlimited ? '${usage.transactionsThisMonth} (unlimited)' : '${usage.transactionsThisMonth} of ${current.monthlyTxnLimit}'),
          KeyValueRow('Active logins', '${usage.staff} of ${current.staffLimit}'),
        ]),
      ),
    );
  }
}
