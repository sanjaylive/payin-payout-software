import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pay2all_agent/core/auth/token_manager.dart';
import 'package:pay2all_agent/core/providers.dart';
import 'package:pay2all_agent/core/theme.dart';
import 'package:pay2all_agent/features/auth/ui/login_screen.dart';

void main() {
  Future<void> pumpLogin(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(ProviderScope(
      overrides: [tokenStorageProvider.overrideWithValue(MemoryTokenStorage())],
      child: MaterialApp(theme: AppTheme.light(), home: const LoginScreen()),
    ));
  }

  testWidgets('shows validation errors and does not submit an empty form', (tester) async {
    await pumpLogin(tester);

    expect(find.text('Sign in to your counter'), findsOneWidget);
    await tester.tap(find.byKey(const Key('login.submit')));
    await tester.pump();

    expect(find.text('Enter your email or mobile number'), findsOneWidget);
    expect(find.text('Enter your password'), findsOneWidget);
  });

  testWidgets('rejects an invalid identifier but accepts an Indian mobile', (tester) async {
    await pumpLogin(tester);

    await tester.enterText(find.byKey(const Key('login.identifier')), '12345');
    await tester.enterText(find.byKey(const Key('login.password')), 'secret');
    await tester.tap(find.byKey(const Key('login.submit')));
    await tester.pump();
    expect(find.text('Enter a valid email or 10-digit mobile number'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('login.identifier')), 'agent@example');
    await tester.tap(find.byKey(const Key('login.submit')));
    await tester.pump();
    expect(find.text('Enter a valid email address'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('login.identifier')), '+91 98765 43210');
    await tester.enterText(find.byKey(const Key('login.password')), '');
    await tester.tap(find.byKey(const Key('login.submit')));
    await tester.pump();
    expect(find.text('Enter a valid email or 10-digit mobile number'), findsNothing);
    expect(find.text('Enter your password'), findsOneWidget);
  });

  testWidgets('password visibility toggles', (tester) async {
    await pumpLogin(tester);
    EditableText password() => tester.widget<EditableText>(find.descendant(of: find.byKey(const Key('login.password')), matching: find.byType(EditableText)));

    expect(password().obscureText, isTrue);
    await tester.tap(find.byTooltip('Show password'));
    await tester.pump();
    expect(password().obscureText, isFalse);
  });
}
