import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/customer_models.dart';

/// Text controllers + picks for a customer form.
class CustomerFormData {
  final name = TextEditingController();
  final mobile = TextEditingController();
  final email = TextEditingController();
  final address = TextEditingController();
  final city = TextEditingController();
  final pincode = TextEditingController();
  final idNumber = TextEditingController();
  final note = TextEditingController();
  String? dateOfBirth;
  String? idType;

  void fill(Customer c) {
    name.text = c.name;
    mobile.text = V.tenDigitMobile(c.mobile) ?? c.mobile;
    email.text = c.email ?? '';
    address.text = c.addressLine ?? '';
    city.text = c.city ?? '';
    pincode.text = c.pincode ?? '';
    note.text = c.note ?? '';
    dateOfBirth = c.dateOfBirth;
    idType = c.idType;
  }

  CustomerInput toInput() => CustomerInput(
        name: name.text,
        mobile: mobile.text,
        email: email.text,
        addressLine: address.text,
        city: city.text,
        pincode: pincode.text,
        dateOfBirth: dateOfBirth,
        idType: idType,
        idNumber: idNumber.text,
        note: note.text,
      );

  void dispose() {
    for (final c in [name, mobile, email, address, city, pincode, idNumber, note]) {
      c.dispose();
    }
  }
}

/// The customer form fields (used by Add/Edit customer and inside the transfer flow).
class CustomerFields extends StatefulWidget {
  const CustomerFields({
    super.key,
    required this.data,
    this.fieldErrors = const {},
    this.onEdited,
    this.mobileReadOnly = false,
    this.existingIdMasked,
    this.showNote = true,
  });

  final CustomerFormData data;
  final Map<String, String> fieldErrors;

  /// Called with the field key when the user edits it (to clear its server error).
  final ValueChanged<String>? onEdited;
  final bool mobileReadOnly;

  /// When editing: the stored ID's masked form ("XXXX1234"); leave the number blank to keep it.
  final String? existingIdMasked;
  final bool showNote;

  @override
  State<CustomerFields> createState() => _CustomerFieldsState();
}

