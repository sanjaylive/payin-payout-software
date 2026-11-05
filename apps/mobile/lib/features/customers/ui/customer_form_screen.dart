import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/customer_models.dart';
import 'customer_detail_screen.dart';
import 'customer_fields.dart';

/// Add a customer, or edit one when [customerId] is given.
class CustomerFormScreen extends ConsumerStatefulWidget {
  const CustomerFormScreen({super.key, this.customerId});
  final String? customerId;

  @override
  ConsumerState<CustomerFormScreen> createState() => _CustomerFormScreenState();
}

class _CustomerFormScreenState extends ConsumerState<CustomerFormScreen> {
  final _form = GlobalKey<FormState>();
  final _data = CustomerFormData();
  bool _loading = false;
  Object? _loadError;
  bool _busy = false;
  String? _error;
  String? _idMasked;
  Map<String, String> _fe = const {};

  bool get _editing => widget.customerId != null;

  @override
  void initState() {
    super.initState();
    if (_editing) _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final c = await ref.read(customersRepositoryProvider).get(widget.customerId!);
      _data.fill(c);
      _idMasked = c.idNumberMasked;
    } catch (e) {
      _loadError = e;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _data.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _error = null;
      _fe = const {};
    });
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final repo = ref.read(customersRepositoryProvider);
      final Customer c = _editing ? await repo.update(widget.customerId!, _data.toInput()) : await repo.create(_data.toInput());
      ref.read(customerRevisionProvider.notifier).bump();
      if (_editing) ref.invalidate(customerProvider(c.id));
      if (!mounted) return;
      showSnack(context, _editing ? 'Customer updated' : 'Customer added');
      if (_editing) {
        context.pop();
      } else {
        context.pushReplacement('/customer/${c.id}');
      }
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
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? 'Edit customer' : 'Add customer')),
      body: _loading
          ? const LoadingView()
          : _loadError != null
              ? ErrorView(error: _loadError!, onRetry: _load)
              : SafeArea(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(16),
                    child: Form(
                      key: _form,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        if (_error != null) ...[ErrorBanner(_error!), const SizedBox(height: 16)],
                        CustomerFields(
                          data: _data,
                          fieldErrors: _fe,
                          existingIdMasked: _idMasked,
                          onEdited: (k) {
                            if (_fe.containsKey(k)) setState(() => _fe = Map.of(_fe)..remove(k));
                          },
                        ),
                        const SizedBox(height: 24),
                        BusyButton(label: _editing ? 'Save changes' : 'Add customer', busy: _busy, onPressed: _save),
                      ]),
                    ),
                  ),
                ),
    );
  }
}
