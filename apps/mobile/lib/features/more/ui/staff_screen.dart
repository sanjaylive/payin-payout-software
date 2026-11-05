import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/agent_models.dart';
import 'plan_card.dart';

final staffProvider = FutureProvider.autoDispose<StaffList>((ref) => ref.watch(agentRepositoryProvider).staff());

class StaffScreen extends ConsumerWidget {
  const StaffScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(staffProvider);
    final list = value.value;
    return Scaffold(
      appBar: AppBar(title: const Text('Staff')),
      floatingActionButton: list == null
          ? null
          : FloatingActionButton.extended(
              onPressed: () async {
                if (list.atLimit) {
                  await showUpgradeSheet(context,
                      title: 'Login limit reached', message: 'Your plan allows ${list.staffLimit} active login${list.staffLimit == 1 ? '' : 's'} (owner included). Upgrade to add more staff.');
                  return;
                }
                final added = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => const _AddStaffSheet());
                if (added == true && context.mounted) showSnack(context, 'Operator added. Share the password with them.');
              },
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Add operator'),
            ),
      body: AsyncBody<StaffList>(
        value: value,
        onRetry: () => ref.invalidate(staffProvider),
        data: (s) => RefreshIndicator(
          onRefresh: () => ref.refresh(staffProvider.future).then((_) {}, onError: (_) {}),
          child: ListView(padding: const EdgeInsets.only(bottom: 96), children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: InfoBanner(
                '${s.active} of ${s.staffLimit} logins in use. Counter operators can record transactions and customers, but not change settings, plans or statuses.',
                icon: Icons.groups_outlined,
              ),
            ),
            for (final m in s.members) _MemberTile(m: m),
          ]),
        ),
      ),
    );
  }
}

class _MemberTile extends ConsumerStatefulWidget {
  const _MemberTile({required this.m});
  final StaffMember m;

  @override
  ConsumerState<_MemberTile> createState() => _MemberTileState();
}

class _MemberTileState extends ConsumerState<_MemberTile> {
  bool _busy = false;

  Future<void> _toggle(bool active) async {
    if (!active) {
      final ok = await confirmDialog(context,
          title: 'Disable ${widget.m.name}?', message: 'They are signed out everywhere and can’t sign in until you enable them again.', confirmLabel: 'Disable', destructive: true);
      if (!ok) return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(agentRepositoryProvider).setStaffActive(widget.m.userId, active);
      ref.invalidate(staffProvider);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.isLimitExceeded) {
        await showUpgradeSheet(context, title: 'Login limit reached', message: e.message);
      } else {
        showErrorSnack(context, e);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.m;
    final editable = !m.isOwner && !m.isYou;
    return ListTile(
      leading: CircleAvatar(child: Icon(m.isOwner ? Icons.verified_user_outlined : Icons.person_outline)),
      title: Text('${m.name}${m.isYou ? ' (you)' : ''}', style: TextStyle(fontWeight: FontWeight.w600, decoration: m.active ? null : TextDecoration.lineThrough)),
      subtitle: Text([
        m.roleName,
        if (m.email != null) m.email!,
        if (m.mobile != null) m.mobile!,
        m.lastLoginAt == null ? 'Never signed in' : 'Last sign-in ${Ist.formatRelative(m.lastLoginAt)}',
      ].join('\n')),
      isThreeLine: true,
      trailing: editable
          ? (_busy ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)) : Switch(value: m.active, onChanged: _toggle))
          : null,
    );
  }
}

class _AddStaffSheet extends ConsumerStatefulWidget {
  const _AddStaffSheet();

  @override
  ConsumerState<_AddStaffSheet> createState() => _AddStaffSheetState();
}

class _AddStaffSheetState extends ConsumerState<_AddStaffSheet> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _mobile = TextEditingController();
  final _password = TextEditingController();
  bool _obscure = true;
  bool _busy = false;
  String? _error;
  Map<String, String> _fe = const {};

  @override
  void dispose() {
    for (final c in [_name, _email, _mobile, _password]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _error = null;
      _fe = const {};
    });
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      await ref.read(agentRepositoryProvider).addStaff(name: _name.text, email: _email.text, mobile: _mobile.text, password: _password.text);
      ref.invalidate(staffProvider);
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _fe = e.fieldErrors;
          _error = e.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const gap = SizedBox(height: 14);
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Form(
          key: _form,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Add counter operator', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            if (_error != null) ...[ErrorBanner(_error!), gap],
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Name'),
              validator: (v) => V.name(v, 'the name'),
              forceErrorText: _fe['name'],
            ),
            gap,
            TextFormField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Email'),
              validator: V.email,
              forceErrorText: _fe['email'],
            ),
            gap,
            TextFormField(
              controller: _mobile,
              keyboardType: TextInputType.phone,
              inputFormatters: mobileInputFormatters,
              decoration: const InputDecoration(labelText: 'Mobile number', prefixText: '+91 '),
              validator: V.mobile,
              forceErrorText: _fe['mobile'],
            ),
            gap,
            TextFormField(
              controller: _password,
              obscureText: _obscure,
              decoration: InputDecoration(
                labelText: 'Starting password',
                helperText: 'At least 12 characters. Share it with them privately.',
                suffixIcon: IconButton(
                  icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ),
              validator: V.newPassword,
              forceErrorText: _fe['password'],
            ),
            const SizedBox(height: 20),
            BusyButton(label: 'Create login', busy: _busy, onPressed: _save),
          ]),
        ),
      ),
    );
  }
}
