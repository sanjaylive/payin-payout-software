import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../../core/config.dart';
import '../../../core/widgets/common.dart';
import '../../auth/ui/brand_mark.dart';

final packageInfoProvider = FutureProvider<PackageInfo>((ref) => PackageInfo.fromPlatform());

class AboutScreen extends ConsumerWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final info = ref.watch(packageInfoProvider).value;
    return Scaffold(
      appBar: AppBar(title: const Text('About')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        const BrandMark(),
        const SizedBox(height: 8),
        Center(child: Text(info == null ? '' : 'Version ${info.version} (${info.buildNumber})')),
        const SizedBox(height: 24),
        const Text(
          'Pay2All Agent is the counter register for customer service points: customers, beneficiaries, '
          'transactions with receipts, the day’s cash position, reports, backups and staff logins.\n\n'
          'Nothing in this app moves money. Record what you did on your bank or UPI app here.',
        ),
        const SizedBox(height: 24),
        KeyValueRow('Server', AppConfig.apiBaseUrl),
        const SizedBox(height: 16),
        Center(
          child: TextButton(
            onPressed: () => showLicensePage(context: context, applicationName: AppConfig.appName, applicationVersion: info?.version),
            child: const Text('Open-source licences'),
          ),
        ),
      ]),
    );
  }
}
