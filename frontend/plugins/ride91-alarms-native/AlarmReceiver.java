package com.ride91.alarms;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Fires when the AlarmManager wakes us. Builds a high-priority notification
 * with a full-screen intent that launches AlarmActivity — this is how Android
 * lifts the app over the lock screen without a push.
 */
public class AlarmReceiver extends BroadcastReceiver {
    static final String CHANNEL_ID = "ride91_shift_alarms";
    static final int NOTIF_ID = 91;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String scheduleId = intent.getStringExtra(Ride91AlarmsModule.EXTRA_SCHEDULE_ID);
        String driverId = intent.getStringExtra(Ride91AlarmsModule.EXTRA_DRIVER_ID);
        String title = intent.getStringExtra(Ride91AlarmsModule.EXTRA_TITLE);
        String lang = intent.getStringExtra(Ride91AlarmsModule.EXTRA_LANG);
        boolean hi = "hi".equals(lang);
        long firedAt = System.currentTimeMillis();

        // Full-screen intent to the alarm UI.
        Intent full = new Intent(ctx, AlarmActivity.class);
        full.putExtra(Ride91AlarmsModule.EXTRA_SCHEDULE_ID, scheduleId);
        full.putExtra(Ride91AlarmsModule.EXTRA_DRIVER_ID, driverId);
        full.putExtra(Ride91AlarmsModule.EXTRA_TITLE, title);
        full.putExtra(Ride91AlarmsModule.EXTRA_LANG, lang);
        full.putExtra("firedAt", firedAt);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent fsi = PendingIntent.getActivity(ctx, scheduleId != null ? scheduleId.hashCode() : 0, full, flags);

        // Channel.
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, hi ? "\u0936\u093f\u092b\u093c\u094d\u091f \u0905\u0932\u093e\u0930\u094d\u092e" : "Shift alarms", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(hi ? "\u0936\u093f\u092b\u093c\u094d\u091f \u0938\u0947 1 \u0918\u0902\u091f\u093e \u092a\u0939\u0932\u0947 \u0915\u093e \u091c\u093c\u0930\u0942\u0930\u0940 \u0905\u0932\u093e\u0930\u094d\u092e" : "Mandatory 1-hour-before-shift alarm");
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle(title != null ? title : (hi ? "1 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902 \u0936\u093f\u092b\u093c\u094d\u091f \u0936\u0941\u0930\u0942 \u0939\u094b\u0917\u0940" : "Shift starts in 1 hour"))
                .setContentText(hi ? "\u091c\u0935\u093e\u092c \u0926\u0947\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u0926\u092c\u093e\u090f\u0901" : "Tap to respond")
                .setSmallIcon(ctx.getApplicationInfo().icon)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fsi, true);

        nm.notify(NOTIF_ID, b.build());
        // Also start the activity directly — safe fallback when the phone is
        // unlocked and awake (full-screen intent won't kick in there).
        try { ctx.startActivity(full); } catch (Throwable ignored) {}
    }
}
