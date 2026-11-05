import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';

class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key, this.initial});
  final String? initial;

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _form = GlobalKey<FormState>();
  late final _id = TextEditingController(text: widget.initial);
  bool _busy = false;
  bool _sent = false;
  String? _error;

  @override
  void dispose() {
    _id.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).forgotPassword(_id.text);
      if (mounted) setState(() => _sent = true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: _sent
              ? Column(children: [
                  Icon(Icons.mark_email_read_outlined, size: 64, color: t.colorScheme.primary),
                  const SizedBox(height: 16),
                  Text('Check your email', style: t.textTheme.titleLarge),
                  const SizedBox(height: 8),
                  const Text(
                    'If an account exists for that email or mobile number, we have sent a link to reset the password. '
                    'Open it on this phone or a computer, set a new password, then sign in here.',
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  FilledButton(onPressed: () => Navigator.of(context).maybePop(), child: const Text('Back to sign in')),
                ])
              : Form(
                  key: _form,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const Text('Enter the email or mobile number you sign in with. We’ll email you a link to set a new password.'),
                    const SizedBox(height: 24),
                    if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
                    TextFormField(
                      controller: _id,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(labelText: 'Email or mobile number', prefixIcon: Icon(Icons.person_outline)),
                      validator: V.identifier,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 24),
                    BusyButton(label: 'Send reset link', busy: _busy, onPressed: _submit),
                  ]),
                ),
        ),
      ),
    );
  }
}
