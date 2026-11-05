import '../../../core/format/money.dart';
import '../../../core/json.dart';

/// Plan: `{ code, name, description, price_monthly, price_yearly, monthly_txn_limit, staff_limit,
/// drive_backup, branded_receipts, messaging, active }` (+ `expires_at`, `lapsed_from` for the current one).
class Plan {
  const Plan({
    required this.code,
    required this.name,
    this.description,
    required this.priceMonthlyPaise,
    required this.priceYearlyPaise,
    this.monthlyTxnLimit,
    required this.staffLimit,
    required this.driveBackup,
    required this.brandedReceipts,
    required this.messaging,
    required this.active,
    this.expiresAt,
    this.lapsedFrom,
  });

  final String code;
  final String name;
  final String? description;
  final int priceMonthlyPaise;
  final int priceYearlyPaise;

  /// Null = unlimited.
  final int? monthlyTxnLimit;
  final int staffLimit;
  final bool driveBackup;
  final bool brandedReceipts;
  final bool messaging;
  final bool active;
  final DateTime? expiresAt;

  /// When a paid plan has run out, the code it lapsed from (the agent is on Free meanwhile).
  final String? lapsedFrom;

  bool get isFree => code == 'FREE';
  bool get unlimited => monthlyTxnLimit == null;

  String get txnLimitLabel => monthlyTxnLimit == null ? 'Unlimited transactions' : '${Money.format(monthlyTxnLimit! * 100, symbol: false, compactZeroPaise: true)} transactions / month';

  factory Plan.fromJson(Json j) => Plan(
        code: jStr(j, 'code'),
        name: jStr(j, 'name', jStr(j, 'code')),
        description: jText(j, 'description'),
        priceMonthlyPaise: Money.parsePaise(j['price_monthly']),
        priceYearlyPaise: Money.parsePaise(j['price_yearly']),
        monthlyTxnLimit: jIntOrNull(j, 'monthly_txn_limit'),
        staffLimit: jInt(j, 'staff_limit', 1),
        driveBackup: jBool(j, 'drive_backup'),
        brandedReceipts: jBool(j, 'branded_receipts'),
        messaging: jBool(j, 'messaging'),
        active: jBool(j, 'active', true),
        expiresAt: jDate(j, 'expires_at'),
        lapsedFrom: jText(j, 'lapsed_from'),
      );
}

class Usage {
  const Usage({required this.transactionsThisMonth, required this.staff});
  final int transactionsThisMonth;
  final int staff;

  factory Usage.fromJson(Json j) => Usage(transactionsThisMonth: jInt(j, 'transactions_this_month'), staff: jInt(j, 'staff'));

  /// 0..1 of the plan's monthly allowance, null when unlimited.
  double? fraction(Plan plan) {
    final limit = plan.monthlyTxnLimit;
    if (limit == null || limit <= 0) return null;
    return (transactionsThisMonth / limit).clamp(0, 1).toDouble();
  }
}

/// Shop profile with plan and usage.
class AgentProfile {
  const AgentProfile({
    required this.id,
    required this.shopName,
    this.ownerName,
    this.email,
    this.mobile,
    this.addressLine,
    this.city,
    this.state,
    this.pincode,
    this.upiVpa,
    this.upiPayeeName,
    required this.hasQrImage,
    required this.hasLogo,
    this.receiptFooter,
    required this.plan,
    required this.usage,
  });

  final String id;
  final String shopName;
  final String? ownerName;
  final String? email;
  final String? mobile;
  final String? addressLine;
  final String? city;
  final String? state;
  final String? pincode;
  final String? upiVpa;
  final String? upiPayeeName;
  final bool hasQrImage;
  final bool hasLogo;
  final String? receiptFooter;
  final Plan plan;
  final Usage usage;

  String get address => [addressLine, city, state, pincode].whereType<String>().where((s) => s.isNotEmpty).join(', ');

  factory AgentProfile.fromJson(Json j) => AgentProfile(
        id: jStr(j, 'id'),
        shopName: jStr(j, 'shop_name', 'My shop'),
        ownerName: jText(j, 'owner_name'),
        email: jText(j, 'email'),
        mobile: jText(j, 'mobile'),
        addressLine: jText(j, 'address_line'),
        city: jText(j, 'city'),
        state: jText(j, 'state'),
        pincode: jText(j, 'pincode'),
        upiVpa: jText(j, 'upi_vpa'),
        upiPayeeName: jText(j, 'upi_payee_name'),
        hasQrImage: jBool(j, 'has_qr_image'),
        hasLogo: jBool(j, 'has_logo'),
        receiptFooter: jText(j, 'receipt_footer'),
        plan: Plan.fromJson(jObj(j, 'plan') ?? const {}),
        usage: Usage.fromJson(jObj(j, 'usage') ?? const {}),
      );
}

