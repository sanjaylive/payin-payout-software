import 'package:flutter/material.dart';

import '../../../core/config.dart';

/// App logo + name.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 56, this.showName = true});
  final double size;
  final bool showName;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [scheme.primary, scheme.tertiary], begin: Alignment.topLeft, end: Alignment.bottomRight),
          borderRadius: BorderRadius.circular(size * 0.28),
        ),
        child: Icon(Icons.storefront_rounded, color: scheme.onPrimary, size: size * 0.55),
      ),
      if (showName) ...[
        const SizedBox(height: 12),
        Text(AppConfig.appName, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
      ],
    ]);
  }
}
