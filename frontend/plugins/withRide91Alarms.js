/**
 * Expo config plugin that wires the native Ride91Alarms Android module in.
 * Requires a dev-client or production build — NOT compatible with Expo Go.
 *
 * What it does at prebuild time:
 *   1. Adds Android permissions & <receiver>/<activity> declarations.
 *   2. Drops the Java sources under android/app/src/main/java/com/ride91/alarms/.
 *   3. Registers Ride91AlarmsPackage in MainApplication.
 */
const { withAndroidManifest, withDangerousMod, withMainApplication, AndroidConfig } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PACKAGE = "com.ride91.alarms";

const withPermissionsAndComponents = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const manifest = cfg.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    const perms = [
      "android.permission.SCHEDULE_EXACT_ALARM",
      "android.permission.USE_EXACT_ALARM",
      "android.permission.USE_FULL_SCREEN_INTENT",
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.WAKE_LOCK",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.VIBRATE",
    ];
    for (const name of perms) {
      if (!manifest["uses-permission"].some((p) => p.$["android:name"] === name)) {
        manifest["uses-permission"].push({ $: { "android:name": name } });
      }
    }
    app.receiver = app.receiver || [];
    if (!app.receiver.some((r) => r.$["android:name"] === `${PACKAGE}.AlarmReceiver`)) {
      app.receiver.push({
        $: { "android:name": `${PACKAGE}.AlarmReceiver`, "android:exported": "false" },
      });
    }
    if (!app.receiver.some((r) => r.$["android:name"] === `${PACKAGE}.BootReceiver`)) {
      app.receiver.push({
        $: {
          "android:name": `${PACKAGE}.BootReceiver`,
          "android:exported": "true",
          "android:enabled": "true",
        },
        "intent-filter": [{ action: [{ $: { "android:name": "android.intent.action.BOOT_COMPLETED" } }] }],
      });
    }
    app.activity = app.activity || [];
    if (!app.activity.some((a) => a.$["android:name"] === `${PACKAGE}.AlarmActivity`)) {
      app.activity.push({
        $: {
          "android:name": `${PACKAGE}.AlarmActivity`,
          "android:exported": "false",
          "android:showOnLockScreen": "true",
          "android:turnScreenOn": "true",
          "android:launchMode": "singleTop",
          "android:excludeFromRecents": "true",
          "android:taskAffinity": "",
          "android:theme": "@android:style/Theme.Material.NoActionBar.Fullscreen",
        },
      });
    }
    return cfg;
  });
};

const withNativeSources = (config) => {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const dst = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        "com",
        "ride91",
        "alarms",
      );
      fs.mkdirSync(dst, { recursive: true });
      const src = path.join(__dirname, "ride91-alarms-native");
      for (const f of fs.readdirSync(src)) {
        if (f.endsWith(".java")) {
          fs.copyFileSync(path.join(src, f), path.join(dst, f));
        }
      }
      // layout
      const layoutDst = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "layout",
      );
      fs.mkdirSync(layoutDst, { recursive: true });
      fs.copyFileSync(
        path.join(src, "activity_alarm.xml"),
        path.join(layoutDst, "activity_alarm.xml"),
      );
      return cfg;
    },
  ]);
};

const withPackageRegistration = (config) => {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    // Import
    if (!contents.includes(`import ${PACKAGE}.Ride91AlarmsPackage`)) {
      contents = contents.replace(
        /package [^\n]+\n/,
        (m) => `${m}\nimport ${PACKAGE}.Ride91AlarmsPackage\n`,
      );
    }
    // add(Ride91AlarmsPackage())  — inserted in getPackages()
    if (!contents.includes("Ride91AlarmsPackage()")) {
      contents = contents.replace(
        /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
        `$1        packages.add(Ride91AlarmsPackage())\n`,
      );
    }
    cfg.modResults.contents = contents;
    return cfg;
  });
};

module.exports = (config) => {
  config = withPermissionsAndComponents(config);
  config = withNativeSources(config);
  config = withPackageRegistration(config);
  return config;
};
