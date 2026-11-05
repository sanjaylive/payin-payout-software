import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/providers.dart';
import '../../../core/theme.dart';
import '../../../core/widgets/common.dart';
import '../../transactions/data/transaction_models.dart';
import '../data/report_models.dart';

final reportProvider = FutureProvider.autoDispose.family<ReportSummary, IstDateRange>((ref, range) => ref.watch(reportsRepositoryProvider).summary(range));

enum _Preset { today, yesterday, week, month, lastMonth, custom }

class ReportsScreen extends ConsumerStatefulWidget {
  const ReportsScreen({super.key});

  @override
  ConsumerState<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends ConsumerState<ReportsScreen> {
  _Preset _preset = _Preset.today;
  IstDateRange _range = Ist.todayRange();
  bool _exporting = false;

  static const _labels = {
    _Preset.today: 'Today',
    _Preset.yesterday: 'Yesterday',
    _Preset.week: 'This week',
    _Preset.month: 'This month',
    _Preset.lastMonth: 'Last month',
    _Preset.custom: 'Custom',
  };

  Future<void> _choose(_Preset p) async {
    if (p == _Preset.custom) {
      final now = Ist.nowWall();
      final last = DateTime(now.year, now.month, now.day);
      final from = Ist.parseDateString(_range.from)!;
      final to = Ist.parseDateString(_range.to)!;
      final r = await showDateRangePicker(
        context: context,
        firstDate: DateTime(now.year - 3),
        lastDate: last,
        initialDateRange: DateTimeRange(start: DateTime(from.year, from.month, from.day), end: DateTime(to.year, to.month, to.day)),
        helpText: 'Report dates (IST)',
      );
      if (r == null) return;
      if (r.end.difference(r.start).inDays > 365) {
        if (mounted) showSnack(context, 'Choose at most 366 days', error: true);
        return;
      }
      setState(() {
        _preset = p;
        _range = IstDateRange(
          Ist.dateString(DateTime.utc(r.start.year, r.start.month, r.start.day)),
          Ist.dateString(DateTime.utc(r.end.year, r.end.month, r.end.day)),
        );
      });
      return;
    }
    setState(() {
      _preset = p;
      _range = switch (p) {
        _Preset.today => Ist.todayRange(),
        _Preset.yesterday => Ist.yesterday(),
        _Preset.week => Ist.thisWeek(),
        _Preset.month => Ist.thisMonth(),
        _Preset.lastMonth => Ist.lastMonth(),
        _Preset.custom => _range,
      };
    });
  }

  Future<void> _export() async {
    setState(() => _exporting = true);
    try {
      final dir = await getTemporaryDirectory();
      final file = await ref.read(reportsRepositoryProvider).exportCsv(_range, dir);
      await SharePlus.instance.share(ShareParams(
        files: [XFile(file.path, mimeType: 'text/csv')],
        subject: 'Transactions ${Ist.formatRange(_range)}',
        text: 'Transactions ${Ist.formatRange(_range)}',
      ));
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(reportProvider(_range));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reports'),
        actions: [
          _exporting
              ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
              : IconButton(tooltip: 'Export CSV', onPressed: _export, icon: const Icon(Icons.file_download_outlined)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(reportProvider(_range).future).then((_) {}, onError: (_) {}),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            SizedBox(
              height: 56,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                children: [
                  for (final p in _Preset.values)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: ChoiceChip(
                        label: Text(_labels[p]!),
                        avatar: p == _Preset.custom ? const Icon(Icons.date_range, size: 18) : null,
                        selected: _preset == p,
                        onSelected: (_) => _choose(p),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(Ist.formatRange(_range), style: Theme.of(context).textTheme.titleMedium),
            ),
            const SizedBox(height: 8),
            switch (value) {
              AsyncValue(:final value?) => _ReportBody(s: value),
              AsyncValue(:final error?) => Padding(
                  padding: const EdgeInsets.only(top: 48),
                  child: ErrorView(error: error, onRetry: () => ref.invalidate(reportProvider(_range))),
                ),
              _ => const Padding(padding: EdgeInsets.only(top: 64), child: LoadingView()),
            },
          ],
        ),
      ),
    );
  }
}

class _ReportBody extends StatelessWidget {
  const _ReportBody({required this.s});
  final ReportSummary s;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final b = t.brightness;
    if (s.totals.count == 0 && s.byStatus.isEmpty) {
      return const Padding(
        padding: EdgeInsets.only(top: 32),
        child: EmptyView(icon: Icons.insights_outlined, title: 'No transactions in this period'),
      );
    }
    Widget totalTile(String label, int paise, Color? color) => Expanded(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: t.textTheme.labelMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(Money.format(paise), style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700, color: color)),
                ),
              ]),
            ),
          ),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Column(children: [
          Row(children: [
            totalTile('Money in', s.totals.moneyIn, AppColors.moneyInOn(b)),
            const SizedBox(width: 8),
            totalTile('Money out', s.totals.moneyOut, AppColors.moneyOutOn(b)),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            totalTile('Fees earned', s.totals.fees, AppColors.feeOn(b)),
            const SizedBox(width: 8),
            totalTile('Net (${s.totals.count} entries)', s.totals.net, null),
          ]),
          const SizedBox(height: 6),
          Text('Totals leave out failed and refunded entries.', style: t.textTheme.bodySmall),
        ]),
      ),
      if (s.byDay.isNotEmpty) ...[
        const SectionHeader('By day'),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: _DayBars(days: s.byDay)),
      ],
      if (s.byType.isNotEmpty) ...[
        const SectionHeader('By type'),
        _Table(rows: [
          for (final r in s.byType)
            _Row(
              title: '${r.label} · ${r.direction == 'IN' ? 'in' : 'out'}',
              subtitle: '${r.count} entries · fees ${Money.format(r.fees)}',
              amount: r.amount,
              direction: r.direction,
            ),
        ]),
      ],
      if (s.byMode.isNotEmpty) ...[
        const SectionHeader('By mode'),
        _Table(rows: [
          for (final r in s.byMode)
            _Row(title: '${PayMode.label(r.mode)} · ${r.direction == 'IN' ? 'in' : 'out'}', subtitle: '${r.count} entries', amount: r.amount, direction: r.direction),
        ]),
      ],
      if (s.byStatus.isNotEmpty) ...[
        const SectionHeader('By status'),
        _Table(rows: [
          for (final r in s.byStatus) _Row(title: TxnStatus.label(r.status), subtitle: '${r.count} entries', amount: r.amount, status: r.status),
        ]),
      ],
    ]);
  }
}

