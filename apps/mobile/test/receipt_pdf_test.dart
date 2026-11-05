import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/features/transactions/data/receipt_pdf.dart';
import 'package:pay2all_agent/features/transactions/data/transaction_models.dart';

Receipt sampleReceipt({bool branded = false}) => Receipt.fromJson({
      'transaction': {
        'id': 'atx_01JABCDEFGHJKMNPQRSTVWXYZ0',
        'receipt_no': 'R-000042',
        'type': 'MONEY_TRANSFER',
        'direction': 'IN',
        'mode': 'CASH',
        'status': 'SUCCESS',
        'amount': '5000.00',
        'fee': '50.00',
        'total': '5050.00',
        'reference': 'UTR123456789',
        'description': null,
        'customer': {'id': 'acu_1', 'name': 'Ramesh Kumar', 'mobile': '+919876543210'},
        'beneficiary': {'id': 'abn_1', 'name': 'Suresh Kumar', 'bank_name': 'State Bank of India', 'account_masked': 'XXXX4321', 'ifsc': 'SBIN0001234', 'upi_id': null},
        'occurred_at': '2026-11-05T08:45:00.000Z',
        'created_by': 'Owner',
        'receipt_token': 'tok',
      },
      'type_label': 'Money transfer',
      'shop': {'name': 'Sharma CSP Point', 'mobile': '+919000000000', 'address': 'Main Road, Patna, Bihar, 800001', 'upi_vpa': 'sharma@okaxis', 'logo_url': null, 'footer': branded ? 'Thank you!' : null},
      'branded': branded,
      'powered_by': branded ? null : 'Pay2All',
      'public_url': 'https://web.test/r/tok',
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('receipt model parses amounts and nested objects', () {
    final r = sampleReceipt();
    expect(r.transaction.amountPaise, 500000);
    expect(r.transaction.totalPaise, 505000);
    expect(r.transaction.beneficiary?.accountMasked, 'XXXX4321');
    expect(r.poweredBy, 'Pay2All');
    expect(receiptFileName(r), 'Receipt-R-000042.pdf');
  });

  test('receipt lines show IST time, masked account and status', () {
    final lines = Map.fromEntries(receiptLines(sampleReceipt()).map((e) => MapEntry(e.$1, e.$2)));
    expect(lines['Date & time'], '5 Nov 2026, 2:15 PM IST');
    expect(lines['Account'], 'XXXX4321');
    expect(lines['Reference'], 'UTR123456789');
    expect(lines['Status'], 'Success');
    expect(lines.containsKey('Note'), isFalse);
  });

  test('builds a PDF document (unbranded and branded)', () async {
    final fonts = await ReceiptFonts.load();
    for (final branded in [false, true]) {
      final bytes = await buildReceiptPdf(sampleReceipt(branded: branded), fonts: fonts);
      expect(bytes.length, greaterThan(1000));
      expect(ascii.decode(bytes.sublist(0, 5)), '%PDF-');
    }
  });

  test('a receipt with missing optional fields still renders', () async {
    final fonts = await ReceiptFonts.load();
    final r = Receipt.fromJson({
      'transaction': {'id': 'atx_x', 'type': 'OTHER', 'direction': 'OUT', 'amount': '10.00'},
      'shop': {'name': 'Shop'},
    });
    final bytes = await buildReceiptPdf(r, fonts: fonts);
    expect(ascii.decode(bytes.sublist(0, 5)), '%PDF-');
  });
}
