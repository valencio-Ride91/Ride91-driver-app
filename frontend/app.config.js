// Dynamic part of the Expo config. Everything else lives in app.json.
//
// This one project builds two apps:
//
//   (default)         Ride91 Driver   com.ride91.driver   routes in ./app
//   APP_VARIANT=hub   Ride91 Hub      com.ride91.hub      routes in ./hub-app
//
// The hub manager's app shares the design, text helpers and API code in ./src
// but few of the driver app's phone features: it uses the camera (photos of a
// car at shift change) and asks for no location, no microphone and no alarms.
// Its map of the hub's drivers is Google Maps, like the driver app's, so it
// needs the same Maps key. Set APP_VARIANT=hub for BOTH `expo prebuild` and the Gradle
// build (the JS bundle is made during the Gradle build and picks its routes
// folder from this file).
//
// The Google Maps key is kept out of the repository: app.json carries a
// placeholder, and the real key is read from the GOOGLE_MAPS_API_KEY
// environment variable when the native project is generated (expo prebuild).
// Without the variable the placeholder stays and the maps render blank. The
// key must list each app it is used by (package name + signing SHA-1).

const HUB_BLOCKED_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_LOCATION",
  "android.permission.RECORD_AUDIO",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.USE_FULL_SCREEN_INTENT",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.POST_NOTIFICATIONS",
];

function hubVariant(config) {
  const splash = (config.plugins || []).find((p) => Array.isArray(p) && p[0] === "expo-splash-screen");
  return {
    ...config,
    name: "Ride91 Hub",
    slug: "ride91-hub",
    scheme: "ride91hub",
    ios: { supportsTablet: false, bundleIdentifier: "com.ride91.hub" },
    android: {
      // Same mark as the driver app on a charcoal tile, so the two are easy to
      // tell apart on a phone that has both.
      adaptiveIcon: { ...config.android.adaptiveIcon, backgroundColor: "#434343" },
      package: "com.ride91.hub",
      versionCode: config.android.versionCode,
      // Carries the Maps key placeholder; the real key is set below.
      config: config.android.config,
      permissions: ["CAMERA"],
      blockedPermissions: [...(config.android.blockedPermissions || []), ...HUB_BLOCKED_PERMISSIONS],
    },
    plugins: [
      ["expo-router", { root: "./hub-app" }],
      "expo-secure-store",
      ["expo-image-picker", { cameraPermission: "Take photos of the car at shift change.", photosPermission: false, microphonePermission: false }],
      ...(splash ? [splash] : []),
      "expo-font",
      "expo-status-bar",
    ],
    extra: { ...config.extra, router: { ...((config.extra || {}).router || {}), root: "hub-app" } },
  };
}

module.exports = ({ config }) => {
  const hub = process.env.APP_VARIANT === "hub";
  if (hub) config = hubVariant(config);

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) {
    config.android = {
      ...config.android,
      config: { ...(config.android && config.android.config), googleMaps: { apiKey: key } },
    };
  }
  // Google Play needs a higher versionCode on every upload. Set
  // ANDROID_VERSION_CODE at prebuild to stamp one without editing app.json.
  const code = parseInt(process.env.ANDROID_VERSION_CODE || "", 10);
  if (code > 0) {
    config.android = { ...config.android, versionCode: code };
  }
  return config;
};
