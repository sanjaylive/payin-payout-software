import 'dart:io';

import '../../../core/api/api_client.dart';
import '../../../core/format/dates.dart';
import '../../../core/json.dart';
import 'report_models.dart';

class ReportsRepository {
  ReportsRepository(this.api);
  final ApiClient api;

  Future<ReportSummary> summary(IstDateRange range) async =>
      ReportSummary.fromJson(asJson(await api.get('/v1/agent/reports/summary', query: {'from': range.from, 'to': range.to})));

  /// Download the CSV into [dir] and return the file.
  Future<File> exportCsv(IstDateRange range, Directory dir) async {
    final file = File('${dir.path}/transactions-${range.from}-to-${range.to}.csv');
    await api.download('/v1/agent/reports/export', file.path, query: {'from': range.from, 'to': range.to});
    return file;
  }
}
