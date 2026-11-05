import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/auth_models.dart';

/// Enter the 6-digit code emailed at sign-up. Verifying signs the new owner in.
class SignupVerifyScreen extends ConsumerStatefulWidget {
  const SignupVerifyScreen({super.key, required this.started});
  final SignupStarted started;

  @override
  ConsumerState<SignupVerifyScreen> createState() => _SignupVerifyScreenState();
}

class _SignupVerifyScreenState extends ConsumerState<SignupVerifyScreen> {
  final _form = GlobalKey<FormState>();
  final _code = TextEditingController();
  late SignupStarted _started = widget.started;
  Timer? _timer;
  int _resendIn = 0;
  bool _busy = false;
  bool _resending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _startCountdown(_started.resendAfter);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _code.dispose();
    super.dispose();
  }

  void _startCountdown(int seconds) {
    _timer?.cancel();
    setState(() => _resendIn = seconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _resendIn = _resendIn > 0 ? _resendIn - 1 : 0);
      if (_resendIn == 0) t.cancel();
    });
  }

  Future<void> _resend() async {
    setState(() {
      _resending = true;
      _error = null;
    });
    try {
      final s = await ref.read(authRepositoryProvider).resendSignup(_started.signupId);
      if (!mounted) return;
      _started = s;
      _startCountdown(s.resendAfter);
      showSnack(context, 'We sent a new code to ${s.emailMasked}');
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  Future<void> _verify() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final result = await ref.read(authRepositoryProvider).verifySignup(_started.signupId, _code.text);
      switch (result) {
        case LoginAuthenticated(:final tokens):
          await ref.read(sessionProvider.notifier).completeSignIn(tokens);
        case LoginNeedsMfa():
        case LoginBlocked():
          if (mounted) setState(() => _error = 'Your account is ready. Sign in to continue.');
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.fieldErrors['code'] ?? e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Verify your email')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _form,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Icon(Icons.mark_email_unread_outlined, size: 56, color: t.colorScheme.primary),
              const SizedBox(height: 16),
              Text('Enter the 6-digit code', textAlign: TextAlign.center, style: t.textTheme.titleLarge),
              const SizedBox(height: 6),
              Text('We emailed it to ${_started.emailMasked}', textAlign: TextAlign.center),
              const SizedBox(height: 24),
              if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
              TextFormField(
                controller: _code,
                autofocus: true,
                textAlign: TextAlign.center,
                keyboardType: TextInputType.number,
                autofillHints: const [AutofillHints.oneTimeCode],
                style: t.textTheme.headlineSmall?.copyWith(letterSpacing: 8),
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                decoration: const InputDecoration(hintText: '••••••'),
                validator: V.code6,
                onChanged: (v) {
                  if (v.length == 6 && !_busy) _verify();
                },
              ),
              const SizedBox(height: 24),
              BusyButton(label: 'Verify and continue', busy: _busy, onPressed: _verify),
              const SizedBox(height: 12),
              TextButton(
                onPressed: (_resendIn > 0 || _resending) ? null : _resend,
                child: Text(_resendIn > 0 ? 'Resend code in ${_resendIn}s' : (_resending ? 'Sending…' : 'Resend code')),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
