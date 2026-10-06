package com.ride91.alarms;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.Spinner;
import android.widget.TextView;

/**
 * Full-screen mandatory alarm UI, shown over the lock screen.
 *
 * Start alarm (an hour before the shift): "Awake" or "Not coming" (which
 * reveals the required reason dropdown). End alarm (schedule id ends "-end"):
 * "Heading back to hub" or "Running late". One snooze either way.
 *
 * It rings on the alarm stream and vibrates until the driver answers, or for
 * RING_LIMIT_MS at most. The answer is stored by Ride91AlarmsModule so it
 * reaches the server even if the app was not running.
 */
public class AlarmActivity extends Activity {
    private static final String[] REASON_CODES = {
            "unwell", "family_emergency", "vehicle_problem",
            "transport_problem", "personal", "other"
    };
    private static final String[] REASON_LABELS = {
            "Unwell", "Family emergency", "Vehicle problem",
            "Transport problem", "Personal", "Other"
    };
    // Hindi (same order as REASON_CODES), shown when the app language is Hindi.
    private static final String[] REASON_LABELS_HI = {
            "\u0924\u092c\u0940\u092f\u0924 \u0920\u0940\u0915 \u0928\u0939\u0940\u0902", "\u0918\u0930 \u092e\u0947\u0902 \u0907\u092e\u0930\u091c\u0947\u0902\u0938\u0940", "\u0917\u093e\u0921\u093c\u0940 \u092e\u0947\u0902 \u0926\u093f\u0915\u093c\u094d\u0915\u093c\u0924",
            "\u0906\u0928\u0947 \u0915\u093e \u0938\u093e\u0927\u0928 \u0928\u0939\u0940\u0902", "\u0928\u093f\u091c\u0940 \u0915\u093e\u0930\u0923", "\u0905\u0928\u094d\u092f"
    };
    private static final long SNOOZE_MS = 10 * 60 * 1000L;
    private static final long RING_LIMIT_MS = 5 * 60 * 1000L;

    private String scheduleId;
    private long firedAt;
    private int snoozeCount = 0;

    private MediaPlayer player;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ringTimeout = this::stopRinging;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // Wake screen, show above lock screen.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        int layoutId = getResources().getIdentifier("activity_alarm", "layout", getPackageName());
        setContentView(layoutId);

