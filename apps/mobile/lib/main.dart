import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    final text = await rootBundle.loadString('assets/fonts/Roboto_LICENSE.txt');
    yield LicenseEntryWithLineBreaks(const ['Roboto (receipt PDF font)'], text);
  });
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp, DeviceOrientation.portraitDown]);
  runApp(
    // Show errors right away (with a Retry button) instead of Riverpod's automatic retries.
    ProviderScope(retry: (_, _) => null, child: const Pay2AllAgentApp()),
  );
}
