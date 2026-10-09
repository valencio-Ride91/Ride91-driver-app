// One driver: where they stand, call them, set their shift time, take their
// cash, see what they pressed today and where, and talk to them.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { formatDuration, formatINR, formatIST, formatISTTime } from "@/src/i18n";
import { CashSheet, CashTarget } from "@/src/hub/CashSheet";
import { hubApi } from "@/src/hub/session";
import { NotComingSheet } from "@/src/hub/sheets";
import { doing, tagFor } from "@/src/hub/status";
import { useHubText, HubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Icon, useToast } from "@/src/hub/kit";
import { Btn, Empty, SectionTitle, Tag, callPhone, hubStyles } from "@/src/hub/ui";
import { colors, fonts, platformLabels, radius, spacing } from "@/src/theme";

interface Tap {
  id: string | null;
  at: string;
  action: string;
  state: string;
  turned_on: string[];
  turned_off: string[];
  lat: number | null;
  lng: number | null;
  location_source: "tap" | "nearby_ping" | null;
}

interface Note {
  id: string;
  direction: "from_driver" | "to_driver";
  body: string;
  created_at: string;
  read: boolean;
  kind?: "system" | null;
}

const appName = (p: string) => platformLabels[p] ?? p;

function describeTap(e: Tap, t: HubText): string {
  if (t.taps[e.action]) return t.taps[e.action];
  if (e.action === "apps_changed") return [...e.turned_on.map((p) => t.tap_on(appName(p))), ...e.turned_off.map((p) => t.tap_off(appName(p)))].join(", ");
  return t.tap_nothing;
}

