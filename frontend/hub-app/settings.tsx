// Hub settings — the things a manager does now and then rather than every
// day: set the shift time for all day or night drivers at once, bring back a
// driver who was removed, change their own password, switch hub, sign out.
import React, { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { formatISTDate } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Icon, useToast } from "@/src/hub/kit";
import { Btn, Empty, SectionTitle, hubStyles } from "@/src/hub/ui";
import { colors, fonts, spacing } from "@/src/theme";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
interface Removed { driver_id: string; name: string | null; phone: string | null; removed_at: string | null }
type Who = "all" | "day" | "night";

export default function Settings() {
  const t = useHubText();
  const router = useRouter();
  const { session, signOut, chooseHub } = useHubSession();
  const { today, refresh } = useHubToday();
  const hubId = session?.hubId;
  const [who, setWho] = useState<Who>("day");
  const [time, setTime] = useState("");
  const [sure, setSure] = useState(false);          // asking before the shift time is set for everyone
  const [removed, setRemoved] = useState<Removed[] | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);      // which action is running

  const loadRemoved = useCallback(async () => {
    if (!hubId) return;
    try {
      setRemoved((await hubApi.get<{ items: Removed[] }>(`/admin/hubs/${hubId}/removed-drivers`)).items);
    } catch {
      setRemoved([]);       // an older server has no such list
    }
  }, [hubId]);

  useFocusEffect(useCallback(() => { loadRemoved(); }, [loadRemoved]));

  const say = useToast();
  const fail = (m: string) => say(m, "bad");

  const run = async (key: string, work: () => Promise<string>, onFail?: (e: any) => string) => {
    if (busy) return;
    setBusy(key);
    try {
      say(await work());
    } catch (e) {
      fail(onFail ? onFail(e) : t.action_fail);
    } finally {
      setBusy(null);
    }
  };

  // How many drivers the chosen group covers (a driver with no shift type counts as day).
  const affected = (today?.drivers ?? []).filter((d) => who === "all" || (d.shift_type === "night" ? "night" : "day") === who).length;
  const askShift = () => {
    if (!HHMM.test(time.trim())) return fail(t.df_bad_time);
    setSure(true);
  };
  const saveShift = () => {
    setSure(false);
    run("shift", async () => {
      const r = await hubApi.post<{ updated: number }>(`/admin/hubs/${hubId}/shift-times`, { shift_start_time: time.trim(), shift_type: who });
      await refresh();
      return t.set_done(r.updated);
    });
  };

  const restore = (d: Removed) =>
    run(`restore:${d.driver_id}`, async () => {
      await hubApi.post(`/admin/drivers/${d.driver_id}/restore`);
      await Promise.all([loadRemoved(), refresh()]);
      return t.restored(d.name ?? "");
    });

  const changePassword = () => {
    if (newPw.length < 10) return fail(t.pw_short);
    run("pw", async () => {
      await hubApi.post("/admin/change-password", { old_password: oldPw, new_password: newPw });
      setOldPw("");
      setNewPw("");
      return t.pw_done;
    }, (e) => (e?.body?.detail === "wrong_current_password" ? t.pw_wrong : t.action_fail));
  };

  // A fleet manager or owner can hop to another hub; a hub manager cannot.
  const canChangeHub = session?.role !== "hub_manager";

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)" as never))} style={styles.back} testID="hub-set-back">
            <Icon name="chevron-back" size={26} color={colors.ink} />
          </TouchableOpacity>
          <Text style={styles.title} testID="hub-set-title">{t.settings_title}</Text>
        </View>

        <ScrollView contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled">

          <SectionTitle>{t.set_shift_all}</SectionTitle>
          <View style={hubStyles.card}>
            <View style={styles.switch}>
              {(["day", "night", "all"] as const).map((w) => (
                <TouchableOpacity key={w} style={[styles.seg, who === w ? styles.segOn : null]} onPress={() => setWho(w)} testID={`hub-set-who-${w}`}>
                  <Text style={[styles.segText, who === w ? styles.segTextOn : null]}>{w === "day" ? t.set_day : w === "night" ? t.set_night : t.set_everyone}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.inline}>
              <TextInput testID="hub-set-time" value={time} onChangeText={setTime} placeholder="07:00" placeholderTextColor={colors.muted}
                keyboardType="numbers-and-punctuation" maxLength={5} style={[hubStyles.input, styles.mono, { width: 110 }]} />
              <Btn label={t.save} small onPress={askShift} busy={busy === "shift"} disabled={sure} testID="hub-set-shift-save" />
            </View>
            {sure ? (
              <View style={styles.sure} testID="hub-set-sure">
                <Text style={styles.sureText}>{t.set_sure(time.trim(), affected)}</Text>
                <View style={styles.inline}>
                  <Btn label={t.cancel} small kind="ghost" onPress={() => setSure(false)} style={{ flex: 1 }} testID="hub-set-no" />
                  <Btn label={t.set_yes} small onPress={saveShift} style={{ flex: 1 }} testID="hub-set-yes" />
                </View>
              </View>
            ) : null}
            <Text style={hubStyles.sub}>{t.set_shift_all_hint}</Text>
          </View>

          <SectionTitle>{t.removed_title}</SectionTitle>
          <View style={hubStyles.card} testID="hub-set-removed">
            {removed === null ? <Empty>{t.loading}</Empty> : removed.length === 0 ? <Empty>{t.removed_none}</Empty> : removed.map((d, i) => (
              <View key={d.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.name}>{d.name ?? "—"}</Text>
                  <Text style={hubStyles.sub}>{[d.phone, d.removed_at ? formatISTDate(d.removed_at) : null].filter(Boolean).join(" · ")}</Text>
                </View>
                <Btn label={t.restore} small kind="ghost" onPress={() => restore(d)} busy={busy === `restore:${d.driver_id}`} testID={`hub-set-restore-${d.driver_id}`} />
              </View>
            ))}
          </View>

          <SectionTitle>{t.pw_title}</SectionTitle>
          <View style={hubStyles.card}>
            <Text style={[hubStyles.label, { marginTop: 0 }]}>{t.pw_old}</Text>
            <TextInput testID="hub-set-pw-old" value={oldPw} onChangeText={setOldPw} secureTextEntry autoCapitalize="none" style={hubStyles.input} />
            <Text style={hubStyles.label}>{t.pw_new}</Text>
            <TextInput testID="hub-set-pw-new" value={newPw} onChangeText={setNewPw} secureTextEntry autoCapitalize="none" style={hubStyles.input} />
            <Btn label={t.pw_change} small kind="ghost" onPress={changePassword} busy={busy === "pw"} disabled={!oldPw || !newPw} style={{ marginTop: spacing.md }} testID="hub-set-pw-save" />
          </View>

          <SectionTitle>{t.account}</SectionTitle>
          <View style={[hubStyles.card, styles.account]}>
            <Text style={[hubStyles.name, { flex: 1 }]} numberOfLines={1}>{session?.username}</Text>
            {canChangeHub ? <Btn label={t.change_hub} small kind="ghost" onPress={() => chooseHub("", "")} testID="hub-change-hub" /> : null}
            <Btn label={t.sign_out} small kind="ghost" onPress={signOut} testID="hub-sign-out" />
          </View>
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
  switch: { flexDirection: "row", padding: 3, backgroundColor: colors.paper, borderRadius: 12, borderWidth: 1, borderColor: colors.line },
  seg: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 10 },
  segOn: { backgroundColor: colors.brand },
  segText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.muted },
  segTextOn: { color: colors.onBrand },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.xs },
  mono: { fontFamily: fonts.dataMed },
  sure: { marginBottom: spacing.sm, padding: spacing.md, borderRadius: 12, backgroundColor: colors.paper },
  sureText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
  account: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
