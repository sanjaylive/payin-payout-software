import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session.dart';
import 'brand_mark.dart';

/// Restores the session from the stored refresh token. Offline → message + Retry.
class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  bool _started = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _restore());
  }

  Future<void> _restore() async {
    if (_started && ref.read(sessionProvider).message == null) return;
    _started = true;
    await ref.read(sessionProvider.notifier).restore();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(sessionProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const BrandMark(size: 72),
              const SizedBox(height: 32),
              if (s.message == null)
                const CircularProgressIndicator()
              else ...[
                Text(s.message!, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
                const SizedBox(height: 16),
                FilledButton.icon(onPressed: _restore, icon: const Icon(Icons.refresh), label: const Text('Retry')),
                TextButton(onPressed: () => ref.read(sessionProvider.notifier).signOut(), child: const Text('Sign in again')),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
