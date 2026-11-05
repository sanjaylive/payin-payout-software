import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';

class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final me = session.me;
    final profile = ref.watch(profileProvider).value;
    final t = Theme.of(context);
    final settings = session.can(Perm.settingsManage);

    Widget tile(IconData icon, String title, String route, {String? subtitle}) => ListTile(
          leading: Icon(icon),
          title: Text(title),
          subtitle: subtitle == null ? null : Text(subtitle),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(route),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(profileProvider);
          await ref.read(sessionProvider.notifier).refreshMe();
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(children: [
                    CircleAvatar(radius: 26, child: Icon(Icons.storefront_rounded, color: t.colorScheme.primary)),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(profile?.shopName ?? me?.orgName ?? '', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                        Text('${me?.name ?? ''}${me?.roleLabel.isNotEmpty == true ? ' · ${me!.roleLabel}' : ''}'),
                        if (profile != null) Text('${profile.plan.name} plan', style: t.textTheme.bodySmall),
                      ]),
                    ),
                  ]),
                ),
              ),
            ),
            tile(Icons.qr_code_2_rounded, 'My QR', '/settings/qr', subtitle: 'Show your UPI QR to customers'),
            if (settings) tile(Icons.storefront_outlined, 'Shop profile & settings', '/settings/profile', subtitle: 'Address, UPI id, receipt logo & footer'),
            if (settings) tile(Icons.group_outlined, 'Staff', '/settings/staff', subtitle: 'Counter operator logins'),
            tile(Icons.workspace_premium_outlined, 'Plan & billing', '/settings/billing'),
            if (settings) tile(Icons.add_to_drive_outlined, 'Google Drive backup', '/settings/drive'),
            const Divider(),
            tile(Icons.info_outline, 'About', '/settings/about'),
            ListTile(
              leading: Icon(Icons.logout, color: t.colorScheme.error),
              title: Text('Sign out', style: TextStyle(color: t.colorScheme.error)),
              onTap: () async {
                final ok = await confirmDialog(context, title: 'Sign out?', message: 'You’ll need your password to sign in again.', confirmLabel: 'Sign out', destructive: true);
                if (ok) await ref.read(sessionProvider.notifier).signOut();
              },
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}
