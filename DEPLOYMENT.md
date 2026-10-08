# Ride91 Driver App — Deployment (Google Play, internal track)

Private, employer-issued app. Distributed to drivers through a **Google Play
internal/closed testing track**, not the public store. Builds are produced by
**EAS Build** (Expo cloud) as a signed `.aab`, then submitted to Play.

Why EAS builds rather than local Gradle: the cloud runner sidesteps the Windows
path-length / ABI failures we hit locally, and it manages the upload keystore
for Play App Signing.

---

## One-time decisions (make before the first Play upload — some are permanent)

| Decision | Status | Notes |
|---|---|---|
| **Application ID** | `com.ride91.driver` (set in `app.json`) | **Immutable once uploaded to Play.** Was the Emergent placeholder `com.emergent.fleetmobile.uefjzz`. Confirm you're happy with `com.ride91.driver` before the first upload. |
| **Google Maps API key** | ✅ created, kept out of git | Key "Ride91 driver app maps" in the Ride91 Google Cloud project, restricted to `com.ride91.driver` + the signing SHA-1 and to Maps SDK for Android. `app.json` keeps the placeholder; `app.config.js` reads the real key from the `GOOGLE_MAPS_API_KEY` environment variable at `expo prebuild`. If the app is re-signed (e.g. for Play), add the new SHA-1 to the key. |
| **Privacy policy URL** | ❌ needed | Play requires one for an app that collects location + camera. Host a page and enter it in the Play data-safety form. |
| **Backend deployed** | ✅ live | Cloud Run `ride91-api` (asia-south1). The app's URL is baked in at build time from `EXPO_PUBLIC_BACKEND_URL`. |
| **Release signing key** | ✅ created (Oct 2026) | Upload key `ride91-upload`, kept **outside the repo** on the build machine with its `keystore.properties`. SHA-1 `41:EA:A1:01:D1:0B:62:D5:B2:06:7C:F7:AC:C4:02:95:21:CC:26:85`. Back it up; with Play App Signing a lost upload key can be reset through Play support, but only by the account owner. |

---

## Local release build (how the Play bundle is built today)

The EAS route below still works, but the bundle is currently built locally with
Gradle. Nothing secret is in the repository: the Maps key and the signing
passwords are supplied at build time.

```bash
cd frontend

# 1. Regenerate the native project. Needed after any change to app.json, a
#    config plugin or the alarm's Java sources, and to stamp a new versionCode
#    (Play refuses an upload whose versionCode it has seen before).
GOOGLE_MAPS_API_KEY=<the Maps key> ANDROID_VERSION_CODE=<last + 1> CI=1 \
  npx expo prebuild --platform android --clean --no-install

# 2. Build the signed bundle (.aab). Signing is injected, so the generated
#    build.gradle is left alone.
cd android
EXPO_PUBLIC_BACKEND_URL=<backend url> ./gradlew bundleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.injected.signing.store.file=<path to ride91-upload.jks> \
  -Pandroid.injected.signing.store.password=<from keystore.properties> \
  -Pandroid.injected.signing.key.alias=ride91-upload \
  -Pandroid.injected.signing.key.password=<from keystore.properties>
# -> android/app/build/outputs/bundle/release/app-release.aab
#    (64-bit only: on this Windows machine the 32-bit armeabi-v7a native build
#    fails in ninja, so phones that are 32-bit only cannot install it. EAS
#    cloud builds do not have that limit.)
```

**Maps key and signing.** The Maps key is locked to the app's signing
fingerprints. A build installed from Play is signed by *Google's* app-signing
key, not the upload key, so after the first upload copy the "App signing key
certificate" SHA-1 from Play Console (Setup → App integrity) and add it to the
key, alongside the upload key's SHA-1:

```bash
gcloud services api-keys update <key id> \
  --allowed-application=sha1_fingerprint=<upload SHA-1>,package_name=com.ride91.driver \
  --allowed-application=sha1_fingerprint=<Play app-signing SHA-1>,package_name=com.ride91.driver \
  --api-target=service=maps-android-backend.googleapis.com
```

