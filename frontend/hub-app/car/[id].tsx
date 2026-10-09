// One car: what the hub does with it and everything on file for it.
//
//   - Shift change, Inspect, Add service — the three things done to a car.
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
import { CHECK_ITEMS, CarCheck, CarHistory, CarsData, SERVICE_KINDS } from "@/src/hub/cars";
import { hubApi, useHubSession } from "@/src/hub/session";
import { ServiceSheet } from "@/src/hub/sheets";
import { useHubText } from "@/src/hub/text";
import { Icon, useToast } from "@/src/hub/kit";
import { Btn, Empty, SectionTitle, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface Photo { label: string; data: string }
const uri = (p: Photo) => (p.data.startsWith("data:") ? p.data : `data:image/jpeg;base64,${p.data}`);
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

  const load = useCallback(async () => {
    if (!signedIn) return;          // the saved session is still being read back
    try {
      setH(await hubApi.get<CarHistory>(`/admin/vehicles/${id}/history`));
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
        checks: [], services: [], last_done: {}, handovers: [],
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
                {[h.vehicle.current_soc != null ? `${t.battery} ${h.vehicle.current_soc}%` : null,
                  limited ? null : h.checks[0] ? t.car_last_inspected(formatISTDate(h.checks[0].created_at)) : t.car_never_inspected].filter(Boolean).join(" · ")}
              </Text>
              <View style={styles.actions}>
                <Btn label={t.shift_change} small kind={limited ? "primary" : "ghost"} onPress={() => router.push(`/handover/${id}` as never)} style={{ flex: 1 }} testID="hub-car-handover" />
                {limited ? null : <Btn label={t.car_inspect} small onPress={() => router.push(`/car-check?vehicle=${id}` as never)} style={{ flex: 1 }} testID="hub-car-inspect" />}
              </View>
            </View>
            {limited ? <Text style={[hubStyles.warn, { marginTop: spacing.md }]} testID="hub-car-limited">{t.car_limited}</Text> : null}

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
                    {x.damage_note ? <Tag tone="warn">{t.damage_tag}</Tag> : null}
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
  dangerText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
});
