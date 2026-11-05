import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../../transactions/data/transaction_models.dart';
import '../../transactions/ui/txn_tile.dart';
import '../data/customer_models.dart';
import 'customer_fields.dart';

final customerProvider = FutureProvider.autoDispose.family<Customer, String>((ref, id) => ref.watch(customersRepositoryProvider).get(id));

final customerTxnsProvider = FutureProvider.autoDispose.family<List<AgentTransaction>, String>((ref, id) async {
  final page = await ref.watch(transactionsRepositoryProvider).list(TxnFilter(customerId: id), limit: 20);
  return page.items;
});

class CustomerDetailScreen extends ConsumerWidget {
  const CustomerDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(customerProvider(id));
    final canWrite = ref.watch(sessionProvider).can(Perm.deskWrite);
    return Scaffold(
      appBar: AppBar(
        title: Text(value.value?.name ?? 'Customer'),
        actions: [
          if (canWrite && value.hasValue)
            IconButton(
              tooltip: 'Edit',
              icon: const Icon(Icons.edit_outlined),
              onPressed: () async {
                await context.push('/customer/$id/edit');
                ref.invalidate(customerProvider(id));
              },
            ),
        ],
      ),
      floatingActionButton: canWrite && value.hasValue
          ? FloatingActionButton.extended(
              onPressed: () => context.push('/txn/new?type=MONEY_TRANSFER&customer=$id'),
              icon: const Icon(Icons.send_rounded),
              label: const Text('New transfer'),
            )
          : null,
      body: AsyncBody<Customer>(
        value: value,
        onRetry: () => ref.invalidate(customerProvider(id)),
        data: (c) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(customerTxnsProvider(id));
            await ref.refresh(customerProvider(id).future).then((_) {}, onError: (_) {});
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
            children: [
              _ProfileCard(c: c, canWrite: canWrite),
              SectionHeader(
                'Beneficiaries',
                padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
                trailing: canWrite
                    ? TextButton.icon(
                        onPressed: () async {
                          final b = await showAddBeneficiarySheet(context, c.id);
                          if (b != null) {
                            ref.invalidate(customerProvider(id));
                            if (context.mounted) showSnack(context, 'Beneficiary added');
                          }
                        },
                        icon: const Icon(Icons.add),
                        label: const Text('Add'),
                      )
                    : null,
              ),
              if (c.activeBeneficiaries.isEmpty)
                const Card(child: Padding(padding: EdgeInsets.all(16), child: Text('No beneficiaries yet.')))
              else
                Card(
                  child: Column(children: [
                    for (final b in c.activeBeneficiaries) _BeneficiaryTile(b: b, canWrite: canWrite, customerId: id),
                  ]),
                ),
              const SectionHeader('Transactions', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
              _CustomerTxns(id: id),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProfileCard extends ConsumerStatefulWidget {
  const _ProfileCard({required this.c, required this.canWrite});
  final Customer c;
  final bool canWrite;

  @override
  ConsumerState<_ProfileCard> createState() => _ProfileCardState();
}

class _ProfileCardState extends ConsumerState<_ProfileCard> {
  String? _revealed;
  bool _revealing = false;

  Future<void> _reveal() async {
    final ok = await confirmDialog(
      context,
      title: 'Show full ID number?',
      message: 'Viewing the full ID number is recorded in the audit log. Only do this when you need it.',
      confirmLabel: 'Show',
    );
    if (!ok) return;
    setState(() => _revealing = true);
    try {
      final r = await ref.read(customersRepositoryProvider).revealId(widget.c.id);
      if (mounted) setState(() => _revealed = r.idNumber ?? '—');
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _revealing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final t = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            CircleAvatar(radius: 28, child: Text(c.initials, style: t.textTheme.titleLarge)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(c.name, style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                Text(c.mobile, style: t.textTheme.bodyLarge),
              ]),
            ),
          ]),
          const SizedBox(height: 12),
          if (c.email != null) KeyValueRow('Email', c.email),
          if (c.addressLine != null || c.city != null || c.pincode != null)
            KeyValueRow('Address', [c.addressLine, c.city, c.pincode].whereType<String>().join(', ')),
          if (c.dateOfBirth != null) KeyValueRow('Date of birth', Ist.formatCalendarDate(c.dateOfBirth)),
          if (c.idType != null)
            KeyValueRow(
              IdTypes.label(c.idType),
              null,
              valueWidget: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                Flexible(child: SelectableText(_revealed ?? c.idNumberMasked ?? '—', style: t.textTheme.bodyLarge)),
                if (widget.canWrite && _revealed == null && c.idNumberMasked != null)
                  _revealing
                      ? const Padding(padding: EdgeInsets.all(8), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
                      : IconButton(tooltip: 'Show full number', onPressed: _reveal, icon: const Icon(Icons.visibility_outlined)),
              ]),
            ),
          if (c.note != null) KeyValueRow('Note', c.note),
          KeyValueRow('Transactions', '${c.transactions ?? 0}${c.lastTransactionAt != null ? ' · last ${Ist.formatRelative(c.lastTransactionAt)}' : ''}'),
          if (c.createdAt != null) KeyValueRow('Customer since', Ist.formatDate(c.createdAt)),
        ]),
      ),
    );
  }
}

class _BeneficiaryTile extends ConsumerWidget {
  const _BeneficiaryTile({required this.b, required this.canWrite, required this.customerId});
  final Beneficiary b;
  final bool canWrite;
  final String customerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListTile(
      leading: CircleAvatar(child: Icon(b.upiId != null && b.accountNumber == null && b.accountMasked == null ? Icons.qr_code : Icons.account_balance_outlined)),
      title: Text(b.relation == null ? b.name : '${b.name} (${b.relation})'),
      subtitle: Text(b.subtitle),
      onLongPress: b.accountNumber == null
          ? null
          : () {
              Clipboard.setData(ClipboardData(text: b.accountNumber!));
              showSnack(context, 'Account number copied');
            },
      trailing: canWrite
          ? IconButton(
              tooltip: 'Remove',
              icon: const Icon(Icons.delete_outline),
              onPressed: () async {
                final ok = await confirmDialog(context,
                    title: 'Remove ${b.name}?', message: 'Past receipts keep the beneficiary’s details.', confirmLabel: 'Remove', destructive: true);
                if (!ok) return;
                try {
                  await ref.read(customersRepositoryProvider).removeBeneficiary(b.id);
                  ref.invalidate(customerProvider(customerId));
                  if (context.mounted) showSnack(context, 'Beneficiary removed');
                } catch (e) {
                  if (context.mounted) showErrorSnack(context, e);
                }
              },
            )
          : null,
    );
  }
}

class _CustomerTxns extends ConsumerWidget {
  const _CustomerTxns({required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = ref.watch(customerTxnsProvider(id));
    return v.when(
      data: (list) => list.isEmpty
          ? const Card(child: Padding(padding: EdgeInsets.all(16), child: Text('No transactions for this customer yet.')))
          : Card(child: Column(children: [for (final t in list) TxnTile(txn: t)])),
      loading: () => const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
      error: (e, _) => ErrorView(error: e, onRetry: () => ref.invalidate(customerTxnsProvider(id)), compact: true),
    );
  }
}