class _CustomerFieldsState extends State<CustomerFields> {
  CustomerFormData get d => widget.data;

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final current = Ist.parseDateString(d.dateOfBirth);
    final picked = await showDatePicker(
      context: context,
      initialDate: current != null ? DateTime(current.year, current.month, current.day) : DateTime(now.year - 30),
      firstDate: DateTime(1900),
      lastDate: now,
      initialEntryMode: DatePickerEntryMode.calendarOnly,
      helpText: 'Date of birth',
    );
    if (picked != null) {
      setState(() => d.dateOfBirth = Ist.dateString(DateTime.utc(picked.year, picked.month, picked.day)));
      widget.onEdited?.call('date_of_birth');
    }
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.fieldErrors;
    void edited(String k) => widget.onEdited?.call(k);
    const gap = SizedBox(height: 14);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextFormField(
        controller: d.name,
        textCapitalization: TextCapitalization.words,
        textInputAction: TextInputAction.next,
        decoration: const InputDecoration(labelText: 'Full name *', prefixIcon: Icon(Icons.person_outline)),
        validator: (v) => V.name(v, 'the customer name'),
        forceErrorText: e['name'],
        onChanged: (_) => edited('name'),
      ),
      gap,
      TextFormField(
        controller: d.mobile,
        readOnly: widget.mobileReadOnly,
        keyboardType: TextInputType.phone,
        textInputAction: TextInputAction.next,
        inputFormatters: mobileInputFormatters,
        decoration: const InputDecoration(labelText: 'Mobile number *', prefixText: '+91 ', prefixIcon: Icon(Icons.phone_outlined)),
        validator: V.mobile,
        forceErrorText: e['mobile'],
        onChanged: (_) => edited('mobile'),
      ),
      gap,
      TextFormField(
        controller: d.email,
        keyboardType: TextInputType.emailAddress,
        textInputAction: TextInputAction.next,
        decoration: const InputDecoration(labelText: 'Email (optional)', prefixIcon: Icon(Icons.mail_outline)),
        validator: V.optionalEmail,
        forceErrorText: e['email'],
        onChanged: (_) => edited('email'),
      ),
      gap,
      TextFormField(
        controller: d.address,
        textCapitalization: TextCapitalization.sentences,
        textInputAction: TextInputAction.next,
        decoration: const InputDecoration(labelText: 'Address', prefixIcon: Icon(Icons.home_outlined)),
        forceErrorText: e['address_line'],
        onChanged: (_) => edited('address_line'),
      ),
      gap,
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          flex: 3,
          child: TextFormField(
            controller: d.city,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(labelText: 'City'),
            forceErrorText: e['city'],
            onChanged: (_) => edited('city'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          flex: 2,
          child: TextFormField(
            controller: d.pincode,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: 'PIN code'),
            validator: V.optionalPincode,
            forceErrorText: e['pincode'],
            onChanged: (_) => edited('pincode'),
          ),
        ),
      ]),
      gap,
      InkWell(
        onTap: _pickDob,
        borderRadius: BorderRadius.circular(12),
        child: InputDecorator(
          decoration: InputDecoration(
            labelText: 'Date of birth',
            prefixIcon: const Icon(Icons.cake_outlined),
            errorText: e['date_of_birth'],
            suffixIcon: d.dateOfBirth == null
                ? const Icon(Icons.calendar_month_outlined)
                : IconButton(
                    tooltip: 'Clear',
                    icon: const Icon(Icons.clear),
                    onPressed: () => setState(() => d.dateOfBirth = null),
                  ),
          ),
          child: Text(d.dateOfBirth == null ? 'Not set' : Ist.formatCalendarDate(d.dateOfBirth)),
        ),
      ),
      gap,
      DropdownButtonFormField<String?>(
        initialValue: d.idType,
        decoration: InputDecoration(labelText: 'ID document', prefixIcon: const Icon(Icons.badge_outlined), errorText: e['id_type']),
        items: [
          const DropdownMenuItem<String?>(value: null, child: Text('None')),
          for (final t in IdTypes.all) DropdownMenuItem<String?>(value: t, child: Text(IdTypes.label(t))),
        ],
        onChanged: (v) => setState(() {
          d.idType = v;
          edited('id_type');
        }),
      ),
      if (d.idType != null) ...[
        gap,
        TextFormField(
          controller: d.idNumber,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [UpperCaseFormatter(), LengthLimitingTextInputFormatter(20)],
          decoration: InputDecoration(
            labelText: '${IdTypes.label(d.idType)} number',
            helperText: widget.existingIdMasked != null ? 'Stored: ${widget.existingIdMasked}. Leave blank to keep it.' : null,
          ),
          validator: V.optionalIdNumber,
          forceErrorText: e['id_number'],
          onChanged: (_) => edited('id_number'),
        ),
      ],
      if (widget.showNote) ...[
        gap,
        TextFormField(
          controller: d.note,
          maxLength: 255,
          decoration: const InputDecoration(labelText: 'Note', prefixIcon: Icon(Icons.notes_outlined)),
          forceErrorText: e['note'],
          onChanged: (_) => edited('note'),
        ),
      ],
    ]);
  }
}

/// Add a beneficiary for [customerId]; returns it when saved.
Future<Beneficiary?> showAddBeneficiarySheet(BuildContext context, String customerId) => showModalBottomSheet<Beneficiary>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _BeneficiarySheet(customerId: customerId),
    );

class _BeneficiarySheet extends ConsumerStatefulWidget {
  const _BeneficiarySheet({required this.customerId});
  final String customerId;

  @override
  ConsumerState<_BeneficiarySheet> createState() => _BeneficiarySheetState();
}