export default function DriverPage() {
  const t = useHubText();
  const router = useRouter();
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const { today, refresh } = useHubToday();
  const d = useMemo(() => today?.drivers.find((x) => x.driver_id === id) ?? null, [today, id]);

  const [taps, setTaps] = useState<Tap[] | null>(null);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [shift, setShift] = useState<string | null>(null);     // null = not being edited
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingShift, setSavingShift] = useState(false);
  const [cash, setCash] = useState<CashTarget | null>(null);
  const [notComing, setNotComing] = useState(false);     // the "not coming: why?" sheet
  const [marking, setMarking] = useState(false);

  // Opened from the Inbox (`focus=messages`): go straight to the messages, once
  // they are on the page.
  const scroller = useRef<ScrollView>(null);
  const [threadY, setThreadY] = useState<number | null>(null);
  const jumped = useRef(false);
  useEffect(() => {
    if (focus !== "messages" || threadY == null || notes === null || jumped.current) return;
    jumped.current = true;
    scroller.current?.scrollTo({ y: threadY, animated: false });
  }, [focus, threadY, notes]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [duty, thread] = await Promise.all([
        hubApi.get<{ log?: Tap[] }>(`/admin/drivers/${id}/duty`),
        hubApi.get<{ items: Note[] }>(`/admin/drivers/${id}/notifications`),
      ]);
      setTaps(duty.log ?? []);
      setNotes(thread.items);
      // Opening the page counts as having read what the driver wrote.
      if (thread.items.some((n) => n.direction === "from_driver" && !n.read)) {
        hubApi.post(`/admin/drivers/${id}/notifications/read`).then(refresh).catch(() => {});
      }
    } catch {
      // keep what we had
    }
  }, [id, refresh]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [load]);

  const say = useToast();
  const fail = (m: string) => say(m, "bad");

  // The driver phoned to say they are coming: record it as their answer.
  const markComing = async () => {
    if (marking) return;
    setMarking(true);
    try {
      await hubApi.post(`/admin/drivers/${id}/shift-answer`, { response: "coming" });
      say(t.answer_saved);
      await refresh();
    } catch {
      fail(t.action_fail);
    } finally {
      setMarking(false);
    }
  };

  const saveShift = async () => {
    const v = (shift ?? "").trim();
    if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return fail(t.shift_bad);
    setSavingShift(true);
    try {
      await hubApi.patch(`/admin/drivers/${id}`, { shift_start_time: v });
      setShift(null);
      say(t.shift_saved);
      await refresh();
    } catch {
      fail(t.action_fail);
    } finally {
      setSavingShift(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await hubApi.post(`/admin/drivers/${id}/notifications`, { body });
      setDraft("");
      await Promise.all([load(), refresh()]);
    } catch {
      fail(t.action_fail);
    } finally {
      setSending(false);
    }
  };

  const tag = d ? tagFor(d, t) : null;

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/drivers" as never))} style={styles.back} testID="hub-driver-back">
            <Icon name="chevron-back" size={26} color={colors.ink} />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1} testID="hub-driver-name">{d?.name ?? "—"}</Text>
          {tag ? <Tag tone={tag.tone}>{tag.label}</Tag> : null}
          {d ? <Btn label={t.edit} small kind="ghost" onPress={() => router.push(`/driver-form?id=${d.driver_id}` as never)} testID="hub-driver-edit" /> : null}
        </View>

        <ScrollView ref={scroller} contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled">

          {!d ? <Empty>{t.loading}</Empty> : (
            <>
              <View style={hubStyles.card}>
                <Text style={hubStyles.name}>{doing(d, t)}</Text>
                <Text style={hubStyles.sub}>{d.phone ?? ""}</Text>
                {d.shift_status !== "no_shift_time" && d.shift_status !== "alarm_pending" && !d.on_duty ? (
                  <Text style={hubStyles.subAlert}>
                    {t.status[d.shift_status]}
                    {d.shift_status === "not_coming" && d.reason_code ? ` · ${d.reason_code === "other" && d.reason_note ? d.reason_note : t.reasons[d.reason_code] ?? d.reason_code}` : ""}
                    {d.back_by ? ` · ${t.back_by(d.back_by)}` : ""}
                    {d.answered_by ? ` · ${t.answered_by_hub(d.answered_by)}` : ""}
                  </Text>
                ) : null}
                {d.tracking === "stopped" ? (
                  <Text style={hubStyles.subAlert}>{t.att.tracking_stopped} · {d.tracking_reason === "location_off" ? t.att_location_off : t.att_no_signal}</Text>
                ) : null}
                <View style={styles.actions}>
                  <Btn label={t.call} onPress={() => callPhone(d.phone)} disabled={!d.phone} style={{ flex: 1 }} testID="hub-driver-call" />
                </View>
              </View>

              <View style={[hubStyles.card, { marginTop: spacing.md }]}>
                <KV k={t.car} v={d.vehicle_number ?? t.no_car} />
                <KV k={t.working} v={formatDuration(d.working_seconds)} />
                <View style={styles.kv}>
                  <Text style={styles.k}>{t.cash_owed}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={[styles.v, d.over_limit ? { color: colors.alert } : null]}>{formatINR(d.you_owe)}</Text>
                    {d.you_owe > 0 ? <Btn label={t.received} small onPress={() => setCash({ driver_id: d.driver_id, name: d.name, you_owe: d.you_owe })} testID="hub-driver-cash" /> : null}
                  </View>
                </View>
                {d.shift_status !== "no_shift_time" && d.shift_status !== "started" && !d.on_duty ? (
                  <View style={styles.phoned} testID="hub-driver-phoned">
                    <Text style={styles.k}>{t.phoned_in}</Text>
                    <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
                      <Btn label={t.mark_coming} small kind="ghost" onPress={markComing} busy={marking} style={{ flex: 1 }} testID="hub-driver-mark-coming" />
                      <Btn label={t.mark_not_coming} small kind="danger" onPress={() => setNotComing(true)} disabled={marking} style={{ flex: 1 }} testID="hub-driver-mark-not-coming" />
                    </View>
                  </View>
                ) : null}
                <View style={styles.kv}>
                  <Text style={styles.k}>{t.shift_time}</Text>
                  {shift === null ? (
                    <TouchableOpacity onPress={() => { setShift(d.shift_start_time ?? ""); }} testID="hub-driver-shift-edit">
                      <Text style={[styles.v, styles.link]}>{d.shift_start_time ?? t.none}</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <TextInput testID="hub-driver-shift-input" value={shift} onChangeText={setShift} placeholder="07:00" placeholderTextColor={colors.muted}
                        keyboardType="numbers-and-punctuation" maxLength={5} style={[hubStyles.input, styles.shiftInput]} />
                      <Btn label={t.save} small onPress={saveShift} busy={savingShift} testID="hub-driver-shift-save" />
                    </View>
                  )}
                </View>
                {shift !== null ? <Text style={hubStyles.sub}>{t.shift_time_hint}</Text> : null}
              </View>
            </>
          )}

          <SectionTitle>{t.recent_taps}</SectionTitle>
          <View style={hubStyles.card} testID="hub-driver-taps">
            {taps === null ? <Empty>{t.loading}</Empty> : taps.length === 0 ? <Empty>{t.no_taps}</Empty> : [...taps].reverse().slice(0, 12).map((e, i) => (
              <View key={e.id ?? `${e.at}-${i}`} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}>
                <Text style={styles.tapTime}>{formatISTTime(e.at)}</Text>
                <Text style={[hubStyles.name, { flex: 1, fontSize: 14 }]}>{describeTap(e, t)}</Text>
                {e.lat != null && e.lng != null ? (
                  <TouchableOpacity onPress={() => Linking.openURL(`https://www.google.com/maps?q=${e.lat},${e.lng}`).catch(() => {})}>
                    <Text style={styles.link}>{t.open_map}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
          </View>

          <View onLayout={(e) => setThreadY(e.nativeEvent.layout.y)}><SectionTitle>{t.conversation}</SectionTitle></View>
          <View style={hubStyles.card} testID="hub-driver-thread">
            {notes === null ? <Empty>{t.loading}</Empty> : notes.length === 0 ? <Empty>{t.no_messages}</Empty> : [...notes].reverse().slice(-20).map((n) => {
              const mine = n.direction === "to_driver";
              return (
                <View key={n.id} style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                  <Text style={[styles.bubbleText, mine ? { color: colors.onBrand } : null]}>{n.body}</Text>
                  <Text style={[styles.bubbleMeta, mine ? { color: colors.onBrand } : null]}>
                    {n.kind === "system" ? `${t.automatic} · ` : ""}{formatIST(n.created_at)}
                  </Text>
                </View>
              );
            })}
            <View style={styles.composer}>
              <TextInput testID="hub-driver-draft" value={draft} onChangeText={setDraft} placeholder={t.type_message} placeholderTextColor={colors.muted}
                style={[hubStyles.input, { flex: 1 }]} multiline />
              <Btn label={t.send} small onPress={send} busy={sending} disabled={!draft.trim()} testID="hub-driver-send" />
            </View>
          </View>
        </ScrollView>

        <CashSheet target={cash} onClose={() => setCash(null)} onDone={(m) => { setCash(null); say(m); refresh(); }} />
        <NotComingSheet visible={notComing} driverId={id as string} name={d?.name ?? ""} onClose={() => setNotComing(false)}
          onDone={(m) => { setNotComing(false); say(m); refresh(); }} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const KV: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <View style={styles.kv}>
    <Text style={styles.k}>{k}</Text>
    <Text style={styles.v}>{v}</Text>
  </View>
);

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  kv: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line, minHeight: 44 },
  phoned: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, marginTop: spacing.md },
  k: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  v: { fontFamily: fonts.dataMed, fontSize: 15, color: colors.ink },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.live, textDecorationLine: "underline" },
  shiftInput: { width: 84, paddingVertical: 7, textAlign: "center", fontFamily: fonts.dataMed },
  tapTime: { fontFamily: fonts.data, fontSize: 12, color: colors.muted, width: 62 },
  bubble: { maxWidth: "84%", borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.sm },
  mine: { alignSelf: "flex-end", backgroundColor: colors.brand },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.paper },
  bubbleText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
  bubbleMeta: { fontFamily: fonts.ui, fontSize: 10, color: colors.muted, marginTop: 3 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, marginTop: spacing.sm },
});
