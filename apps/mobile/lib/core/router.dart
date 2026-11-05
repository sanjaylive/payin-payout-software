import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/data/auth_models.dart';
import '../features/auth/ui/forgot_password_screen.dart';
import '../features/auth/ui/login_screen.dart';
import '../features/auth/ui/mfa_screen.dart';
import '../features/auth/ui/signup_screen.dart';
import '../features/auth/ui/signup_verify_screen.dart';
import '../features/auth/ui/splash_screen.dart';
import '../features/customers/ui/customer_detail_screen.dart';
import '../features/customers/ui/customer_form_screen.dart';
import '../features/customers/ui/customers_screen.dart';
import '../features/home/ui/home_screen.dart';
import '../features/home/ui/shell.dart';
import '../features/more/ui/about_screen.dart';
import '../features/more/ui/billing_screen.dart';
import '../features/more/ui/drive_screen.dart';
import '../features/more/ui/more_screen.dart';
import '../features/more/ui/my_qr_screen.dart';
import '../features/more/ui/shop_profile_screen.dart';
import '../features/more/ui/staff_screen.dart';
import '../features/reports/ui/reports_screen.dart';
import '../features/transactions/data/transaction_models.dart';
import '../features/transactions/ui/new_transaction_screen.dart';
import '../features/transactions/ui/receipt_screen.dart';
import '../features/transactions/ui/transaction_detail_screen.dart';
import '../features/transactions/ui/transactions_screen.dart';
import 'auth/session.dart';

const _publicPaths = {'/login', '/login/mfa', '/forgot', '/signup', '/signup/verify'};

final rootNavigatorKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final session = ValueNotifier<SessionState>(ref.read(sessionProvider));
  ref.listen(sessionProvider, (_, next) => session.value = next);
  ref.onDispose(session.dispose);

  final router = GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/splash',
    refreshListenable: session,
    redirect: (context, state) {
      final s = session.value;
      final path = state.matchedLocation;
      switch (s.status) {
        case SessionStatus.unknown:
          return path == '/splash' ? null : '/splash';
        case SessionStatus.signedOut:
          return _publicPaths.contains(path) ? null : '/login';
        case SessionStatus.signedIn:
          return (_publicPaths.contains(path) || path == '/splash') ? '/home' : null;
      }
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const SplashScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(
        path: '/login/mfa',
        redirect: (_, state) => state.extra is MfaChallenge ? null : '/login',
        builder: (_, state) => MfaScreen(challenge: state.extra! as MfaChallenge),
      ),
      GoRoute(path: '/forgot', builder: (_, state) => ForgotPasswordScreen(initial: state.uri.queryParameters['id'])),
      GoRoute(path: '/signup', builder: (_, _) => const SignupScreen()),
      GoRoute(
        path: '/signup/verify',
        redirect: (_, state) => state.extra is SignupStarted ? null : '/signup',
        builder: (_, state) => SignupVerifyScreen(started: state.extra! as SignupStarted),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: '/home', builder: (_, _) => const HomeScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/transactions', builder: (_, _) => const TransactionsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/customers', builder: (_, _) => const CustomersScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/reports', builder: (_, _) => const ReportsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: '/more', builder: (_, _) => const MoreScreen())]),
        ],
      ),
      GoRoute(
        path: '/txn/new',
        builder: (_, state) => NewTransactionScreen(
          type: TxnType.fromCode(state.uri.queryParameters['type']) ?? TxnType.moneyTransfer,
          customerId: state.uri.queryParameters['customer'],
        ),
      ),
      GoRoute(path: '/txn/:id', builder: (_, state) => TransactionDetailScreen(id: state.pathParameters['id']!)),
      GoRoute(
        path: '/txn/:id/receipt',
        builder: (_, state) => ReceiptScreen(id: state.pathParameters['id']!, justRecorded: state.uri.queryParameters['new'] == '1'),
      ),
      GoRoute(path: '/customer/new', builder: (_, _) => const CustomerFormScreen()),
      GoRoute(path: '/customer/:id', builder: (_, state) => CustomerDetailScreen(id: state.pathParameters['id']!)),
      GoRoute(path: '/customer/:id/edit', builder: (_, state) => CustomerFormScreen(customerId: state.pathParameters['id'])),
      GoRoute(path: '/settings/qr', builder: (_, _) => const MyQrScreen()),
      GoRoute(path: '/settings/profile', builder: (_, _) => const ShopProfileScreen()),
      GoRoute(path: '/settings/staff', builder: (_, _) => const StaffScreen()),
      GoRoute(path: '/settings/billing', builder: (_, _) => const BillingScreen()),
      GoRoute(path: '/settings/drive', builder: (_, _) => const DriveScreen()),
      GoRoute(path: '/settings/about', builder: (_, _) => const AboutScreen()),
    ],
    errorBuilder: (context, state) => Scaffold(
      appBar: AppBar(),
      body: Center(child: Text('Page not found: ${state.uri.path}')),
    ),
  );
  ref.onDispose(router.dispose);
  return router;
});
