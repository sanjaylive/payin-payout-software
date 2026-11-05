import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/format/validators.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../data/agent_models.dart';
import 'my_qr_screen.dart';

class ShopProfileScreen extends ConsumerWidget {
  const ShopProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(profileProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Shop profile')),
      body: AsyncBody<AgentProfile>(
        value: value,
        onRetry: () => ref.invalidate(profileProvider),
        data: (p) => _ProfileForm(key: ValueKey(p.id), profile: p),
      ),
    );
  }
}

class _ProfileForm extends ConsumerStatefulWidget {
  const _ProfileForm({super.key, required this.profile});
  final AgentProfile profile;

  @override
  ConsumerState<_ProfileForm> createState() => _ProfileFormState();
}

class _ProfileFormState extends ConsumerState<_ProfileForm> {
  final _form = GlobalKey<FormState>();
  late final _shop = TextEditingController(text: widget.profile.shopName);
  late final _owner = TextEditingController(text: widget.profile.ownerName);
  late final _address = TextEditingController(text: widget.profile.addressLine);
  late final _city = TextEditingController(text: widget.profile.city);
  late final _state = TextEditingController(text: widget.profile.state);
  late final _pin = TextEditingController(text: widget.profile.pincode);
  late final _vpa = TextEditingController(text: widget.profile.upiVpa);
  late final _payee = TextEditingController(text: widget.profile.upiPayeeName);
  late final _footer = TextEditingController(text: widget.profile.receiptFooter);
  bool _busy = false;
  String? _error;
  Map<String, String> _fe = const {};

  @override
  void dispose() {
    for (final c in [_shop, _owner, _address, _city, _state, _pin, _vpa, _payee, _footer]) {
      c.dispose();
    }
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
      final updated = await ref.read(agentRepositoryProvider).updateProfile({
        'shop_name': _shop.text.trim(),
        'owner_name': _owner.text.trim(),
        'address_line': _address.text.trim(),
        'city': _city.text.trim(),
        'state': _state.text.trim(),
        'pincode': _pin.text.trim(),
        'upi_vpa': _vpa.text.trim(),
        'upi_payee_name': _payee.text.trim(),
        'receipt_footer': _footer.text.trim(),
      });
      _refreshProfile(updated);
      if (mounted) showSnack(context, 'Shop profile saved');
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

  void _refreshProfile(AgentProfile _) {
    ref.invalidate(profileProvider);
    ref.invalidate(dashboardProvider);
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.profile;
    const gap = SizedBox(height: 14);
    TextFormField field(TextEditingController c, String label, String key,
            {String? Function(String?)? validator, TextInputType? keyboard, String? helper, int? maxLength, List<TextInputFormatter>? formatters}) =>
        TextFormField(
          controller: c,
          keyboardType: keyboard,
          maxLength: maxLength,
          inputFormatters: formatters,
          textCapitalization: keyboard == null ? TextCapitalization.words : TextCapitalization.none,
          decoration: InputDecoration(labelText: label, helperText: helper, helperMaxLines: 2),
          validator: validator,
          forceErrorText: _fe[key],
        );
    return Form(
      key: _form,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        if (_error != null) ...[ErrorBanner(_error!), gap],
        field(_shop, 'Shop name', 'shop_name', validator: (v) => V.name(v, 'the shop name')),
        gap,
        field(_owner, 'Owner name', 'owner_name', validator: (v) => V.name(v, 'the owner name')),
        gap,
        field(_address, 'Address', 'address_line'),
        gap,
        Row(children: [
          Expanded(child: field(_city, 'City', 'city')),
          const SizedBox(width: 12),
          Expanded(child: field(_state, 'State', 'state')),
        ]),
        gap,
        field(_pin, 'PIN code', 'pincode',
            keyboard: TextInputType.number,
            validator: V.optionalPincode,
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)]),
        const SectionHeader('UPI', padding: EdgeInsets.fromLTRB(0, 20, 0, 8)),
        field(_vpa, 'UPI id', 'upi_vpa', keyboard: TextInputType.emailAddress, validator: V.optionalUpi, helper: 'e.g. shopname@okaxis — used for the payment QR'),
        gap,
        field(_payee, 'Payee name on QR', 'upi_payee_name'),
        const SectionHeader('Receipts', padding: EdgeInsets.fromLTRB(0, 20, 0, 8)),
        field(_footer, 'Receipt footer', 'receipt_footer',
            maxLength: 200, helper: p.plan.brandedReceipts ? 'Printed at the bottom of every receipt.' : 'Shown on receipts with the Starter or Business plan.'),
        const SizedBox(height: 16),
        BusyButton(label: 'Save', busy: _busy, onPressed: _save),
        const SectionHeader('Images', padding: EdgeInsets.fromLTRB(0, 28, 0, 8)),
        _ImageTile(kind: 'logo', title: 'Shop logo', has: p.hasLogo, hint: p.plan.brandedReceipts ? 'Shown on receipts' : 'Shown on receipts with Starter or Business'),
        const SizedBox(height: 10),
        _ImageTile(kind: 'qr', title: 'Bank QR image', has: p.hasQrImage, hint: 'Shown on the My QR screen'),
        const SizedBox(height: 32),
      ]),
    );
  }
}

