import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/auth_models.dart';

/// Second sign-in step: authenticator code, or a recovery code. Passkeys are web-only.
class MfaScreen extends ConsumerStatefulWidget {
  const MfaScreen({super.key, required this.challenge});
  final MfaChallenge challenge;

  @override
  ConsumerState<MfaScreen> createState() => _MfaScreenState();
}

class _MfaScreenState extends ConsumerState<MfaScreen> {
  final _form = GlobalKey<FormState>();
  final _code = TextEditingController();
  late bool _recovery = !widget.challenge.totp;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final repo = ref.read(authRepositoryProvider);
      final result = _recovery
          ? await repo.verifyMfa(widget.challenge.mfaToken, recoveryCode: _code.text)
          : await repo.verifyMfa(widget.challenge.mfaToken, code: _code.text);
      switch (result) {
        case LoginAuthenticated(:final tokens):
          await ref.read(sessionProvider.notifier).completeSignIn(tokens);
        case LoginNeedsMfa():
          setState(() => _error = 'Verification failed. Try again.');
        case LoginBlocked(:final message):
          setState(() => _error = message);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final totp = widget.challenge.totp;
    return Scaffold(
      appBar: AppBar(title: const Text('Two-step verification')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _form,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Icon(_recovery ? Icons.key_rounded : Icons.phonelink_lock_rounded, size: 56, color: t.colorScheme.primary),
              const SizedBox(height: 16),
              Text(
                _recovery ? 'Enter one of your recovery codes' : 'Enter the 6-digit code from your authenticator app',
                textAlign: TextAlign.center,
                style: t.textTheme.titleMedium,
              ),
              if (!totp) ...[
                const SizedBox(height: 16),
                const InfoBanner('This account uses a passkey. Use the web to sign in with a passkey, or enter a recovery code here.', icon: Icons.web),
              ],
              const SizedBox(height: 24),
              if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
              TextFormField(
                key: ValueKey(_recovery),
                controller: _code,
                autofocus: true,
                textAlign: TextAlign.center,
                style: t.textTheme.headlineSmall?.copyWith(letterSpacing: _recovery ? 2 : 8),
                keyboardType: _recovery ? TextInputType.visiblePassword : TextInputType.number,
                autofillHints: _recovery ? null : const [AutofillHints.oneTimeCode],
                inputFormatters: _recovery
                    ? [UpperCaseFormatter(), LengthLimitingTextInputFormatter(11)]
                    : [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                decoration: InputDecoration(hintText: _recovery ? 'ABCDE-FGH23' : '••••••'),
                validator: _recovery
                    ? (v) => RegExp(r'^[A-Z2-7]{5}-[A-Z2-7]{5}$').hasMatch(v?.trim().toUpperCase() ?? '') ? null : 'Recovery codes look like ABCDE-FGH23'
                    : V.code6,
                onChanged: (v) {
                  if (!_recovery && v.length == 6 && !_busy) _submit();
                },
                onFieldSubmitted: (_) => _submit(),
              ),
              const SizedBox(height: 24),
              BusyButton(label: 'Verify', busy: _busy, onPressed: _submit),
              const SizedBox(height: 12),
              if (totp)
                TextButton(
                  onPressed: () => setState(() {
                    _recovery = !_recovery;
                    _code.clear();
                    _error = null;
                  }),
                  child: Text(_recovery ? 'Use authenticator code instead' : 'Use a recovery code'),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}
