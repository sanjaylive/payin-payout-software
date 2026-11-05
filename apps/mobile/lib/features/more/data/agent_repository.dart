import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../../core/api/api_client.dart';
import '../../../core/json.dart';
import 'agent_models.dart';

/// Profile, images, staff, billing and Drive backup.
class AgentRepository {
  AgentRepository(this.api);
  final ApiClient api;

  Future<AgentProfile> profile() async => AgentProfile.fromJson(asJson(await api.get('/v1/agent/profile')));

  /// Only the given keys are sent; '' clears an optional field.
  Future<AgentProfile> updateProfile(Map<String, Object?> fields) async =>
      AgentProfile.fromJson(asJson(await api.patch('/v1/agent/profile', data: fields)));

  /// kind: qr | logo
  Future<Uint8List> image(String kind) => api.getBytes('/v1/agent/profile/$kind');

  Future<AgentProfile> uploadImage(String kind, String filePath, {String? filename}) async {
    final form = FormData.fromMap({'file': await MultipartFile.fromFile(filePath, filename: filename ?? filePath.split('/').last)});
    return AgentProfile.fromJson(asJson(await api.post('/v1/agent/profile/$kind', data: form)));
  }

  Future<AgentProfile> removeImage(String kind) async => AgentProfile.fromJson(asJson(await api.delete('/v1/agent/profile/$kind')));

  // ---- Staff -------------------------------------------------------------------------------------

  Future<StaffList> staff() async => StaffList.fromJson(asJson(await api.get('/v1/agent/staff')));

  Future<StaffList> addStaff({required String name, required String email, required String mobile, required String password}) async =>
      StaffList.fromJson(asJson(await api.post('/v1/agent/staff', data: {'name': name.trim(), 'email': email.trim(), 'mobile': mobile.trim(), 'password': password})));

  Future<StaffList> setStaffActive(String userId, bool active) async =>
      StaffList.fromJson(asJson(await api.post('/v1/agent/staff/$userId/status', data: {'active': active})));

  // ---- Billing -----------------------------------------------------------------------------------

  Future<BillingOverview> billing() async => BillingOverview.fromJson(asJson(await api.get('/v1/agent/billing')));

  /// planCode: STARTER | BUSINESS; period: MONTHLY | YEARLY.
  Future<PlanOrder> checkout(String planCode, String period) async =>
      PlanOrder.fromJson(asJson(await api.post('/v1/agent/billing/checkout', data: {'plan_code': planCode, 'period': period})));

  Future<PlanOrder> order(String id) async => PlanOrder.fromJson(asJson(await api.get('/v1/agent/billing/orders/$id')));

  Future<PlanOrder> cancelOrder(String id) async => PlanOrder.fromJson(asJson(await api.post('/v1/agent/billing/orders/$id/cancel')));

  // ---- Google Drive ------------------------------------------------------------------------------

  Future<DriveStatus> drive() async => DriveStatus.fromJson(asJson(await api.get('/v1/agent/drive')));

  Future<String> driveConnectUrl() async => jStr(asJson(await api.post('/v1/agent/drive/connect')), 'url');

  Future<DriveStatus> driveBackupNow() async => DriveStatus.fromJson(asJson(await api.post('/v1/agent/drive/backup')));

  Future<DriveStatus> driveAutoBackup(bool on) async => DriveStatus.fromJson(asJson(await api.put('/v1/agent/drive/settings', data: {'auto_backup': on})));

  Future<void> driveDisconnect() async {
    await api.delete('/v1/agent/drive');
  }
}
