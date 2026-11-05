import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../auth/token_manager.dart';
import '../config.dart';
import '../json.dart';
import 'api_exception.dart';

/// One page of a cursor-paged list (`meta: { limit, has_more, next_cursor }`).
class PageResult<T> {
  const PageResult({required this.items, required this.hasMore, this.nextCursor});
  final List<T> items;
  final bool hasMore;
  final String? nextCursor;
}

/// `options.extra` flag: don't attach the bearer token or try to refresh (public / auth endpoints).
const String kNoAuth = 'pay2all.noAuth';
const String _kRetried = 'pay2all.retried';

/// Header that makes the auth endpoints return `refresh_token` in the body (docs/AGENTS.md §8).
const Map<String, String> kMobileClientHeader = {'X-Pay2All-Client': 'mobile'};

Dio createDio({String? baseUrl, HttpClientAdapter? adapter}) {
  final dio = Dio(BaseOptions(
    baseUrl: baseUrl ?? AppConfig.apiBaseUrl,
    connectTimeout: const Duration(seconds: 20),
    sendTimeout: const Duration(seconds: 60),
    receiveTimeout: const Duration(seconds: 60),
    headers: {'Accept': 'application/json', ...kMobileClientHeader},
  ));
  if (adapter != null) dio.httpClientAdapter = adapter;
  return dio;
}

/// The refresh call made with a bare Dio (no auth interceptor, so it can never recurse).
RefreshCall mobileRefreshCall(Dio bare) => (String refreshToken) async {
      try {
        final res = await bare.post<Object?>(
          '/v1/auth/mobile/refresh',
          data: {'refresh_token': refreshToken},
          options: Options(headers: kMobileClientHeader),
        );
        final data = unwrapEnvelope(res.statusCode, res.data);
        final j = asJson(data);
        final at = jText(j, 'access_token');
        if (at == null) throw ApiException(code: 'UNAUTHORIZED', message: 'Please sign in again.', status: 401);
        return SessionTokens(accessToken: at, refreshToken: jText(j, 'refresh_token'), expiresIn: jIntOrNull(j, 'expires_in'));
      } on DioException catch (e) {
        throw ApiException.fromDio(e);
      }
    };

/// `{ success: true, data }` → data. Anything else → [ApiException].
Object? unwrapEnvelope(int? status, Object? body) {
  if (body is Map && body['success'] == true) return body['data'];
  if (body is Map && body['success'] == false) throw ApiException.fromResponse(status, body);
  // Not an envelope (shouldn't happen for JSON routes): hand it back as-is.
  return body;
}

/// Adds the bearer token and, on a 401, refreshes once (single-flight) and retries the request.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({required this.tokens, required this.dio});

  final TokenManager tokens;
  final Dio dio;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (options.extra[kNoAuth] != true) {
      final t = tokens.accessToken;
      if (t != null) options.headers['Authorization'] = 'Bearer $t';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    final is401 = err.response?.statusCode == 401;
    if (!is401 || options.extra[kNoAuth] == true || options.extra[_kRetried] == true) {
      return handler.next(err);
    }
    try {
      final sent = options.headers['Authorization'];
      final current = tokens.accessToken;
      // Another request already refreshed while this one was in flight: just retry with the new token.
      final token = (current != null && sent != 'Bearer $current') ? current : await tokens.refresh();
      final retry = options.copyWith(
        headers: {...options.headers, 'Authorization': 'Bearer $token'},
        extra: {...options.extra, _kRetried: true},
        data: options.data is FormData ? (options.data as FormData).clone() : options.data,
      );
      final res = await dio.fetch<Object?>(retry);
      handler.resolve(res);
    } on DioException catch (e) {
      handler.next(e);
    } on ApiException catch (e) {
      handler.next(DioException(requestOptions: options, response: err.response, error: e, type: DioExceptionType.unknown));
    }
  }
}

/// Thin wrapper over Dio: unwraps the envelope, maps every failure to [ApiException].
class ApiClient {
  ApiClient({required this.dio, required this.tokens}) {
    dio.interceptors.add(AuthInterceptor(tokens: tokens, dio: dio));
  }

  final Dio dio;
  final TokenManager tokens;

  Options _opts({bool auth = true, Map<String, String>? headers, ResponseType? responseType}) => Options(
        extra: auth ? null : {kNoAuth: true},
        headers: headers,
        responseType: responseType,
      );

  Future<T> _run<T>(Future<T> Function() f) async {
    try {
      return await f();
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  Future<Object?> get(String path, {Map<String, Object?>? query, bool auth = true}) => _run(() async {
        final res = await dio.get<Object?>(path, queryParameters: _clean(query), options: _opts(auth: auth));
        return unwrapEnvelope(res.statusCode, res.data);
      });

  Future<Object?> post(String path, {Object? data, Map<String, String>? headers, bool auth = true}) => _run(() async {
        final res = await dio.post<Object?>(path, data: data ?? const <String, Object?>{}, options: _opts(auth: auth, headers: headers));
        return unwrapEnvelope(res.statusCode, res.data);
      });

  Future<Object?> patch(String path, {Object? data}) => _run(() async {
        final res = await dio.patch<Object?>(path, data: data ?? const <String, Object?>{}, options: _opts());
        return unwrapEnvelope(res.statusCode, res.data);
      });

  Future<Object?> put(String path, {Object? data}) => _run(() async {
        final res = await dio.put<Object?>(path, data: data ?? const <String, Object?>{}, options: _opts());
        return unwrapEnvelope(res.statusCode, res.data);
      });

  Future<Object?> delete(String path) => _run(() async {
        final res = await dio.delete<Object?>(path, options: _opts());
        return unwrapEnvelope(res.statusCode, res.data);
      });

  Future<PageResult<T>> getPage<T>(String path, T Function(Json) parse, {Map<String, Object?>? query}) => _run(() async {
        final res = await dio.get<Object?>(path, queryParameters: _clean(query), options: _opts());
        final data = unwrapEnvelope(res.statusCode, res.data);
        final meta = res.data is Map ? asJson((res.data as Map)['meta']) : <String, dynamic>{};
        final items = data is List ? data.whereType<Map>().map((e) => parse(asJson(e))).toList() : <T>[];
        return PageResult(items: items, hasMore: jBool(meta, 'has_more'), nextCursor: jText(meta, 'next_cursor'));
      });

  /// Raw bytes (images). Error bodies are JSON envelopes and still map to [ApiException].
  Future<Uint8List> getBytes(String path, {bool auth = true, Map<String, Object?>? query}) => _run(() async {
        final res = await dio.get<List<int>>(path, queryParameters: _clean(query), options: _opts(auth: auth, responseType: ResponseType.bytes));
        final data = res.data ?? const <int>[];
        return data is Uint8List ? data : Uint8List.fromList(data);
      });

  /// Stream a file to [savePath] with auth (CSV export).
  Future<void> download(String path, String savePath, {Map<String, Object?>? query}) => _run(() async {
        await dio.download(path, savePath, queryParameters: _clean(query), options: _opts());
      });

  static Map<String, Object?>? _clean(Map<String, Object?>? q) {
    if (q == null) return null;
    final out = <String, Object?>{};
    q.forEach((k, v) {
      if (v == null) return;
      if (v is String && v.trim().isEmpty) return;
      out[k] = v;
    });
    return out;
  }
}
