/// Null-tolerant readers for API JSON. A missing or mistyped field never throws; it falls back.
typedef Json = Map<String, dynamic>;

Json asJson(Object? v) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.map((k, val) => MapEntry(k.toString(), val));
  return <String, dynamic>{};
}

/// Null for null/missing, otherwise the value as a string ('' stays '').
String? jStrOrNull(Json j, String key) {
  final v = j[key];
  if (v == null) return null;
  return v.toString();
}

/// Null for null/missing/blank.
String? jText(Json j, String key) {
  final v = jStrOrNull(j, key)?.trim();
  return (v == null || v.isEmpty) ? null : v;
}

String jStr(Json j, String key, [String fallback = '']) => jStrOrNull(j, key) ?? fallback;

int jInt(Json j, String key, [int fallback = 0]) => jIntOrNull(j, key) ?? fallback;

int? jIntOrNull(Json j, String key) {
  final v = j[key];
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v);
  return null;
}

bool jBool(Json j, String key, [bool fallback = false]) {
  final v = j[key];
  if (v is bool) return v;
  if (v is String) return v == 'true';
  if (v is num) return v != 0;
  return fallback;
}

List<T> jList<T>(Json j, String key, T Function(Json) parse) {
  final v = j[key];
  if (v is! List) return <T>[];
  return v.whereType<Map>().map((e) => parse(asJson(e))).toList();
}

List<String> jStrings(Json j, String key) {
  final v = j[key];
  if (v is! List) return const [];
  return v.where((e) => e != null).map((e) => e.toString()).toList();
}

DateTime? jDate(Json j, String key) {
  final v = j[key];
  if (v == null) return null;
  return DateTime.tryParse(v.toString())?.toUtc();
}

Json? jObj(Json j, String key) {
  final v = j[key];
  return v is Map ? asJson(v) : null;
}
