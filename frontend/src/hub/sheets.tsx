// The hub app's small pop-up forms: add a car, add a service entry, message
// every driver, and record "not coming" for a driver who phoned in.
//
// Each form's body is mounted only while its sheet is open, so it starts
// empty every time and carries one id for the whole attempt — a second tap on
// Save, or a retry after a dropped connection, cannot create a second record.
import React, { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Crypto from "expo-crypto";

import { BottomSheet } from "@/src/components/ui";
import { SERVICE_KINDS } from "@/src/hub/cars";
import { hubApi } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { Btn, hubStyles } from "@/src/hub/ui";
import { colors, fonts, spacing } from "@/src/theme";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
// Today in India, as YYYY-MM-DD.
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const Chips: React.FC<{ options: readonly string[]; labels: Record<string, string>; value: string | null; onPick: (v: string) => void; testID: string }> = ({ options, labels, value, onPick, testID }) => (
  <View style={styles.chips}>
    {options.map((o) => (
      <TouchableOpacity key={o} onPress={() => onPick(o)} style={[styles.chip, value === o ? styles.chipOn : null]} testID={`${testID}-${o}`}>
        <Text style={[styles.chipText, value === o ? styles.chipTextOn : null]}>{labels[o] ?? o}</Text>
      </TouchableOpacity>
    ))}
  </View>
);

interface SheetProps { visible: boolean; onClose: () => void; onDone: (message: string) => void }

// ---- add a car --------------------------------------------------------------
export const AddCarSheet: React.FC<SheetProps & { hubId: string }> = ({ visible, onClose, onDone, hubId }) => {
  const t = useHubText();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t.car_add_title} testID="hub-car-sheet">
      {visible ? <AddCarBody hubId={hubId} onDone={onDone} /> : null}
    </BottomSheet>
  );
};

const AddCarBody: React.FC<{ hubId: string; onDone: (m: string) => void }> = ({ hubId, onDone }) => {
  const t = useHubText();
  const [number, setNumber] = useState("");
  const [model, setModel] = useState("Citroën ëC3");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    if (number.trim().length < 3) return setErr(t.car_number_bad);
    setBusy(true);
    setErr(null);
    try {
      await hubApi.post("/admin/vehicles", { number: number.trim(), model: model.trim() || "Citroën ëC3", hub_id: hubId });
      onDone(t.car_added);
    } catch (e: any) {
      const code = e?.body?.detail;
      setErr(code === "vehicle_number_exists" ? t.car_number_taken : code === "hub_full" ? t.car_hub_full : t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={hubStyles.label}>{t.car_number}</Text>
      <TextInput testID="hub-car-number" value={number} onChangeText={setNumber} autoCapitalize="characters" autoCorrect={false} placeholder="MH-14-EV-1001" placeholderTextColor={colors.muted} style={[hubStyles.input, styles.mono]} />
      <Text style={hubStyles.label}>{t.car_model}</Text>
      <TextInput testID="hub-car-model" value={model} onChangeText={setModel} style={hubStyles.input} />
      {err ? <Text style={hubStyles.err} testID="hub-car-err">{err}</Text> : null}
      <Btn label={t.car_add_title} onPress={save} busy={busy} style={{ marginTop: spacing.md }} testID="hub-car-save" />
    </>
  );
};

// ---- work done on a car -----------------------------------------------------
export const ServiceSheet: React.FC<SheetProps & { vehicleId: string }> = ({ visible, onClose, onDone, vehicleId }) => {
  const t = useHubText();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t.car_add_service} testID="hub-svc-sheet">
      {visible ? <ServiceBody vehicleId={vehicleId} onDone={onDone} /> : null}
    </BottomSheet>
  );
};

const ServiceBody: React.FC<{ vehicleId: string; onDone: (m: string) => void }> = ({ vehicleId, onDone }) => {
  const t = useHubText();
  const [actionId] = useState(() => Crypto.randomUUID());
  const [kind, setKind] = useState<string>("service");
  const [date, setDate] = useState(todayIST);
  const [note, setNote] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    const d = date.trim();
    if (!YMD.test(d) || Number.isNaN(Date.parse(d)) || d > todayIST()) return setErr(t.svc_bad_date);
    if (kind === "other" && !note.trim()) return setErr(t.svc_note_needed);
    setBusy(true);
    setErr(null);
    try {
      await hubApi.post(`/admin/vehicles/${vehicleId}/services`, {
        kind, service_date: d, note: note.trim() || null, cost: cost.trim() ? Number(cost) : null, client_action_id: actionId,
      });
      onDone(t.svc_saved);
    } catch (e: any) {
      const code = e?.body?.detail;
      setErr(code === "bad_date" || code === "date_in_future" ? t.svc_bad_date : code === "note_required" ? t.svc_note_needed : t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={hubStyles.label}>{t.svc_kind}</Text>
      <Chips options={SERVICE_KINDS} labels={t.service_kinds} value={kind} onPick={setKind} testID="hub-svc-kind" />
      <Text style={hubStyles.label}>{t.svc_date}</Text>
      <TextInput testID="hub-svc-date" value={date} onChangeText={setDate} keyboardType="numbers-and-punctuation" maxLength={10} style={[hubStyles.input, styles.mono]} />
      <Text style={hubStyles.label}>{t.svc_note}</Text>
      <TextInput testID="hub-svc-note" value={note} onChangeText={setNote} multiline style={[hubStyles.input, styles.area]} />
      <Text style={hubStyles.label}>{t.svc_cost}</Text>
      <TextInput testID="hub-svc-cost" value={cost} onChangeText={(v) => setCost(v.replace(/[^0-9.]/g, ""))} keyboardType="numeric" style={[hubStyles.input, styles.mono]} />
      {err ? <Text style={hubStyles.err} testID="hub-svc-err">{err}</Text> : null}
      <Btn label={t.save} onPress={save} busy={busy} style={{ marginTop: spacing.md }} testID="hub-svc-save" />
    </>
  );
};

// ---- one message to every driver ------------------------------------------
export const BroadcastSheet: React.FC<SheetProps & { hubId: string }> = ({ visible, onClose, onDone, hubId }) => {
  const t = useHubText();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t.msg_all_title} testID="hub-bc-sheet">
      {visible ? <BroadcastBody hubId={hubId} onDone={onDone} /> : null}
    </BottomSheet>
  );
};

