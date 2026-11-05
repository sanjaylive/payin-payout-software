import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/core/format/money.dart';
import 'package:pay2all_agent/features/transactions/data/transaction_models.dart';
import 'package:pay2all_agent/features/transactions/data/transactions_repository.dart';
import 'package:pay2all_agent/features/transactions/data/upi.dart';

void main() {
  group('Money.tryParsePaise', () {
    test('parses rupee strings exactly (no floating point)', () {
      expect(Money.tryParsePaise('1500.00'), 150000);
      expect(Money.tryParsePaise('1500'), 150000);
      expect(Money.tryParsePaise('1500.5'), 150050);
      expect(Money.tryParsePaise('0.1'), 10);
      expect(Money.tryParsePaise('.75'), 75);
      expect(Money.tryParsePaise('19.99'), 1999);
      expect(Money.tryParsePaise('1,50,000.25'), 15000025);
      expect(Money.tryParsePaise('₹ 2,000'), 200000);
      expect(Money.tryParsePaise('-12.30'), -1230);
    });

    test('rejects invalid input', () {
      for (final bad in [null, '', ' ', '.', '-', 'abc', '1.234', '1.2.3', '12a']) {
        expect(Money.tryParsePaise(bad), isNull, reason: '$bad');
      }
    });

    test('parsePaise is lenient for API values', () {
      expect(Money.parsePaise(null), 0);
      expect(Money.parsePaise('garbage'), 0);
      expect(Money.parsePaise('99.90'), 9990);
      expect(Money.parsePaise(5), 500);
    });
  });

  group('Money formatting', () {
    test('toApi writes the wire format with two decimals', () {
      expect(Money.toApi(150000), '1500.00');
      expect(Money.toApi(5), '0.05');
      expect(Money.toApi(0), '0.00');
      expect(Money.toApi(-1230), '-12.30');
    });

    test('format uses ₹ and Indian digit grouping', () {
      expect(Money.format(15000025), '₹1,50,000.25');
      expect(Money.format(1234567800), '₹1,23,45,678.00');
      expect(Money.format(99), '₹0.99');
      expect(Money.format(-50000), '-₹500.00');
      expect(Money.format(100000000, compactZeroPaise: true), '₹10,00,000');
      expect(Money.format(150050, symbol: false), '1,500.50');
      expect(Money.formatApi('2500.00'), '₹2,500.00');
    });

    test('round trip', () {
      for (final p in [0, 1, 10, 99, 100, 123456, 9999999999]) {
        expect(Money.tryParsePaise(Money.toApi(p)), p);
      }
    });
  });

  group('NewTransaction', () {
    test('totals and JSON follow the type direction', () {
      const t = NewTransaction(type: TxnType.cashWithdrawal, mode: 'CASH', status: 'SUCCESS', amountPaise: 500000, feePaise: 2000);
      expect(t.effectiveDirection, 'OUT');
      expect(t.totalPaise, 498000);
      final j = t.toJson();
      expect(j['amount'], '5000.00');
      expect(j['fee'], '20.00');
      expect(j.containsKey('direction'), isFalse);
    });

    test('OTHER sends its direction; quick customer only without a saved one', () {
      const t = NewTransaction(
        type: TxnType.other,
        direction: 'IN',
        mode: 'UPI',
        status: 'PENDING',
        amountPaise: 10000,
        feePaise: 0,
        customerName: ' Ravi ',
        customerMobile: '9876543210',
        reference: '  ',
      );
      final j = t.toJson();
      expect(j['direction'], 'IN');
      expect(j['customer_name'], 'Ravi');
      expect(j['customer_mobile'], '9876543210');
      expect(j.containsKey('reference'), isFalse);
      expect(t.totalPaise, 10000);
    });

    test('occurred_at is sent as a UTC ISO instant', () {
      final t = NewTransaction(
        type: TxnType.recharge,
        mode: 'CASH',
        status: 'SUCCESS',
        amountPaise: 100,
        feePaise: 0,
        occurredAt: DateTime.utc(2026, 11, 5, 8, 30),
      );
      expect(t.toJson()['occurred_at'], '2026-11-05T08:30:00.000Z');
    });
  });

  group('UPI URI', () {
    test('builds a upi://pay link with amount and encoded names', () {
      final uri = buildUpiUri(vpa: 'shop@okaxis', payeeName: 'Ram Stores', amountPaise: 150050, note: 'R-000012');
      expect(uri, 'upi://pay?pa=shop@okaxis&pn=Ram%20Stores&am=1500.50&tn=R-000012&cu=INR');
    });

    test('omits amount and note when not given', () {
      expect(buildUpiUri(vpa: 'a.b@ybl'), 'upi://pay?pa=a.b@ybl&cu=INR');
    });
  });
}
