// Daily earnings — the hub keys in what each driver earned on each app for a
// day (total fares, and how much of it was cash). These figures drive the
// driver's salary and the cash they owe, so each save is one app for one
// driver for one day, and an official Uber-report figure can never be typed
// over.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { BottomSheet } from "@/src/components/ui";
import { formatINR, formatISTDate } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, platformColors, platformLabels, spacing } from "@/src/theme";

const APPS = ["uber", "rapido", "ola"] as const;
type App = (typeof APPS)[number];

interface AppEntry { gross: number | null; cash: number | null; locked: boolean }
interface Row {
  driver_id: string;
  name: string | null;
  shift_type: string;
  apps: Record<string, AppEntry | null>;
  gross_total: number;
  cash_total: number;
  entered: boolean;
}
interface Day { date: string; today: string; items: Row[]; count: number; entered: number }

type Draft = Record<App, { gross: string; cash: string }>;

// Step a YYYY-MM-DD date by whole days.
function shiftDate(d: string, days: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}

export default function Earnings() {
  const t = useHubText();
  const router = useRouter();
  const { session } = useHubSession();
  const { refresh } = useHubToday();
  const hubId = session?.hubId;
  const [date, setDate] = useState<string | null>(null);     // null = let the server pick yesterday
  const [day, setDay] = useState<Day | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (d: string | null) => {
    if (!hubId) return;
    try {
      // Earnings are normally entered the morning after, so open on yesterday.
      let target = d;
      if (!target) {
        const probe = await hubApi.get<Day>(`/admin/hubs/${hubId}/earnings-day`);
        target = shiftDate(probe.today, -1);
        setDate(target);
      }
      setDay(await hubApi.get<Day>(`/admin/hubs/${hubId}/earnings-day?date=${target}`));
    } catch {
      // keep what we had
    }
  }, [hubId]);

  useEffect(() => {
    load(date);
    // only when the chosen date changes; `load` is stable per hub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, hubId]);

  const open = (r: Row) => {
    const d = {} as Draft;
    for (const a of APPS) {
      const e = r.apps[a];
      d[a] = { gross: e?.gross != null ? String(e.gross) : "", cash: e?.cash != null ? String(e.cash) : "" };
    }
    setDraft(d);
    setErr(null);
    setEditing(r);
  };

  const save = async () => {
    if (!editing || !draft || !day || busy) return;
    setErr(null);
    // Only apps that are not locked, have a fares figure, and actually changed.
    const todo: { app: App; gross: number; cash: number }[] = [];
    for (const a of APPS) {
      const was = editing.apps[a];
      if (was?.locked) continue;
      const g = draft[a].gross.trim(), c = draft[a].cash.trim();
      if (g === "" && c === "") continue;
      const gross = Number(g || "0"), cash = Number(c || "0");
      if (!Number.isFinite(gross) || !Number.isFinite(cash) || gross < 0 || cash < 0) return setErr(t.earn_bad);
      if (cash > gross) return setErr(t.earn_cash_more);
      if (was && was.gross === gross && (was.cash ?? 0) === cash) continue;
      todo.push({ app: a, gross, cash });
    }
    if (todo.length === 0) {
      const anything = APPS.some((a) => draft[a].gross.trim() !== "" || editing.apps[a]?.locked);
      if (!anything) return setErr(t.earn_nothing);
      return setEditing(null);
    }
    setBusy(true);
    try {
      for (const x of todo) {
        await hubApi.post(`/admin/drivers/${editing.driver_id}/earnings`, {
          business_date: day.date, platform: x.app, gross_amount: x.gross, cash_amount: x.cash,
        });
      }
      const name = editing.name ?? "";
      setEditing(null);
      if (msgTimer.current) clearTimeout(msgTimer.current);
      setMsg(t.earn_saved(name));
      msgTimer.current = setTimeout(() => setMsg(null), 4000);
      await Promise.all([load(day.date), refresh()]);
    } catch (e: any) {
      setErr(e?.body?.detail === "already_imported" ? t.from_report : t.action_fail);
    } finally {
      setBusy(false);
    }
  };

  const atToday = !!day && !!date && date >= day.today;
  const dayLabel = !day || !date ? "" : date === day.today ? t.today_word : date === shiftDate(day.today, -1) ? t.yesterday_word : "";

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/money" as never))} style={styles.back} testID="hub-earn-back">
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title} testID="hub-earn-title">{t.earnings_title}</Text>
      </View>

      <ScrollView contentContainerStyle={hubStyles.scroll}>
        <View style={styles.dateRow}>
          <Btn label="‹" small kind="ghost" onPress={() => date && setDate(shiftDate(date, -1))} testID="hub-earn-prev" />
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={styles.date} testID="hub-earn-date">{date ? formatISTDate(`${date}T12:00:00+05:30`) : ""}</Text>
            <Text style={hubStyles.sub}>{[dayLabel, day ? t.earnings_progress(day.entered, day.count) : ""].filter(Boolean).join(" · ")}</Text>
          </View>
          <Btn label="›" small kind="ghost" disabled={atToday} onPress={() => date && setDate(shiftDate(date, 1))} testID="hub-earn-next" />
        </View>
        {msg ? <Text style={hubStyles.done} testID="hub-earn-msg">{msg}</Text> : null}

        {!day ? <Empty>{t.loading}</Empty> : (
          <View style={hubStyles.card} testID="hub-earn-list">
            {day.items.length === 0 ? <Empty>{t.no_drivers}</Empty> : day.items.map((r, i) => (
              <TouchableOpacity key={r.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} onPress={() => open(r)} testID={`hub-earn-${r.driver_id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.name}>{r.name ?? "—"}</Text>
                  {r.entered ? (
                    <Text style={hubStyles.sub}>
                      {APPS.filter((a) => r.apps[a]?.gross != null).map((a) => `${platformLabels[a]} ${formatINR(r.apps[a]!.gross ?? 0)}`).join(" · ")}
                    </Text>
                  ) : <Text style={hubStyles.sub}>{r.shift_type}</Text>}
                </View>
                {r.entered
                  ? <View style={{ alignItems: "flex-end" }}><Text style={styles.total}>{formatINR(r.gross_total)}</Text><Text style={hubStyles.sub}>{t.cash_collected.replace(" (₹)", "")} {formatINR(r.cash_total)}</Text></View>
                  : <Tag tone="warn">{t.not_entered}</Tag>}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      <BottomSheet visible={!!editing} onClose={() => (busy ? undefined : setEditing(null))} title={editing ? `${editing.name ?? ""} · ${day?.date ?? ""}` : ""} testID="hub-earn-sheet">
        <View style={styles.headRow}>
          <Text style={[styles.colApp]} />
          <Text style={styles.colHead}>{t.fares_total}</Text>
          <Text style={styles.colHead}>{t.cash_collected}</Text>
        </View>
        {editing && draft ? APPS.map((a) => {
          const locked = !!editing.apps[a]?.locked;
          return (
            <View key={a}>
              <View style={styles.appRow}>
                <View style={styles.colApp}>
                  <View style={[styles.dot, { backgroundColor: platformColors[a] }]} />
                  <Text style={styles.appName}>{platformLabels[a]}</Text>
                </View>
                <TextInput testID={`hub-earn-gross-${a}`} editable={!locked} value={draft[a].gross} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.muted}
                  onChangeText={(v) => setDraft({ ...draft, [a]: { ...draft[a], gross: v.replace(/[^0-9.]/g, "") } })}
                  style={[hubStyles.input, styles.num, locked ? styles.locked : null]} />
                <TextInput testID={`hub-earn-cash-${a}`} editable={!locked} value={draft[a].cash} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.muted}
                  onChangeText={(v) => setDraft({ ...draft, [a]: { ...draft[a], cash: v.replace(/[^0-9.]/g, "") } })}
                  style={[hubStyles.input, styles.num, locked ? styles.locked : null]} />
              </View>
              {locked ? <Text style={[hubStyles.sub, { marginBottom: 4 }]}>{t.from_report}</Text> : null}
            </View>
          );
        }) : null}
        {err ? <Text style={hubStyles.err} testID="hub-earn-err">{err}</Text> : null}
        <Btn label={t.save} onPress={save} busy={busy} style={{ marginTop: spacing.md }} testID="hub-earn-save" />
      </BottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  backText: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.ink, lineHeight: 32 },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  dateRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  date: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink },
  total: { fontFamily: fonts.dataMed, fontSize: 16, color: colors.ink },
  headRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, marginTop: spacing.sm },
  colHead: { flex: 1, fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted },
  appRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  colApp: { width: 74, flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  appName: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink },
  num: { flex: 1, fontFamily: fonts.dataMed, paddingVertical: 9 },
  locked: { backgroundColor: colors.paper, color: colors.muted },
});
