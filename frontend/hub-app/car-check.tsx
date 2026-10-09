// Inspect a car (opened with ?vehicle=<id>): the hub manager walks round it
// and marks each point OK or "needs attention", with a note where something
// is wrong. Then the battery performance report, and any other notes.
//
// A point left unmarked is saved as "not checked", so a quick look at two
// things is not recorded as a full inspection. Each inspection is kept in the
// car's history.
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";

import { CHECK_ITEMS, CheckStatus } from "@/src/hub/cars";
import { hubApi } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { Icon } from "@/src/hub/kit";
import { Btn, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

type Marks = Record<string, { status: CheckStatus; note: string }>;

export default function CarCheckForm() {
  const t = useHubText();
  const router = useRouter();
  const { vehicle } = useLocalSearchParams<{ vehicle: string }>();
  const [actionId] = useState(() => Crypto.randomUUID());
  const [marks, setMarks] = useState<Marks>(() => Object.fromEntries(CHECK_ITEMS.map((k) => [k, { status: "not_checked", note: "" }])));
  const [battery, setBattery] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)/cars" as never));
  // Tapping the chosen answer again clears it.
  const mark = (k: string, status: CheckStatus) =>
    setMarks((m) => ({ ...m, [k]: { ...m[k], status: m[k].status === status ? "not_checked" : status } }));
  const allOk = () =>
    setMarks((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.status === "not_checked" ? { ...v, status: "ok" as CheckStatus } : v])));

  const save = async () => {
    if (busy) return;
    const touched = Object.values(marks).some((v) => v.status !== "not_checked");
    if (!touched && !battery.trim() && !notes.trim()) return setErr(t.check_nothing);
    setBusy(true);
    setErr(null);
    try {
      await hubApi.post(`/admin/vehicles/${vehicle}/checks`, {
        items: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, { status: v.status, note: v.status === "attention" ? v.note.trim() || null : null }])),
        battery_note: battery.trim() || null,
        notes: notes.trim() || null,
        client_action_id: actionId,
      });
      back();
    } catch (e: any) {
      setErr(e?.body?.detail === "nothing_checked" ? t.check_nothing : t.action_fail);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={back} style={styles.back} testID="hub-check-back">
            <Icon name="chevron-back" size={26} color={colors.ink} />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1} testID="hub-check-title">{t.car_inspect}</Text>
          <TouchableOpacity onPress={allOk} testID="hub-check-all-ok"><Text style={styles.link}>{t.check_mark_all_ok}</Text></TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled">
          <View style={hubStyles.card} testID="hub-check-items">
            {CHECK_ITEMS.map((k, i) => {
              const m = marks[k];
              return (
                <View key={k} style={[styles.item, i === 0 ? { borderTopWidth: 0 } : null]}>
                  <Text style={styles.itemName}>{t.check_items[k]}</Text>
                  <View style={styles.choices}>
                    <TouchableOpacity onPress={() => mark(k, "ok")} style={[styles.choice, m.status === "ok" ? styles.okOn : null]} testID={`hub-check-${k}-ok`}>
                      <Text style={[styles.choiceText, m.status === "ok" ? { color: colors.onBrand } : null]}>{t.check_ok}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => mark(k, "attention")} style={[styles.choice, m.status === "attention" ? styles.badOn : null]} testID={`hub-check-${k}-attention`}>
                      <Text style={[styles.choiceText, m.status === "attention" ? { color: colors.white } : null]}>{t.check_attention}</Text>
                    </TouchableOpacity>
                  </View>
                  {m.status === "attention" ? (
                    <TextInput testID={`hub-check-${k}-note`} value={m.note} onChangeText={(v) => setMarks((x) => ({ ...x, [k]: { ...x[k], note: v } }))}
                      maxLength={300} placeholder={t.check_note_ph} placeholderTextColor={colors.muted} style={[hubStyles.input, { marginTop: spacing.sm }]} />
                  ) : null}
                </View>
              );
            })}
          </View>

          <View style={[hubStyles.card, { marginTop: spacing.md }]}>
            <Text style={[hubStyles.label, { marginTop: 0 }]}>{t.check_battery}</Text>
            <TextInput testID="hub-check-battery" value={battery} onChangeText={setBattery} multiline maxLength={1000}
              placeholder={t.check_battery_ph} placeholderTextColor={colors.muted} style={[hubStyles.input, styles.area]} />
            <Text style={hubStyles.label}>{t.check_notes}</Text>
            <TextInput testID="hub-check-notes" value={notes} onChangeText={setNotes} multiline maxLength={2000}
              placeholder={t.check_notes_ph} placeholderTextColor={colors.muted} style={[hubStyles.input, styles.area]} />
          </View>

          {err ? <Text style={hubStyles.err} testID="hub-check-err">{err}</Text> : null}
          <Btn label={t.check_save} onPress={save} busy={busy} style={{ marginTop: spacing.lg }} testID="hub-check-save" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.live, paddingHorizontal: spacing.sm },
  item: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line },
  itemName: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink },
  choices: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  choice: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  okOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  badOn: { backgroundColor: colors.alert, borderColor: colors.alert },
  choiceText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  area: { minHeight: 84, textAlignVertical: "top" },
});
