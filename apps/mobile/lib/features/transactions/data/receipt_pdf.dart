import 'package:flutter/services.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import 'transaction_models.dart';

/// Fonts for receipt PDFs. Roboto is embedded because the PDF standard fonts have no ₹ glyph.
class ReceiptFonts {
  const ReceiptFonts(this.regular, this.bold);
  final pw.Font regular;
  final pw.Font bold;

  static ReceiptFonts? _cached;

  static Future<ReceiptFonts> load([AssetBundle? bundle]) async {
    if (_cached != null) return _cached!;
    final b = bundle ?? rootBundle;
    final regular = pw.Font.ttf(await b.load('assets/fonts/Roboto-Regular.ttf'));
    final bold = pw.Font.ttf(await b.load('assets/fonts/Roboto-Bold.ttf'));
    return _cached = ReceiptFonts(regular, bold);
  }
}

String receiptFileName(Receipt r) => 'Receipt-${r.transaction.receiptNo.isEmpty ? r.transaction.id : r.transaction.receiptNo}.pdf';

/// Lines shared by the on-screen receipt and the PDF, so both always show the same thing.
List<(String, String)> receiptLines(Receipt r) {
  final t = r.transaction;
  final c = t.customer;
  final b = t.beneficiary;
  return [
    ('Receipt no', t.receiptNo),
    ('Date & time', '${Ist.formatDateTime(t.occurredAt)} IST'),
    ('Type', r.typeLabel),
    if (c != null) ('Customer', [c.name, c.mobile].whereType<String>().join(' · ')),
    if (b != null) ('Beneficiary', b.name ?? '—'),
    if (b?.bankName != null) ('Bank', b!.bankName!),
    if (b?.accountMasked != null) ('Account', b!.accountMasked!),
    if (b?.ifsc != null) ('IFSC', b!.ifsc!),
    if (b?.upiId != null) ('UPI id', b!.upiId!),
    ('Mode', _mode(t.mode)),
    if (t.reference != null) ('Reference', t.reference!),
    if (t.description != null) ('Note', t.description!),
    ('Status', _status(t.status)),
  ];
}

String _mode(String m) => switch (m) { 'CASH' => 'Cash', 'UPI' => 'UPI', 'BANK' => 'Bank', _ => 'Other' };
String _status(String s) => switch (s) { 'SUCCESS' => 'Success', 'PENDING' => 'Pending', 'FAILED' => 'Failed', 'REFUNDED' => 'Refunded', _ => s };

String totalLabel(AgentTransaction t) => t.isIn ? 'Total paid by customer' : 'Total paid to customer';

/// Build the receipt as an A5 PDF.
Future<Uint8List> buildReceiptPdf(Receipt r, {required ReceiptFonts fonts, Uint8List? logo}) async {
  final t = r.transaction;
  final doc = pw.Document(title: 'Receipt ${t.receiptNo}', author: r.shop.name, creator: 'Pay2All Agent');
  final grey = PdfColor.fromInt(0xFF6B7280);
  final line = PdfColor.fromInt(0xFFE5E7EB);
  final accent = PdfColor.fromInt(0xFF1F4FD8);

  pw.Widget row(String k, String v, {bool bold = false, double size = 10}) => pw.Padding(
        padding: const pw.EdgeInsets.symmetric(vertical: 3),
        child: pw.Row(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
          pw.Expanded(flex: 2, child: pw.Text(k, style: pw.TextStyle(color: grey, fontSize: size))),
          pw.Expanded(
            flex: 3,
            child: pw.Text(v, textAlign: pw.TextAlign.right, style: pw.TextStyle(fontSize: size, font: bold ? fonts.bold : fonts.regular)),
          ),
        ]),
      );

  pw.ImageProvider? logoImage;
  if (logo != null && logo.isNotEmpty) {
    try {
      logoImage = pw.MemoryImage(logo);
    } catch (_) {
      logoImage = null;
    }
  }

  doc.addPage(pw.Page(
    pageFormat: PdfPageFormat.a5,
    margin: const pw.EdgeInsets.all(28),
    theme: pw.ThemeData.withFont(base: fonts.regular, bold: fonts.bold),
    build: (context) => pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.stretch, children: [
      pw.Row(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
        if (logoImage != null) pw.Container(width: 48, height: 48, margin: const pw.EdgeInsets.only(right: 12), child: pw.Image(logoImage, fit: pw.BoxFit.contain)),
        pw.Expanded(
          child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
            pw.Text(r.shop.name, style: pw.TextStyle(font: fonts.bold, fontSize: 16)),
            if (r.shop.address != null) pw.Text(r.shop.address!, style: pw.TextStyle(color: grey, fontSize: 9)),
            if (r.shop.mobile != null) pw.Text('Mobile: ${r.shop.mobile}', style: pw.TextStyle(color: grey, fontSize: 9)),
          ]),
        ),
      ]),
      pw.SizedBox(height: 14),
      pw.Container(
        padding: const pw.EdgeInsets.symmetric(vertical: 8, horizontal: 10),
        decoration: pw.BoxDecoration(color: PdfColor.fromInt(0xFFF1F5FF), borderRadius: pw.BorderRadius.circular(6)),
        child: pw.Row(children: [
          pw.Expanded(child: pw.Text('${r.typeLabel} receipt', style: pw.TextStyle(font: fonts.bold, fontSize: 12, color: accent))),
          pw.Text(t.receiptNo, style: pw.TextStyle(font: fonts.bold, fontSize: 12)),
        ]),
      ),
      pw.SizedBox(height: 10),
      for (final (k, v) in receiptLines(r)) row(k, v),
      pw.Divider(color: line),
      row('Amount', Money.format(t.amountPaise)),
      row('Service charge', Money.format(t.feePaise)),
      pw.Divider(color: line),
      row(totalLabel(t), Money.format(t.totalPaise), bold: true, size: 13),
      pw.Spacer(),
      if (r.publicUrl != null)
        pw.Row(crossAxisAlignment: pw.CrossAxisAlignment.end, children: [
          pw.Expanded(
            child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
              if (r.shop.footer != null) pw.Text(r.shop.footer!, style: const pw.TextStyle(fontSize: 9)),
              pw.SizedBox(height: 4),
              pw.Text('View this receipt online:', style: pw.TextStyle(color: grey, fontSize: 8)),
              pw.UrlLink(destination: r.publicUrl!, child: pw.Text(r.publicUrl!, style: pw.TextStyle(color: accent, fontSize: 8))),
            ]),
          ),
          pw.SizedBox(width: 12),
          pw.BarcodeWidget(barcode: pw.Barcode.qrCode(), data: r.publicUrl!, width: 64, height: 64, drawText: false, textStyle: pw.TextStyle(font: fonts.regular)),
        ])
      else if (r.shop.footer != null)
        pw.Text(r.shop.footer!, style: const pw.TextStyle(fontSize: 9)),
      if (!r.branded && r.poweredBy != null) ...[
        pw.SizedBox(height: 8),
        pw.Center(child: pw.Text('Powered by ${r.poweredBy}', style: pw.TextStyle(color: grey, fontSize: 8))),
      ],
    ]),
  ));
  return doc.save();
}
