import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../customers/data/customer_models.dart';
import '../../customers/ui/customer_fields.dart';
import '../../more/ui/plan_card.dart';
import '../../more/ui/upi_qr.dart';
import '../data/transaction_models.dart';
import '../data/transactions_repository.dart';
import 'txn_tile.dart';

enum _Step { customer, beneficiary, details, review }

/// Record a counter entry. MONEY_TRANSFER: sender → beneficiary → details → review.
/// Other types: optional customer → details → review.
class NewTransactionScreen extends ConsumerStatefulWidget {
  const NewTransactionScreen({super.key, required this.type, this.customerId});
  final TxnType type;
  final String? customerId;

  @override
  ConsumerState<NewTransactionScreen> createState() => _NewTransactionScreenState();
}

class _NewTransactionScreenState extends ConsumerState<NewTransactionScreen> {
  late TxnType _type = widget.type;

  /// One key per entry flow, re-sent on every retry so a double tap or a lost response never records twice.
  final String _idempotencyKey = const Uuid().v4().replaceAll('-', '');

  int _index = 0;

  // Customer
  final _mobile = TextEditingController();
  String? _lookedUpFor;
  bool _lookingUp = false;
  Object? _lookupError;
  Customer? _customer;
  List<Beneficiary> _beneficiaries = [];
  final _customerForm = GlobalKey<FormState>();
  final _newCustomer = CustomerFormData();
  Map<String, String> _customerErrors = const {};
  String? _customerError;
  bool _savingCustomer = false;
  final _quickName = TextEditingController();
  String? _mobileError;

  // Beneficiary
  Beneficiary? _beneficiary;
  String? _beneficiaryError;

  // Details
  final _detailsForm = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _fee = TextEditingController();
  final _reference = TextEditingController();
  final _note = TextEditingController();
  String _mode = 'CASH';
  String _status = 'SUCCESS';
  String? _direction;
  DateTime? _occurredAt;
  Map<String, String> _detailErrors = const {};
  String? _directionError;

  // Submit
  bool _submitting = false;
  String? _submitError;

  bool get _isTransfer => _type == TxnType.moneyTransfer;

  List<_Step> get _steps => _isTransfer ? const [_Step.customer, _Step.beneficiary, _Step.details, _Step.review] : const [_Step.customer, _Step.details, _Step.review];

  _Step get _step => _steps[_index.clamp(0, _steps.length - 1)];

  @override
  void initState() {
    super.initState();
    if (widget.customerId != null) _loadInitialCustomer(widget.customerId!);
  }

  @override
  void dispose() {
    for (final c in [_mobile, _quickName, _amount, _fee, _reference, _note]) {
      c.dispose();
    }
    _newCustomer.dispose();
    super.dispose();
  }

  // ---- Customer ------------------------------------------------------------------------------

  Future<void> _loadInitialCustomer(String id) async {
    setState(() => _lookingUp = true);
    try {
      final c = await ref.read(customersRepositoryProvider).get(id);
      if (!mounted) return;
      _mobile.text = V.tenDigitMobile(c.mobile) ?? c.mobile;
      _lookedUpFor = V.tenDigitMobile(c.mobile);
      _setCustomer(c);
    } catch (e) {
      if (mounted) setState(() => _lookupError = e);
    } finally {
      if (mounted) setState(() => _lookingUp = false);
    }
  }

  void _setCustomer(Customer? c) {
    setState(() {
      _customer = c;
      _beneficiaries = c?.activeBeneficiaries ?? [];
      if (_beneficiary != null && !_beneficiaries.any((b) => b.id == _beneficiary!.id)) _beneficiary = null;
    });
  }

  void _onMobileChanged(String v) {
    final ten = V.tenDigitMobile(v);
    if (_mobileError != null) setState(() => _mobileError = null);
    if (ten == null) {
      if (_lookedUpFor != null || _customer != null) {
        setState(() => _lookedUpFor = null);
        _setCustomer(null);
      }
      return;
    }
    if (ten != _lookedUpFor) _lookup();
  }

