import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/money.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../auth/data/auth_models.dart';
import '../data/agent_models.dart';
import 'upi_qr.dart';

/// The bank QR image the shop uploaded (fetched with auth).
final shopImageProvider = FutureProvider.autoDispose.family<Uint8List, String>((ref, kind) => ref.watch(agentRepositoryProvider).image(kind));

class MyQrScreen extends ConsumerStatefulWidget {
  const MyQrScreen({super.key});

  @override
  ConsumerState<MyQrScreen> createState() => _MyQrScreenState();
}

class _MyQrScreenState extends ConsumerState<MyQrScreen> {
  final _amount = TextEditingController();
  int? _amountPaise;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(profileProvider);
    final canEdit = ref.watch(sessionProvider).can(Perm.settingsManage);
    return Scaffold(
      appBar: AppBar(title: const Text('My QR')),
      body: AsyncBody<AgentProfile>(
        value: value,
        onRetry: () => ref.invalidate(profileProvider),
        data: (p) => ListView(padding: const EdgeInsets.all(16), children: [
          if (p.upiVpa == null)
            EmptyView(
              icon: Icons.qr_code_2_rounded,
              title: 'No UPI id yet',
              message: canEdit ? 'Add your shop’s UPI id to show a payment QR.' : 'Ask the shop owner to add a UPI id.',
              action: canEdit ? FilledButton(onPressed: () => context.push('/settings/profile'), child: const Text('Add UPI id')) : null,
            )
          else ...[
            Center(child: UpiQrCard(vpa: p.upiVpa!, payeeName: p.upiPayeeName ?? p.shopName, amountPaise: _amountPaise)),
            const SizedBox(height: 20),
            TextField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: amountInputFormatters,
              decoration: InputDecoration(
                labelText: 'Amount (optional)',
                prefixText: '₹ ',
                helperText: 'Fixes the amount in the customer’s UPI app',
                suffixIcon: _amountPaise == null
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () => setState(() {
                          _amount.clear();
                          _amountPaise = null;
                        }),
                      ),
              ),
              onChanged: (v) => setState(() {
                final paise = Money.tryParsePaise(v);
                _amountPaise = (paise != null && paise > 0) ? paise : null;
              }),
            ),
          ],
          if (p.hasQrImage) ...[
            const SectionHeader('Bank QR', padding: EdgeInsets.fromLTRB(0, 28, 0, 8)),
            _BankQr(),
          ],
        ]),
      ),
    );
  }
}

class _BankQr extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final img = ref.watch(shopImageProvider('qr'));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: img.when(
          data: (bytes) => ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(bytes, fit: BoxFit.contain, errorBuilder: (_, _, _) => const Padding(padding: EdgeInsets.all(24), child: Text('This image can’t be shown.'))),
          ),
          loading: () => const SizedBox(height: 200, child: Center(child: CircularProgressIndicator())),
          error: (e, _) => ErrorView(error: e, onRetry: () => ref.invalidate(shopImageProvider('qr')), compact: true),
        ),
      ),
    );
  }
}
