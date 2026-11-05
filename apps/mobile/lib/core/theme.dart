import 'package:flutter/material.dart';

/// Brand + semantic colours. Money in is green, money out is amber/red, fees are indigo.
class AppColors {
  AppColors._();
  static const seed = Color(0xFF1F4FD8);
  static const moneyIn = Color(0xFF0F9D58);
  static const moneyOut = Color(0xFFD9480F);
  static const fee = Color(0xFF5B5BD6);
  static const pending = Color(0xFFB7791F);
  static const failed = Color(0xFFC92A2A);
  static const refunded = Color(0xFF6B7280);

  static Color moneyInOn(Brightness b) => b == Brightness.dark ? const Color(0xFF4ADE80) : moneyIn;
  static Color moneyOutOn(Brightness b) => b == Brightness.dark ? const Color(0xFFFF8A4C) : moneyOut;
  static Color feeOn(Brightness b) => b == Brightness.dark ? const Color(0xFFA5A6F6) : fee;
}

class AppTheme {
  AppTheme._();

  static ThemeData light() => _build(ColorScheme.fromSeed(seedColor: AppColors.seed));

  static ThemeData dark() => _build(ColorScheme.fromSeed(seedColor: AppColors.seed, brightness: Brightness.dark));

  static ThemeData _build(ColorScheme scheme) {
    final base = ThemeData(colorScheme: scheme, useMaterial3: true);
    final radius = BorderRadius.circular(14);
    return base.copyWith(
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
        titleTextStyle: base.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600, color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6))),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: scheme.outlineVariant)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: base.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(minimumSize: const Size(48, 44))),
      listTileTheme: const ListTileThemeData(contentPadding: EdgeInsets.symmetric(horizontal: 16), minVerticalPadding: 10),
      navigationBarTheme: NavigationBarThemeData(
        height: 68,
        indicatorColor: scheme.primaryContainer,
        labelTextStyle: WidgetStatePropertyAll(base.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600)),
      ),
      chipTheme: base.chipTheme.copyWith(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
      bottomSheetTheme: const BottomSheetThemeData(showDragHandle: true, shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24)))),
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
      dividerTheme: DividerThemeData(color: scheme.outlineVariant.withValues(alpha: 0.6), space: 1),
    );
  }
}
