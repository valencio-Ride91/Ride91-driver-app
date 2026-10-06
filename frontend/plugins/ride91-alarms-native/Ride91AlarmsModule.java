package com.ride91.alarms;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native bridge for the mandatory shift alarm.
 *  - schedule(atMs, meta): AlarmManager.setAlarmClock so it survives Doze.
 *  - cancel(scheduleId): cancels a pending alarm.
 *  - fireNow(meta): fires the alarm right now for testing.
 *  - drainPending(): hands JS every response the driver has given since it
 *    last asked, and forgets them.
 *
 * The alarm usually fires while the app is not running (a wake-up alarm an
 * hour before the shift), so a response cannot simply be emitted to JS - there
 * may be no JS to hear it. Every response is therefore first written to
 * SharedPreferences; the event is only a nudge to come and collect. JS drains
 * on start-up, on returning to the foreground, and on the nudge, then posts
 * each response to /api/shift-alarm/response.
 */
public class Ride91AlarmsModule extends ReactContextBaseJavaModule {
    public static final String NAME = "Ride91Alarms";
    static final String EXTRA_SCHEDULE_ID = "scheduleId";
    static final String EXTRA_DRIVER_ID = "driverId";
    static final String EXTRA_TITLE = "title";
    // "hi" when the driver uses the app in Hindi; the alarm screen follows it.
    static final String EXTRA_LANG = "lang";
    static final String EVENT_RESPONSE = "Ride91AlarmResponse";

    private static final String PREFS = "ride91_alarms";
    private static final String KEY_PENDING = "pending_responses";
    private static final Object LOCK = new Object();

    private static ReactApplicationContext currentReactContext;

    public Ride91AlarmsModule(ReactApplicationContext ctx) {
        super(ctx);
        currentReactContext = ctx;
    }

    @Override
    public String getName() {
        return NAME;
    }

    /** Record a response durably, then nudge JS if it happens to be running. */
    public static void emitResponse(Context ctx, String scheduleId, String response, String reasonCode,
                                    long firedAt, long respondedAt) {
        try {
            JSONObject o = new JSONObject();
            o.put("scheduleId", scheduleId);
            o.put("response", response);
            o.put("reasonCode", reasonCode == null ? JSONObject.NULL : reasonCode);
            o.put("firedAt", firedAt);
            o.put("respondedAt", respondedAt);
            synchronized (LOCK) {
                SharedPreferences sp = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                JSONArray arr = new JSONArray(sp.getString(KEY_PENDING, "[]"));
                arr.put(o);
                // commit(), not apply(): the process may be killed right after the alarm screen closes.
                sp.edit().putString(KEY_PENDING, arr.toString()).commit();
            }
        } catch (Throwable ignored) {
            // A response we cannot store is lost; nothing more useful to do on the alarm screen.
        }
        try {
            ReactApplicationContext rc = currentReactContext;
            if (rc != null && rc.hasActiveReactInstance()) {
                rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                        .emit(EVENT_RESPONSE, Arguments.createMap());
            }
        } catch (Throwable ignored) {
            // JS not reachable - it will drain on its next start.
        }
    }

    private static PendingIntent pending(Context ctx, String scheduleId, String driverId, String title, String lang) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.putExtra(EXTRA_SCHEDULE_ID, scheduleId);
        i.putExtra(EXTRA_DRIVER_ID, driverId);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_LANG, lang);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, scheduleId.hashCode(), i, flags);
    }

    @ReactMethod
    public void schedule(double atMs, ReadableMap meta, Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            String scheduleId = meta.hasKey("scheduleId") ? meta.getString("scheduleId") : "default";
            String driverId = meta.hasKey("driverId") ? meta.getString("driverId") : "";
            String title = meta.hasKey("title") ? meta.getString("title") : "Shift starts in 1 hour";
            String lang = meta.hasKey("lang") ? meta.getString("lang") : "en";
            PendingIntent pi = pending(ctx, scheduleId, driverId, title, lang);
            AlarmManager.AlarmClockInfo info = new AlarmManager.AlarmClockInfo((long) atMs, pi);
            am.setAlarmClock(info, pi);
            promise.resolve(scheduleId);
        } catch (Throwable t) {
            promise.reject("schedule_failed", t.getMessage(), t);
        }
    }

    @ReactMethod
    public void cancel(String scheduleId, Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            am.cancel(pending(ctx, scheduleId, "", "", "en"));
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("cancel_failed", t.getMessage(), t);
        }
    }

    @ReactMethod
    public void fireNow(ReadableMap meta, Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            Intent i = new Intent(ctx, AlarmReceiver.class);
            i.putExtra(EXTRA_SCHEDULE_ID, meta.hasKey("scheduleId") ? meta.getString("scheduleId") : "test");
            i.putExtra(EXTRA_DRIVER_ID, meta.hasKey("driverId") ? meta.getString("driverId") : "");
            i.putExtra(EXTRA_TITLE, meta.hasKey("title") ? meta.getString("title") : "Test alarm");
            i.putExtra(EXTRA_LANG, meta.hasKey("lang") ? meta.getString("lang") : "en");
            ctx.sendBroadcast(i);
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("fire_failed", t.getMessage(), t);
        }
    }

    /** Resolve with a JSON array of the stored responses and clear the store. */
    @ReactMethod
    public void drainPending(Promise promise) {
        try {
            String json;
            synchronized (LOCK) {
                SharedPreferences sp = getReactApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                json = sp.getString(KEY_PENDING, "[]");
                sp.edit().remove(KEY_PENDING).commit();
            }
            promise.resolve(json);
        } catch (Throwable t) {
            promise.reject("drain_failed", t.getMessage(), t);
        }
    }

    // Boilerplate for RN native module event emitter (required on RN 0.65+).
    @ReactMethod public void addListener(String eventName) {}
    @ReactMethod public void removeListeners(Integer count) {}
}
