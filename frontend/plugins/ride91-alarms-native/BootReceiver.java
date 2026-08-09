package com.ride91.alarms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Reschedules the pending shift alarm when the phone reboots.
 * Actual rescheduling happens on the JS side (which reads /shift-alarm/next
 * and calls Ride91Alarms.schedule again). Here we just start the app so the
 * JS thread runs — Android launches the main launcher activity indirectly.
 * Registered in AndroidManifest with the BOOT_COMPLETED intent-filter.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String a = intent.getAction();
        if (!"android.intent.action.BOOT_COMPLETED".equals(a)) return;
        // Cold-start the main activity in the background so RN can re-arm.
        // Users tapping the launcher will hit the arming code on init anyway;
        // this receiver is a best-effort — do nothing dangerous here.
        try {
            Intent launch = ctx.getPackageManager()
                    .getLaunchIntentForPackage(ctx.getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(launch);
            }
        } catch (Throwable ignored) {}
    }
}