        scheduleId = getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_SCHEDULE_ID);
        if (scheduleId == null) scheduleId = "unknown";
        firedAt = getIntent().getLongExtra("firedAt", System.currentTimeMillis());
        snoozeCount = b != null ? b.getInt("snoozes", 0) : 0;
        final boolean hi = "hi".equals(getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_LANG));
        final boolean isEnd = scheduleId.endsWith("-end");

        TextView kicker = findViewById(id("alarm_kicker"));
        TextView title = findViewById(id("alarm_title"));
        Spinner spinner = findViewById(id("reason_spinner"));
        Button first = findViewById(id("btn_awake"));
        Button second = findViewById(id("btn_not_coming"));
        Button confirm = findViewById(id("btn_confirm"));
        Button snooze = findViewById(id("btn_snooze"));

        String t = getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_TITLE);
        if (t == null) {
            t = isEnd
                    ? (hi ? "\u0936\u093f\u092b\u093c\u094d\u091f \u0916\u093c\u0924\u094d\u092e \u0939\u094b\u0928\u0947 \u0935\u093e\u0932\u0940 \u0939\u0948 \u2014 \u0939\u092c \u0932\u094c\u091f\u0947\u0902" : "Shift ends soon \u2014 head back to hub")
                    : (hi ? "1 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902 \u0936\u093f\u092b\u093c\u094d\u091f \u0936\u0941\u0930\u0942 \u0939\u094b\u0917\u0940" : "Shift starts in 1 hour");
        }
        title.setText(t);
        if (kicker != null) {
            kicker.setText(isEnd
                    ? (hi ? "RIDE91 \u00b7 \u0936\u093f\u092b\u093c\u094d\u091f \u0916\u093c\u0924\u094d\u092e \u0915\u093e \u0905\u0932\u093e\u0930\u094d\u092e" : "RIDE91 \u00b7 SHIFT END ALARM")
                    : (hi ? "RIDE91 \u00b7 \u0936\u093f\u092b\u093c\u094d\u091f \u0905\u0932\u093e\u0930\u094d\u092e" : "RIDE91 \u00b7 SHIFT ALARM"));
        }

        spinner.setAdapter(new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item, hi ? REASON_LABELS_HI : REASON_LABELS));
        spinner.setVisibility(View.GONE);
        confirm.setVisibility(View.GONE);
        confirm.setText(hi ? "\u092a\u0915\u094d\u0915\u093e \u0915\u0930\u0947\u0902 \u2014 \u0928\u0939\u0940\u0902 \u0906 \u0930\u0939\u093e" : "Confirm \u2014 not coming");
        snooze.setText(hi ? "10 \u092e\u093f\u0928\u091f \u092c\u093e\u0926 \u092b\u093f\u0930 \u092c\u091c\u093e\u090f\u0901 (\u090f\u0915 \u092c\u093e\u0930)" : "Snooze 10 minutes (once)");
        if (snoozeCount >= 1) snooze.setVisibility(View.GONE);

        if (isEnd) {
            first.setText(hi ? "\u0905\u092d\u0940 \u0939\u092c \u0932\u094c\u091f \u0930\u0939\u093e \u0939\u0942\u0901" : "Heading back to hub now");
            second.setText(hi ? "\u0926\u0947\u0930 \u0939\u094b \u0930\u0939\u0940 \u0939\u0948 \u2014 \u0911\u092b\u093c\u093f\u0938 \u0915\u094b \u092c\u0924\u093e\u090f\u0901" : "Running late \u2014 inform dispatch");
            first.setOnClickListener(v -> respond("heading_back", null));
            second.setOnClickListener(v -> respond("delayed", null));
        } else {
            first.setText(hi ? "\u091c\u093e\u0917 \u0917\u092f\u093e \u0939\u0942\u0901, \u0921\u094d\u092f\u0942\u091f\u0940 \u092a\u0930 \u0906 \u0930\u0939\u093e \u0939\u0942\u0901" : "Awake and coming for duty");
            second.setText(hi ? "\u0928\u0939\u0940\u0902 \u0906 \u0930\u0939\u093e" : "Not coming");
            first.setOnClickListener(v -> respond("awake", null));
            second.setOnClickListener(v -> {
                // The driver is clearly awake now; stop the noise while they pick a reason.
                stopRinging();
                spinner.setVisibility(View.VISIBLE);
                confirm.setVisibility(View.VISIBLE);
                first.setVisibility(View.GONE);
                second.setVisibility(View.GONE);
                snooze.setVisibility(View.GONE);
            });
            confirm.setOnClickListener(v ->
                    respond("not_coming", REASON_CODES[spinner.getSelectedItemPosition()]));
        }

        snooze.setOnClickListener(v -> {
            if (snoozeCount >= 1) return;
            // Ring again in 10 minutes; the new alarm remembers a snooze was used.
            try {
                android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
                Intent i = new Intent(this, AlarmReceiver.class);
                i.putExtras(getIntent());
                i.putExtra("snoozes", snoozeCount + 1);
                int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
                android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(this,
                        (scheduleId + "-snooze").hashCode(), i, flags);
                am.setAlarmClock(new android.app.AlarmManager.AlarmClockInfo(
                        System.currentTimeMillis() + SNOOZE_MS, pi), pi);
            } catch (Throwable ignored) {
                // Could not re-arm (e.g. exact alarms disallowed); still record the snooze below.
            }
            respond("snooze", null);
        });

        if (b == null) snoozeCount = getIntent().getIntExtra("snoozes", snoozeCount);
        if (snoozeCount >= 1) snooze.setVisibility(View.GONE);

        startRinging();
    }

    private int id(String name) {
        return getResources().getIdentifier(name, "id", getPackageName());
    }

    /** Loop the phone's alarm sound on the alarm stream and vibrate. */
    private void startRinging() {
        stopRinging();
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (uri != null) {
                MediaPlayer p = new MediaPlayer();
                p.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                p.setDataSource(this, uri);
                p.setLooping(true);
                p.prepare();
                p.start();
                player = p;
            }
        } catch (Throwable ignored) {
            // No sound available; vibration and the screen still alert the driver.
        }
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 800, 700};
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Throwable ignored) {
            // Vibration is best-effort.
        }
        handler.postDelayed(ringTimeout, RING_LIMIT_MS);
    }

    private void stopRinging() {
        handler.removeCallbacks(ringTimeout);
        try {
            if (player != null) {
                player.stop();
                player.release();
            }
        } catch (Throwable ignored) {
            // Already stopped.
        }
        player = null;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Throwable ignored) {
            // Nothing to cancel.
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putInt("snoozes", snoozeCount);
    }

    @Override
    protected void onDestroy() {
        stopRinging();
        super.onDestroy();
    }

    private void respond(String response, String reasonCode) {
        Ride91AlarmsModule.emitResponse(this, scheduleId, response, reasonCode, firedAt, System.currentTimeMillis());
        finishAndDismiss();
    }

    private void finishAndDismiss() {
        stopRinging();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(AlarmReceiver.NOTIF_ID);
        finish();
    }

    @Override
    public void onBackPressed() {
        // Not dismissible via back. The driver must pick a response.
    }
}