const BroadcastBody: React.FC<{ hubId: string; onDone: (m: string) => void }> = ({ hubId, onDone }) => {
  const t = useHubText();
  const [actionId] = useState(() => Crypto.randomUUID());
  const [to, setTo] = useState<string>("all");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    if (busy || !body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await hubApi.post<{ sent: number }>(`/admin/hubs/${hubId}/broadcast`, { body: body.trim(), shift_type: to, client_action_id: actionId });
      onDone(t.msg_all_sent(r.sent));
    } catch {
      setErr(t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Chips options={["all", "day", "night"]} labels={{ all: t.set_everyone, day: t.set_day, night: t.set_night }} value={to} onPick={setTo} testID="hub-bc-to" />
      <TextInput testID="hub-bc-body" value={body} onChangeText={setBody} multiline maxLength={1000} placeholder={t.type_message} placeholderTextColor={colors.muted} style={[hubStyles.input, styles.area, { marginTop: spacing.md }]} />
      {err ? <Text style={hubStyles.err}>{err}</Text> : null}
      <Btn label={t.send} onPress={send} busy={busy} disabled={!body.trim()} style={{ marginTop: spacing.md }} testID="hub-bc-send" />
    </>
  );
};

// ---- "not coming", for a driver who phoned in -------------------------------
const REASONS = ["unwell", "family_emergency", "vehicle_problem", "transport_problem", "personal", "other"] as const;

export const NotComingSheet: React.FC<SheetProps & { driverId: string; name: string }> = ({ visible, onClose, onDone, driverId, name }) => {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={name} testID="hub-nc-sheet">
      {visible ? <NotComingBody driverId={driverId} onDone={onDone} /> : null}
    </BottomSheet>
  );
};

const NotComingBody: React.FC<{ driverId: string; onDone: (m: string) => void }> = ({ driverId, onDone }) => {
  const t = useHubText();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [backBy, setBackBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    if (!reason || (reason === "other" && !note.trim())) return setErr(t.need_reason);
    const back = backBy.trim();
    if (back && (!YMD.test(back) || Number.isNaN(Date.parse(back)))) return setErr(t.bad_date);
    setBusy(true);
    setErr(null);
    try {
      await hubApi.post(`/admin/drivers/${driverId}/shift-answer`, {
        response: "not_coming", reason_code: reason, reason_note: reason === "other" ? note.trim() : null, back_by: back || null,
      });
      onDone(t.answer_saved);
    } catch (e: any) {
      setErr(e?.body?.detail === "bad_date" ? t.bad_date : t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={hubStyles.label}>{t.answer_why}</Text>
      <Chips options={REASONS} labels={t.reasons} value={reason} onPick={setReason} testID="hub-nc-reason" />
      {reason === "other" ? (
        <>
          <Text style={hubStyles.label}>{t.other_reason}</Text>
          <TextInput testID="hub-nc-note" value={note} onChangeText={setNote} maxLength={200} style={hubStyles.input} />
        </>
      ) : null}
      <Text style={hubStyles.label}>{t.back_by_label}</Text>
      <TextInput testID="hub-nc-back" value={backBy} onChangeText={setBackBy} keyboardType="numbers-and-punctuation" maxLength={10} placeholder="2026-10-12" placeholderTextColor={colors.muted} style={[hubStyles.input, styles.mono]} />
      {err ? <Text style={hubStyles.err} testID="hub-nc-err">{err}</Text> : null}
      <Btn label={t.mark_not_coming} kind="danger" onPress={save} busy={busy} style={{ marginTop: spacing.md }} testID="hub-nc-save" />
    </>
  );
};

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink },
  chipTextOn: { color: colors.white },
  mono: { fontFamily: fonts.dataMed },
  area: { minHeight: 76, textAlignVertical: "top" },
});
