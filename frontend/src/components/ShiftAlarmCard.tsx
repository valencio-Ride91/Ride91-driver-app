// Shift alarm — the driver's view of their wake-up alarm.
//
// The hub sets each driver's shift time; the alarm rings an hour before it.
// This card tells the driver, at a glance: is the alarm on, when will it ring,
// and is anything stopping it (an old app build, or notifications switched
// off). "Test the alarm" rings it once so they can hear it for themselves.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, PermissionsAndroid, Platform, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from "react-native";

import { Card } from "@/src/components/ui";
import { formatDuration, formatIST, formatISTTime } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { useShiftAlarm } from "@/src/shift-alarms";
import { alarms } from "@/src/alarms";
import { colors, fonts, radius, spacing } from "@/src/theme";

const LIVE_TINT = "#E3F1EA";
const AMBER_TINT = "#FCF2D9";
const AMBER_INK = "#8A5D00";
const ALERT_TINT = "#F8E4E0";

// Android 13+ needs the driver's permission before the alarm can show.
const NEEDS_NOTIF_PERMISSION = Platform.OS === "android" && Number(Platform.Version) >= 33;

export const ShiftAlarmCard: React.FC<{ style?: ViewStyle }> = ({ style }) => {
  const c = useCardText();
  const { next, refresh, testFireNow, nativeAvailable } = useShiftAlarm();
  const [now, setNow] = useState(() => Date.now());
  const [notifOk, setNotifOk] = useState(true);
  const [exactOk, setExactOk] = useState(true);
  const exactWas = useRef(true);

  // Keep the countdown moving.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Is the alarm allowed to show? Checked on open and again whenever the
  // driver comes back to the app (e.g. from the phone's settings).
  useEffect(() => {
    if (!NEEDS_NOTIF_PERMISSION) return;
    let alive = true;
    const check = () => {
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
        .then((ok) => { if (alive) setNotifOk(ok); })
        .catch(() => {});   // advisory only
    };
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // May the alarm ring at the exact minute? Re-checked whenever the driver
  // comes back to the app, e.g. from the phone's "Alarms & reminders" switch.
  // Once it flips to allowed, re-arm so the alarm becomes the exact kind.
  useEffect(() => {
    let alive = true;
    const check = () => {
      alarms.exactAllowed().then((ok) => {
        if (!alive) return;
        if (ok && !exactWas.current) refresh();
        exactWas.current = ok;
        setExactOk(ok);
      });
    };
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [refresh]);

  const allowNotif = useCallback(async () => {
    try {
      const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (res === PermissionsAndroid.RESULTS.GRANTED) return setNotifOk(true);
      // Refused before: Android won't ask again, so take them to the app's settings.
      if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) await Linking.openSettings();
    } catch {
      // nothing more we can do from here
    }
  }, []);

  const alarmAt = next?.alarm_fires_at ? new Date(next.alarm_fires_at).getTime() : NaN;
  const shiftAt = next?.shift_start ? new Date(next.shift_start).getTime() : NaN;
  const hasAlarm = !!next && !Number.isNaN(alarmAt) && !Number.isNaN(shiftAt);
  const upcoming = hasAlarm && alarmAt > now;          // still to ring
  const hubSet = next?.source === "ops";

  const badge = !nativeAvailable
    ? { text: c.alarm_off, style: styles.badgeOff, textStyle: styles.badgeTextOff }
    : hasAlarm
      ? { text: c.alarm_on, style: styles.badgeOn, textStyle: styles.badgeTextOn }
      : { text: c.alarm_not_set, style: styles.badgeIdle, textStyle: styles.badgeTextIdle };

  return (
    <Card testID="profile-alarm-card" style={style}>
      <View style={styles.head}>
        <Text style={styles.title}>{c.shift_alarm}</Text>
        <View style={[styles.badge, badge.style]} testID="alarm-badge">
          <Text style={[styles.badgeText, badge.textStyle]}>{badge.text}</Text>
        </View>
      </View>

      {hasAlarm ? (
        <View style={styles.summary}>
          <Text style={styles.kicker}>{upcoming ? c.alarm_rings_at : c.alarm_shift_starts}</Text>
          <Text style={styles.hero} testID="alarm-fires-at">
            {formatIST(upcoming ? next!.alarm_fires_at : next!.shift_start)}
          </Text>
          <Text style={styles.sub}>
            {upcoming
              ? `${c.alarm_before_shift(formatISTTime(next!.shift_start))} · ${c.alarm_in(formatDuration(Math.max(0, Math.round((alarmAt - now) / 1000))))}`
              : c.alarm_already_rang}
          </Text>
        </View>
      ) : (
        <View style={styles.summary}>
          <Text style={styles.heroNone} testID="alarm-none">{c.alarm_none}</Text>
          <Text style={styles.sub}>{c.alarm_none_hub}</Text>
        </View>
      )}

      {hubSet ? <Text style={styles.note}>{c.set_by_hub} · {c.hub_sets_time}</Text> : null}

      {!nativeAvailable ? (
        <Text style={[styles.warn, styles.warnAlert]} testID="alarm-unavailable">{c.alarm_unavailable}</Text>
      ) : !notifOk ? (
        <View style={[styles.warnRow, styles.warnAmber]} testID="alarm-notif-off">
          <Text style={styles.warnRowText}>{c.alarm_notif_off}</Text>
          <TouchableOpacity style={styles.allowBtn} onPress={allowNotif} testID="alarm-allow-notif">
            <Text style={styles.allowBtnText}>{c.alarm_allow}</Text>
          </TouchableOpacity>
        </View>
      ) : !exactOk ? (
        <View style={[styles.warnRow, styles.warnAmber]} testID="alarm-exact-off">
          <Text style={styles.warnRowText}>{c.alarm_exact_off}</Text>
          <TouchableOpacity style={styles.allowBtn} onPress={() => alarms.openExactSettings()} testID="alarm-allow-exact">
            <Text style={styles.allowBtnText}>{c.alarm_allow}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {nativeAvailable ? (
        <>
          <TouchableOpacity style={styles.testBtn} onPress={() => testFireNow()} testID="alarm-test-btn">
            <Text style={styles.testBtnText}>{c.alarm_test}</Text>
          </TouchableOpacity>
          <Text style={styles.testNote}>{c.alarm_test_note}</Text>
        </>
      ) : null}

      <TouchableOpacity style={styles.refresh} onPress={refresh} testID="alarm-refresh-btn">
        <Text style={styles.refreshText}>{c.refresh}</Text>
      </TouchableOpacity>
    </Card>
  );
};

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeOn: { backgroundColor: LIVE_TINT },
  badgeOff: { backgroundColor: ALERT_TINT },
  badgeIdle: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 0.4 },
  badgeTextOn: { color: colors.live },
  badgeTextOff: { color: colors.alert },
  badgeTextIdle: { color: colors.muted },

  summary: { backgroundColor: colors.paper, borderRadius: radius.md, padding: spacing.md },
  kicker: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.8 },
  hero: { fontFamily: fonts.dataMed, fontSize: 24, color: colors.ink, marginTop: 2 },
  heroNone: { fontFamily: fonts.uiBold, fontSize: 18, color: colors.muted },
  sub: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, marginTop: 4, lineHeight: 19 },
  note: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: spacing.sm, lineHeight: 17 },

  warn: {
    fontFamily: fonts.uiMed, fontSize: 13, borderRadius: radius.md, overflow: "hidden",
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.sm, lineHeight: 19,
  },
  warnAlert: { backgroundColor: ALERT_TINT, color: colors.alert },
  warnRow: {
    flexDirection: "row", alignItems: "center", borderRadius: radius.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.sm,
  },
  warnAmber: { backgroundColor: AMBER_TINT },
  warnRowText: { flex: 1, fontFamily: fonts.uiMed, fontSize: 13, color: AMBER_INK, lineHeight: 19, paddingRight: spacing.sm },
  allowBtn: { backgroundColor: AMBER_INK, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 12 },
  allowBtnText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.white },

  testBtn: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
    paddingVertical: 12, alignItems: "center", marginTop: spacing.md,
  },
  testBtnText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 14 },
  testNote: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 6, textAlign: "center" },
  refresh: { paddingVertical: 10, alignItems: "center", marginTop: 2 },
  refreshText: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
});
