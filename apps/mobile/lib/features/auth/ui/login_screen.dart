import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/session.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/auth_models.dart';
import 'brand_mark.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _id = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;
  Map<String, String> _fieldErrors = const {};

  @override
  void initState() {
    super.initState();
    _error = ref.read(sessionProvider).message;
  }

  @override
  void dispose() {
    _id.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _fieldErrors = const {};
      _error = null;
    });
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final result = await ref.read(authRepositoryProvider).login(_id.text, _password.text);
      if (!mounted) return;
      switch (result) {
        case LoginAuthenticated(:final tokens):
          await ref.read(sessionProvider.notifier).completeSignIn(tokens);
        case LoginNeedsMfa(:final challenge):
          context.push('/login/mfa', extra: challenge);
        case LoginBlocked(:final message):
          setState(() => _error = message);
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _fieldErrors = e.fieldErrors;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Form(
                  key: _form,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const BrandMark(),
                    const SizedBox(height: 8),
                    Text('Sign in to your counter', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
                    const SizedBox(height: 32),
                    if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
                    TextFormField(
                      key: const Key('login.identifier'),
                      controller: _id,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.username, AutofillHints.email, AutofillHints.telephoneNumber],
                      decoration: const InputDecoration(labelText: 'Email or mobile number', prefixIcon: Icon(Icons.person_outline)),
                      validator: V.identifier,
                      forceErrorText: _fieldErrors['identifier'],
                      onChanged: (_) => _fieldErrors.isEmpty ? null : setState(() => _fieldErrors = const {}),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      key: const Key('login.password'),
                      controller: _password,
                      obscureText: _obscure,
                      textInputAction: TextInputAction.done,
                      autofillHints: const [AutofillHints.password],
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          tooltip: _obscure ? 'Show password' : 'Hide password',
                          icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      validator: (v) => (v == null || v.isEmpty) ? 'Enter your password' : null,
                      forceErrorText: _fieldErrors['password'],
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: () => context.push(Uri(path: '/forgot', queryParameters: _id.text.trim().isEmpty ? null : {'id': _id.text.trim()}).toString()),
                        child: const Text('Forgot password?'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    BusyButton(key: const Key('login.submit'), label: 'Sign in', busy: _busy, onPressed: _submit),
                    const SizedBox(height: 24),
                    Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      const Text('New shop?'),
                      TextButton(onPressed: () => context.push('/signup'), child: const Text('Create an agent account')),
                    ]),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
