import '../../../core/format/money.dart';
import '../../../core/json.dart';

class Totals {
  const Totals({required this.moneyIn, required this.moneyOut, required this.fees, required this.net, required this.count});
  final int moneyIn;
  final int moneyOut;
  final int fees;
  final int net;
  final int count;

  factory Totals.fromJson(Json j) => Totals(
        moneyIn: Money.parsePaise(j['money_in']),
        moneyOut: Money.parsePaise(j['money_out']),
        fees: Money.parsePaise(j['fees']),
        net: Money.parsePaise(j['net']),
        count: jInt(j, 'count'),
      );
}

class DayRow {
  const DayRow({required this.date, required this.totals});
  final String date;
  final Totals totals;
  factory DayRow.fromJson(Json j) => DayRow(date: jStr(j, 'date'), totals: Totals.fromJson(j));
}

class TypeRow {
  const TypeRow({required this.type, required this.label, required this.direction, required this.amount, required this.fees, required this.count});
  final String type;
  final String label;
  final String direction;
  final int amount;
  final int fees;
  final int count;
  factory TypeRow.fromJson(Json j) => TypeRow(
        type: jStr(j, 'type'),
        label: jText(j, 'label') ?? jStr(j, 'type'),
        direction: jStr(j, 'direction'),
        amount: Money.parsePaise(j['amount']),
        fees: Money.parsePaise(j['fees']),
        count: jInt(j, 'count'),
      );
}

class ModeRow {
  const ModeRow({required this.mode, required this.direction, required this.amount, required this.count});
  final String mode;
  final String direction;
  final int amount;
  final int count;
  factory ModeRow.fromJson(Json j) =>
      ModeRow(mode: jStr(j, 'mode'), direction: jStr(j, 'direction'), amount: Money.parsePaise(j['amount']), count: jInt(j, 'count'));
}

class StatusRow {
  const StatusRow({required this.status, required this.amount, required this.count});
  final String status;
  final int amount;
  final int count;
  factory StatusRow.fromJson(Json j) => StatusRow(status: jStr(j, 'status'), amount: Money.parsePaise(j['amount']), count: jInt(j, 'count'));
}

class ReportSummary {
  const ReportSummary({required this.from, required this.to, required this.totals, required this.byType, required this.byMode, required this.byStatus, required this.byDay});
  final String from;
  final String to;
  final Totals totals;
  final List<TypeRow> byType;
  final List<ModeRow> byMode;
  final List<StatusRow> byStatus;
  final List<DayRow> byDay;

  factory ReportSummary.fromJson(Json j) => ReportSummary(
        from: jStr(j, 'from'),
        to: jStr(j, 'to'),
        totals: Totals.fromJson(jObj(j, 'totals') ?? const {}),
        byType: jList(j, 'by_type', TypeRow.fromJson),
        byMode: jList(j, 'by_mode', ModeRow.fromJson),
        byStatus: jList(j, 'by_status', StatusRow.fromJson),
        byDay: jList(j, 'by_day', DayRow.fromJson),
      );
}
