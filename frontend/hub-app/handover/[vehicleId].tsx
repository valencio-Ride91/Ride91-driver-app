// Shift change for one car: who brings it back, who takes it out, battery,
// odometer, photos, any new damage, and the cash the returning driver owes.
//
// The record is evidence of how the car was at that moment. It does not move
// the car between drivers — the day / night slots on the roster do that.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";

import { formatINR } from "@/src/i18n";
import { CarsData } from "@/src/hub/cars";
import { CashSheet, CashTarget } from "@/src/hub/CashSheet";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, SectionTitle, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

// The five views every shift change should have, in the order they are taken.
const SIDES = ["front", "back", "left", "right", "dashboard"] as const;

// Which driver is most likely handing over and taking over right now: in the
// morning the night driver returns and the day driver takes; later, the reverse.
function likelyDirection(): "night_to_day" | "day_to_night" {
  const hourIST = (new Date().getUTCHours() + 5.5) % 24;
  return hourIST >= 4 && hourIST < 16 ? "night_to_day" : "day_to_night";
}

export default function Handover() {
  const t = useHubText();
  const router = useRouter();
  const { vehicleId } = useLocalSearchParams<{ vehicleId: string }>();
  const { session } = useHubSession();
  const { refresh } = useHubToday();
  const hubId = session?.hubId;

  const [data, setData] = useState<CarsData | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [soc, setSoc] = useState("");
  const [odo, setOdo] = useState("");
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [damage, setDamage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cash, setCash] = useState<CashTarget | null>(null);
  // One id for this shift change, so a retry after a dropped connection
  // cannot record it twice.
  const [actionId] = useState(() => Crypto.randomUUID());

  const load = useCallback(async () => {
    if (!hubId) return null;
    try {
      const d = await hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`);
      setData(d);
      return d;
    } catch {
      return null;
    }
  }, [hubId]);

  const car = useMemo(() => data?.cars.find((c) => c.id === vehicleId) ?? null, [data, vehicleId]);

  // First load: suggest the two drivers from the car's day / night slots and
  // start the odometer from the last reading.
  useEffect(() => {
    load().then((d) => {
      const c = d?.cars.find((x) => x.id === vehicleId);
      if (!c) return;
      const dir = likelyDirection();
      setFromId((dir === "night_to_day" ? c.night_driver : c.day_driver)?.driver_id ?? null);
      setToId((dir === "night_to_day" ? c.day_driver : c.night_driver)?.driver_id ?? null);
      if (c.odometer_km != null) setOdo(String(Math.round(c.odometer_km)));
    });
  }, [load, vehicleId]);

  const takePhoto = async (label: string) => {
    setErr(null);
    try {
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return setErr(t.camera_denied);
      }
      // A small, well-compressed picture: enough to see a scratch, light
      // enough to send five of them on mobile data.
      const opts = { mediaTypes: ["images"] as ImagePicker.MediaType[], base64: true, quality: 0.3 };
      const res = Platform.OS === "web" ? await ImagePicker.launchImageLibraryAsync(opts) : await ImagePicker.launchCameraAsync(opts);
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      if (a.base64) setPhotos((p) => ({ ...p, [label]: `data:${a.mimeType ?? "image/jpeg"};base64,${a.base64}` }));
    } catch {
      setErr(t.camera_denied);
    }
  };

  const fromDriver = data?.drivers.find((d) => d.driver_id === fromId) ?? null;
  const taken = SIDES.filter((s) => photos[s]).length;

  const submit = async () => {
    if (busy || !car) return;
    setErr(null);
    if (!fromId && !toId) return setErr(t.ho_err.driver_required);
    if (fromId && fromId === toId) return setErr(t.ho_err.same_driver);
    const socN = soc.trim() === "" ? null : Number(soc);
    if (socN != null && (!Number.isFinite(socN) || socN < 0 || socN > 100)) return setErr(t.ho_bad_battery);
    const odoN = odo.trim() === "" ? null : Number(odo);
    if (odoN != null && (!Number.isFinite(odoN) || odoN < 0)) return setErr(t.ho_err.odometer_lower);
    setBusy(true);
    try {
      await hubApi.post(`/admin/hubs/${hubId}/handovers`, {
        vehicle_id: car.id,
        from_driver_id: fromId,
        to_driver_id: toId,
        soc_pct: socN == null ? null : Math.round(socN),
        odometer_km: odoN,
        damage_note: damage.trim() || null,
        photos: Object.entries(photos).map(([label, d]) => ({ label, data: d })),
        client_action_id: actionId,
      });
      setMsg(t.handover_done(car.number ?? ""));
      refresh();
      setTimeout(() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/cars" as never)), 1200);
    } catch (e: any) {
      setErr(t.ho_err[e?.body?.detail] ?? t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  const Picker: React.FC<{ value: string | null; onChange: (id: string | null) => void; testID: string }> = ({ value, onChange, testID }) => (
    <View style={styles.chips} testID={testID}>
      <Chip label={t.nobody} on={value === null} onPress={() => onChange(null)} />
      {(data?.drivers ?? []).map((d) => (
        <Chip key={d.driver_id} label={d.name ?? "—"} on={value === d.driver_id} onPress={() => onChange(d.driver_id)} testID={`${testID}-${d.driver_id}`} />
      ))}
    </View>
  );

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/cars" as never))} style={styles.back} testID="hub-ho-back">
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1} testID="hub-ho-title">{t.shift_change}</Text>
            <Text style={hubStyles.sub}>{car ? [car.number, car.model].filter(Boolean).join(" · ") : ""}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled">
          {msg ? <Text style={hubStyles.done} testID="hub-ho-done">{msg}</Text> : null}
          {!data ? <Empty>{t.loading}</Empty> : !car ? <Empty>{t.cars_none}</Empty> : (
            <>
              <SectionTitle>{t.returning}</SectionTitle>
              <Picker value={fromId} onChange={setFromId} testID="hub-ho-from" />
              <SectionTitle>{t.taking}</SectionTitle>
              <Picker value={toId} onChange={setToId} testID="hub-ho-to" />

              <View style={[styles.two, { marginTop: spacing.lg }]}>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.label}>{t.battery_pct}</Text>
                  <TextInput testID="hub-ho-soc" value={soc} onChangeText={(v) => setSoc(v.replace(/[^0-9]/g, ""))} keyboardType="numeric" maxLength={3}
                    style={hubStyles.input} placeholder={car.current_soc != null ? String(car.current_soc) : "0"} placeholderTextColor={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.label}>{t.odometer_km}</Text>
                  <TextInput testID="hub-ho-odo" value={odo} onChangeText={(v) => setOdo(v.replace(/[^0-9.]/g, ""))} keyboardType="numeric"
                    style={hubStyles.input} placeholder="0" placeholderTextColor={colors.muted} />
                </View>
              </View>

              <SectionTitle right={<Text style={taken === SIDES.length ? styles.countOk : styles.countWarn} testID="hub-ho-count">{t.photos_count(taken, SIDES.length)}</Text>}>
                {t.car_photos}
              </SectionTitle>
              <View style={styles.photoGrid}>
                {SIDES.map((s) => (
                  <TouchableOpacity key={s} style={[styles.photo, photos[s] ? styles.photoDone : null]} onPress={() => takePhoto(s)} testID={`hub-ho-photo-${s}`}>
                    {photos[s] ? <Image source={{ uri: photos[s] }} style={styles.photoImg} /> : <Text style={styles.plus}>+</Text>}
                    <Text style={styles.photoLabel} numberOfLines={1}>{t.photo_labels[s]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={hubStyles.label}>{t.new_damage}</Text>
              <TextInput testID="hub-ho-damage" value={damage} onChangeText={setDamage} style={hubStyles.input} placeholder={t.damage_placeholder} placeholderTextColor={colors.muted} multiline />
              {damage.trim() ? (
                <TouchableOpacity style={[styles.photo, styles.photoWide, photos.damage ? styles.photoDone : null]} onPress={() => takePhoto("damage")} testID="hub-ho-photo-damage">
                  {photos.damage ? <Image source={{ uri: photos.damage }} style={styles.photoImg} /> : <Text style={styles.plus}>+</Text>}
                  <Text style={styles.photoLabel}>{t.damage_photo}</Text>
                </TouchableOpacity>
              ) : null}

              {fromDriver && fromDriver.you_owe > 0 ? (
                <View style={[hubStyles.card, styles.cashRow]} testID="hub-ho-cash">
                  <View style={{ flex: 1 }}>
                    <Text style={hubStyles.sub}>{t.cash_due_from(fromDriver.name ?? "")}</Text>
                    <Text style={styles.cashAmt}>{formatINR(fromDriver.you_owe)}</Text>
                  </View>
                  <Btn label={t.received} small kind="ghost" onPress={() => setCash({ driver_id: fromDriver.driver_id, name: fromDriver.name, you_owe: fromDriver.you_owe })} testID="hub-ho-cash-btn" />
                </View>
              ) : null}

              {err ? <Text style={hubStyles.err} testID="hub-ho-err">{err}</Text> : null}
              <Btn label={t.confirm_handover} onPress={submit} busy={busy} disabled={!!msg} style={{ marginTop: spacing.lg }} testID="hub-ho-submit" />
            </>
          )}
        </ScrollView>

        <CashSheet target={cash} onClose={() => setCash(null)} onDone={() => { setCash(null); load(); refresh(); }} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const Chip: React.FC<{ label: string; on: boolean; onPress: () => void; testID?: string }> = ({ label, on, onPress, testID }) => (
  <TouchableOpacity onPress={onPress} style={[styles.chip, on ? styles.chipOn : null]} testID={testID}>
    <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  chipTextOn: { color: colors.white },
  two: { flexDirection: "row", gap: spacing.md },
  countOk: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.live },
  countWarn: { fontFamily: fonts.uiBold, fontSize: 12, color: "#8A5D00" },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photo: {
    width: "31%", aspectRatio: 1, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, borderStyle: "dashed",
    backgroundColor: colors.card, alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  photoWide: { width: "100%", aspectRatio: 3, marginTop: spacing.sm },
  photoDone: { borderStyle: "solid", borderColor: colors.brand },
  photoImg: { ...StyleSheet.absoluteFill, width: "100%", height: "100%" },
  plus: { fontFamily: fonts.uiBold, fontSize: 26, color: colors.muted },
  photoLabel: { position: "absolute", bottom: 0, left: 0, right: 0, textAlign: "center", fontFamily: fonts.uiBold, fontSize: 11, color: colors.ink, backgroundColor: "rgba(255,255,255,0.85)", paddingVertical: 3 },
  cashRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.lg },
  cashAmt: { fontFamily: fonts.dataMed, fontSize: 20, color: colors.ink },
});
