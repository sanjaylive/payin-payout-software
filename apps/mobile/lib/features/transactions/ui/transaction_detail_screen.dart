import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../data/transaction_models.dart';
import 'receipt_actions.dart';
import 'txn_tile.dart';

class TransactionDetailScreen extends ConsumerWidget {
  const TransactionDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(receiptProvider(id));
    final canManage = ref.watch(sessionProvider).can(Perm.txnManage);
    return Scaffold(
      appBar: AppBar(
        title: Text(value.value?.transaction.receiptNo ?? 'Transaction'),
        actions: [
          IconButton(tooltip: 'Receipt', onPressed: () => context.push('/txn/$id/receipt'), icon: const Icon(Icons.receipt_outlined)),
        ],
      ),
      body: AsyncBody<Receipt>(
        value: value,
        onRetry: () => ref.invalidate(receiptProvider(id)),
        data: (r) {
          final t = r.transaction;
          final next = TxnStatus.nextFrom(t.status);
          return RefreshIndicator(
            onRefresh: () => ref.refresh(receiptProvider(id).future).then((_) {}, onError: (_) {}),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                _Header(t: t),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(children: [
                      KeyValueRow('Type', t.typeLabel),
                      KeyValueRow('Direction', t.isIn ? 'Money in' : 'Money out'),
                      KeyValueRow('Mode', PayMode.label(t.mode)),
                      KeyValueRow('Amount', Money.format(t.amountPaise)),
                      KeyValueRow('Service charge', Money.format(t.feePaise)),
                      KeyValueRow(t.isIn ? 'Customer paid' : 'Customer received', Money.format(t.totalPaise), bold: true),
                      if (t.reference != null) KeyValueRow('Reference', t.reference),
                      if (t.description != null) KeyValueRow('Note', t.description),
                      KeyValueRow('Date & time', '${Ist.formatDateTime(t.occurredAt)} IST'),
                      if (t.createdBy != null) KeyValueRow('Recorded by', t.createdBy),
                    ]),
                  ),
                ),
                if (t.customer != null) ...[
                  const SectionHeader('Customer', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
                  Card(
                    child: ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                      title: Text(t.customer!.name ?? '—'),
                      subtitle: Text(t.customer!.mobile ?? ''),
                      trailing: t.customer!.id != null ? const Icon(Icons.chevron_right) : null,
                      onTap: t.customer!.id != null ? () => context.push('/customer/${t.customer!.id}') : null,
                    ),
                  ),
                ],
                if (t.beneficiary != null) ...[
                  const SectionHeader('Beneficiary', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(children: [
                        KeyValueRow('Name', t.beneficiary!.name),
                        if (t.beneficiary!.bankName != null) KeyValueRow('Bank', t.beneficiary!.bankName),
                        if (t.beneficiary!.accountMasked != null) KeyValueRow('Account', t.beneficiary!.accountMasked),
                        if (t.beneficiary!.ifsc != null) KeyValueRow('IFSC', t.beneficiary!.ifsc),
                        if (t.beneficiary!.upiId != null) KeyValueRow('UPI id', t.beneficiary!.upiId),
                      ]),
                    ),
                  ),
                ],
                if (t.statusChangedAt != null || t.statusNote != null || t.receiptSentAt != null) ...[
                  const SectionHeader('History', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(children: [
                        if (t.statusChangedAt != null) KeyValueRow('Status changed', Ist.formatDateTime(t.statusChangedAt)),
                        if (t.statusNote != null) KeyValueRow('Status note', t.statusNote),
                        if (t.receiptSentAt != null) KeyValueRow('Receipt sent', Ist.formatDateTime(t.receiptSentAt)),
                      ]),
                    ),
                  ),
                ],
                const SectionHeader('Receipt', padding: EdgeInsets.fromLTRB(4, 20, 4, 8)),
                ReceiptActions(receipt: r),
                if (canManage && next.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  OutlinedButton.icon(
                    onPressed: () => _changeStatus(context, ref, t, next),
                    icon: const Icon(Icons.swap_horiz_rounded),
                    label: const Text('Change status'),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _changeStatus(BuildContext context, WidgetRef ref, AgentTransaction t, List<String> options) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _StatusSheet(txn: t, options: options),
    );
    if (changed == true) {
      ref.invalidate(receiptProvider(id));
      ref.invalidate(dashboardProvider);
      ref.read(txnRevisionProvider.notifier).bump();
      if (context.mounted) showSnack(context, 'Status updated');
    }
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.t});
  final AgentTransaction t;

  @override
  Widget build(BuildContext context) {
    final th = Theme.of(context);
    return Column(children: [
      const SizedBox(height: 8),
      CircleAvatar(radius: 28, backgroundColor: th.colorScheme.secondaryContainer, child: Icon(txnIcon(t.type), size: 28)),
      const SizedBox(height: 10),
      AmountText(t.amountPaise, direction: t.direction, style: th.textTheme.headlineMedium, strike: !t.countsInTotals),
      const SizedBox(height: 6),
      Text(t.title, style: th.textTheme.titleMedium, textAlign: TextAlign.center),
      const SizedBox(height: 8),
      StatusChip(t.status, dense: false),
    ]);
  }
}

class _StatusSheet extends ConsumerStatefulWidget {
  const _StatusSheet({required this.txn, required this.options});
  final AgentTransaction txn;
  final List<String> options;

  @override
  ConsumerState<_StatusSheet> createState() => _StatusSheetState();
}

class _StatusSheetState extends ConsumerState<_StatusSheet> {
  late String _status = widget.options.first;
  final _note = TextEditingController();
  late final _reference = TextEditingController(text: widget.txn.reference);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    _reference.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(transactionsRepositoryProvider).changeStatus(
            widget.txn.id,
            _status,
            reference: _reference.text != (widget.txn.reference ?? '') ? _reference.text : null,
            note: _note.text,
          );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final finalStatus = _status == 'FAILED' || _status == 'REFUNDED';
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Change status', style: t.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text('Currently ${TxnStatus.label(widget.txn.status)}', style: t.textTheme.bodyMedium),
          const SizedBox(height: 16),
          SegmentedButton<String>(
            segments: [for (final s in widget.options) ButtonSegment(value: s, label: Text(TxnStatus.label(s)))],
            selected: {_status},
            onSelectionChanged: (v) => setState(() => _status = v.first),
          ),
          if (finalStatus) ...[
            const SizedBox(height: 12),
            InfoBanner('${TxnStatus.label(_status)} is final and leaves this entry out of totals.', icon: Icons.warning_amber_rounded),
          ],
          const SizedBox(height: 16),
          TextField(controller: _reference, decoration: const InputDecoration(labelText: 'Reference (UTR / RRN)')),
          const SizedBox(height: 12),
          TextField(controller: _note, maxLength: 255, decoration: const InputDecoration(labelText: 'Note (why)')),
          if (_error != null) ...[const SizedBox(height: 8), ErrorBanner(_error!)],
          const SizedBox(height: 12),
          BusyButton(label: 'Save', busy: _busy, onPressed: _save),
        ]),
      ),
    );
  }
}
