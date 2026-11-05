import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/core/format/dates.dart';

void main() {
  group('IST conversion', () {
    test('a UTC instant late in the evening is the next IST day', () {
      final instant = DateTime.utc(2026, 11, 4, 19, 0); // 00:30 IST on 5 Nov
      final w = Ist.wall(instant);
      expect([w.year, w.month, w.day, w.hour, w.minute], [2026, 11, 5, 0, 30]);
      expect(Ist.today(instant), '2026-11-05');
    });

    test('IST wall time → UTC instant', () {
      expect(Ist.instant(2026, 11, 5, 0, 30), DateTime.utc(2026, 11, 4, 19, 0));
      expect(Ist.instant(2026, 1, 1), DateTime.utc(2025, 12, 31, 18, 30));
    });

    test('formats an API instant in IST regardless of device zone', () {
      final instant = DateTime.parse('2026-11-05T08:45:00Z');
      expect(Ist.formatDateTime(instant), '5 Nov 2026, 2:15 PM');
      expect(Ist.formatDate(instant), '5 Nov 2026');
      expect(Ist.formatTime(instant), '2:15 PM');
      expect(Ist.formatDateTime(null), '—');
    });

    test('relative labels', () {
      final now = DateTime.utc(2026, 11, 5, 10); // 15:30 IST
      expect(Ist.formatRelative(DateTime.utc(2026, 11, 5, 4, 0), now: now), 'Today, 9:30 AM');
      expect(Ist.formatRelative(DateTime.utc(2026, 11, 4, 12, 0), now: now), 'Yesterday, 5:30 PM');
      expect(Ist.formatRelative(DateTime.utc(2026, 10, 1, 6, 30), now: now), '1 Oct, 12:00 PM');
      expect(Ist.formatRelative(DateTime.utc(2025, 10, 1, 6, 30), now: now), '1 Oct 2025, 12:00 PM');
    });

    test('date strings', () {
      expect(Ist.dateString(DateTime.utc(2026, 3, 7)), '2026-03-07');
      expect(Ist.parseDateString('2026-03-07'), DateTime.utc(2026, 3, 7));
      expect(Ist.parseDateString('nope'), isNull);
      expect(Ist.formatDateString('2026-03-07'), '7 Mar 2026');
      expect(Ist.formatDayLabel('2026-11-05'), 'Thu, 5 Nov');
    });
  });

  group('report presets (IST)', () {
    // Thursday 5 Nov 2026, 00:30 IST (still 4 Nov in UTC).
    final now = DateTime.utc(2026, 11, 4, 19, 0);

    test('today / yesterday', () {
      expect(Ist.todayRange(now), const IstDateRange('2026-11-05', '2026-11-05'));
      expect(Ist.yesterday(now), const IstDateRange('2026-11-04', '2026-11-04'));
    });

    test('this week starts on Monday', () {
      expect(Ist.thisWeek(now), const IstDateRange('2026-11-02', '2026-11-05'));
    });

    test('this month and last month', () {
      expect(Ist.thisMonth(now), const IstDateRange('2026-11-01', '2026-11-05'));
      expect(Ist.lastMonth(now), const IstDateRange('2026-10-01', '2026-10-31'));
    });

    test('last month across a year boundary and in February', () {
      expect(Ist.lastMonth(DateTime.utc(2026, 1, 10)), const IstDateRange('2025-12-01', '2025-12-31'));
      expect(Ist.lastMonth(DateTime.utc(2028, 3, 10)), const IstDateRange('2028-02-01', '2028-02-29'));
    });

    test('range labels', () {
      expect(Ist.formatRange(const IstDateRange('2026-11-05', '2026-11-05')), '5 Nov 2026');
      expect(Ist.formatRange(const IstDateRange('2026-11-01', '2026-11-05')), '1 Nov – 5 Nov 2026');
      expect(Ist.formatRange(const IstDateRange('2025-12-20', '2026-01-05')), '20 Dec 2025 – 5 Jan 2026');
    });
  });
}
