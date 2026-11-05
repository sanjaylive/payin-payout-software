import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../../core/widgets/paged_list.dart';
import '../../auth/data/auth_models.dart';
import '../data/transaction_models.dart';
import 'txn_tile.dart';

class TransactionsScreen extends ConsumerStatefulWidget {
  const TransactionsScreen({super.key});

  @override
  ConsumerState<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends ConsumerState<TransactionsScreen> {
  TxnFilter _filter = const TxnFilter();
  late final PagedController<AgentTransaction> _paged = PagedController(_fetcher(_filter));
  final _search = TextEditingController();
  Timer? _debounce;
  bool _searching = false;

  PageFetcher<AgentTransaction> _fetcher(TxnFilter f) => (cursor) => ref.read(transactionsRepositoryProvider).list(f, cursor: cursor);

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _paged.dispose();
    super.dispose();
  }

  void _apply(TxnFilter f) {
    setState(() => _filter = f);
    _paged.reset(_fetcher(f));
  }

  void _onSearch(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () => _apply(_filter.copyWith(search: q.trim())));
  }

  Future<void> _openFilters() async {
    final f = await showModalBottomSheet<TxnFilter>(
      context: context,
      isScrollControlled: true,
      builder: (_) => TxnFilterSheet(initial: _filter),
    );
    if (f != null) _apply(f);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(txnRevisionProvider, (_, _) => _paged.refresh());
    final canWrite = ref.watch(sessionProvider).can(Perm.deskWrite);
    final active = _filter.activeCount;
    return Scaffold(
      appBar: AppBar(
        title: _searching
            ? TextField(
                controller: _search,
                autofocus: true,
                decoration: const InputDecoration(hintText: 'Receipt no, name, mobile, reference', border: InputBorder.none, filled: false),
                textInputAction: TextInputAction.search,
                onChanged: _onSearch,
              )
            : const Text('Transactions'),
        actions: [
          IconButton(
            tooltip: _searching ? 'Close search' : 'Search',
            icon: Icon(_searching ? Icons.close : Icons.search),
            onPressed: () {
              setState(() => _searching = !_searching);
              if (!_searching && _search.text.isNotEmpty) {
                _search.clear();
                _apply(_filter.copyWith(search: ''));
              }
            },
          ),
          IconButton(
            tooltip: 'Filters',
            onPressed: _openFilters,
            icon: Badge(isLabelVisible: active > 0, label: Text('$active'), child: const Icon(Icons.tune_rounded)),
          ),
        ],
      ),
      floatingActionButton: canWrite
          ? FloatingActionButton(tooltip: 'New entry', onPressed: () => context.push('/txn/new?type=MONEY_TRANSFER'), child: const Icon(Icons.add))
          : null,
      body: PagedListView<AgentTransaction>(
        controller: _paged,
        header: active > 0 ? _ActiveFilters(filter: _filter, onClear: () => _apply(TxnFilter(search: _filter.search))) : null,
        itemBuilder: (_, t) => TxnTile(txn: t),
        empty: EmptyView(
          icon: Icons.receipt_long_outlined,
          title: _filter.isEmpty ? 'No transactions yet' : 'Nothing matches',
          message: _filter.isEmpty ? 'Entries you record show up here.' : 'Try other filters or search words.',
        ),
      ),
    );
  }
}

class _ActiveFilters extends StatelessWidget {
  const _ActiveFilters({required this.filter, required this.onClear});
  final TxnFilter filter;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final chips = <String>[
      if (filter.from != null || filter.to != null) Ist.formatRange(IstDateRange(filter.from ?? filter.to!, filter.to ?? filter.from!)),
      if (filter.type != null) TxnType.labelFor(filter.type),
      if (filter.direction != null) filter.direction == 'IN' ? 'Money in' : 'Money out',
      if (filter.status != null) TxnStatus.label(filter.status),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        for (final c in chips) Chip(label: Text(c), visualDensity: VisualDensity.compact),
        TextButton(onPressed: onClear, child: const Text('Clear')),
      ]),
    );
  }
}

/// Date range, type, in/out, status.
class TxnFilterSheet extends StatefulWidget {
  const TxnFilterSheet({super.key, required this.initial});
  final TxnFilter initial;

  @override
  State<TxnFilterSheet> createState() => _TxnFilterSheetState();
}

class _TxnFilterSheetState extends State<TxnFilterSheet> {
  late String? _from = widget.initial.from;
  late String? _to = widget.initial.to;
  late String? _type = widget.initial.type;
  late String? _direction = widget.initial.direction;
  late String? _status = widget.initial.status;

  Future<void> _pickRange() async {
    final now = Ist.nowWall();
    final first = DateTime(now.year - 2);
    final last = DateTime(now.year, now.month, now.day);
    DateTime? toLocal(String? s) {
      final d = Ist.parseDateString(s);
      return d == null ? null : DateTime(d.year, d.month, d.day);
    }

    final f = toLocal(_from);
    final t = toLocal(_to);
    final r = await showDateRangePicker(
      context: context,
      firstDate: first,
      lastDate: last,
      initialDateRange: (f != null && t != null) ? DateTimeRange(start: f, end: t) : null,
    );
    if (r != null) {
      setState(() {
        _from = Ist.dateString(DateTime.utc(r.start.year, r.start.month, r.start.day));
        _to = Ist.dateString(DateTime.utc(r.end.year, r.end.month, r.end.day));
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget group(String title, List<Widget> chips) => Padding(
          padding: const EdgeInsets.only(top: 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t.textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: chips),
          ]),
        );
    ChoiceChip choice(String label, bool selected, VoidCallback onTap) => ChoiceChip(label: Text(label), selected: selected, onSelected: (_) => onTap());

    final presets = <(String, IstDateRange)>[
      ('Today', Ist.todayRange()),
      ('Yesterday', Ist.yesterday()),
      ('This week', Ist.thisWeek()),
      ('This month', Ist.thisMonth()),
      ('Last month', Ist.lastMonth()),
    ];
    final range = (_from != null && _to != null) ? IstDateRange(_from!, _to!) : null;

    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Filter transactions', style: t.textTheme.titleLarge),
          group('Date', [
            for (final (label, r) in presets)
              choice(label, range == r, () {
                final off = range == r;
                setState(() {
                  _from = off ? null : r.from;
                  _to = off ? null : r.to;
                });
              }),
            ActionChip(
              avatar: const Icon(Icons.date_range, size: 18),
              label: Text(range != null && !presets.any((p) => p.$2 == range) ? Ist.formatRange(range) : 'Custom…'),
              onPressed: _pickRange,
            ),
          ]),
          group('Type', [
            for (final type in TxnType.values) choice(type.label, _type == type.code, () => setState(() => _type = _type == type.code ? null : type.code)),
          ]),
          group('Direction', [
            choice('Money in', _direction == 'IN', () => setState(() => _direction = _direction == 'IN' ? null : 'IN')),
            choice('Money out', _direction == 'OUT', () => setState(() => _direction = _direction == 'OUT' ? null : 'OUT')),
          ]),
          group('Status', [
            for (final s in TxnStatus.all) choice(TxnStatus.label(s), _status == s, () => setState(() => _status = _status == s ? null : s)),
          ]),
          const SizedBox(height: 24),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => Navigator.pop(context, TxnFilter(search: widget.initial.search)),
                child: const Text('Reset'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                onPressed: () => Navigator.pop(
                  context,
                  TxnFilter(from: _from, to: _to, type: _type, direction: _direction, status: _status, search: widget.initial.search),
                ),
                child: const Text('Apply'),
              ),
            ),
          ]),
        ]),
      ),
    );
  }
}
