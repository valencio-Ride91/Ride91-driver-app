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
| **Google Maps API key** | ❌ placeholder | `app.json → android.config.googleMaps.apiKey` is `REPLACE_WITH_GOOGLE_MAPS_API_KEY`. The Home map is blank until a real key is set, restricted to this package + the release signing SHA-1. |
| **Privacy policy URL** | ❌ needed | Play requires one for an app that collects location + camera. Host a page and enter it in the Play data-safety form. |
| **Backend deployed** | ❌ not live | `fleet-mobile-16` does not yet have the bookings / dashboard / QR-deposit / cash-model / charging endpoints. Deploy the backend (separate task) or the app will hit 404s. |

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

- Real Google Maps key.
- Privacy policy page + Data safety form.
- Backend deploy of the current patches to `fleet-mobile-16`.
- Play service-account JSON for automated `eas submit`.
- App icon / feature graphic review for the store listing (internal track needs
  minimal, but the icon should be final before wider rollout).
