import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/data/auth_models.dart';
import '../api/api_exception.dart';
import '../providers.dart';
import 'token_manager.dart';

enum SessionStatus { unknown, signedOut, signedIn }

@immutable
class SessionState {
  const SessionState._(this.status, this.me, this.message);
  const SessionState.unknown([String? message]) : this._(SessionStatus.unknown, null, message);
  const SessionState.signedOut([String? message]) : this._(SessionStatus.signedOut, null, message);
  const SessionState.signedIn(Me me) : this._(SessionStatus.signedIn, me, null);

  final SessionStatus status;
  final Me? me;

  /// Why the user was signed out (shown on the login screen), or why restoring failed (splash).
  final String? message;

  bool can(String permission) => me?.can(permission) ?? false;
}

class NotAgentAccount implements Exception {
  const NotAgentAccount();
  static const message = 'This app is for agent accounts. Use the web dashboard for other accounts.';
}

final sessionProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);

/// Session lifecycle: restore on launch, finish sign-in, sign out (also when refresh fails).
class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() {
    ref.read(tokenManagerProvider).onSessionExpired = () {
      if (state.status == SessionStatus.signedIn) {
        _reset();
        state = const SessionState.signedOut('Your session has ended. Please sign in again.');
      }
    };
    return const SessionState.unknown();
  }

  TokenManager get _tokens => ref.read(tokenManagerProvider);

  /// App start: use the stored refresh token, if any.
  Future<void> restore() async {
    if (!await _tokens.hasStoredSession()) {
      state = const SessionState.signedOut();
      return;
    }
    try {
      await _tokens.refresh();
      await _loadMe();
    } on NotAgentAccount {
      await signOut(message: NotAgentAccount.message);
    } on ApiException catch (e) {
      if (e.isNetwork) {
        // Offline at launch: keep the stored session; the splash screen offers Retry.
        state = SessionState.unknown(e.message);
      } else {
        await _tokens.clear();
        state = const SessionState.signedOut();
      }
    }
  }

  /// After login / MFA / sign-up verify returned tokens.
  Future<void> completeSignIn(SessionTokens tokens) async {
    await _tokens.setSession(tokens);
    try {
      await _loadMe();
    } on NotAgentAccount {
      await signOut(message: NotAgentAccount.message);
      throw ApiException(code: 'NOT_AGENT', message: NotAgentAccount.message);
    } catch (_) {
      await _tokens.clear();
      rethrow;
    }
  }

  Future<void> _loadMe() async {
    final me = await ref.read(authRepositoryProvider).me();
    if (!me.isAgent) throw const NotAgentAccount();
    _reset();
    state = SessionState.signedIn(me);
  }

  /// Reload permissions (e.g. after pull-to-refresh on More).
  Future<void> refreshMe() async {
    try {
      await _loadMe();
    } on NotAgentAccount {
      await signOut(message: NotAgentAccount.message);
    } catch (_) {}
  }

  Future<void> signOut({String? message}) async {
    final rt = await _tokens.storage.readRefreshToken();
    if (rt != null) {
      try {
        await ref.read(authRepositoryProvider).logout(rt);
      } catch (_) {
        // Signing out locally is what matters; the server session expires on its own.
      }
    }
    await _tokens.clear();
    _reset();
    state = SessionState.signedOut(message);
  }

  /// Drop cached per-account data.
  void _reset() {
    ref.invalidate(profileProvider);
    ref.invalidate(dashboardProvider);
  }
}