/// Plan purchase order.
class PlanOrder {
  const PlanOrder({
    required this.id,
    required this.planCode,
    required this.planName,
    required this.period,
    required this.amountPaise,
    required this.status,
    this.checkoutUrl,
    this.periodStart,
    this.periodEnd,
    this.paidAt,
    required this.granted,
    this.createdAt,
  });

  final String id;
  final String planCode;
  final String planName;
  final String period;
  final int amountPaise;

  /// PENDING | PAID | EXPIRED | CANCELLED
  final String status;
  final String? checkoutUrl;
  final DateTime? periodStart;
  final DateTime? periodEnd;
  final DateTime? paidAt;
  final bool granted;
  final DateTime? createdAt;

  bool get isPending => status == 'PENDING';
  bool get isFinal => status == 'PAID' || status == 'EXPIRED' || status == 'CANCELLED';
  String get periodLabel => period == 'YEARLY' ? 'Yearly' : 'Monthly';

  factory PlanOrder.fromJson(Json j) => PlanOrder(
        id: jStr(j, 'id'),
        planCode: jStr(j, 'plan_code'),
        planName: jStr(j, 'plan_name', jStr(j, 'plan_code')),
        period: jStr(j, 'period', 'MONTHLY'),
        amountPaise: Money.parsePaise(j['amount']),
        status: jStr(j, 'status', 'PENDING'),
        checkoutUrl: jText(j, 'checkout_url'),
        periodStart: jDate(j, 'period_start'),
        periodEnd: jDate(j, 'period_end'),
        paidAt: jDate(j, 'paid_at'),
        granted: jBool(j, 'granted'),
        createdAt: jDate(j, 'created_at'),
      );
}

class BillingOverview {
  const BillingOverview({required this.current, required this.usage, required this.plans, required this.onlinePaymentAvailable, required this.orders});
  final Plan current;
  final Usage usage;
  final List<Plan> plans;
  final bool onlinePaymentAvailable;
  final List<PlanOrder> orders;

  factory BillingOverview.fromJson(Json j) => BillingOverview(
        current: Plan.fromJson(jObj(j, 'current') ?? const {}),
        usage: Usage.fromJson(jObj(j, 'usage') ?? const {}),
        plans: jList(j, 'plans', Plan.fromJson),
        onlinePaymentAvailable: jBool(j, 'online_payment_available'),
        orders: jList(j, 'orders', PlanOrder.fromJson),
      );
}

class DriveStatus {
  const DriveStatus({
    required this.available,
    required this.includedInPlan,
    required this.connected,
    this.googleEmail,
    this.status,
    required this.autoBackup,
    this.lastBackupAt,
    this.lastError,
    this.folderUrl,
  });

  final bool available;
  final bool includedInPlan;
  final bool connected;
  final String? googleEmail;
  final String? status;
  final bool autoBackup;
  final DateTime? lastBackupAt;
  final String? lastError;
  final String? folderUrl;

  factory DriveStatus.fromJson(Json j) => DriveStatus(
        available: jBool(j, 'available'),
        includedInPlan: jBool(j, 'included_in_plan'),
        connected: jBool(j, 'connected'),
        googleEmail: jText(j, 'google_email'),
        status: jText(j, 'status'),
        autoBackup: jBool(j, 'auto_backup'),
        lastBackupAt: jDate(j, 'last_backup_at'),
        lastError: jText(j, 'last_error'),
        folderUrl: jText(j, 'folder_url'),
      );
}

class StaffMember {
  const StaffMember({
    required this.userId,
    required this.name,
    this.email,
    this.mobile,
    required this.role,
    required this.roleName,
    required this.active,
    this.lastLoginAt,
    required this.isYou,
  });

  final String userId;
  final String name;
  final String? email;
  final String? mobile;
  final String role;
  final String roleName;
  final bool active;
  final DateTime? lastLoginAt;
  final bool isYou;

  bool get isOwner => role == 'AGENT_OWNER';

  factory StaffMember.fromJson(Json j) => StaffMember(
        userId: jStr(j, 'user_id'),
        name: jStr(j, 'name'),
        email: jText(j, 'email'),
        mobile: jText(j, 'mobile'),
        role: jStr(j, 'role'),
        roleName: jStr(j, 'role_name', jStr(j, 'role')),
        active: jBool(j, 'active', true),
        lastLoginAt: jDate(j, 'last_login_at'),
        isYou: jBool(j, 'is_you'),
      );
}

class StaffList {
  const StaffList({required this.staffLimit, required this.active, required this.members});
  final int staffLimit;
  final int active;
  final List<StaffMember> members;

  bool get atLimit => active >= staffLimit;

  factory StaffList.fromJson(Json j) => StaffList(
        staffLimit: jInt(j, 'staff_limit', 1),
        active: jInt(j, 'active'),
        members: jList(j, 'members', StaffMember.fromJson),
      );
}
