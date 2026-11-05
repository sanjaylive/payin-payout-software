import '../../../core/api/api_client.dart';
import '../../../core/format/money.dart';
import '../../../core/json.dart';
import '../../more/data/agent_models.dart';
import '../../transactions/data/transaction_models.dart';

class Dashboard {
  const Dashboard({
    required this.profile,
    required this.todayIn,
    required this.todayOut,
    required this.todayFees,
    required this.todayNet,
    required this.todayCount,
    required this.monthVolume,
    required this.monthFees,
    required this.monthCount,
    required this.customers,
    required this.recent,
  });

  final AgentProfile profile;
  final int todayIn;
  final int todayOut;
  final int todayFees;
  final int todayNet;
  final int todayCount;
  final int monthVolume;
  final int monthFees;
  final int monthCount;
  final int customers;
  final List<AgentTransaction> recent;

  factory Dashboard.fromJson(Json j) {
    final t = jObj(j, 'today') ?? const <String, dynamic>{};
    final m = jObj(j, 'month') ?? const <String, dynamic>{};
    return Dashboard(
      profile: AgentProfile.fromJson(jObj(j, 'profile') ?? const {}),
      todayIn: Money.parsePaise(t['money_in']),
      todayOut: Money.parsePaise(t['money_out']),
      todayFees: Money.parsePaise(t['fees']),
      todayNet: Money.parsePaise(t['net']),
      todayCount: jInt(t, 'count'),
      monthVolume: Money.parsePaise(m['volume']),
      monthFees: Money.parsePaise(m['fees']),
      monthCount: jInt(m, 'count'),
      customers: jInt(j, 'customers'),
      recent: jList(j, 'recent', AgentTransaction.fromJson),
    );
  }
}

class DashboardRepository {
  DashboardRepository(this.api);
  final ApiClient api;
  Future<Dashboard> load() async => Dashboard.fromJson(asJson(await api.get('/v1/agent/dashboard')));
}