class _BeneficiarySheetState extends ConsumerState<_BeneficiarySheet> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _bank = TextEditingController();
  final _account = TextEditingController();
  final _confirmAccount = TextEditingController();
  final _ifsc = TextEditingController();
  final _upi = TextEditingController();
  final _relation = TextEditingController();
  bool _useUpi = false;
  bool _busy = false;
  String? _error;
  Map<String, String> _fe = const {};

  @override
  void dispose() {
    for (final c in [_name, _bank, _account, _confirmAccount, _ifsc, _upi, _relation]) {
      c.dispose();
    }
    super.dispose();
  }

  void _clear(String k) {
    if (_fe.containsKey(k)) setState(() => _fe = Map.of(_fe)..remove(k));
  }

  Future<void> _save() async {
    setState(() {
      _error = null;
      _fe = const {};
    });
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final b = await ref.read(customersRepositoryProvider).addBeneficiary(
            widget.customerId,
            BeneficiaryInput(
              name: _name.text,
              bankName: _useUpi ? null : _bank.text,
              accountNumber: _useUpi ? null : _account.text,
              ifsc: _useUpi ? null : _ifsc.text,
              upiId: _useUpi ? _upi.text : null,
              relation: _relation.text,
            ),
          );
      if (mounted) Navigator.pop(context, b);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _fe = e.fieldErrors;
          _error = e.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const gap = SizedBox(height: 14);
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Form(
          key: _form,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Add beneficiary', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, icon: Icon(Icons.account_balance_outlined), label: Text('Bank account')),
                ButtonSegment(value: true, icon: Icon(Icons.qr_code), label: Text('UPI id')),
              ],
              selected: {_useUpi},
              onSelectionChanged: (v) => setState(() => _useUpi = v.first),
            ),
            const SizedBox(height: 16),
            if (_error != null) ...[ErrorBanner(_error!), gap],
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Beneficiary name *'),
              validator: (v) => V.name(v, 'the beneficiary name'),
              forceErrorText: _fe['name'],
              onChanged: (_) => _clear('name'),
            ),
            gap,
            if (!_useUpi) ...[
              TextFormField(
                controller: _bank,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(labelText: 'Bank name'),
                forceErrorText: _fe['bank_name'],
              ),
              gap,
              TextFormField(
                controller: _account,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
                decoration: const InputDecoration(labelText: 'Account number *'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Enter the account number' : V.optionalAccount(v),
                forceErrorText: _fe['account_number'],
                onChanged: (_) => _clear('account_number'),
              ),
              gap,
              TextFormField(
                controller: _confirmAccount,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(18)],
                decoration: const InputDecoration(labelText: 'Re-enter account number *'),
                validator: (v) => v != _account.text ? 'Account numbers don’t match' : null,
              ),
              gap,
              TextFormField(
                controller: _ifsc,
                textCapitalization: TextCapitalization.characters,
                inputFormatters: [UpperCaseFormatter(), FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9]')), LengthLimitingTextInputFormatter(11)],
                decoration: const InputDecoration(labelText: 'IFSC *', hintText: 'SBIN0001234'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'IFSC is needed with an account number' : V.optionalIfsc(v),
                forceErrorText: _fe['ifsc'],
                onChanged: (_) => _clear('ifsc'),
              ),
            ] else
              TextFormField(
                controller: _upi,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: 'UPI id *', hintText: 'name@okaxis'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Enter the UPI id' : V.optionalUpi(v),
                forceErrorText: _fe['upi_id'],
                onChanged: (_) => _clear('upi_id'),
              ),
            gap,
            TextFormField(
              controller: _relation,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Relation (optional)', hintText: 'Self, Father, Wife…'),
              forceErrorText: _fe['relation'],
            ),
            const SizedBox(height: 20),
            BusyButton(label: 'Save beneficiary', busy: _busy, onPressed: _save),
          ]),
        ),
      ),
    );
  }
}
