# Pay2All Agent (Flutter)

The counter app for **agents** (customer service points) on Pay2All: record money transfers, cash
withdrawals/deposits, bill payments and recharges, hand out receipts, see the day's cash position,
reports, staff logins, plan billing and Google Drive backup. Product rules and the API contract are in
[`docs/AGENTS.md`](../../docs/AGENTS.md). Nothing in the app moves money.

- Android (applicationId `in.co.twoall.pay2all_agent`) and iOS. Flutter 3.47 / Dart 3.13.
- State: Riverpod 3 · routing: go_router · HTTP: dio · receipts: `pdf` + `printing`.

## Run

```bash
cd apps/mobile
flutter pub get
flutter run --dart-define=API_BASE_URL=https://py.2all.co.in      # default if omitted
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000       # local API from the Android emulator*
```

\* Release builds only allow HTTPS (`usesCleartextTraffic="false"`). For a plain-HTTP local API on a
debug build, add `android:usesCleartextTraffic="true"` to `android/app/src/debug/AndroidManifest.xml`
(don't commit it), or use an HTTPS tunnel.

The public receipt link (`public_url`) and logo paths come from the API; nothing web-related is
hard-coded.

## Checks

```bash
flutter analyze
flutter test
flutter build apk --debug
```

## Release builds (Android)

1. Create an upload keystore once (keep it out of git and backed up safely):

   ```bash
   keytool -genkey -v -keystore ~/keys/pay2all-agent-upload.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias upload
   ```

2. Create `apps/mobile/android/key.properties` (git-ignored, together with `*.jks` / `*.keystore`):

   ```properties
   storePassword=<keystore password>
   keyPassword=<key password>
   keyAlias=upload
   storeFile=/Users/<you>/keys/pay2all-agent-upload.jks
   ```

   `android/app/build.gradle.kts` signs release builds with it when the file exists, and falls back
   to the debug key otherwise (fine for local testing, never for the Play Store).

3. Build, with the production API:

   ```bash
   flutter build appbundle --release --dart-define=API_BASE_URL=https://py.2all.co.in   # Play Store (.aab)
   flutter build apk --release --split-per-abi --dart-define=API_BASE_URL=https://py.2all.co.in   # sideload
   ```

   Bump `version:` in `pubspec.yaml` (`1.2.0+12` = versionName 1.2.0, versionCode 12) for every upload.

In CI, write `key.properties` and the keystore from secrets at build time.

## iOS

- Open `ios/Runner.xcworkspace` in Xcode, set the Team and bundle id (e.g. `in.co.twoall.pay2allAgent`)
  under Signing & Capabilities, then `flutter build ipa --dart-define=API_BASE_URL=…`.
- `Info.plist` already has the camera / photo library usage strings (QR and logo upload) and
  `LSApplicationQueriesSchemes` for `https`, `whatsapp` and `upi`.
- The refresh token lives in the Keychain (`first_unlock_this_device`, not synced to iCloud).
- Not built or tested on a Mac/iOS device as part of this change; run `pod install` via
  `flutter build ios` the first time.

## How it works

```
lib/
  main.dart, app.dart             ProviderScope, MaterialApp.router, light/dark theme
  core/
    config.dart                   API_BASE_URL (dart-define)
    api/api_client.dart           dio client: envelope unwrap, paging, AuthInterceptor (refresh + retry)
    api/api_exception.dart        typed errors: code, message, request_id, fieldErrors from details[]
    auth/token_manager.dart       access token in memory, refresh token in secure storage, single-flight refresh
    auth/session.dart             restore / sign-in / sign-out, /auth/me, agent-only check, permissions
    format/                       money (paise ints, ₹ en-IN), IST dates & report presets, validators
    router.dart, theme.dart, providers.dart, widgets/
  features/
    auth/        login, MFA (TOTP / recovery code), forgot password, sign-up + email code
    home/        dashboard, bottom-navigation shell
    transactions/ list + filters, new entry flow, detail + status change, receipt (PDF / print / share)
    customers/   list, add/edit, detail, beneficiaries, ID reveal
    reports/     presets, totals, by day/type/mode/status, CSV export
    more/        My QR, shop profile & images, staff, plan & billing, Drive backup, about
```

### Sign-in for native apps

- `X-Pay2All-Client: mobile` is sent on every request; the auth endpoints then return
  `refresh_token` in the body.
- The 15-minute access token is kept in memory only. The refresh token is stored with
  `flutter_secure_storage` (Android Keystore / iOS Keychain).
- On a 401, the client calls `POST /v1/auth/mobile/refresh` **once** for all concurrent failures,
  stores the new (rotated) refresh token and retries each request once. If the refresh is rejected,
  the session is cleared and the app returns to the login screen. Offline refreshes keep the session.
- After sign-in, `GET /v1/auth/me` must report an `AGENT` organization. Owner-only screens and
  buttons are hidden based on `permissions[]` (`agent.settings.manage`, `agent.billing.manage`,
  `agent.txn.manage`).
- Passkeys are web-only; the MFA screen offers TOTP and recovery codes.

### Receipts

The PDF is A5 with the shop header (logo when the plan is branded), all receipt lines in IST, totals,
the footer, a QR of the public receipt link and "Powered by …" on unbranded plans. Roboto (Apache
2.0, `assets/fonts`) is embedded because the PDF base fonts have no ₹ glyph; scripts Roboto lacks
(e.g. Devanagari names) would need an extra Noto font.
