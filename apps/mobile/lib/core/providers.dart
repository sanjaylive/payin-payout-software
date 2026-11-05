import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/data/auth_repository.dart';
import '../features/customers/data/customers_repository.dart';
import '../features/home/data/dashboard.dart';
import '../features/more/data/agent_models.dart';
import '../features/more/data/agent_repository.dart';
import '../features/reports/data/reports_repository.dart';
import '../features/transactions/data/transactions_repository.dart';
import 'api/api_client.dart';
import 'auth/token_manager.dart';

/// Overridden in tests with [MemoryTokenStorage].
final tokenStorageProvider = Provider<TokenStorage>((ref) => SecureTokenStorage());

final tokenManagerProvider = Provider<TokenManager>((ref) {
  final bare = createDio();
  return TokenManager(storage: ref.watch(tokenStorageProvider), refreshCall: mobileRefreshCall(bare));
});

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(dio: createDio(), tokens: ref.watch(tokenManagerProvider)));

final authRepositoryProvider = Provider((ref) => AuthRepository(ref.watch(apiClientProvider)));
final dashboardRepositoryProvider = Provider((ref) => DashboardRepository(ref.watch(apiClientProvider)));
final transactionsRepositoryProvider = Provider((ref) => TransactionsRepository(ref.watch(apiClientProvider)));
final customersRepositoryProvider = Provider((ref) => CustomersRepository(ref.watch(apiClientProvider)));
final reportsRepositoryProvider = Provider((ref) => ReportsRepository(ref.watch(apiClientProvider)));
final agentRepositoryProvider = Provider((ref) => AgentRepository(ref.watch(apiClientProvider)));

/// Shared reads, invalidated after writes that change them.
final dashboardProvider = FutureProvider.autoDispose<Dashboard>((ref) => ref.watch(dashboardRepositoryProvider).load());

/// The shop profile (plan, usage, UPI id). Kept alive: many screens read it.
final profileProvider = FutureProvider<AgentProfile>((ref) => ref.watch(agentRepositoryProvider).profile());

/// Bumped after writes so open lists reload (transactions / customers).
class Revision extends Notifier<int> {
  @override
  int build() => 0;
  void bump() => state++;
}

final txnRevisionProvider = NotifierProvider<Revision, int>(Revision.new);
final customerRevisionProvider = NotifierProvider<Revision, int>(Revision.new);
