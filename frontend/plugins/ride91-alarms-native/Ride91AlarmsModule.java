package com.ride91.alarms;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * Native bridge for the mandatory shift alarm.
 *  - schedule(atMs, scheduleId, driverId): AlarmManager.setAlarmClock so it survives Doze.
 *  - cancel(scheduleId): cancels a pending alarm.
 *  - fireNow(scheduleId): fires the alarm right now for testing.
 * The AlarmActivity relays "awake" / "not_coming" / "snooze" responses back
 * to JS via a DeviceEvent so the app can POST them to /api/shift-alarm/response.
 */
public class Ride91AlarmsModule extends ReactContextBaseJavaModule {
    public static final String NAME = "Ride91Alarms";
    static final String EXTRA_SCHEDULE_ID = "scheduleId";
    static final String EXTRA_DRIVER_ID = "driverId";
    static final String EXTRA_TITLE = "title";
    static final String EVENT_RESPONSE = "Ride91AlarmResponse";

    private static ReactApplicationContext currentReactContext;

    public Ride91AlarmsModule(ReactApplicationContext ctx) {
        super(ctx);
        currentReactContext = ctx;
    }

    @Override
    public String getName() {
        return NAME;
    }

    public static void emitResponse(String scheduleId, String response, String reasonCode, String reasonNote, String backBy, long firedAt, long respondedAt) {
        if (currentReactContext == null) return;
        WritableMap m = Arguments.createMap();
        m.putString("scheduleId", scheduleId);
        m.putString("response", response);
        m.putString("reasonCode", reasonCode);
        m.putString("reasonNote", reasonNote);
        m.putString("backBy", backBy);
        m.putDouble("firedAt", firedAt);
        m.putDouble("respondedAt", respondedAt);
        currentReactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(EVENT_RESPONSE, m);
    }

    private static PendingIntent pending(Context ctx, String scheduleId, String driverId, String title) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.putExtra(EXTRA_SCHEDULE_ID, scheduleId);
        i.putExtra(EXTRA_DRIVER_ID, driverId);
        i.putExtra(EXTRA_TITLE, title);
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
            PendingIntent pi = pending(ctx, scheduleId, driverId, title);
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
            am.cancel(pending(ctx, scheduleId, "", ""));
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
            ctx.sendBroadcast(i);
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("fire_failed", t.getMessage(), t);
        }
    }

    // Boilerplate for RN native module event emitter (required on RN 0.65+).
    @ReactMethod public void addListener(String eventName) {}
    @ReactMethod public void removeListeners(Integer count) {}
}