**Moving from sideloaded APKs.** Earlier APKs were signed with the stock debug
key. Android will not install a differently signed build over them, so each
phone must uninstall the old app once before installing from Play (the driver
signs in again; nothing else is lost).

**What Play will ask about** (declare these in the Play Console):

| Permission | Why the app has it |
|---|---|
| Background location + location foreground service | Live fleet tracking while the driver is signed in. The app shows its own notice (what, why, "even when the app is closed") before Android's prompt. |
| Full-screen intent, exact alarm (`SCHEDULE_EXACT_ALARM`) | The shift wake-up alarm. The driver switches exact alarms on; without it the alarm still rings, possibly a few minutes late. |
| Camera, microphone | The pre-duty inspection photo and walk-around video. |
| Notifications | The alarm and the location-sharing notice. |

Not requested: storage / media access (documents use the system photo picker),
draw-over-other-apps, `USE_EXACT_ALARM`.

---

## Prerequisites (once per machine / account)

```bash
npm install -g eas-cli
eas login                      # your Expo account
cd frontend
eas init                       # creates the EAS project, writes extra.eas.projectId + owner into app.json
```

`eas init` is what makes `appVersionSource: "remote"` work — EAS then owns the
`versionCode` and `autoIncrement` bumps it on every production build.

## Regenerate native project for the new package (local builds only)

EAS cloud builds run a fresh prebuild automatically, so skip this for EAS. For a
local build, the checked-in `android/` still carries the old package:

```bash
cd frontend
npx expo prebuild -p android --clean
```

## Google Maps key

1. Google Cloud console → create an Android-restricted Maps SDK key.
2. Restrict it to package `com.ride91.driver` + the app's SHA-1 (from
   `eas credentials` once the keystore exists).
3. Replace the placeholder in `app.json`.

---

## Build + submit

```bash
cd frontend

# Sideload test build (APK, install directly on a phone)
eas build -p android --profile preview

# Play build (AAB) — production profile, versionCode auto-increments
eas build -p android --profile production

# Upload to the Play internal track (draft)
eas submit -p android --profile production
```

`eas submit` needs a **Google Play service-account JSON** with the
Android Publisher role, configured once. Alternatively upload the `.aab`
by hand in the Play Console the first time.

The backend URL is baked in at build time from `eas.json → build.<profile>.env
→ EXPO_PUBLIC_BACKEND_URL`. Update it there if the backend host changes;
`EXPO_PUBLIC_*` values are embedded in the JS bundle, so a change needs a rebuild.

---

## Play Console (first release)

1. Create the app (private / internal testing).
2. Testing → Internal testing → create a release → upload the `.aab`
   (or via `eas submit`). Play App Signing is offered — accept it.
3. Add testers: a Google Group or a list of driver Google accounts.
4. Complete the required forms: Data safety (location, camera, phone number),
   Content rating, Privacy policy URL, Target audience.
5. Share the internal-testing opt-in link with drivers; they install through Play
   and get updates automatically.

## Updating later

- **JS-only change** (most bug fixes / copy / logic): `eas update --branch production`
  pushes over-the-air — drivers get it on next app open, no reinstall. Works
  because `runtimeVersion.policy = "appVersion"` and the `production` channel.
- **Native change** (new permission, SDK bump, new native module): rebuild the
  AAB and ship a new Play release; bump `version` when `runtimeVersion` must move.

---

## Not done yet (tracked)

- Google Play developer account, and the first upload to the internal testing track.
- After the first upload: add Play's app-signing SHA-1 to the Maps key (see above).
- Privacy policy page + Data safety form + permission declarations.
- A test driver login for Play's reviewers.
- App icon / feature graphic review for the store listing (internal track needs
  minimal, but the icon should be final before wider rollout).
- Make the GitHub repository private and rotate the secrets that were shared in chat.
