import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/core/api/api_client.dart';
import 'package:pay2all_agent/core/api/api_exception.dart';
import 'package:pay2all_agent/core/auth/token_manager.dart';

typedef Handler = Future<ResponseBody> Function(RequestOptions options);

/// Answers requests in-process (no network).
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);
  final Handler handler;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(int status, Object body) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

ResponseBody unauthorized() => jsonBody(401, {
      'success': false,
      'error': {'code': 'UNAUTHORIZED', 'message': 'Authentication required', 'request_id': 'r1'},
    });

Map<String, dynamic> bodyOf(RequestOptions o) => o.data is Map ? Map<String, dynamic>.from(o.data as Map) : jsonDecode(o.data as String) as Map<String, dynamic>;

void main() {
  const base = 'https://api.test';

  late MemoryTokenStorage storage;
  late TokenManager tokens;
  late ApiClient api;
  late FakeAdapter adapter;
  late int refreshCalls;
  late List<String> refreshTokensSent;
  late bool refreshFails;
  late int expiredCalls;

  setUp(() {
    storage = MemoryTokenStorage('rt-1');
    refreshCalls = 0;
    refreshTokensSent = [];
    refreshFails = false;
    expiredCalls = 0;
    adapter = FakeAdapter((o) async {
      if (o.path == '/v1/auth/mobile/refresh') {
        refreshCalls++;
        refreshTokensSent.add(bodyOf(o)['refresh_token'] as String);
        expect(o.headers['X-Pay2All-Client'], 'mobile');
        // Slow enough that every concurrent 401 arrives while the refresh is in flight.
        await Future<void>.delayed(const Duration(milliseconds: 50));
        if (refreshFails) return unauthorized();
        return jsonBody(200, {
          'success': true,
          'data': {'status': 'AUTHENTICATED', 'access_token': 'access-new', 'token_type': 'Bearer', 'expires_in': 900, 'refresh_token': 'rt-2'},
        });
      }
      if (o.path == '/v1/auth/login') return unauthorized();
      if (o.headers['Authorization'] != 'Bearer access-new') return unauthorized();
      return jsonBody(200, {
        'success': true,
        'data': {'path': o.path},
      });
    });
    tokens = TokenManager(storage: storage, refreshCall: mobileRefreshCall(createDio(baseUrl: base, adapter: adapter)));
    tokens.onSessionExpired = () => expiredCalls++;
    api = ApiClient(dio: createDio(baseUrl: base, adapter: adapter), tokens: tokens);
  });

  test('concurrent 401s share one refresh, then every request is retried with the new token', () async {
    await tokens.setSession(const SessionTokens(accessToken: 'access-old'));

    final results = await Future.wait([
      api.get('/v1/agent/dashboard'),
      api.get('/v1/agent/profile'),
      api.get('/v1/agent/customers'),
      api.post('/v1/agent/transactions', data: {'type': 'RECHARGE'}),
    ]);

    expect(refreshCalls, 1, reason: 'single-flight: one refresh for all concurrent 401s');
    expect(refreshTokensSent, ['rt-1']);
    expect(results.map((r) => (r! as Map)['path']), ['/v1/agent/dashboard', '/v1/agent/profile', '/v1/agent/customers', '/v1/agent/transactions']);
    expect(tokens.accessToken, 'access-new');
    expect(storage.token, 'rt-2', reason: 'the rotated refresh token replaces the old one');
    expect(expiredCalls, 0);
  });

  test('a later 401 refreshes again with the rotated token, never the old one', () async {
    await tokens.setSession(const SessionTokens(accessToken: 'access-old'));
    await api.get('/v1/agent/dashboard');
    expect(storage.token, 'rt-2');

    // Simulate expiry of the new access token.
    await tokens.setSession(const SessionTokens(accessToken: 'stale'));
    await api.get('/v1/agent/dashboard');
    expect(refreshTokensSent, ['rt-1', 'rt-2']);
  });

  test('when refresh fails every waiting request fails once and the session is cleared', () async {
    refreshFails = true;
    await tokens.setSession(const SessionTokens(accessToken: 'access-old'));

    final outcomes = await Future.wait([
      api.get('/v1/agent/dashboard').then<Object>((v) => v!, onError: (Object e) => e),
      api.get('/v1/agent/profile').then<Object>((v) => v!, onError: (Object e) => e),
    ]);

    expect(refreshCalls, 1);
    for (final o in outcomes) {
      expect(o, isA<ApiException>().having((e) => e.code, 'code', ApiException.sessionExpired));
    }
    expect(expiredCalls, 1);
    expect(storage.token, isNull);
    expect(tokens.accessToken, isNull);
  });

  test('unauthenticated calls (login) never try to refresh', () async {
    await expectLater(
      api.post('/v1/auth/login', data: {'identifier': 'a@b.co', 'password': 'x'}, headers: kMobileClientHeader, auth: false),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
    );
    expect(refreshCalls, 0);
    final login = adapter.requests.firstWhere((r) => r.path == '/v1/auth/login');
    expect(login.headers['X-Pay2All-Client'], 'mobile');
    expect(login.headers.containsKey('Authorization'), isFalse);
  });

  test('a request that still gets 401 after the refresh is not retried forever', () async {
    final looping = FakeAdapter((o) async {
      if (o.path == '/v1/auth/mobile/refresh') {
        refreshCalls++;
        return jsonBody(200, {
          'success': true,
          'data': {'access_token': 'a2', 'refresh_token': 'rt-3'},
        });
      }
      return unauthorized();
    });
    final t = TokenManager(storage: MemoryTokenStorage('rt-1'), refreshCall: mobileRefreshCall(createDio(baseUrl: base, adapter: looping)));
    final client = ApiClient(dio: createDio(baseUrl: base, adapter: looping), tokens: t);
    await t.setSession(const SessionTokens(accessToken: 'a1'));

    await expectLater(client.get('/v1/agent/dashboard'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
    expect(refreshCalls, 1);
    expect(looping.requests.where((r) => r.path == '/v1/agent/dashboard'), hasLength(2));
  });

  test('offline during refresh keeps the stored session', () async {
    final offline = FakeAdapter((o) async {
      if (o.path == '/v1/auth/mobile/refresh') throw DioException.connectionError(requestOptions: o, reason: 'offline');
      return unauthorized();
    });
    final s = MemoryTokenStorage('rt-keep');
    var expired = 0;
    final t = TokenManager(storage: s, refreshCall: mobileRefreshCall(createDio(baseUrl: base, adapter: offline)))..onSessionExpired = () => expired++;

    await expectLater(t.refresh(), throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', isTrue)));
    expect(s.token, 'rt-keep');
    expect(expired, 0);
  });
}