class _Row {
  const _Row({required this.title, required this.subtitle, required this.amount, this.direction, this.status});
  final String title;
  final String subtitle;
  final int amount;
  final String? direction;
  final String? status;
}

class _Table extends StatelessWidget {
  const _Table({required this.rows});
  final List<_Row> rows;

  @override
  Widget build(BuildContext context) {
    final maxAmount = rows.fold<int>(1, (m, r) => math.max(m, r.amount));
    final t = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Card(
        child: Column(children: [
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(r.title, style: t.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                      Text(r.subtitle, style: t.textTheme.bodySmall),
                    ]),
                  ),
                  if (r.status != null) ...[StatusChip(r.status!), const SizedBox(width: 8)],
                  AmountText(r.amount, direction: r.direction, style: t.textTheme.titleSmall),
                ]),
                const SizedBox(height: 6),
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: r.amount / maxAmount,
                    minHeight: 4,
                    backgroundColor: t.colorScheme.surfaceContainerHighest,
                    color: r.direction == 'OUT' ? AppColors.moneyOutOn(t.brightness) : (r.direction == 'IN' ? AppColors.moneyInOn(t.brightness) : t.colorScheme.primary),
                  ),
                ),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// Money in (green) vs money out (orange) per day, drawn with plain widgets.
class _DayBars extends StatelessWidget {
  const _DayBars({required this.days});
  final List<DayRow> days;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final b = t.brightness;
    final maxV = days.fold<int>(1, (m, d) => math.max(m, math.max(d.totals.moneyIn, d.totals.moneyOut)));
    return Card(
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
          child: Row(children: [
            _legend(AppColors.moneyInOn(b), 'In'),
            const SizedBox(width: 16),
            _legend(AppColors.moneyOutOn(b), 'Out'),
            const Spacer(),
            Text('Net', style: t.textTheme.labelMedium),
          ]),
        ),
        for (final d in days.reversed)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Row(children: [
              SizedBox(width: 88, child: Text(Ist.formatDayLabel(d.date), style: t.textTheme.bodySmall)),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  _bar(d.totals.moneyIn / maxV, AppColors.moneyInOn(b)),
                  const SizedBox(height: 3),
                  _bar(d.totals.moneyOut / maxV, AppColors.moneyOutOn(b)),
                ]),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 92,
                child: Text(
                  Money.format(d.totals.net, compactZeroPaise: true),
                  textAlign: TextAlign.right,
                  style: t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
              ),
            ]),
          ),
        const SizedBox(height: 6),
      ]),
    );
  }

  Widget _legend(Color c, String label) => Row(children: [
        Container(width: 10, height: 10, decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(2))),
        const SizedBox(width: 4),
        Text(label),
      ]);

  Widget _bar(double fraction, Color color) => LayoutBuilder(
        builder: (_, c) => Container(
          height: 8,
          width: math.max(2, c.maxWidth * fraction.clamp(0, 1)),
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
        ),
      );
}
