// Dynamic part of the Expo config. Everything else lives in app.json.
//
// The Google Maps key is kept out of the repository: app.json carries a
// placeholder, and the real key is read here from the GOOGLE_MAPS_API_KEY
// environment variable when the native project is generated (expo prebuild).
// Without the variable the placeholder stays and the Home map renders blank.
module.exports = ({ config }) => {
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
