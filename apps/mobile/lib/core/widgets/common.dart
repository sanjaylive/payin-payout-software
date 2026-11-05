import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_exception.dart';
import '../format/money.dart';
import '../theme.dart';

class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.message});
  final String? message;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const CircularProgressIndicator(),
            if (message != null) ...[const SizedBox(height: 16), Text(message!, textAlign: TextAlign.center)],
          ]),
        ),
      );
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry, this.compact = false});
  final Object error;
  final VoidCallback? onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final network = error is ApiException && (error as ApiException).isNetwork;
    final body = Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(network ? Icons.wifi_off_rounded : Icons.error_outline_rounded, size: compact ? 32 : 48, color: scheme.error),
      const SizedBox(height: 12),
      Text(errorMessage(error), textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
      if (onRetry != null) ...[
        const SizedBox(height: 16),
        FilledButton.tonalIcon(onPressed: onRetry, icon: const Icon(Icons.refresh_rounded), label: const Text('Retry')),
      ],
    ]);
    return Center(child: Padding(padding: const EdgeInsets.all(24), child: body));
  }
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.icon, required this.title, this.message, this.action});
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          CircleAvatar(radius: 32, backgroundColor: t.colorScheme.primaryContainer, child: Icon(icon, size: 32, color: t.colorScheme.onPrimaryContainer)),
          const SizedBox(height: 16),
          Text(title, style: t.textTheme.titleMedium, textAlign: TextAlign.center),
          if (message != null) ...[
            const SizedBox(height: 6),
            Text(message!, style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant), textAlign: TextAlign.center),
          ],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ]),
      ),
    );
  }
}

/// Loading / error (with retry) / data for an [AsyncValue].
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({super.key, required this.value, required this.data, this.onRetry});
  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final v = value;
    if (v.hasValue) return data(v.requireValue);
    if (v.hasError) return ErrorView(error: v.error!, onRetry: onRetry);
    return const LoadingView();
  }
}

/// ₹ amount coloured by direction: IN green with "+", OUT orange with "−".
class AmountText extends StatelessWidget {
  const AmountText(this.paise, {super.key, this.direction, this.style, this.strike = false});
  final int paise;
  final String? direction;
  final TextStyle? style;
  final bool strike;

  @override
  Widget build(BuildContext context) {
    final b = Theme.of(context).brightness;
    final color = direction == 'IN' ? AppColors.moneyInOn(b) : (direction == 'OUT' ? AppColors.moneyOutOn(b) : null);
    final sign = direction == 'IN' ? '+' : (direction == 'OUT' ? '−' : '');
    return Text(
      '$sign${Money.format(paise)}',
      style: (style ?? Theme.of(context).textTheme.titleMedium)?.copyWith(
        color: strike ? Theme.of(context).colorScheme.onSurfaceVariant : color,
        fontWeight: FontWeight.w700,
        decoration: strike ? TextDecoration.lineThrough : null,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key, this.dense = true});
  final String status;
  final bool dense;

  static Color colorFor(String status, Brightness b) => switch (status) {
        'SUCCESS' || 'PAID' => AppColors.moneyInOn(b),
        'PENDING' => AppColors.pending,
        'FAILED' || 'EXPIRED' => AppColors.failed,
        _ => AppColors.refunded,
      };

  static String labelFor(String s) => switch (s) {
        'SUCCESS' => 'Success',
        'PENDING' => 'Pending',
        'FAILED' => 'Failed',
        'REFUNDED' => 'Refunded',
        'PAID' => 'Paid',
        'EXPIRED' => 'Expired',
        'CANCELLED' => 'Cancelled',
        _ => s,
      };

  @override
  Widget build(BuildContext context) {
    final c = colorFor(status, Theme.of(context).brightness);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 8 : 12, vertical: dense ? 2 : 6),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(labelFor(status), style: TextStyle(color: c, fontWeight: FontWeight.w600, fontSize: dense ? 12 : 14)),
    );
  }
}

class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.trailing, this.padding = const EdgeInsets.fromLTRB(16, 20, 16, 8)});
  final String title;
  final Widget? trailing;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: padding,
        child: Row(children: [
          Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
          ?trailing,
        ]),
      );
}

/// Label on the left, value on the right; long values wrap.
class KeyValueRow extends StatelessWidget {
  const KeyValueRow(this.label, this.value, {super.key, this.bold = false, this.valueWidget});
  final String label;
  final String? value;
  final bool bold;
  final Widget? valueWidget;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(flex: 2, child: Text(label, style: t.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant))),
        const SizedBox(width: 12),
        Expanded(
          flex: 3,
          child: valueWidget ??
              SelectableText(value ?? '—', textAlign: TextAlign.right, style: (bold ? t.titleMedium : t.bodyLarge)?.copyWith(fontWeight: bold ? FontWeight.w700 : null)),
        ),
      ]),
    );
  }
}

void showSnack(BuildContext context, String message, {bool error = false}) {
  final scheme = Theme.of(context).colorScheme;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? scheme.error : null,
      showCloseIcon: error,
      closeIconColor: error ? scheme.onError : null,
    ));
}

void showErrorSnack(BuildContext context, Object error) => showSnack(context, errorMessage(error), error: true);

Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  String? message,
  String confirmLabel = 'Confirm',
  bool destructive = false,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) {
      final scheme = Theme.of(ctx).colorScheme;
      return AlertDialog(
        title: Text(title),
        content: message == null ? null : Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: destructive ? FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError) : null,
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return ok ?? false;
}

/// A primary button that shows a spinner while [busy].
class BusyButton extends StatelessWidget {
  const BusyButton({super.key, required this.label, required this.onPressed, this.busy = false, this.icon});
  final String label;
  final VoidCallback? onPressed;
  final bool busy;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final child = busy
        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
        : (icon == null ? Text(label) : Row(mainAxisSize: MainAxisSize.min, children: [Icon(icon), const SizedBox(width: 8), Text(label)]));
    return SizedBox(width: double.infinity, child: FilledButton(onPressed: busy ? null : onPressed, child: child));
  }
}

/// A banner for form-level errors.
class ErrorBanner extends StatelessWidget {
  const ErrorBanner(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: scheme.errorContainer, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Icon(Icons.error_outline, color: scheme.onErrorContainer),
        const SizedBox(width: 10),
        Expanded(child: Text(message, style: TextStyle(color: scheme.onErrorContainer))),
      ]),
    );
  }
}

class InfoBanner extends StatelessWidget {
  const InfoBanner(this.message, {super.key, this.icon = Icons.info_outline, this.action});
  final String message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: scheme.secondaryContainer, borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        Icon(icon, color: scheme.onSecondaryContainer),
        const SizedBox(width: 10),
        Expanded(child: Text(message, style: TextStyle(color: scheme.onSecondaryContainer))),
        ?action,
      ]),
    );
  }
}
