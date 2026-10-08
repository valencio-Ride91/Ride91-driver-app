// Money — cash the hub still has to collect, and salary withdrawals waiting
// to be paid or turned down.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { BottomSheet } from "@/src/components/ui";
import { formatINR, formatISTDate } from "@/src/i18n";
import { CashSheet, CashTarget } from "@/src/hub/CashSheet";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, SectionTitle, Tile, hubStyles } from "@/src/hub/ui";
import { colors, spacing } from "@/src/theme";

interface Withdrawal {
  id: string;
  driver_id: string;
  driver_name: string | null;
  amount: number;
  state: "pending" | "paid" | "rejected";
  requested_at: string;
  bank_kind: "bank_account" | "vpa" | null;
  bank_masked: string | null;
  payable_now?: number;
}

// What the manager is doing to a withdrawal: paying by hand (needs a
// reference) or rejecting (needs a reason the driver will read).
type Act = { w: Withdrawal; kind: "manual" | "reject" } | null;

export default function Money() {
  const t = useHubText();
  const { session } = useHubSession();
  const { today, refresh } = useHubToday();
  const hubId = session?.hubId;
  const router = useRouter();
  const [wds, setWds] = useState<Withdrawal[] | null>(null);
  // How far yesterday's earnings entry has got: "6 of 10 drivers entered".
  const [earn, setEarn] = useState<{ entered: number; count: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cash, setCash] = useState<CashTarget | null>(null);
  const [act, setAct] = useState<Act>(null);
  const [text, setText] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadWds = useCallback(async () => {
    if (!hubId) return;
    try {
      const r = await hubApi.get<{ items: Withdrawal[] }>(`/admin/withdrawals?state=pending&hub_id=${hubId}`);
      setWds(r.items);
    } catch {
      // keep what we had
    }
  }, [hubId]);

  useEffect(() => {
    loadWds();
    const id = setInterval(loadWds, 30000);
    return () => clearInterval(id);
  }, [loadWds]);

  const loadEarn = useCallback(async () => {
    if (!hubId) return;
    try {
      const probe = await hubApi.get<{ today: string }>(`/admin/hubs/${hubId}/earnings-day`);
      const y = new Date(`${probe.today}T00:00:00Z`);
      y.setUTCDate(y.getUTCDate() - 1);
      setEarn(await hubApi.get<{ entered: number; count: number }>(`/admin/hubs/${hubId}/earnings-day?date=${y.toISOString().slice(0, 10)}`));
    } catch {
      // older server: the row simply shows no progress
    }
  }, [hubId]);
  // Refresh when coming back from the earnings screen.
  useFocusEffect(useCallback(() => { loadEarn(); }, [loadEarn]));

  const reload = useCallback(async () => {
    await Promise.all([refresh(), loadWds()]);
  }, [refresh, loadWds]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  // One message at a time: a newer one must not be wiped by an older one's timer.
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (m: string) => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(m);
    msgTimer.current = setTimeout(() => setMsg(null), 5000);
  };

  const run = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusyId(id);
    setErr(null);
    try {
      await fn();
      setAct(null);
      say(done);
      await reload();
    } catch {
      setErr(t.action_fail);
    } finally {
      setBusyId(null);
    }
  };

  const payNow = (w: Withdrawal) => run(w.id, () => hubApi.post(`/admin/withdrawals/${w.id}/pay`, { method: "razorpayx" }), t.pay_sent);

  const confirmAct = () => {
    if (!act) return;
    const value = text.trim();
    if (act.kind === "manual") {
      if (value.length < 2) return setErr(t.ref_needed);
      run(act.w.id, () => hubApi.post(`/admin/withdrawals/${act.w.id}/pay`, { method: "manual", reference: value }), t.pay_done);
    } else {
      run(act.w.id, () => hubApi.post(`/admin/withdrawals/${act.w.id}/reject`, { decision: "reject", note: value || null }), t.reject_done);
    }
  };

  const owing = (today?.drivers ?? []).filter((d) => d.you_owe > 0).sort((a, b) => b.you_owe - a.you_owe);

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_money} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {msg ? <Text style={hubStyles.done} testID="hub-money-msg">{msg}</Text> : null}
        {err && !act ? <Text style={[hubStyles.err, { marginBottom: spacing.sm }]}>{err}</Text> : null}

        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <Tile value={formatINR(today?.counts.cash_owed ?? 0)} label={t.cash_to_collect} tone={today?.counts.over_limit ? "bad" : undefined} testID="hub-money-owed" />
          <Tile value={String(wds?.length ?? today?.counts.withdrawals_pending ?? 0)} label={t.withdrawals} testID="hub-money-wd-count" />
        </View>

        <TouchableOpacity style={[hubStyles.card, { marginTop: spacing.md, flexDirection: "row", alignItems: "center" }]}
          onPress={() => router.push("/earnings" as never)} testID="hub-earnings-link">
          <View style={{ flex: 1 }}>
            <Text style={hubStyles.name}>{t.enter_earnings}</Text>
            <Text style={hubStyles.sub}>{earn ? `${t.yesterday_word} · ${t.earnings_progress(earn.entered, earn.count)}` : t.earnings_title}</Text>
          </View>
          <Text style={{ fontSize: 22, color: colors.muted }}>›</Text>
        </TouchableOpacity>

        <SectionTitle>{t.cash_to_collect}</SectionTitle>
        <View style={hubStyles.card} testID="hub-cash-list">
          {!today ? <Empty>{t.loading}</Empty> : owing.length === 0 ? <Empty>{t.nobody_owes}</Empty> : owing.map((d, i) => (
            <View key={d.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} testID={`hub-cash-${d.driver_id}`}>
              <View style={{ flex: 1 }}>
                <Text style={hubStyles.name}>{d.name ?? "—"}</Text>
                <Text style={d.over_limit ? hubStyles.subAlert : hubStyles.sub}>
                  {t.owes(formatINR(d.you_owe))}{d.over_limit ? ` · ${t.over_limit}` : ""}
                </Text>
              </View>
              <Btn label={t.received} small onPress={() => setCash({ driver_id: d.driver_id, name: d.name, you_owe: d.you_owe })} testID={`hub-cash-btn-${d.driver_id}`} />
            </View>
          ))}
        </View>

        <SectionTitle>{t.withdrawal_requests}</SectionTitle>
        <View style={hubStyles.card} testID="hub-wd-list">
          {wds === null ? <Empty>{t.loading}</Empty> : wds.length === 0 ? <Empty>{t.no_withdrawals}</Empty> : wds.map((w, i) => {
            const short = w.payable_now != null && w.amount > w.payable_now + 0.005;
            const busy = busyId === w.id;
            return (
              <View key={w.id} style={[{ paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.line }]} testID={`hub-wd-${w.id}`}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={hubStyles.name}>{w.driver_name ?? "—"}</Text>
                  <Text style={hubStyles.name}>{formatINR(w.amount)}</Text>
                </View>
                <Text style={hubStyles.sub}>
                  {formatISTDate(w.requested_at)} · {w.bank_kind ? t.pay_to(`${w.bank_kind === "vpa" ? "UPI" : "bank"} ${w.bank_masked ?? ""}`.trim()) : t.no_bank}
                </Text>
                {short
                  ? <Text style={hubStyles.subAlert}>{t.less_than_asked} {t.payable_now(formatINR(w.payable_now ?? 0))}</Text>
                  : null}
                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" }}>
                  {today?.razorpayx_ready && w.bank_kind ? (
                    <Btn label={t.pay_now} small onPress={() => payNow(w)} busy={busy} disabled={short} testID={`hub-wd-pay-${w.id}`} />
                  ) : null}
                  <Btn label={t.mark_paid} small kind={today?.razorpayx_ready && w.bank_kind ? "ghost" : "primary"} disabled={short || busy}
                    onPress={() => { setText(""); setErr(null); setAct({ w, kind: "manual" }); }} testID={`hub-wd-manual-${w.id}`} />
                  <Btn label={t.reject} small kind="danger" disabled={busy}
                    onPress={() => { setText(""); setErr(null); setAct({ w, kind: "reject" }); }} testID={`hub-wd-reject-${w.id}`} />
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      <CashSheet target={cash} onClose={() => setCash(null)} onDone={(m) => { setCash(null); say(m); reload(); }} />

      <BottomSheet visible={!!act} onClose={() => (busyId ? undefined : setAct(null))} testID="hub-wd-sheet"
        title={act ? `${act.w.driver_name ?? ""} · ${formatINR(act.w.amount)}` : ""}>
        <Text style={hubStyles.label}>{act?.kind === "manual" ? t.paid_ref : t.reject_why}</Text>
        <TextInput testID="hub-wd-text" value={text} onChangeText={setText} style={hubStyles.input} placeholderTextColor={colors.muted} />
        {err && act ? <Text style={hubStyles.err}>{err}</Text> : null}
        <Btn label={act?.kind === "manual" ? t.mark_paid : t.reject} kind={act?.kind === "reject" ? "danger" : "primary"}
          onPress={confirmAct} busy={!!busyId} style={{ marginTop: spacing.md }} testID="hub-wd-confirm" />
      </BottomSheet>
    </SafeAreaView>
  );
}
