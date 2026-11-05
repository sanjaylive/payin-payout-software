/// Build-time configuration.
///
/// `flutter run --dart-define=API_BASE_URL=https://api.example.com`
class AppConfig {
  AppConfig._();

  static const String _rawBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'https://py.2all.co.in');

  /// API origin without a trailing slash, e.g. `https://py.2all.co.in`.
  static String get apiBaseUrl => _rawBaseUrl.replaceAll(RegExp(r'/+$'), '');

  /// Turn an API path (e.g. a receipt's `logo_url`) into an absolute URL.
  static String apiUrl(String pathOrUrl) {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
    return '$apiBaseUrl${pathOrUrl.startsWith('/') ? '' : '/'}$pathOrUrl';
  }

  static const String appName = 'Pay2All Agent';
}
