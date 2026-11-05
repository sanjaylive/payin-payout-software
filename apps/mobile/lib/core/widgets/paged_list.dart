import 'package:flutter/material.dart';

import '../api/api_client.dart';
import 'common.dart';

typedef PageFetcher<T> = Future<PageResult<T>> Function(String? cursor);

/// Cursor-paged list state: first page, next pages, refresh, errors.
class PagedController<T> extends ChangeNotifier {
  PagedController(this._fetch);

  PageFetcher<T> _fetch;
  final List<T> items = [];
  String? _cursor;
  bool hasMore = true;
  bool loading = false;
  Object? error;
  int _generation = 0;
  bool _disposed = false;

  bool get isInitialLoading => loading && items.isEmpty;

  /// Replace the fetcher (filters changed) and reload.
  void reset(PageFetcher<T> fetch) {
    _fetch = fetch;
    refresh();
  }

  Future<void> refresh() async {
    _generation++;
    items.clear();
    _cursor = null;
    hasMore = true;
    error = null;
    loading = false;
    await loadMore();
  }

  Future<void> loadMore() async {
    if (loading || !hasMore) return;
    loading = true;
    error = null;
    _notify();
    final gen = _generation;
    try {
      final page = await _fetch(_cursor);
      if (gen != _generation) return;
      items.addAll(page.items);
      _cursor = page.nextCursor;
      hasMore = page.hasMore && page.nextCursor != null;
    } catch (e) {
      if (gen != _generation) return;
      error = e;
    } finally {
      if (gen == _generation) {
        loading = false;
        _notify();
      }
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Infinite list with pull-to-refresh and loading / empty / error states.
class PagedListView<T> extends StatefulWidget {
  const PagedListView({
    super.key,
    required this.controller,
    required this.itemBuilder,
    required this.empty,
    this.header,
    this.padding = const EdgeInsets.only(bottom: 96),
    this.separated = true,
  });

  final PagedController<T> controller;
  final Widget Function(BuildContext, T) itemBuilder;
  final Widget empty;
  final Widget? header;
  final EdgeInsets padding;
  final bool separated;

  @override
  State<PagedListView<T>> createState() => _PagedListViewState<T>();
}

class _PagedListViewState<T> extends State<PagedListView<T>> {
  @override
  void initState() {
    super.initState();
    if (widget.controller.items.isEmpty && !widget.controller.loading) {
      WidgetsBinding.instance.addPostFrameCallback((_) => widget.controller.loadMore());
    }
  }

  bool _onScroll(ScrollNotification n) {
    if (n.metrics.pixels >= n.metrics.maxScrollExtent - 400) widget.controller.loadMore();
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller;
        final header = widget.header;
        Widget body;
        if (c.items.isEmpty) {
          final Widget state;
          if (c.error != null) {
            state = ErrorView(error: c.error!, onRetry: c.refresh);
          } else if (c.loading || c.hasMore) {
            state = const Padding(padding: EdgeInsets.only(top: 48), child: LoadingView());
          } else {
            state = widget.empty;
          }
          body = ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: [?header, Padding(padding: const EdgeInsets.only(top: 24), child: state)],
          );
        } else {
          final extra = (header != null ? 1 : 0);
          final count = c.items.length + extra + 1;
          body = NotificationListener<ScrollNotification>(
            onNotification: _onScroll,
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: widget.padding,
              itemCount: count,
              itemBuilder: (context, i) {
                if (header != null && i == 0) return header;
                final idx = i - extra;
                if (idx == c.items.length) return _footer(c);
                final tile = widget.itemBuilder(context, c.items[idx]);
                if (!widget.separated || idx == c.items.length - 1) return tile;
                return Column(mainAxisSize: MainAxisSize.min, children: [tile, const Divider(indent: 72)]);
              },
            ),
          );
        }
        return RefreshIndicator(onRefresh: c.refresh, child: body);
      },
    );
  }

  Widget _footer(PagedController<T> c) {
    if (c.error != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Center(child: TextButton.icon(onPressed: c.loadMore, icon: const Icon(Icons.refresh), label: const Text('Couldn’t load more. Retry'))),
      );
    }
    if (c.hasMore) {
      if (!c.loading) WidgetsBinding.instance.addPostFrameCallback((_) => c.loadMore());
      return const Padding(padding: EdgeInsets.all(20), child: Center(child: CircularProgressIndicator()));
    }
    return const SizedBox(height: 16);
  }
}
