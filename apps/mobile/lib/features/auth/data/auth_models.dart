import '../../../core/auth/token_manager.dart';
import '../../../core/json.dart';

/// Permission keys (docs/AGENTS.md §1).
class Perm {
  Perm._();
  static const deskRead = 'agent.desk.read';
  static const deskWrite = 'agent.desk.write';
  static const txnManage = 'agent.txn.manage';
  static const settingsManage = 'agent.settings.manage';
  static const billingManage = 'agent.billing.manage';
}

/// `GET /v1/auth/me`.
class Me {
  const Me({
    required this.userId,
    required this.name,
    required this.email,
    required this.mobile,
    required this.orgId,
    required this.orgName,
    required this.orgType,
    required this.orgStatus,
    required this.roles,
    required this.permissions,
  });

  final String userId;
  final String name;
  final String? email;
  final String? mobile;
  final String orgId;
  final String orgName;
  final String orgType;
  final String? orgStatus;
  final List<String> roles;
  final Set<String> permissions;

  bool get isAgent => orgType == 'AGENT';
  bool can(String permission) => permissions.contains(permission);
  bool get isOwner => roles.contains('AGENT_OWNER');
  String get roleLabel => isOwner ? 'Owner' : (roles.contains('AGENT_OPERATOR') ? 'Counter operator' : (roles.isEmpty ? '' : roles.first));

  factory Me.fromJson(Json j) {
    final u = jObj(j, 'user') ?? const <String, dynamic>{};
    final o = jObj(j, 'organization') ?? const <String, dynamic>{};
    return Me(
      userId: jStr(u, 'id'),
      name: jStr(u, 'name'),
      email: jText(u, 'email'),
      mobile: jText(u, 'mobile'),
      orgId: jStr(o, 'id'),
      orgName: jStr(o, 'name'),
      orgType: jStr(o, 'type'),
      orgStatus: jText(o, 'status'),
      roles: jStrings(j, 'roles'),
      permissions: jStrings(j, 'permissions').toSet(),
    );
  }
}

/// Second step of sign-in. The API sends `mfa_methods` as `{ totp: bool, passkey: bool }`.
class MfaChallenge {
  const MfaChallenge({required this.mfaToken, required this.totp, required this.passkey});
  final String mfaToken;
  final bool totp;
  final bool passkey;

  factory MfaChallenge.fromJson(Json j) {
    final raw = j['mfa_methods'];
    var totp = false;
    var passkey = false;
    if (raw is Map) {
      final m = asJson(raw);
      totp = jBool(m, 'totp');
      passkey = jBool(m, 'passkey');
    } else if (raw is List) {
      // Tolerate a list form (["TOTP", "PASSKEY"]) too.
      final l = raw.map((e) => e.toString().toUpperCase()).toList();
      totp = l.contains('TOTP');
      passkey = l.contains('PASSKEY');
    }
    return MfaChallenge(mfaToken: jStr(j, 'mfa_token'), totp: totp, passkey: passkey);
  }
}

/// Result of login / MFA / sign-up verify.
sealed class LoginResult {
  const LoginResult();
}

class LoginAuthenticated extends LoginResult {
  const LoginAuthenticated(this.tokens);
  final SessionTokens tokens;
}

class LoginNeedsMfa extends LoginResult {
  const LoginNeedsMfa(this.challenge);
  final MfaChallenge challenge;
}

/// The session's status was something the app can't continue with (e.g. MFA enrollment required).
class LoginBlocked extends LoginResult {
  const LoginBlocked(this.message);
  final String message;
}

/// `POST /v1/signup` → `{ signup_id, email_masked, expires_in, resend_after }`.
class SignupStarted {
  const SignupStarted({required this.signupId, required this.emailMasked, required this.expiresIn, required this.resendAfter});
  final String signupId;
  final String emailMasked;
  final int expiresIn;
  final int resendAfter;

  factory SignupStarted.fromJson(Json j) => SignupStarted(
        signupId: jStr(j, 'signup_id'),
        emailMasked: jStr(j, 'email_masked'),
        expiresIn: jInt(j, 'expires_in', 600),
        resendAfter: jInt(j, 'resend_after', 60),
      );
}
