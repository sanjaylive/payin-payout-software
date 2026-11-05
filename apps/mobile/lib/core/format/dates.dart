import 'package:intl/intl.dart';

/// An inclusive range of IST calendar days, as the API's `from` / `to` (YYYY-MM-DD).
class IstDateRange {
  const IstDateRange(this.from, this.to);
  final String from;
  final String to;

  @override
  bool operator ==(Object other) => other is IstDateRange && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(from, to);

  @override
  String toString() => '$from..$to';
}

/// India Standard Time helpers. The API speaks UTC instants; everything shown to the agent and every
/// report date is an IST calendar day, regardless of the phone's own time zone.
///
/// "Wall" values below are [DateTime]s flagged UTC whose fields hold IST clock time, so formatting
/// them never applies the device's offset.
class Ist {
  Ist._();

  static const Duration offset = Duration(hours: 5, minutes: 30);

  static final DateFormat _date = DateFormat('d MMM yyyy');
  static final DateFormat _dateShort = DateFormat('d MMM');
  static final DateFormat _time = DateFormat('h:mm a');
  static final DateFormat _weekday = DateFormat('EEE, d MMM');

  /// A UTC instant → IST wall clock.
  static DateTime wall(DateTime instant) {
    final u = instant.toUtc().add(offset);
    return DateTime.utc(u.year, u.month, u.day, u.hour, u.minute, u.second, u.millisecond);
  }

  /// IST wall clock fields → the UTC instant.
  static DateTime instant(int year, int month, int day, [int hour = 0, int minute = 0]) =>
      DateTime.utc(year, month, day, hour, minute).subtract(offset);

  /// The current IST wall clock (or of [now] for tests).
  static DateTime nowWall([DateTime? now]) => wall(now ?? DateTime.now());

  /// Parse an ISO-8601 string from the API. Null / invalid → null.
  static DateTime? parse(Object? value) {
    if (value == null) return null;
    return DateTime.tryParse(value.toString())?.toUtc();
  }

  static String _two(int n) => n.toString().padLeft(2, '0');

  /// IST wall date → "YYYY-MM-DD".
  static String dateString(DateTime wallDate) => '${wallDate.year}-${_two(wallDate.month)}-${_two(wallDate.day)}';

  /// "YYYY-MM-DD" → IST wall date (midnight). Invalid → null.
  static DateTime? parseDateString(String? s) {
    if (s == null) return null;
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(s);
    if (m == null) return null;
    return DateTime.utc(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
  }

  /// Today's IST date as "YYYY-MM-DD".
  static String today([DateTime? now]) => dateString(nowWall(now));

  /// "5 Nov 2026, 2:15 PM" for an API instant.
  static String formatDateTime(DateTime? instant) {
    if (instant == null) return '—';
    final w = wall(instant);
    return '${_date.format(w)}, ${_time.format(w)}';
  }

  static String formatDate(DateTime? instant) => instant == null ? '—' : _date.format(wall(instant));

  static String formatTime(DateTime? instant) => instant == null ? '—' : _time.format(wall(instant));

  /// "Today, 2:15 PM", "Yesterday, 9:00 AM" or "3 Nov, 4:30 PM" (year added when not this year).
  static String formatRelative(DateTime? instant, {DateTime? now}) {
    if (instant == null) return '—';
    final w = wall(instant);
    final n = nowWall(now);
    final today = DateTime.utc(n.year, n.month, n.day);
    final day = DateTime.utc(w.year, w.month, w.day);
    final diff = today.difference(day).inDays;
    final t = _time.format(w);
    if (diff == 0) return 'Today, $t';
    if (diff == 1) return 'Yesterday, $t';
    if (w.year == n.year) return '${_dateShort.format(w)}, $t';
    return '${_date.format(w)}, $t';
  }

  /// "YYYY-MM-DD" → "5 Nov 2026".
  static String formatDateString(String? s) {
    final d = parseDateString(s);
    return d == null ? (s ?? '—') : _date.format(d);
  }

  /// "YYYY-MM-DD" → "Thu, 5 Nov".
  static String formatDayLabel(String? s) {
    final d = parseDateString(s);
    return d == null ? (s ?? '—') : _weekday.format(d);
  }

  /// Date-of-birth style date (stored as a calendar date): "YYYY-MM-DD" → "5 Nov 1990".
  static String formatCalendarDate(String? s) => formatDateString(s);

  // ---- Report presets ------------------------------------------------------------------------

  static IstDateRange todayRange([DateTime? now]) {
    final t = today(now);
    return IstDateRange(t, t);
  }

  static IstDateRange yesterday([DateTime? now]) {
    final n = nowWall(now);
    final y = dateString(DateTime.utc(n.year, n.month, n.day - 1));
    return IstDateRange(y, y);
  }

  /// Monday to today.
  static IstDateRange thisWeek([DateTime? now]) {
    final n = nowWall(now);
    final start = DateTime.utc(n.year, n.month, n.day - (n.weekday - DateTime.monday));
    return IstDateRange(dateString(start), dateString(n));
  }

  /// 1st of this month to today.
  static IstDateRange thisMonth([DateTime? now]) {
    final n = nowWall(now);
    return IstDateRange(dateString(DateTime.utc(n.year, n.month, 1)), dateString(n));
  }

  static IstDateRange lastMonth([DateTime? now]) {
    final n = nowWall(now);
    final start = DateTime.utc(n.year, n.month - 1, 1);
    final end = DateTime.utc(n.year, n.month, 0);
    return IstDateRange(dateString(start), dateString(end));
  }

  /// "5 Nov 2026" or "1 Nov – 5 Nov 2026".
  static String formatRange(IstDateRange r) {
    if (r.from == r.to) return formatDateString(r.from);
    final a = parseDateString(r.from);
    final b = parseDateString(r.to);
    if (a == null || b == null) return '${r.from} – ${r.to}';
    if (a.year == b.year) return '${_dateShort.format(a)} – ${_date.format(b)}';
    return '${_date.format(a)} – ${_date.format(b)}';
  }
}