  Future<void> _lookup() async {
    final ten = V.tenDigitMobile(_mobile.text);
    if (ten == null) {
      setState(() => _mobileError = 'Enter a valid 10-digit Indian mobile number');
      return;
    }
    setState(() {
      _lookingUp = true;
      _lookupError = null;
    });
    try {
      final c = await ref.read(customersRepositoryProvider).lookup(ten);
      if (!mounted || V.tenDigitMobile(_mobile.text) != ten) return;
      _lookedUpFor = ten;
      _setCustomer(c);
      if (c == null) {
        _newCustomer.mobile.text = ten;
        _customerErrors = const {};
      }
    } catch (e) {
      if (mounted) setState(() => _lookupError = e);
    } finally {
      if (mounted) setState(() => _lookingUp = false);
    }
  }

  Future<void> _saveNewCustomer() async {
    setState(() {
      _customerError = null;
      _customerErrors = const {};
    });
    if (!_customerForm.currentState!.validate()) return;
    setState(() => _savingCustomer = true);
    try {
      final c = await ref.read(customersRepositoryProvider).create(_newCustomer.toInput());
      ref.read(customerRevisionProvider.notifier).bump();
      _setCustomer(c);
      _next();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _customerErrors = e.fieldErrors;
          _customerError = e.message;
        });
      }
    } finally {
      if (mounted) setState(() => _savingCustomer = false);
    }
  }

  Future<void> _continueFromCustomer() async {
    final text = _mobile.text.trim();
    if (_isTransfer) {
      if (_customer != null) return _next();
      if (_lookedUpFor != null && _lookedUpFor == V.tenDigitMobile(text)) return _saveNewCustomer();
      return _lookup();
    }
    // Other types: the customer is optional.
    if (text.isEmpty) {
      _setCustomer(null);
      return _next();
    }
    final ten = V.tenDigitMobile(text);
    if (ten == null) {
      setState(() => _mobileError = 'Enter a valid 10-digit Indian mobile number, or leave it empty');
      return;
    }
    if (_lookedUpFor != ten) {
      await _lookup();
      if (_lookedUpFor != ten) return;
    }
    _next();
  }

  void _skipCustomer() {
    _mobile.clear();
    _quickName.clear();
    _lookedUpFor = null;
    _setCustomer(null);
    _next();
  }

  // ---- Navigation ----------------------------------------------------------------------------

  void _next() {
    FocusScope.of(context).unfocus();
    setState(() {
      _submitError = null;
      if (_index < _steps.length - 1) _index++;
    });
  }

  void _back() {
    FocusScope.of(context).unfocus();
    if (_index > 0) setState(() => _index--);
  }

  void _goTo(_Step s) {
    final i = _steps.indexOf(s);
    if (i >= 0) setState(() => _index = i);
  }

  // ---- Details -------------------------------------------------------------------------------

  int get _amountPaise => Money.tryParsePaise(_amount.text) ?? 0;
  int get _feePaise => Money.tryParsePaise(_fee.text) ?? 0;
  String get _effectiveDirection => _type.direction ?? _direction ?? 'IN';
  int get _totalPaise => _effectiveDirection == 'IN' ? _amountPaise + _feePaise : _amountPaise - _feePaise;

  Future<void> _pickWhen() async {
    final nowWall = Ist.nowWall();
    final current = _occurredAt == null ? nowWall : Ist.wall(_occurredAt!);
    final today = DateTime(nowWall.year, nowWall.month, nowWall.day);
    final date = await showDatePicker(
      context: context,
      initialDate: DateTime(current.year, current.month, current.day),
      firstDate: today.subtract(const Duration(days: 30)),
      lastDate: today,
      helpText: 'When did it happen? (IST)',
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay(hour: current.hour, minute: current.minute), helpText: 'Time (IST)');
    if (time == null) return;
    var instant = Ist.instant(date.year, date.month, date.day, time.hour, time.minute);
    final now = DateTime.now().toUtc();
    if (instant.isAfter(now)) instant = now;
    if (instant.isBefore(now.subtract(const Duration(days: 30)))) {
      if (mounted) showSnack(context, 'Entries can be back-dated by at most 30 days', error: true);
      return;
    }
    setState(() {
      _occurredAt = instant;
      _detailErrors = Map.of(_detailErrors)..remove('occurred_at');
    });
  }

  void _continueFromDetails() {
    setState(() {
      _detailErrors = const {};
      _directionError = (_type == TxnType.other && _direction == null) ? 'Choose money in or money out' : null;
    });
    final ok = _detailsForm.currentState!.validate();
    if (!ok || _directionError != null) return;
    if (_effectiveDirection == 'OUT' && _feePaise > _amountPaise) {
      setState(() => _detailErrors = {'fee': 'The fee is more than the amount'});
      return;
    }
    _next();
  }

  // ---- Submit --------------------------------------------------------------------------------

  NewTransaction _build() => NewTransaction(
        type: _type,
        direction: _type == TxnType.other ? _direction : null,
        mode: _mode,
        status: _status,
        amountPaise: _amountPaise,
        feePaise: _feePaise,
        reference: _reference.text,
        description: _note.text,
        customerId: _customer?.id,
        beneficiaryId: _isTransfer ? _beneficiary?.id : null,
        customerName: _customer == null ? _quickName.text : null,
        customerMobile: _customer == null ? V.tenDigitMobile(_mobile.text) : null,
        occurredAt: _occurredAt,
      );

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    try {
      final t = await ref.read(transactionsRepositoryProvider).create(_build(), idempotencyKey: _idempotencyKey);
      ref.read(txnRevisionProvider.notifier).bump();
      ref.invalidate(dashboardProvider);
      ref.invalidate(profileProvider);
      if (mounted) context.pushReplacement('/txn/${t.id}/receipt?new=1');
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.isLimitExceeded) {
        setState(() => _submitError = e.message);
        await showUpgradeSheet(context, title: 'Monthly limit reached', message: e.message);
        return;
      }
      final fe = e.fieldErrors;
      const detailKeys = {'amount', 'fee', 'reference', 'description', 'occurred_at', 'mode', 'status', 'direction'};
      if (fe.keys.any(detailKeys.contains)) {
        setState(() {
          _detailErrors = fe;
          _directionError = fe['direction'];
          _submitError = e.message;
        });
        _goTo(_Step.details);
      } else if (fe.containsKey('beneficiary_id') && _isTransfer) {
        setState(() => _beneficiaryError = fe['beneficiary_id']);
        _goTo(_Step.beneficiary);
      } else if (fe.containsKey('customer_id') || fe.containsKey('customer_mobile') || fe.containsKey('customer_name')) {
        setState(() => _mobileError = fe['customer_mobile'] ?? fe['customer_id'] ?? fe['customer_name']);
        _goTo(_Step.customer);
      } else {
        setState(() => _submitError = e.message);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ---- UI ------------------------------------------------------------------------------------

  String get _stepTitle => switch (_step) {
        _Step.customer => _isTransfer ? 'Sender' : 'Customer',
        _Step.beneficiary => 'Beneficiary',
        _Step.details => 'Amount & details',
        _Step.review => 'Review',
      };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return PopScope(
      canPop: _index == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(_type.label),
            Text('Step ${_index + 1} of ${_steps.length} · $_stepTitle', style: t.textTheme.bodySmall),
          ]),
          actions: [
            if (_index == 0)
              PopupMenuButton<TxnType>(
                tooltip: 'Change type',
                icon: const Icon(Icons.swap_vert_rounded),
                onSelected: (v) => setState(() {
                  _type = v;
                  _index = 0;
                }),
                itemBuilder: (_) => [
                  for (final type in TxnType.values)
                    PopupMenuItem(
                      value: type,
                      child: Row(children: [Icon(txnIcon(type.code)), const SizedBox(width: 12), Text(type.label)]),
                    ),
                ],
              ),
          ],
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(4),
            child: LinearProgressIndicator(value: (_index + 1) / _steps.length, minHeight: 4),
          ),
        ),
        body: SafeArea(
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            child: KeyedSubtree(
              key: ValueKey(_step),
              child: switch (_step) {
                _Step.customer => _customerStep(t),
                _Step.beneficiary => _beneficiaryStep(t),
                _Step.details => _detailsStep(t),
                _Step.review => _reviewStep(t),
              },
            ),
          ),
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: _bottomButton(),
          ),
        ),
      ),
    );
  }

  Widget _bottomButton() {
    switch (_step) {
      case _Step.customer:
        final notFound = _lookedUpFor != null && _customer == null;
        final label = _isTransfer ? (_customer != null ? 'Continue' : (notFound ? 'Save customer & continue' : 'Find customer')) : 'Continue';
        return BusyButton(label: label, busy: _savingCustomer || _lookingUp, onPressed: _continueFromCustomer);
      case _Step.beneficiary:
        return BusyButton(
          label: 'Continue',
          onPressed: _beneficiary == null ? () => setState(() => _beneficiaryError = 'Choose the beneficiary') : _next,
        );
      case _Step.details:
        return BusyButton(label: 'Review', onPressed: _continueFromDetails);
      case _Step.review:
        return BusyButton(label: 'Record ${Money.format(_totalPaise)}', icon: Icons.check_rounded, busy: _submitting, onPressed: _submit);
    }
  }

  Widget _customerStep(ThemeData t) {
    final notFound = _lookedUpFor != null && _customer == null && !_lookingUp;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text(_isTransfer ? 'Sender’s mobile number' : 'Customer (optional)', style: t.textTheme.titleMedium),
      const SizedBox(height: 12),
      TextField(
        controller: _mobile,
        autofocus: _customer == null,
        keyboardType: TextInputType.phone,
        inputFormatters: mobileInputFormatters,
        style: t.textTheme.titleLarge,
        decoration: InputDecoration(
          labelText: 'Mobile number',
          prefixText: '+91 ',
          errorText: _mobileError,
          suffixIcon: _lookingUp
              ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
              : IconButton(tooltip: 'Find', icon: const Icon(Icons.search), onPressed: _lookup),
        ),
        onChanged: _onMobileChanged,
        onSubmitted: (_) => _lookup(),
      ),
      if (_lookupError != null) ...[
        const SizedBox(height: 12),
        ErrorBanner(errorMessage(_lookupError!)),
        TextButton.icon(onPressed: _lookup, icon: const Icon(Icons.refresh), label: const Text('Try again')),
      ],
      if (_customer != null) ...[
        const SizedBox(height: 16),
        _CustomerCard(customer: _customer!),
      ],
      if (notFound && _isTransfer) ...[
        const SizedBox(height: 20),
        Row(children: [
          Icon(Icons.person_add_alt_1, color: t.colorScheme.primary),
          const SizedBox(width: 8),
          Text('New customer', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        ]),
        const SizedBox(height: 4),
        Text('No saved customer with this number. Add their details once; next time they’re found by mobile.', style: t.textTheme.bodySmall),
        const SizedBox(height: 12),
        if (_customerError != null) ...[ErrorBanner(_customerError!), const SizedBox(height: 12)],
        Form(
          key: _customerForm,
          child: CustomerFields(
            data: _newCustomer,
            mobileReadOnly: true,
            fieldErrors: _customerErrors,
            showNote: false,
            onEdited: (k) {
              if (_customerErrors.containsKey(k)) setState(() => _customerErrors = Map.of(_customerErrors)..remove(k));
            },
          ),
        ),
      ],
      if (notFound && !_isTransfer) ...[
        const SizedBox(height: 16),
        TextField(
          controller: _quickName,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Customer name (optional)', prefixIcon: Icon(Icons.person_outline)),
        ),
        const SizedBox(height: 6),
        Text('Not a saved customer. The name and mobile go on the receipt.', style: t.textTheme.bodySmall),
      ],
      if (!_isTransfer) ...[
        const SizedBox(height: 16),
        Center(child: TextButton(onPressed: _skipCustomer, child: const Text('Skip — walk-in customer'))),
      ],
    ]);
  }

  Widget _beneficiaryStep(ThemeData t) {
    final c = _customer;
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (c != null) _CustomerCard(customer: c, compact: true),
      const SizedBox(height: 16),
      Row(children: [
        Expanded(child: Text('Send to', style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
        if (c != null)
          TextButton.icon(
            onPressed: () async {
              final b = await showAddBeneficiarySheet(context, c.id);
              if (b != null) {
                setState(() {
                  _beneficiaries = [..._beneficiaries, b];
                  _beneficiary = b;
                  _beneficiaryError = null;
                });
              }
            },
            icon: const Icon(Icons.add),
            label: const Text('Add new'),
          ),
      ]),
      if (_beneficiaryError != null) ...[const SizedBox(height: 8), ErrorBanner(_beneficiaryError!)],
      const SizedBox(height: 8),
      if (_beneficiaries.isEmpty)
        const EmptyView(icon: Icons.account_balance_outlined, title: 'No beneficiaries yet', message: 'Add the bank account or UPI id the money goes to.')
      else
        for (final b in _beneficiaries)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Card(
              shape: _beneficiary?.id == b.id
                  ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: t.colorScheme.primary, width: 2))
                  : null,
              child: ListTile(
                onTap: () => setState(() {
                  _beneficiary = b;
                  _beneficiaryError = null;
                }),
                leading: Icon(_beneficiary?.id == b.id ? Icons.radio_button_checked : Icons.radio_button_off, color: _beneficiary?.id == b.id ? t.colorScheme.primary : null),
                title: Text(b.relation == null ? b.name : '${b.name} (${b.relation})', style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(b.subtitle),
              ),
            ),
          ),
    ]);
  }

  Widget _detailsStep(ThemeData t) {
    final profile = ref.watch(profileProvider).value;
    final vpa = profile?.upiVpa;
    final showUpi = _mode == 'UPI' && _effectiveDirection == 'IN' && vpa != null && _totalPaise > 0;
    final when = _occurredAt == null ? 'Now' : '${Ist.formatDateTime(_occurredAt)} IST';
    return Form(
      key: _detailsForm,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        if (_submitError != null) ...[ErrorBanner(_submitError!), const SizedBox(height: 12)],
        if (_type == TxnType.other) ...[
          Text('Money', style: t.textTheme.titleSmall),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            emptySelectionAllowed: true,
            segments: const [
              ButtonSegment(value: 'IN', icon: Icon(Icons.south_west_rounded), label: Text('In (customer pays)')),
              ButtonSegment(value: 'OUT', icon: Icon(Icons.north_east_rounded), label: Text('Out (you pay)')),
            ],
            selected: {?_direction},
            onSelectionChanged: (v) => setState(() {
              _direction = v.isEmpty ? null : v.first;
              _directionError = null;
            }),
          ),
          if (_directionError != null) Padding(padding: const EdgeInsets.only(top: 6, left: 12), child: Text(_directionError!, style: TextStyle(color: t.colorScheme.error))),
          const SizedBox(height: 16),
        ],
        TextFormField(
          controller: _amount,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: amountInputFormatters,
          style: t.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
          decoration: const InputDecoration(labelText: 'Amount', prefixText: '₹ '),
          validator: V.amount,
          forceErrorText: _detailErrors['amount'],
          onChanged: (_) => setState(() => _detailErrors = Map.of(_detailErrors)..remove('amount')),
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: _fee,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: amountInputFormatters,
          decoration: const InputDecoration(labelText: 'Service charge (fee)', prefixText: '₹ ', hintText: '0'),
          validator: V.fee,
          forceErrorText: _detailErrors['fee'],
          onChanged: (_) => setState(() => _detailErrors = Map.of(_detailErrors)..remove('fee')),
        ),
        const SizedBox(height: 10),
        if (_amountPaise > 0)
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: t.colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Expanded(child: Text(_effectiveDirection == 'IN' ? 'Customer pays' : 'Customer receives', style: TextStyle(color: t.colorScheme.onSecondaryContainer))),
              Text(Money.format(_totalPaise), style: t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: t.colorScheme.onSecondaryContainer)),
            ]),
          ),
        const SizedBox(height: 16),
        Text(_effectiveDirection == 'IN' ? 'Customer paid by' : 'Paid to customer by', style: t.textTheme.titleSmall),
        const SizedBox(height: 8),
        SegmentedButton<String>(
          showSelectedIcon: false,
          segments: [for (final m in PayMode.all) ButtonSegment(value: m, label: Text(PayMode.label(m)))],
          selected: {_mode},
          onSelectionChanged: (v) => setState(() => _mode = v.first),
        ),
        if (showUpi) ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () => showUpiQrSheet(
              context,
              vpa: vpa,
              payeeName: profile?.upiPayeeName ?? profile?.shopName,
              amountPaise: _totalPaise,
              note: _note.text.trim().isNotEmpty ? _note.text.trim() : '${_type.label} at ${profile?.shopName ?? 'shop'}',
            ),
            icon: const Icon(Icons.qr_code_2_rounded),
            label: Text('Collect ${Money.format(_totalPaise)} via UPI QR'),
          ),
        ] else if (_mode == 'UPI' && _effectiveDirection == 'IN' && vpa == null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Add your UPI id in More → Shop profile to show a payment QR here.', style: t.textTheme.bodySmall),
          ),
        const SizedBox(height: 16),
        TextFormField(
          controller: _reference,
          textCapitalization: TextCapitalization.characters,
          maxLength: 64,
          decoration: const InputDecoration(labelText: 'Reference (UTR / RRN / bill no.)', counterText: ''),
          forceErrorText: _detailErrors['reference'],
        ),
        const SizedBox(height: 14),
        Text('Status', style: t.textTheme.titleSmall),
        const SizedBox(height: 8),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'SUCCESS', icon: Icon(Icons.check_circle_outline), label: Text('Success')),
            ButtonSegment(value: 'PENDING', icon: Icon(Icons.hourglass_empty_rounded), label: Text('Pending')),
          ],
          selected: {_status},
          onSelectionChanged: (v) => setState(() => _status = v.first),
        ),
        const SizedBox(height: 14),
        TextFormField(
          controller: _note,
          maxLength: 255,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(labelText: 'Note (optional)'),
          forceErrorText: _detailErrors['description'],
        ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.schedule),
            title: const Text('When'),
            subtitle: Text(when),
            trailing: _occurredAt == null
                ? const Text('Change')
                : IconButton(tooltip: 'Use now', icon: const Icon(Icons.restore), onPressed: () => setState(() => _occurredAt = null)),
            onTap: _pickWhen,
          ),
        ),
        if (_detailErrors['occurred_at'] != null)
          Padding(padding: const EdgeInsets.only(top: 6, left: 12), child: Text(_detailErrors['occurred_at']!, style: TextStyle(color: t.colorScheme.error))),
      ]),
    );
  }

  Widget _reviewStep(ThemeData t) {
    final c = _customer;
    final b = _isTransfer ? _beneficiary : null;
    final dir = _effectiveDirection;
    final quickName = _quickName.text.trim();
    final quickMobile = V.tenDigitMobile(_mobile.text);
    Widget edit(_Step s) => TextButton(onPressed: () => _goTo(s), child: const Text('Edit'));
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (_submitError != null) ...[ErrorBanner(_submitError!), const SizedBox(height: 12)],
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(children: [
            Icon(txnIcon(_type.code), size: 36, color: t.colorScheme.primary),
            const SizedBox(height: 6),
            Text(_type.label, style: t.textTheme.titleMedium),
            const SizedBox(height: 4),
            AmountText(_amountPaise, direction: dir, style: t.textTheme.headlineMedium),
            const Divider(height: 24),
            KeyValueRow('Amount', Money.format(_amountPaise)),
            KeyValueRow('Service charge', Money.format(_feePaise)),
            KeyValueRow(dir == 'IN' ? 'Customer pays' : 'Customer receives', Money.format(_totalPaise), bold: true),
            KeyValueRow('Mode', PayMode.label(_mode)),
            if (_reference.text.trim().isNotEmpty) KeyValueRow('Reference', _reference.text.trim()),
            KeyValueRow('Status', TxnStatus.label(_status)),
            if (_note.text.trim().isNotEmpty) KeyValueRow('Note', _note.text.trim()),
            KeyValueRow('When', _occurredAt == null ? 'Now' : '${Ist.formatDateTime(_occurredAt)} IST'),
            Align(alignment: Alignment.centerRight, child: edit(_Step.details)),
          ]),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const CircleAvatar(child: Icon(Icons.person_outline)),
          title: Text(c?.name ?? (quickName.isNotEmpty ? quickName : (quickMobile != null ? 'Customer' : 'Walk-in customer'))),
          subtitle: Text(c?.mobile ?? (quickMobile != null ? '+91 $quickMobile' : 'No customer details')),
          trailing: edit(_Step.customer),
        ),
      ),
      if (b != null) ...[
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            leading: const CircleAvatar(child: Icon(Icons.account_balance_outlined)),
            title: Text(b.name),
            subtitle: Text(b.subtitle),
            trailing: edit(_Step.beneficiary),
          ),
        ),
      ],
    ]);
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard({required this.customer, this.compact = false});
  final Customer customer;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final c = customer;
    return Card(
      color: t.colorScheme.primaryContainer.withValues(alpha: 0.5),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(children: [
          CircleAvatar(child: Text(c.initials)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(c.name, style: t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              Text(c.mobile),
              if (!compact) ...[
                if (c.idType != null) Text('${IdTypes.label(c.idType)} ${c.idNumberMasked ?? ''}', style: t.textTheme.bodySmall),
                Text(
                  '${c.activeBeneficiaries.length} beneficiar${c.activeBeneficiaries.length == 1 ? 'y' : 'ies'}'
                  '${c.transactions != null ? ' · ${c.transactions} transactions' : ''}',
                  style: t.textTheme.bodySmall,
                ),
              ],
            ]),
          ),
          Icon(Icons.verified_rounded, color: t.colorScheme.primary),
        ]),
      ),
    );
  }
}
