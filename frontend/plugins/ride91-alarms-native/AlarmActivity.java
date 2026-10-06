package com.ride91.alarms;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.Spinner;
import android.widget.TextView;

/**
 * Full-screen mandatory alarm UI. Two ways out: "Awake" or "Not coming"
 * (which reveals the required reason dropdown). One snooze allowed.
 * On response, emits a DeviceEvent to RN so the JS layer POSTs to backend.
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

    private String scheduleId;
    private long firedAt;
    private int snoozeCount = 0;

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
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }

        int layoutId = getResources().getIdentifier("activity_alarm", "layout", getPackageName());
        setContentView(layoutId);

        scheduleId = getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_SCHEDULE_ID);
        firedAt = getIntent().getLongExtra("firedAt", System.currentTimeMillis());
        snoozeCount = b != null ? b.getInt("snoozes", 0) : 0;

        int titleId = getResources().getIdentifier("alarm_title", "id", getPackageName());
        TextView title = findViewById(titleId);
        String t = getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_TITLE);
        boolean hi = "hi".equals(getIntent().getStringExtra(Ride91AlarmsModule.EXTRA_LANG));
        title.setText(t != null ? t : (hi ? "1 \u0918\u0902\u091f\u0947 \u092e\u0947\u0902 \u0936\u093f\u092b\u093c\u094d\u091f \u0936\u0941\u0930\u0942 \u0939\u094b\u0917\u0940" : "Shift starts in 1 hour"));

        int spinnerId = getResources().getIdentifier("reason_spinner", "id", getPackageName());
        Spinner spinner = findViewById(spinnerId);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item, hi ? REASON_LABELS_HI : REASON_LABELS);
        spinner.setAdapter(adapter);
        spinner.setVisibility(View.GONE);

        int awakeId = getResources().getIdentifier("btn_awake", "id", getPackageName());
        int notComingId = getResources().getIdentifier("btn_not_coming", "id", getPackageName());
        int confirmId = getResources().getIdentifier("btn_confirm", "id", getPackageName());
        int snoozeId = getResources().getIdentifier("btn_snooze", "id", getPackageName());

        Button awake = findViewById(awakeId);
        Button notComing = findViewById(notComingId);
        Button confirm = findViewById(confirmId);
        Button snooze = findViewById(snoozeId);
        confirm.setVisibility(View.GONE);

        // The layout's built-in texts are English; swap them for Hindi.
        if (hi) {
            int kickerId = getResources().getIdentifier("alarm_kicker", "id", getPackageName());
            TextView kicker = findViewById(kickerId);
            if (kicker != null) kicker.setText("RIDE91 \u00b7 \u0936\u093f\u092b\u093c\u094d\u091f \u0905\u0932\u093e\u0930\u094d\u092e");
            awake.setText("\u091c\u093e\u0917 \u0917\u092f\u093e \u0939\u0942\u0901, \u0921\u094d\u092f\u0942\u091f\u0940 \u092a\u0930 \u0906 \u0930\u0939\u093e \u0939\u0942\u0901");
            notComing.setText("\u0928\u0939\u0940\u0902 \u0906 \u0930\u0939\u093e");
            confirm.setText("\u092a\u0915\u094d\u0915\u093e \u0915\u0930\u0947\u0902");
            snooze.setText("10 \u092e\u093f\u0928\u091f \u092c\u093e\u0926 \u092b\u093f\u0930 \u092c\u091c\u093e\u090f\u0901 (\u090f\u0915 \u092c\u093e\u0930)");
        }

        awake.setOnClickListener(v -> respond("awake", null));
        notComing.setOnClickListener(v -> {
            spinner.setVisibility(View.VISIBLE);
            confirm.setVisibility(View.VISIBLE);
            awake.setVisibility(View.GONE);
            notComing.setVisibility(View.GONE);
        });
        confirm.setOnClickListener(v -> {
            String reasonCode = REASON_CODES[spinner.getSelectedItemPosition()];
            respond("not_coming", reasonCode);
        });
        snooze.setOnClickListener(v -> {
            if (snoozeCount >= 1) {
                snooze.setEnabled(false);
                return;
            }
            snoozeCount++;
            respond("snooze", null);
            // Reschedule ourselves 10 minutes out.
            android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(this, AlarmReceiver.class);
            i.putExtras(getIntent());
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(this,
                    (scheduleId + "-snooze").hashCode(), i, flags);
            am.setAlarmClock(new android.app.AlarmManager.AlarmClockInfo(System.currentTimeMillis() + SNOOZE_MS, pi), pi);
            finishAndDismiss();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putInt("snoozes", snoozeCount);
    }

    private void respond(String response, String reasonCode) {
        long respondedAt = System.currentTimeMillis();
        Ride91AlarmsModule.emitResponse(scheduleId, response, reasonCode, null, null, firedAt, respondedAt);
        finishAndDismiss();
    }

    private void finishAndDismiss() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(AlarmReceiver.NOTIF_ID);
        finish();
    }

    @Override
    public void onBackPressed() {
        // Not dismissible via back. The driver must pick a response.
    }
}