class _ImageTile extends ConsumerStatefulWidget {
  const _ImageTile({required this.kind, required this.title, required this.has, required this.hint});
  final String kind;
  final String title;
  final bool has;
  final String hint;

  @override
  ConsumerState<_ImageTile> createState() => _ImageTileState();
}

class _ImageTileState extends ConsumerState<_ImageTile> {
  bool _busy = false;

  Future<void> _pick() async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose from gallery'), onTap: () => Navigator.pop(ctx, ImageSource.gallery)),
          ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.pop(ctx, ImageSource.camera)),
        ]),
      ),
    );
    if (source == null) return;
    final XFile? file;
    try {
      file = await ImagePicker().pickImage(source: source, maxWidth: 1600, maxHeight: 1600);
    } catch (e) {
      if (mounted) showSnack(context, 'Couldn’t open the ${source == ImageSource.camera ? 'camera' : 'gallery'}. Check app permissions.', error: true);
      return;
    }
    if (file == null) return;
    final size = await File(file.path).length();
    if (size > 2 * 1024 * 1024) {
      if (mounted) showSnack(context, 'The image can be at most 2 MB', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(agentRepositoryProvider).uploadImage(widget.kind, file.path, filename: file.name);
      ref.invalidate(profileProvider);
      ref.invalidate(shopImageProvider(widget.kind));
      if (mounted) showSnack(context, '${widget.title} uploaded');
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove() async {
    final ok = await confirmDialog(context, title: 'Remove ${widget.title.toLowerCase()}?', confirmLabel: 'Remove', destructive: true);
    if (!ok) return;
    setState(() => _busy = true);
    try {
      await ref.read(agentRepositoryProvider).removeImage(widget.kind);
      ref.invalidate(profileProvider);
      ref.invalidate(shopImageProvider(widget.kind));
    } catch (e) {
      if (mounted) showErrorSnack(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    Widget preview;
    if (widget.has) {
      final img = ref.watch(shopImageProvider(widget.kind));
      preview = img.when(
        data: (b) => Image.memory(b, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined)),
        loading: () => const Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
        error: (_, _) => const Icon(Icons.broken_image_outlined),
      );
    } else {
      preview = Icon(widget.kind == 'qr' ? Icons.qr_code_2 : Icons.image_outlined, color: t.colorScheme.outline);
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Container(width: 64, height: 64, color: t.colorScheme.surfaceContainerHighest, child: preview),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.title, style: t.textTheme.titleSmall),
              Text(widget.hint, style: t.textTheme.bodySmall),
              const Text('PNG, JPEG or WebP, up to 2 MB', style: TextStyle(fontSize: 11)),
            ]),
          ),
          if (_busy)
            const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))
          else ...[
            IconButton(tooltip: widget.has ? 'Replace' : 'Upload', onPressed: _pick, icon: Icon(widget.has ? Icons.swap_horiz : Icons.upload_outlined)),
            if (widget.has) IconButton(tooltip: 'Remove', onPressed: _remove, icon: const Icon(Icons.delete_outline)),
          ],
        ]),
      ),
    );
  }
}
