import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/api_exception.dart';

/// Tokens handed out by login, MFA, sign-up verify and refresh.
class SessionTokens {
  const SessionTokens({required this.accessToken, this.refreshToken, this.expiresIn});
  final String accessToken;
  final String? refreshToken;
  final int? expiresIn;
}

/// Where the long-lived refresh token is kept (the OS keystore in the app).
abstract class TokenStorage {
  Future<String?> readRefreshToken();
  Future<void> writeRefreshToken(String token);
  Future<void> clear();
}

class SecureTokenStorage implements TokenStorage {
  SecureTokenStorage([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  static const _key = 'pay2all.refresh_token';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> readRefreshToken() async {
    try {
      return await _storage.read(key: _key);
    } catch (_) {
      // A corrupted keystore entry (e.g. after a backup restore) means "signed out".
      return null;
    }
  }

  @override
  Future<void> writeRefreshToken(String token) => _storage.write(key: _key, value: token);

  @override
  Future<void> clear() async {
    try {
      await _storage.delete(key: _key);
    } catch (_) {}
  }
}

class MemoryTokenStorage implements TokenStorage {
  MemoryTokenStorage([this.token]);
  String? token;

  @override
  Future<String?> readRefreshToken() async => token;

  @override
  Future<void> writeRefreshToken(String t) async => token = t;

  @override
  Future<void> clear() async => token = null;
}

/// Calls `POST /v1/auth/mobile/refresh` and returns the new tokens. Throws [ApiException].
typedef RefreshCall = Future<SessionTokens> Function(String refreshToken);

/// Holds the 15-minute access token in memory and rotates it with the stored refresh token.
///
/// Refreshes are single-flight: concurrent 401s await the same refresh, because each refresh
/// rotates the refresh token and re-using an old one revokes the whole session.
class TokenManager {
  TokenManager({required this.storage, required this.refreshCall});

  final TokenStorage storage;
  final RefreshCall refreshCall;

  /// Called once when the session can no longer be refreshed (sign the user out).
  void Function()? onSessionExpired;

  String? _accessToken;
  Future<String>? _inflight;

  String? get accessToken => _accessToken;

  Future<bool> hasStoredSession() async => (await storage.readRefreshToken()) != null;

  Future<void> setSession(SessionTokens tokens) async {
    _accessToken = tokens.accessToken;
    final rt = tokens.refreshToken;
    if (rt != null && rt.isNotEmpty) await storage.writeRefreshToken(rt);
  }

  /// Get a new access token. Concurrent callers share one network call.
  Future<String> refresh() {
    final existing = _inflight;
    if (existing != null) return existing;
    final f = _doRefresh();
    _inflight = f;
    f.then((_) => _inflight = null, onError: (Object _) => _inflight = null);
    return f;
  }

  Future<String> _doRefresh() async {
    final rt = await storage.readRefreshToken();
    if (rt == null || rt.isEmpty) {
      await _expire();
      throw _expired();
    }
    try {
      final t = await refreshCall(rt);
      _accessToken = t.accessToken;
      if (t.refreshToken != null && t.refreshToken!.isNotEmpty) {
        await storage.writeRefreshToken(t.refreshToken!);
      }
      return t.accessToken;
    } on ApiException catch (e) {
      // Offline: keep the session, the next call can try again.
      if (e.isNetwork) rethrow;
      await _expire();
      throw _expired();
    }
  }

  ApiException _expired() => ApiException(
        code: ApiException.sessionExpired,
        message: 'Your session has ended. Please sign in again.',
        status: 401,
      );

  Future<void> _expire() async {
    _accessToken = null;
    await storage.clear();
    onSessionExpired?.call();
  }

  /// Forget everything locally (sign-out).
  Future<void> clear() async {
    _accessToken = null;
    await storage.clear();
  }
}
