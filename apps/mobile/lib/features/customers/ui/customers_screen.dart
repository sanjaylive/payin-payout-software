import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/session.dart';
import '../../../core/format/dates.dart';
import '../../../core/providers.dart';
import '../../../core/widgets/common.dart';
import '../../../core/widgets/paged_list.dart';
import '../../auth/data/auth_models.dart';
import '../data/customer_models.dart';

class CustomersScreen extends ConsumerStatefulWidget {
  const CustomersScreen({super.key});

  @override
  ConsumerState<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends ConsumerState<CustomersScreen> {
  String _query = '';
  late final PagedController<Customer> _paged = PagedController(_fetcher(''));
  final _search = TextEditingController();
  Timer? _debounce;

  PageFetcher<Customer> _fetcher(String q) => (cursor) => ref.read(customersRepositoryProvider).list(search: q, cursor: cursor);

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _paged.dispose();
    super.dispose();
  }

  void _onSearch(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      if (q.trim() == _query) return;
      _query = q.trim();
      _paged.reset(_fetcher(_query));
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(customerRevisionProvider, (_, _) => _paged.refresh());
    final canWrite = ref.watch(sessionProvider).can(Perm.deskWrite);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Customers'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(64),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
            child: TextField(
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: 'Search name or mobile',
                prefixIcon: const Icon(Icons.search),
                isDense: true,
                suffixIcon: ListenableBuilder(
                  listenable: _search,
                  builder: (_, _) => _search.text.isEmpty
                      ? const SizedBox.shrink()
                      : IconButton(
                          icon: const Icon(Icons.clear),
                          onPressed: () {
                            _search.clear();
                            _onSearch('');
                          },
                        ),
                ),
              ),
            ),
          ),
        ),
      ),
      floatingActionButton: canWrite
          ? FloatingActionButton.extended(onPressed: () => context.push('/customer/new'), icon: const Icon(Icons.person_add_alt_1), label: const Text('Add'))
          : null,
      body: PagedListView<Customer>(
        controller: _paged,
        itemBuilder: (context, c) => ListTile(
          leading: CircleAvatar(child: Text(c.initials)),
          title: Text(c.name, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text([c.mobile, if (c.city != null) c.city!].join(' · ')),
          trailing: c.createdAt == null ? null : Text(Ist.formatDate(c.createdAt), style: Theme.of(context).textTheme.labelSmall),
          onTap: () => context.push('/customer/${c.id}'),
        ),
        empty: EmptyView(
          icon: Icons.people_outline,
          title: _query.isEmpty ? 'No customers yet' : 'No match for “$_query”',
          message: _query.isEmpty ? 'Customers are saved when you record a transfer, or add one here.' : null,
        ),
      ),
    );
  }
}
