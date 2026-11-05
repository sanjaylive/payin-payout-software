import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/format/dates.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/agent_models.dart';
import 'plan_card.dart';

final driveProvider = FutureProvider.autoDispose<DriveStatus>((ref) => ref.watch(agentRepositoryProvider).drive());

/// Google Drive backup: connect (browser), back up now, daily auto-backup, disconnect.
class DriveScreen extends ConsumerStatefulWidget {
  const DriveScreen({super.key});

  @override
  ConsumerState<DriveScreen> createState() => _DriveScreenState();
}

class _DriveScreenState extends ConsumerState<DriveScreen> {
  String? _busy;
  bool _connecting = false;
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // Coming back from Google's consent page: show the new status.
    _lifecycle = AppLifecycleListener(onResume: () {
      if (_connecting) {
        _connecting = false;
        ref.invalidate(driveProvider);
      }
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _run(String key, Future<void> Function() f) async {
    setState(() => _busy = key);
    try {
      await f();
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _connect() => _run('connect', () async {
        final url = await ref.read(agentRepositoryProvider).driveConnectUrl();
        _connecting = true;
        if (!await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication)) {
          _connecting = false;
          if (mounted) showSnack(context, 'Couldn’t open the browser.', error: true);
        }
      });

  Future<void> _backup() => _run('backup', () async {
        await ref.read(agentRepositoryProvider).driveBackupNow();
        ref.invalidate(driveProvider);
        if (mounted) showSnack(context, 'Backed up to Google Drive');
      });

  Future<void> _auto(bool on) => _run('auto', () async {
        await ref.read(agentRepositoryProvider).driveAutoBackup(on);
        ref.invalidate(driveProvider);
      });

  Future<void> _disconnect() async {
    final ok = await confirmDialog(context,
        title: 'Disconnect Google Drive?', message: 'Backups stop. Files already in your Drive stay there.', confirmLabel: 'Disconnect', destructive: true);
    if (!ok) return;
    await _run('disconnect', () async {
      await ref.read(agentRepositoryProvider).driveDisconnect();
      ref.invalidate(driveProvider);
    });
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(driveProvider);
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Google Drive backup')),
      body: AsyncBody<DriveStatus>(
        value: value,
        onRetry: () => ref.invalidate(driveProvider),
        data: (d) => RefreshIndicator(
          onRefresh: () => ref.refresh(driveProvider.future).then((_) {}, onError: (_) {}),
          child: ListView(padding: const EdgeInsets.all(16), children: [
            Row(children: [
              CircleAvatar(radius: 26, backgroundColor: t.colorScheme.primaryContainer, child: const Icon(Icons.add_to_drive_rounded, size: 28)),
              const SizedBox(width: 14),
              const Expanded(
                child: Text('Keeps a copy of your transactions and customers as spreadsheets (CSV) in your own Google Drive, updated daily.'),
              ),
            ]),
            const SizedBox(height: 20),
            if (!d.available)
              const InfoBanner('Google Drive backup isn’t set up on this platform yet.')
            else if (!d.includedInPlan)
              InfoBanner(
                'Drive backup is part of the Starter and Business plans.',
                icon: Icons.lock_outline,
                action: TextButton(
                  onPressed: () => showUpgradeSheet(context, message: 'Upgrade to Starter or Business to back up to Google Drive every day.'),
                  child: const Text('Upgrade'),
                ),
              )
            else if (!d.connected)
              BusyButton(label: 'Connect Google Drive', icon: Icons.link, busy: _busy == 'connect', onPressed: _connect)
            else ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(children: [
                    KeyValueRow('Google account', d.googleEmail),
                    if (d.status != null) KeyValueRow('Status', d.status),
                    KeyValueRow('Last backup', d.lastBackupAt == null ? 'Not yet' : Ist.formatDateTime(d.lastBackupAt)),
                    if (d.lastError != null) ...[const SizedBox(height: 8), ErrorBanner(d.lastError!)],
                  ]),
                ),
              ),
              const SizedBox(height: 12),
              Card(
                child: SwitchListTile(
                  title: const Text('Daily automatic backup'),
                  subtitle: const Text('Runs once a day'),
                  value: d.autoBackup,
                  onChanged: _busy == null ? _auto : null,
                ),
              ),
              const SizedBox(height: 16),
              BusyButton(label: 'Back up now', icon: Icons.backup_outlined, busy: _busy == 'backup', onPressed: _backup),
              const SizedBox(height: 8),
              if (d.folderUrl != null)
                OutlinedButton.icon(
                  onPressed: () => launchUrl(Uri.parse(d.folderUrl!), mode: LaunchMode.externalApplication),
                  icon: const Icon(Icons.folder_open_outlined),
                  label: const Text('Open backup folder'),
                ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _busy == null ? _disconnect : null,
                icon: Icon(Icons.link_off, color: t.colorScheme.error),
                label: Text('Disconnect', style: TextStyle(color: t.colorScheme.error)),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}
