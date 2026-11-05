import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/core/api/api_client.dart';
import 'package:pay2all_agent/core/api/api_exception.dart';
import 'package:pay2all_agent/features/auth/data/auth_models.dart';

void main() {
  group('ApiException.fromResponse', () {
    test('reads code, message, request id and field details from the error envelope', () {
      final e = ApiException.fromResponse(400, {
        'success': false,
        'error': {
          'code': 'INVALID_REQUEST',
          'message': 'Check the highlighted fields',
          'request_id': 'req_123',
          'details': [
            {'path': 'mobile', 'message': 'Enter a valid 10-digit Indian mobile number'},
            {'path': 'customer.email', 'message': 'Enter a valid email address'},
            {'path': 'mobile', 'message': 'second message ignored'},
          ],
        },
      });
      expect(e.code, 'INVALID_REQUEST');
      expect(e.message, 'Check the highlighted fields');
      expect(e.requestId, 'req_123');
      expect(e.status, 400);
      expect(e.details, hasLength(3));
      expect(e.fieldErrors['mobile'], 'Enter a valid 10-digit Indian mobile number');
      expect(e.fieldErrors['customer.email'], 'Enter a valid email address');
      expect(e.fieldErrors['email'], 'Enter a valid email address');
    });

    test('LIMIT_EXCEEDED is recognised', () {
      final e = ApiException.fromResponse(422, {
        'success': false,
        'error': {'code': 'LIMIT_EXCEEDED', 'message': 'Your Free plan allows 100 transactions a month. Upgrade to record more.'},
      });
      expect(e.isLimitExceeded, isTrue);
      expect(e.message, contains('Upgrade'));
    });

    test('falls back to the status when the body is not an envelope', () {
      final e = ApiException.fromResponse(502, '<html>Bad gateway</html>');
      expect(e.code, ApiException.unknown);
      expect(e.message, contains('Try again'));
      expect(ApiException.fromResponse(401, null).isUnauthorized, isTrue);
      expect(ApiException.fromResponse(404, {}).code, 'NOT_FOUND');
    });

    test('decodes byte bodies (image / download requests)', () {
      final bytes = utf8.encode(jsonEncode({
        'success': false,
        'error': {'code': 'NOT_FOUND', 'message': 'No image'},
      }));
      final e = ApiException.fromResponse(404, bytes);
      expect(e.code, 'NOT_FOUND');
      expect(e.message, 'No image');
    });

    test('missing message gets a friendly default; null details are tolerated', () {
      final e = ApiException.fromResponse(429, {
        'success': false,
        'error': {'code': 'RATE_LIMITED', 'details': null},
      });
      expect(e.code, 'RATE_LIMITED');
      expect(e.message, contains('Too many'));
      expect(e.fieldErrors, isEmpty);
    });
  });

  group('ApiException.fromDio', () {
    final req = RequestOptions(path: '/x');

    test('connection problems map to NETWORK_ERROR', () {
      final e = ApiException.fromDio(DioException.connectionError(requestOptions: req, reason: 'down'));
      expect(e.code, ApiException.network);
      expect(e.isNetwork, isTrue);
    });

    test('timeouts map to TIMEOUT', () {
      final e = ApiException.fromDio(DioException.receiveTimeout(timeout: const Duration(seconds: 1), requestOptions: req));
      expect(e.code, ApiException.timeout);
    });

    test('bad responses use the envelope', () {
      final e = ApiException.fromDio(DioException.badResponse(
        statusCode: 409,
        requestOptions: req,
        response: Response(requestOptions: req, statusCode: 409, data: {
          'success': false,
          'error': {'code': 'CONFLICT', 'message': 'This transaction is still being recorded'},
        }),
      ));
      expect(e.code, 'CONFLICT');
      expect(e.status, 409);
    });

    test('an ApiException carried in the DioException is returned as-is', () {
      final inner = ApiException(code: ApiException.sessionExpired, message: 'Sign in again', status: 401);
      expect(identical(ApiException.fromDio(DioException(requestOptions: req, error: inner)), inner), isTrue);
    });
  });

  test('unwrapEnvelope returns data or throws', () {
    expect(unwrapEnvelope(200, {'success': true, 'data': {'a': 1}}), {'a': 1});
    expect(
      () => unwrapEnvelope(200, {
        'success': false,
        'error': {'code': 'X', 'message': 'nope'},
      }),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'X')),
    );
  });

  test('MFA challenge reads mfa_methods as an object (API) or a list', () {
    final a = MfaChallenge.fromJson({
      'status': 'MFA_REQUIRED',
      'mfa_token': 'tok',
      'mfa_methods': {'totp': false, 'passkey': true},
    });
    expect(a.totp, isFalse);
    expect(a.passkey, isTrue);
    final b = MfaChallenge.fromJson({
      'mfa_token': 'tok',
      'mfa_methods': ['TOTP'],
    });
    expect(b.totp, isTrue);
  });
}
