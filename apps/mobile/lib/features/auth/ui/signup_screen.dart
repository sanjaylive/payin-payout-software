import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../more/data/agent_models.dart';
import '../../more/ui/plan_card.dart';

final publicPlansProvider = FutureProvider.autoDispose<List<Plan>>((ref) => ref.watch(authRepositoryProvider).publicPlans());

/// Agent self sign-up: plans overview + the form. Next step is the emailed 6-digit code.
class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _shop = TextEditingController();
  final _email = TextEditingController();
  final _mobile = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  final _referral = TextEditingController();
  bool _terms = false;
  bool _obscure = true;
  bool _busy = false;
  bool _showReferral = false;
  String? _error;
  String? _termsError;
  Map<String, String> _fieldErrors = const {};

  @override
  void dispose() {
    for (final c in [_name, _shop, _email, _mobile, _password, _confirm, _referral]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _error = null;
      _fieldErrors = const {};
      _termsError = _terms ? null : 'Accept the terms to continue';
    });
    final ok = _form.currentState!.validate();
    if (!ok || !_terms) return;
    setState(() => _busy = true);
    try {
      final started = await ref.read(authRepositoryProvider).signup(
            name: _name.text,
            shopName: _shop.text,
            email: _email.text,
            mobile: _mobile.text,
            password: _password.text,
            referralCode: _referral.text,
          );
      if (mounted) context.push('/signup/verify', extra: started);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _fieldErrors = e.fieldErrors;
          if (_fieldErrors['referral_code'] != null) _showReferral = true;
          _error = e.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _clearField(String key) {
    if (_fieldErrors.containsKey(key)) setState(() => _fieldErrors = Map.of(_fieldErrors)..remove(key));
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final plans = ref.watch(publicPlansProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Create agent account')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Run your counter on Pay2All', style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text(
              'Record money transfers, cash withdrawals, bill payments and recharges, give customers receipts, and see your day’s cash at a glance. Start free.',
              style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 210,
              child: plans.when(
                data: (list) => list.isEmpty
                    ? const SizedBox.shrink()
                    : ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: list.length,
                        separatorBuilder: (_, _) => const SizedBox(width: 12),
                        itemBuilder: (_, i) => SizedBox(width: 240, child: PlanCard(plan: list[i], yearly: false, compact: true)),
                      ),
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => ErrorView(error: e, onRetry: () => ref.invalidate(publicPlansProvider), compact: true),
              ),
            ),
            const SizedBox(height: 24),
            Form(
              key: _form,
              child: AutofillGroup(
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
                  TextFormField(
                    controller: _name,
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.name],
                    decoration: const InputDecoration(labelText: 'Your name', prefixIcon: Icon(Icons.person_outline)),
                    validator: (v) => V.name(v, 'your full name'),
                    forceErrorText: _fieldErrors['name'],
                    onChanged: (_) => _clearField('name'),
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _shop,
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(labelText: 'Shop name', prefixIcon: Icon(Icons.storefront_outlined)),
                    validator: (v) => V.name(v, 'the shop name'),
                    forceErrorText: _fieldErrors['business_name'],
                    onChanged: (_) => _clearField('business_name'),
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.mail_outline)),
                    validator: V.email,
                    forceErrorText: _fieldErrors['email'],
                    onChanged: (_) => _clearField('email'),
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _mobile,
                    keyboardType: TextInputType.phone,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.telephoneNumber],
                    inputFormatters: mobileInputFormatters,
                    decoration: const InputDecoration(labelText: 'Mobile number', prefixIcon: Icon(Icons.phone_outlined), prefixText: '+91 '),
                    validator: V.mobile,
                    forceErrorText: _fieldErrors['mobile'],
                    onChanged: (_) => _clearField('mobile'),
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _password,
                    obscureText: _obscure,
                    textInputAction: TextInputAction.next,
                    autofillHints: const [AutofillHints.newPassword],
                    decoration: InputDecoration(
                      labelText: 'Password',
                      helperText: 'At least 12 characters',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        tooltip: _obscure ? 'Show password' : 'Hide password',
                        icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                    ),
                    validator: V.newPassword,
                    forceErrorText: _fieldErrors['password'],
                    onChanged: (_) => _clearField('password'),
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _confirm,
                    obscureText: _obscure,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(labelText: 'Confirm password', prefixIcon: Icon(Icons.lock_outline)),
                    validator: (v) => v != _password.text ? 'Passwords do not match' : null,
                  ),
                  const SizedBox(height: 8),
                  if (_showReferral)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: TextFormField(
                        controller: _referral,
                        decoration: const InputDecoration(labelText: 'Referral code (optional)', prefixIcon: Icon(Icons.card_giftcard_outlined)),
                        forceErrorText: _fieldErrors['referral_code'],
                        onChanged: (_) => _clearField('referral_code'),
                      ),
                    )
                  else
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () => setState(() => _showReferral = true),
                        icon: const Icon(Icons.add),
                        label: const Text('I have a referral code'),
                      ),
                    ),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    value: _terms,
                    onChanged: (v) => setState(() {
                      _terms = v ?? false;
                      if (_terms) _termsError = null;
                    }),
                    title: const Text('I accept the terms of service and privacy policy'),
                    subtitle: (_termsError ?? _fieldErrors['accept_terms']) == null
                        ? null
                        : Text(_termsError ?? _fieldErrors['accept_terms']!, style: TextStyle(color: t.colorScheme.error)),
                  ),
                  const SizedBox(height: 16),
                  BusyButton(label: 'Create account', busy: _busy, onPressed: _submit),
                  const SizedBox(height: 12),
                  TextButton(onPressed: () => context.pop(), child: const Text('Already have an account? Sign in')),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}
