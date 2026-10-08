// Add a driver to the hub, or change one who is already in it (opened with
// ?id=<driver>): name, the phone number they sign in with, their app password,
// day or night shift, shift time, and which car they drive.
//
// A car holds one day driver and one night driver, so the car list only offers
// cars whose slot for the chosen shift is free. The password is typed in plain
// sight because the manager has to tell it to the driver.
//
// Removing a driver archives them: they can no longer sign in and their car is
// freed, but their cash and salary records stay.
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { formatINR } from "@/src/i18n";
import { CarsData, HubCar } from "@/src/hub/cars";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { HubDriver, useHubToday } from "@/src/hub/today";
import { Btn, Empty, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

type Shift = "day" | "night";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// "+919876543210" -> "9876543210" for the box; other numbers are shown as stored.
const localPhone = (p: string | null | undefined) => (p && /^\+91\d{10}$/.test(p) ? p.slice(3) : p ?? "");
// What the manager typed -> ten digits, or null if it is not an Indian mobile.
function tenDigits(typed: string): string | null {
  const d = typed.replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}
const slotOf = (c: HubCar, shift: Shift) => (shift === "day" ? c.day_driver : c.night_driver);

export default function DriverForm() {
  const t = useHubText();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { session } = useHubSession();
  const { today } = useHubToday();
  const hubId = session?.hubId;
  const [cars, setCars] = useState<CarsData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hubId) return;
    let alive = true;
    hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`).then((c) => alive && setCars(c)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [hubId]);

  const driver = id ? today?.drivers.find((d) => d.driver_id === id) ?? null : null;
  const waiting = !cars || (!!id && !driver);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)/drivers" as never));

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={back} style={styles.back} testID="hub-df-back">
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1} testID="hub-df-title">{id ? t.df_edit_title : t.df_add_title}</Text>
        </View>
        {waiting ? (
          <View style={{ padding: spacing.md }}><Empty>{failed ? t.action_fail : t.loading}</Empty></View>
        ) : (
          // Mounted only once its data is here, so the boxes start filled in.
          <Fields hubId={hubId as string} driver={driver} cars={cars as CarsData} />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const Fields: React.FC<{ hubId: string; driver: HubDriver | null; cars: CarsData }> = ({ hubId, driver, cars }) => {
  const t = useHubText();
  const router = useRouter();
  const { refresh } = useHubToday();
  const id = driver?.driver_id ?? null;
  const was = {
    name: driver?.name ?? "",
    phone: localPhone(driver?.phone),
    shift: (driver?.shift_type === "night" ? "night" : "day") as Shift,
    time: driver?.shift_start_time ?? "",
    car: cars.drivers.find((d) => d.driver_id === id)?.vehicle_id ?? null,
  };
  const [name, setName] = useState(was.name);
  const [phone, setPhone] = useState(was.phone);
  const [password, setPassword] = useState("");
  const [shift, setShift] = useState<Shift>(was.shift);
  const [time, setTime] = useState(was.time);
  const [car, setCar] = useState<string | null>(was.car);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);     // the "are you sure" step

  // A car is offered when its slot for this shift is free, or is this driver's own.
  const free = (c: HubCar) => {
    const holder = slotOf(c, shift);
    return !holder || holder.driver_id === id;
  };
  const pickShift = (s: Shift) => {
    setShift(s);
    // The chosen car may have its other slot taken; if so, let go of it.
    const chosen = cars.cars.find((c) => c.id === car);
    const holder = chosen ? slotOf(chosen, s) : null;
    if (holder && holder.driver_id !== id) setCar(null);
  };

  const fail = (e: any) => {
    const code = e?.body?.detail;
    setErr(code === "phone_already_registered" ? t.df_phone_taken : code === "shift_slot_taken" ? t.df_slot_taken : t.action_fail);
  };

  const save = async () => {
    if (busy) return;
    const ten = tenDigits(phone);
    const typedPhone = phone.trim();
    if (!name.trim()) return setErr(t.df_need_name);
    // An existing number that is not an Indian mobile is left alone if untouched.
    if (!ten && !(id && typedPhone === was.phone && typedPhone)) return setErr(t.df_bad_phone);
    if (id ? password !== "" && password.length < 6 : password.length < 6) return setErr(t.df_bad_password);
    if (time.trim() && !HHMM.test(time.trim())) return setErr(t.df_bad_time);
    setErr(null);
    setBusy(true);
    try {
      if (!id) {
        const made = await hubApi.post<{ id: string }>("/admin/drivers", {
          name: name.trim(), phone: ten, password, shift_type: shift, hub_id: hubId, ...(car ? { vehicle_id: car } : {}),
        });
        if (time.trim()) await hubApi.patch(`/admin/drivers/${made.id}`, { shift_start_time: time.trim() });
        await refresh();
        router.replace(`/driver/${made.id}` as never);
        return;
      }
      // The car first: giving a car also sets the shift, in one step on the server.
      const patch: Record<string, string> = {};
      if (car && (car !== was.car || shift !== was.shift)) {
        await hubApi.post(`/admin/vehicles/${car}/assign`, { shift, driver_id: id });
      } else if (!car) {
        if (was.car) await hubApi.post(`/admin/vehicles/${was.car}/assign`, { shift: was.shift, driver_id: null });
        if (shift !== was.shift) patch.shift_type = shift;
      }
      if (name.trim() !== was.name) patch.name = name.trim();
      if (typedPhone !== was.phone && ten) patch.phone = ten;
      if (password) patch.password = password;
      if (time.trim() !== was.time) patch.shift_start_time = time.trim();
      if (Object.keys(patch).length) await hubApi.patch(`/admin/drivers/${id}`, patch);
      await refresh();
      if (router.canGoBack()) router.back();
      else router.replace(`/driver/${id}` as never);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!id || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await hubApi.del(`/admin/drivers/${id}`);
      await refresh();
      router.replace("/(tabs)/drivers" as never);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled">
      <View style={hubStyles.card}>
        <Text style={[hubStyles.label, { marginTop: 0 }]}>{t.df_name}</Text>
        <TextInput testID="hub-df-name" value={name} onChangeText={setName} autoCapitalize="words" style={hubStyles.input} />

        <Text style={hubStyles.label}>{t.df_phone}</Text>
        <TextInput testID="hub-df-phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={14} placeholder="98765 43210" placeholderTextColor={colors.muted} style={[hubStyles.input, styles.mono]} />
        <Text style={hubStyles.sub}>{t.df_phone_hint}</Text>

        <Text style={hubStyles.label}>{id ? t.df_new_password : t.df_password}</Text>
        <TextInput testID="hub-df-password" value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} placeholder={id ? t.df_password_keep : ""} placeholderTextColor={colors.muted} style={[hubStyles.input, styles.mono]} />
        <Text style={hubStyles.sub}>{t.df_password_hint}</Text>
      </View>

      <View style={[hubStyles.card, { marginTop: spacing.md }]}>
        <Text style={[hubStyles.label, { marginTop: 0 }]}>{t.df_shift}</Text>
        <View style={styles.switch}>
          {(["day", "night"] as const).map((s) => (
            <TouchableOpacity key={s} style={[styles.seg, shift === s ? styles.segOn : null]} onPress={() => pickShift(s)} testID={`hub-df-shift-${s}`}>
              <Text style={[styles.segText, shift === s ? styles.segTextOn : null]}>{s === "day" ? t.day_short : t.night_short}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={hubStyles.label}>{t.shift_time}</Text>
        <TextInput testID="hub-df-time" value={time} onChangeText={setTime} placeholder="07:00" placeholderTextColor={colors.muted} keyboardType="numbers-and-punctuation" maxLength={5} style={[hubStyles.input, styles.mono, { width: 110 }]} />
        <Text style={hubStyles.sub}>{t.shift_time_hint}</Text>
      </View>

      <View style={[hubStyles.card, { marginTop: spacing.md }]} testID="hub-df-cars">
        <Text style={[hubStyles.label, { marginTop: 0 }]}>{t.df_car}</Text>
        {[null, ...cars.cars].map((c, i) => {
          const ok = !c || free(c);
          const holder = c ? slotOf(c, shift) : null;
          const on = (c?.id ?? null) === car;
          return (
            <TouchableOpacity key={c?.id ?? "none"} disabled={!ok} onPress={() => setCar(c?.id ?? null)}
              style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null, !ok ? { opacity: 0.45 } : null]} testID={`hub-df-car-${c?.id ?? "none"}`}>
              <View style={[styles.radio, on ? styles.radioOn : null]}>{on ? <View style={styles.radioDot} /> : null}</View>
              <View style={{ flex: 1 }}>
                <Text style={hubStyles.name}>{c ? c.number ?? "—" : t.df_no_car}</Text>
                {c ? <Text style={hubStyles.sub}>{!holder || holder.driver_id === id ? t.df_slot_free(shift === "day" ? t.day_short : t.night_short) : t.df_slot_with(holder.name ?? "—")}</Text> : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {err ? <Text style={hubStyles.err} testID="hub-df-err">{err}</Text> : null}
      <Btn label={id ? t.save : t.df_add} onPress={save} busy={busy && !removing} disabled={busy} style={{ marginTop: spacing.lg }} testID="hub-df-save" />

      {id && driver ? (
        removing ? (
          <View style={[hubStyles.card, styles.danger]} testID="hub-df-remove-confirm">
            <Text style={styles.dangerText}>
              {t.df_remove_sure(driver.name ?? "")}{driver.you_owe > 0 ? ` ${t.df_remove_owes(formatINR(driver.you_owe))}` : ""}
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
              <Btn label={t.cancel} small kind="ghost" onPress={() => setRemoving(false)} disabled={busy} style={{ flex: 1 }} testID="hub-df-remove-no" />
              <Btn label={t.df_remove_yes} small kind="danger" onPress={remove} busy={busy} style={{ flex: 1 }} testID="hub-df-remove-yes" />
            </View>
          </View>
        ) : (
          <Btn label={t.df_remove} kind="danger" onPress={() => setRemoving(true)} disabled={busy} style={{ marginTop: spacing.xl }} testID="hub-df-remove" />
        )
      ) : null}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  mono: { fontFamily: fonts.dataMed },
  switch: { flexDirection: "row", padding: 3, backgroundColor: colors.paper, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  seg: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.md - 2 },
  segOn: { backgroundColor: colors.brand },
  segText: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.muted },
  segTextOn: { color: colors.onBrand },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  radioOn: { borderColor: colors.live },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.live },
  danger: { marginTop: spacing.xl, borderColor: colors.alert },
  dangerText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
});
