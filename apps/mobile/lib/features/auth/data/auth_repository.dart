import '../../../core/api/api_client.dart';
import '../../../core/auth/token_manager.dart';
import '../../../core/json.dart';
import '../../more/data/agent_models.dart';
import 'auth_models.dart';

class AuthRepository {
  AuthRepository(this.api);
  final ApiClient api;

  LoginResult _session(Object? data) {
    final j = asJson(data);
    final status = jStr(j, 'status');
    if (status == 'MFA_REQUIRED') return LoginNeedsMfa(MfaChallenge.fromJson(j));
    if (status == 'MFA_ENROLLMENT_REQUIRED') {
      return const LoginBlocked('Your account must set up two-factor sign-in first. Finish it on the web, then sign in here.');
    }
    final at = jText(j, 'access_token');
    if (at == null) return const LoginBlocked('Sign-in failed. Try again.');
    return LoginAuthenticated(SessionTokens(accessToken: at, refreshToken: jText(j, 'refresh_token'), expiresIn: jIntOrNull(j, 'expires_in')));
  }

  Future<LoginResult> login(String identifier, String password) async {
    final data = await api.post('/v1/auth/login',
        data: {'identifier': identifier.trim(), 'password': password}, headers: kMobileClientHeader, auth: false);
    return _session(data);
  }

  Future<LoginResult> verifyMfa(String mfaToken, {String? code, String? recoveryCode}) async {
    final data = await api.post('/v1/auth/mfa/verify',
        data: {
          'mfa_token': mfaToken,
          if (code != null) 'code': code.trim(),
          if (recoveryCode != null) 'recovery_code': recoveryCode.trim().toUpperCase(),
        },
        headers: kMobileClientHeader,
        auth: false);
    return _session(data);
  }

  Future<void> forgotPassword(String identifier) async {
    await api.post('/v1/auth/password/forgot', data: {'identifier': identifier.trim()}, auth: false);
  }

  Future<Me> me() async => Me.fromJson(asJson(await api.get('/v1/auth/me')));

  Future<void> logout(String refreshToken) async {
    await api.post('/v1/auth/mobile/logout', data: {'refresh_token': refreshToken}, headers: kMobileClientHeader, auth: false);
  }

  // ---- Sign-up ---------------------------------------------------------------------------------

  Future<List<Plan>> publicPlans() async {
    final data = await api.get('/v1/public/agent-plans', auth: false);
    return data is List ? data.whereType<Map>().map((e) => Plan.fromJson(asJson(e))).toList() : <Plan>[];
  }

  Future<SignupStarted> signup({
    required String name,
    required String shopName,
    required String email,
    required String mobile,
    required String password,
    String? referralCode,
  }) async {
    final data = await api.post('/v1/signup',
        data: {
          'name': name.trim(),
          'business_name': shopName.trim(),
          'email': email.trim(),
          'mobile': mobile.trim(),
          'password': password,
          'accept_terms': true,
          'account_type': 'AGENT',
          if (referralCode != null && referralCode.trim().isNotEmpty) 'referral_code': referralCode.trim().toLowerCase(),
        },
        auth: false);
    return SignupStarted.fromJson(asJson(data));
  }

  Future<SignupStarted> resendSignup(String signupId) async =>
      SignupStarted.fromJson(asJson(await api.post('/v1/signup/resend', data: {'signup_id': signupId}, auth: false)));

  Future<LoginResult> verifySignup(String signupId, String code) async {
    final data = await api.post('/v1/signup/verify',
        data: {'signup_id': signupId, 'code': code.trim()}, headers: kMobileClientHeader, auth: false);
    return _session(data);
  }
}
