// One car: what the hub does with it and everything on file for it.
//
//   - Shift change, Inspect, Add service — the three things done to a car.
//   - Drivers: who has it by day and by night, each with "Remove from car";
//     a free shift can be given to a driver who has no car.
//   - Damage from a shift change can be marked repaired.
//   - Last done: when it last had a full service, tyres, wipers, brakes and
//     battery work.
//   - Inspections: each walk-round, with the points that needed attention.
//   - Service history: the work done on it, newest first.
//   - Shift changes: each handover, with its photos.
//
// Removing a car retires it; its history stays on file.
//
// On a server that does not have the history yet, the page still opens from
// the hub's car list, with Shift change and Remove, and says what is missing.
import React, { useCallback, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { formatINR, formatIST, formatISTDate } from "@/src/i18n";
import { CHECK_ITEMS, CarCheck, CarDriver, CarHistory, CarsData, HubCar, SERVICE_KINDS, ago, isStale } from "@/src/hub/cars";
import { hubApi, useHubSession } from "@/src/hub/session";
import { ServiceSheet } from "@/src/hub/sheets";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Icon, useToast } from "@/src/hub/kit";
import { Btn, Empty, SectionTitle, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface Photo { label: string; data: string }
type OnCar = { driver_id: string; name: string | null; shift: string };
const uri = (p: Photo) => (p.data.startsWith("data:") ? p.data : `data:image/jpeg;base64,${p.data}`);
// The drivers on a car as the hub's car list has them (one per shift).
const slotsOf = (c: HubCar | undefined): OnCar[] => (c ? [
  ...(c.day_driver ? [{ driver_id: c.day_driver.driver_id, name: c.day_driver.name, shift: "day" }] : []),
  ...(c.night_driver ? [{ driver_id: c.night_driver.driver_id, name: c.night_driver.name, shift: "night" }] : []),
] : []);
// A date-only value shown as a date, wherever the phone is.
const day = (ymd: string) => formatISTDate(`${ymd}T12:00:00+05:30`);

export default function Car() {
  const t = useHubText();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useHubSession();
  const hubId = session?.hubId;
  const signedIn = !!hubId;
  const [h, setH] = useState<CarHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [limited, setLimited] = useState(false);      // the server has no car history yet
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [openHandover, setOpenHandover] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Record<string, Photo[]>>({});
  const [service, setService] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taking, setTaking] = useState<OnCar | null>(null);     // the "take off this car?" step
  const [giving, setGiving] = useState<"day" | "night" | null>(null);   // picking who takes a free shift
  const [spare, setSpare] = useState<CarDriver[] | null>(null);         // the hub's drivers with no car
  const [fixing, setFixing] = useState<string | null>(null);            // the shift change whose damage is being marked repaired
  const { today, refresh } = useHubToday();

  const load = useCallback(async () => {
    if (!signedIn) return;          // the saved session is still being read back
    try {
      const got = await hubApi.get<CarHistory>(`/admin/vehicles/${id}/history`);
      if (!got.drivers) {
        // An older server: who is on the car comes from the hub's car list.
        const list = await hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`).catch(() => null);
        got.drivers = slotsOf(list?.cars.find((c) => c.id === id));
      }
      setH(got);
      setLimited(false);
      setFailed(false);
      return;
    } catch (e: any) {
      if (e?.status !== 404) return setFailed(true);
    }
    // An older server: show the car from the hub's list, without its history.
    try {
      const list = await hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`);
      const car = list.cars.find((c) => c.id === id);
      if (!car) return setFailed(true);
      setH({
        vehicle: { id: car.id, number: car.number, model: car.model, current_soc: car.current_soc, odometer_km: car.odometer_km },
        checks: [], services: [], last_done: {}, handovers: [], drivers: slotsOf(car),
      });
      setLimited(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id, signedIn, hubId]);

  // Reload whenever the page comes back into view (after an inspection or a shift change).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const say = useToast();
  const fail = (m: string) => say(m, "bad");

  const toggleHandover = async (hid: string, count: number) => {
    if (openHandover === hid) return setOpenHandover(null);
    setOpenHandover(hid);
    if (!count || photos[hid]) return;
    try {
      const r = await hubApi.get<{ photos: Photo[] }>(`/admin/handovers/${hid}`);
      setPhotos((p) => ({ ...p, [hid]: r.photos }));
    } catch {
      fail(t.action_fail);
    }
  };

  // Take one driver off this car. Only lets go if they still hold it, so a
  // page that is out of date cannot take off someone put there since.
  const takeOff = async (d: OnCar) => {
    if (busy) return;
    setBusy(true);
    try {
      await hubApi.post(`/admin/vehicles/${id}/assign`, { shift: d.shift, driver_id: null, release_driver_id: d.driver_id });
      say(t.car_off_done(d.name ?? ""));
      setTaking(null);
      await Promise.all([load(), refresh()]);
    } catch {
      fail(t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  // Pick who takes a free shift: drivers of the hub who have no car.
  const openGive = async (sh: "day" | "night") => {
    setTaking(null);
    setGiving(sh);
    setSpare(null);
    try {
      const list = await hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`);
      setSpare(list.drivers.filter((d) => !d.vehicle_id));
    } catch {
      setSpare([]);
      fail(t.action_fail);
    }
  };

  const give = async (d: CarDriver) => {
    if (busy || !giving) return;
    setBusy(true);
    try {
      // Refused (shift_slot_taken) if someone took the shift meanwhile.
      await hubApi.post(`/admin/vehicles/${id}/assign`, { shift: giving, driver_id: d.driver_id });
      say(t.car_give_done(d.name ?? ""));
      setGiving(null);
      await Promise.all([load(), refresh()]);
    } catch (e: any) {
      fail(e?.body?.detail === "shift_slot_taken" ? t.df_slot_taken : t.action_fail);
      setGiving(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const markRepaired = async (handoverId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await hubApi.post(`/admin/handovers/${handoverId}/damage-repaired`, {});
      say(t.car_damage_done);
      setFixing(null);
      await load();
    } catch {
      fail(t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await hubApi.del(`/admin/vehicles/${id}`);
      router.replace("/(tabs)/cars" as never);
    } catch (e: any) {
      fail(e?.body?.detail === "vehicle_in_use" ? t.car_in_use : t.action_fail);
      setRemoving(false);
      setBusy(false);
    }
  };

  const checkTag = (c: CarCheck) => (c.attention.length
    ? <Tag tone="warn">{t.check_n_attention(c.attention.length)}</Tag>
    : <Tag tone="ok">{t.check_all_ok}</Tag>);

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/cars" as never))} style={styles.back} testID="hub-car-back">
          <Icon name="chevron-back" size={26} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1} testID="hub-car-title">{h?.vehicle.number ?? "—"}</Text>
      </View>

      <ScrollView contentContainerStyle={hubStyles.scroll}>

        {!h ? <Empty>{failed ? t.action_fail : t.loading}</Empty> : (
          <>
            <View style={hubStyles.card}>
              <Text style={hubStyles.name}>{h.vehicle.model ?? "—"}</Text>
              <Text style={hubStyles.sub}>
                {[h.vehicle.current_soc != null ? `${t.battery} ${h.vehicle.current_soc}%${h.vehicle.soc_at ? ` (${ago(h.vehicle.soc_at, t)})` : ""}` : null,
                  h.vehicle.odometer_km != null ? t.car_odometer(Math.round(h.vehicle.odometer_km).toLocaleString("en-IN")) : null,
                  limited ? null : h.checks[0] ? t.car_last_inspected(formatISTDate(h.checks[0].created_at)) : t.car_never_inspected].filter(Boolean).join(" · ")}
              </Text>
              <View style={styles.actions}>
                <Btn label={t.shift_change} small kind={limited ? "primary" : "ghost"} onPress={() => router.push(`/handover/${id}` as never)} style={{ flex: 1 }} testID="hub-car-handover" />
                {limited ? null : <Btn label={t.car_inspect} small onPress={() => router.push(`/car-check?vehicle=${id}` as never)} style={{ flex: 1 }} testID="hub-car-inspect" />}
              </View>
            </View>
            {limited ? <Text style={[hubStyles.warn, { marginTop: spacing.md }]} testID="hub-car-limited">{t.car_limited}</Text> : null}

            {h.handovers.filter((x) => x.damage_note && !x.damage_repaired_at).slice(0, 3).map((x) => (
              <View key={x.id} style={[hubStyles.card, styles.damage]} testID={`hub-car-damage-${x.id}`}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Icon name="warning" size={18} color="#8A5D00" />
                  <Text style={[hubStyles.name, { flex: 1 }]}>{t.car_damage_open(formatISTDate(x.created_at))}</Text>
                </View>
                <Text style={[styles.note, { marginTop: 4 }]}>{x.damage_note}</Text>
                {fixing === x.id ? (
                  <View style={{ marginTop: spacing.sm }}>
                    <Text style={styles.dangerText}>{t.car_damage_sure}</Text>
                    <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
                      <Btn label={t.cancel} small kind="ghost" onPress={() => setFixing(null)} disabled={busy} style={{ flex: 1 }} />
                      <Btn label={t.car_damage_yes} small onPress={() => markRepaired(x.id)} busy={busy} style={{ flex: 1 }} testID="hub-car-damage-yes" />
                    </View>
                  </View>
                ) : (
                  <Btn label={t.car_damage_fix} small kind="ghost" onPress={() => setFixing(x.id)} style={{ marginTop: spacing.sm, alignSelf: "flex-start" }} testID="hub-car-damage-fix" />
                )}
              </View>
            ))}

            <SectionTitle>{t.car_drivers}</SectionTitle>
            <View style={hubStyles.card} testID="hub-car-drivers">
              {(["day", "night"] as const).map((sh, si) => {
                const on = (h.drivers ?? []).filter((d) => (d.shift === "night" ? "night" : "day") === sh);
                const label = sh === "day" ? t.day_short : t.night_short;
                if (on.length === 0) {
                  return (
                    <View key={sh} style={[hubStyles.row, si === 0 ? hubStyles.rowFirst : null]} testID={`hub-car-slot-${sh}`}>
                      <Text style={styles.shift}>{label}</Text>
                      <Text style={[hubStyles.sub, { flex: 1 }]}>{t.slot_free}</Text>
                      <Btn label={t.car_give} small onPress={() => openGive(sh)} disabled={busy} testID={`hub-car-give-${sh}`} />
                    </View>
                  );
                }
                return on.map((d, i) => (
                  <View key={d.driver_id} style={[hubStyles.row, si === 0 && i === 0 ? hubStyles.rowFirst : null]} testID={`hub-car-slot-${sh}`}>
                    <Text style={styles.shift}>{label}</Text>
                    <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push(`/driver/${d.driver_id}` as never)}>
                      <Text style={hubStyles.name} numberOfLines={1}>{d.name ?? "—"}</Text>
                    </TouchableOpacity>
                    <Btn label={t.car_off} small kind="ghost" onPress={() => { setGiving(null); setTaking(d); }} disabled={busy} testID={`hub-car-off-${d.driver_id}`} />
                  </View>
                ));
              })}
              {giving ? (
                <View style={styles.giveBox} testID="hub-car-give-list">
                  <Text style={hubStyles.name}>{t.car_give_title(giving === "day" ? t.day_short : t.night_short)}</Text>
                  {spare === null ? <Empty>{t.loading}</Empty> : spare.length === 0 ? <Text style={[hubStyles.sub, { marginTop: 4 }]}>{t.car_give_none}</Text> : spare.map((d) => {
                    const theirs = d.shift_type === "night" ? "night" : "day";
                    return (
                      <TouchableOpacity key={d.driver_id} style={styles.giveRow} onPress={() => give(d)} disabled={busy} testID={`hub-car-give-${d.driver_id}`}>
                        <View style={{ flex: 1 }}>
                          <Text style={hubStyles.name}>{d.name ?? "—"}</Text>
                          <Text style={hubStyles.sub}>
                            {theirs === "night" ? t.night_short : t.day_short}
                            {theirs !== giving ? ` · ${t.car_give_shift_note(giving === "day" ? t.day_short : t.night_short)}` : ""}
                          </Text>
                        </View>
                        <Icon name="chevron-forward" size={18} color={colors.muted} />
                      </TouchableOpacity>
                    );
                  })}
                  <Btn label={t.cancel} small kind="ghost" onPress={() => setGiving(null)} disabled={busy} style={{ marginTop: spacing.sm }} testID="hub-car-give-cancel" />
                </View>
              ) : (h.drivers ?? []).length < 2 ? <Text style={[hubStyles.sub, { marginTop: spacing.sm }]}>{t.car_free_hint}</Text> : null}
              {taking ? (
                <View style={styles.offBox} testID="hub-car-off-confirm">
                  <Text style={styles.dangerText}>
                    {t.car_off_sure(taking.name ?? "", h.vehicle.number ?? "", taking.shift === "night" ? t.night_short : t.day_short)}
                  </Text>
                  {today?.drivers.find((x) => x.driver_id === taking.driver_id)?.on_duty
                    ? <Text style={[styles.dangerText, { color: colors.alert, marginTop: 4 }]}>{t.car_off_on_duty(taking.name ?? "")}</Text> : null}
                  <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
                    <Btn label={t.cancel} small kind="ghost" onPress={() => setTaking(null)} disabled={busy} style={{ flex: 1 }} testID="hub-car-off-no" />
                    <Btn label={t.car_off_yes} small kind="danger" onPress={() => takeOff(taking)} busy={busy} style={{ flex: 1 }} testID="hub-car-off-yes" />
                  </View>
                </View>
              ) : null}
            </View>

            {limited ? null : (
            <>

            <SectionTitle right={<TouchableOpacity onPress={() => setService(true)} testID="hub-car-add-service"><Text style={styles.link}>+ {t.car_add_service}</Text></TouchableOpacity>}>
              {t.car_last_done}
            </SectionTitle>
            <View style={hubStyles.card} testID="hub-car-lastdone">
              {SERVICE_KINDS.filter((k) => k !== "other").map((k, i) => (
                <View key={k} style={[styles.kv, i === 0 ? { borderTopWidth: 0 } : null]}>
                  <Text style={styles.k}>{t.service_kinds[k]}</Text>
                  <Text style={[styles.v, !h.last_done[k] ? { color: colors.muted } : null]}>{h.last_done[k] ? day(h.last_done[k]) : t.car_never}</Text>
                </View>
              ))}
            </View>

            <SectionTitle>{t.car_inspections}</SectionTitle>
            <View style={hubStyles.card} testID="hub-car-checks">
              {h.checks.length === 0 ? <Empty>{t.car_no_inspections}</Empty> : h.checks.map((c, i) => (
                <View key={c.id} style={[styles.block, i === 0 ? { borderTopWidth: 0 } : null]}>
                  <TouchableOpacity style={styles.blockHead} onPress={() => setOpenCheck(openCheck === c.id ? null : c.id)} testID={`hub-check-${i}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={hubStyles.name}>{formatIST(c.created_at)}</Text>
                      <Text style={hubStyles.sub}>
                        {[c.created_by ? t.by_who(c.created_by) : null, c.attention.map((k) => t.check_items[k] ?? k).join(", ")].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    {checkTag(c)}
                  </TouchableOpacity>
                  {openCheck === c.id ? (
                    <View style={styles.detail} testID={`hub-check-detail-${i}`}>
                      {CHECK_ITEMS.filter((k) => c.items[k] && c.items[k].status !== "not_checked").map((k) => (
                        <View key={k} style={styles.itemRow}>
                          <View style={[styles.dot, { backgroundColor: c.items[k].status === "ok" ? colors.live : colors.amber }]} />
                          <Text style={styles.itemText}>
                            {t.check_items[k]}: {c.items[k].status === "ok" ? t.check_ok : t.check_attention}
                            {c.items[k].note ? ` · ${c.items[k].note}` : ""}
                          </Text>
                        </View>
                      ))}
                      {c.battery_note ? <Text style={styles.note}><Text style={styles.noteLabel}>{t.check_battery}: </Text>{c.battery_note}</Text> : null}
                      {c.notes ? <Text style={styles.note}><Text style={styles.noteLabel}>{t.check_notes}: </Text>{c.notes}</Text> : null}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>

            <SectionTitle>{t.car_service_history}</SectionTitle>
            <View style={hubStyles.card} testID="hub-car-services">
              {h.services.length === 0 ? <Empty>{t.car_no_services}</Empty> : h.services.map((sv, i) => (
                <View key={sv.id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}>
                  <View style={{ flex: 1 }}>
                    <Text style={hubStyles.name}>{t.service_kinds[sv.kind] ?? sv.kind}</Text>
                    <Text style={hubStyles.sub}>{[day(sv.service_date), sv.created_by ? t.by_who(sv.created_by) : null].filter(Boolean).join(" · ")}</Text>
                    {sv.note ? <Text style={hubStyles.sub}>{sv.note}</Text> : null}
                  </View>
                  {sv.cost != null ? <Text style={styles.v}>{formatINR(sv.cost)}</Text> : null}
                </View>
              ))}
            </View>

            <SectionTitle>{t.car_shift_changes}</SectionTitle>
            <View style={hubStyles.card} testID="hub-car-handovers">
              {h.handovers.length === 0 ? <Empty>{t.never_changed}</Empty> : h.handovers.map((x, i) => (
                <View key={x.id} style={[styles.block, i === 0 ? { borderTopWidth: 0 } : null]}>
                  <TouchableOpacity style={styles.blockHead} onPress={() => toggleHandover(x.id, x.photo_count ?? 0)} testID={`hub-handover-${i}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={hubStyles.name}>{x.from_driver_name ?? "—"} → {x.to_driver_name ?? "—"}</Text>
                      <Text style={hubStyles.sub}>
                        {[formatIST(x.created_at), x.soc_pct != null ? `${x.soc_pct}%` : null, x.created_by ? t.by_who(x.created_by) : null].filter(Boolean).join(" · ")}
                      </Text>
                      <Text style={hubStyles.sub}>{x.photo_count ? t.tap_for_photos(x.photo_count) : t.photos_none}</Text>
                    </View>
                    {x.damage_note ? (x.damage_repaired_at ? <Tag tone="ok">{t.damage_fixed_tag}</Tag> : <Tag tone="warn">{t.damage_tag}</Tag>) : null}
                  </TouchableOpacity>
                  {openHandover === x.id ? (
                    <View style={styles.detail}>
                      {x.damage_note ? <Text style={styles.note}>{x.damage_note}</Text> : null}
                      {x.photo_count ? (
                        !photos[x.id] ? <Empty>{t.loading}</Empty> : (
                          <View style={styles.photos} testID={`hub-handover-photos-${i}`}>
                            {photos[x.id].map((p, n) => (
                              <View key={n} style={styles.photo}>
                                <Image source={{ uri: uri(p) }} style={styles.photoImg} resizeMode="cover" />
                                <Text style={styles.photoLabel}>{p.label}</Text>
                              </View>
                            ))}
                          </View>
                        )
                      ) : null}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>

            </>
            )}

            {removing ? (
              <View style={[hubStyles.card, styles.danger]} testID="hub-car-remove-confirm">
                <Text style={styles.dangerText}>{t.car_remove_sure(h.vehicle.number ?? "")}</Text>
                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
                  <Btn label={t.cancel} small kind="ghost" onPress={() => setRemoving(false)} disabled={busy} style={{ flex: 1 }} />
                  <Btn label={t.car_remove_yes} small kind="danger" onPress={remove} busy={busy} style={{ flex: 1 }} testID="hub-car-remove-yes" />
                </View>
              </View>
            ) : (
              <Btn label={t.car_remove} kind="danger" onPress={() => { setRemoving(true); }} style={{ marginTop: spacing.xl }} testID="hub-car-remove" />
            )}
          </>
        )}
      </ScrollView>

      <ServiceSheet visible={service} vehicleId={id as string} onClose={() => setService(false)} onDone={(m) => { setService(false); say(m); load(); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { flex: 1, fontFamily: fonts.dataMed, fontSize: 20, color: colors.ink },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.live },
  kv: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.line },
  k: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  v: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.ink },
  block: { borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 10 },
  blockHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  detail: { marginTop: spacing.sm, padding: spacing.md, backgroundColor: colors.paper, borderRadius: radius.md, gap: 6 },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 5 },
  itemText: { flex: 1, fontFamily: fonts.ui, fontSize: 13, color: colors.ink, lineHeight: 18 },
  note: { fontFamily: fonts.ui, fontSize: 13, color: colors.ink, lineHeight: 18 },
  noteLabel: { fontFamily: fonts.uiBold },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photo: { width: "47%" },
  photoImg: { width: "100%", height: 110, borderRadius: radius.sm, backgroundColor: colors.line },
  photoLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 2, textTransform: "capitalize" },
  danger: { marginTop: spacing.xl, borderColor: colors.alert },
  shift: { width: 52, fontFamily: fonts.uiBold, fontSize: 12, color: colors.muted },
  damage: { marginTop: spacing.md, borderColor: colors.amber },
  giveBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  giveRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
  offBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.alert, backgroundColor: colors.paper },
  dangerText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
});
