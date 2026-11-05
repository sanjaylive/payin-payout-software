import 'dart:convert';

import 'package:dio/dio.dart';

/// One field-level problem from the API's `error.details[]`.
class FieldIssue {
  const FieldIssue(this.path, this.message);
  final String path;
  final String message;
}

/// Every failed API call surfaces as this. [code] is the server's error code (e.g. `LIMIT_EXCEEDED`)
/// or one of the client-side codes below; [message] is safe to show to the user.
class ApiException implements Exception {
  ApiException({
    required this.code,
    required this.message,
    this.status,
    this.requestId,
    this.details = const [],
  });

  static const String network = 'NETWORK_ERROR';
  static const String timeout = 'TIMEOUT';
  static const String cancelled = 'CANCELLED';
  static const String unknown = 'UNKNOWN';
  static const String sessionExpired = 'SESSION_EXPIRED';

  final String code;
  final String message;
  final int? status;
  final String? requestId;
  final List<FieldIssue> details;

  /// `details` keyed by path (first message per path). `customer.mobile` → also `mobile`.
  Map<String, String> get fieldErrors {
    final map = <String, String>{};
    for (final d in details) {
      map.putIfAbsent(d.path, () => d.message);
      final dot = d.path.lastIndexOf('.');
      if (dot >= 0) map.putIfAbsent(d.path.substring(dot + 1), () => d.message);
    }
    return map;
  }

  bool get isUnauthorized => status == 401 || code == 'UNAUTHORIZED';
  bool get isLimitExceeded => code == 'LIMIT_EXCEEDED';
  bool get isNetwork => code == network || code == timeout;
  bool get isNotFound => status == 404 || code == 'NOT_FOUND';

  /// Build from the error envelope `{ success: false, error: { code, message, request_id, details? } }`.
  /// Tolerates anything else the server (or a proxy) might send.
  factory ApiException.fromResponse(int? status, Object? body) {
    body = _decodeBody(body);
    if (body is Map && body['error'] is Map) {
      final err = body['error'] as Map;
      final details = <FieldIssue>[];
      final raw = err['details'];
      if (raw is List) {
        for (final d in raw) {
          if (d is Map) {
            final path = d['path']?.toString() ?? '';
            final msg = d['message']?.toString() ?? '';
            if (msg.isNotEmpty) details.add(FieldIssue(path, msg));
          }
        }
      }
      final msg = err['message']?.toString();
      return ApiException(
        code: err['code']?.toString() ?? _codeForStatus(status),
        message: (msg == null || msg.isEmpty) ? _messageForStatus(status) : msg,
        status: status,
        requestId: err['request_id']?.toString(),
        details: details,
      );
    }
    return ApiException(code: _codeForStatus(status), message: _messageForStatus(status), status: status);
  }

  factory ApiException.fromDio(DioException e) {
    if (e.error is ApiException) return e.error as ApiException;
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return ApiException(code: timeout, message: 'The server took too long to answer. Try again.');
      case DioExceptionType.connectionError:
        return ApiException(code: network, message: 'Can’t reach the server. Check your internet connection.');
      case DioExceptionType.cancel:
        return ApiException(code: cancelled, message: 'Cancelled');
      case DioExceptionType.badCertificate:
        return ApiException(code: network, message: 'Secure connection failed.');
      case DioExceptionType.badResponse:
        return ApiException.fromResponse(e.response?.statusCode, e.response?.data);
      case DioExceptionType.unknown:
        if (e.response != null) return ApiException.fromResponse(e.response?.statusCode, e.response?.data);
        return ApiException(code: network, message: 'Can’t reach the server. Check your internet connection.');
    }
  }

  /// Error bodies of byte / text requests arrive undecoded.
  static Object? _decodeBody(Object? body) {
    try {
      if (body is List<int>) return jsonDecode(utf8.decode(body, allowMalformed: true));
      if (body is String && body.trimLeft().startsWith('{')) return jsonDecode(body);
    } catch (_) {}
    return body;
  }

  static String _codeForStatus(int? status) => switch (status) {
        400 => 'INVALID_REQUEST',
        401 => 'UNAUTHORIZED',
        403 => 'FORBIDDEN',
        404 => 'NOT_FOUND',
        409 => 'CONFLICT',
        422 => 'UNPROCESSABLE',
        429 => 'RATE_LIMITED',
        _ => unknown,
      };

  static String _messageForStatus(int? status) => switch (status) {
        401 => 'Please sign in again.',
        403 => 'You don’t have access to this.',
        404 => 'Not found.',
        429 => 'Too many attempts. Wait a moment and try again.',
        final s? when s >= 500 => 'Something went wrong on our side. Try again.',
        _ => 'Something went wrong. Try again.',
      };

  @override
  String toString() => 'ApiException($code, $status): $message';
}

/// A user-facing message for any error.
String errorMessage(Object error) {
  if (error is ApiException) return error.message;
  if (error is DioException) return ApiException.fromDio(error).message;
  return 'Something went wrong. Try again.';
}
