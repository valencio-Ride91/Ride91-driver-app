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
    // SCHEDULE_EXACT_ALARM only. USE_EXACT_ALARM is reserved by Google Play
    // for alarm-clock and calendar apps; the native module copes when the
    // driver has not allowed exact alarms (see Ride91AlarmsModule.setAlarm).
    const perms = [
      "android.permission.SCHEDULE_EXACT_ALARM",
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
    // Register the package. The template has changed shape over Expo SDKs:
    //   current:  PackageList(this).packages.apply { ... }
    //   older:    val packages = PackageList(this).packages
    if (!contents.includes("Ride91AlarmsPackage()")) {
      if (/PackageList\(this\)\.packages\.apply\s*\{[^\n]*\n/.test(contents)) {
        contents = contents.replace(
          /(PackageList\(this\)\.packages\.apply\s*\{[^\n]*\n)/,
          `$1          add(Ride91AlarmsPackage())\n`,
        );
      } else {
        contents = contents.replace(
          /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
          `$1        packages.add(Ride91AlarmsPackage())\n`,
        );
      }
    }
    // Fail the build rather than ship an app whose wake-up alarm silently
    // isn't there (which is what an unmatched template used to produce).
    if (!contents.includes("Ride91AlarmsPackage()")) {
      throw new Error(
        "withRide91Alarms: could not register Ride91AlarmsPackage in MainApplication — the template changed; update plugins/withRide91Alarms.js.",
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
