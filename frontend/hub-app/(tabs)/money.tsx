// Money — the hub's cash and salary desk.
//
// The dark card on top is the cash still to collect, with how many drivers owe
// it and how many are over the limit. Under it, the day's earnings entry with
// its progress. Then three views, each with its count: To collect (drivers who
// owe cash, with a Received button), Received (what was taken in, with Undo
// for an entry made by mistake) and Withdrawals (salary requests to pay or
// turn down).
import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { BottomSheet } from "@/src/components/ui";
import { formatINR, formatIST, formatISTDate } from "@/src/i18n";
import { CashSheet, CashTarget } from "@/src/hub/CashSheet";
import { Avatar, Icon, ProgressBar, Segmented, useToast } from "@/src/hub/kit";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

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

// Cash a driver handed in and staff recorded.
interface Received {
  id: string;
  driver_name: string | null;
  amount: number;
  reference: string | null;
  recorded_by: string | null;
  created_at: string;
  undone: boolean;
  can_undo: boolean;
}

// What the manager is doing to a withdrawal: paying by hand (needs a
// reference) or rejecting (needs a reason the driver will read).
// "send" is paying through RazorpayX: real money, so it is confirmed first.
type Act = { w: Withdrawal; kind: "manual" | "reject" | "send" } | null;
type Tab = "collect" | "received" | "withdrawals";

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
  const [tab, setTab] = useState<Tab>("collect");
  // The home screen opens this tab on a view (`view=withdrawals`, with a new
  // `at` each tap). Each such request is followed once.
  const { view: wanted, at } = useLocalSearchParams<{ view?: string; at?: string }>();
  const request = wanted === "collect" || wanted === "received" || wanted === "withdrawals" ? `${wanted}:${at ?? ""}` : null;
  const [followed, setFollowed] = useState<string | null>(null);
  if (request && request !== followed) {
    setFollowed(request);
    setTab(wanted as Tab);
  }
  const [err, setErr] = useState<string | null>(null);
  const [received, setReceived] = useState<Received[] | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);     // the entry being asked about

  const loadReceived = useCallback(async () => {
    if (!hubId) return;
    try {
      setReceived((await hubApi.get<{ items: Received[] }>(`/admin/hubs/${hubId}/cash-received?limit=20`)).items);
    } catch {
      setReceived((r) => r ?? []);      // an older server has no such list
    }
  }, [hubId]);

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
  useFocusEffect(useCallback(() => { loadEarn(); loadReceived(); }, [loadEarn, loadReceived]));

  const reload = useCallback(async () => {
    await Promise.all([refresh(), loadWds(), loadReceived()]);
  }, [refresh, loadWds, loadReceived]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const say = useToast();

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

  const undo = async (r: Received) => {
    await run(r.id, () => hubApi.post(`/admin/cash-received/${r.id}/undo`, {}), t.undo_done);
    setUndoing(null);
  };

  const confirmAct = () => {
    if (!act) return;
    const value = text.trim();
    if (act.kind === "send") {
      run(act.w.id, () => hubApi.post(`/admin/withdrawals/${act.w.id}/pay`, { method: "razorpayx" }), t.pay_sent);
    } else if (act.kind === "manual") {
      if (value.length < 2) return setErr(t.ref_needed);
      run(act.w.id, () => hubApi.post(`/admin/withdrawals/${act.w.id}/pay`, { method: "manual", reference: value }), t.pay_done);
    } else {
      run(act.w.id, () => hubApi.post(`/admin/withdrawals/${act.w.id}/reject`, { decision: "reject", note: value || null }), t.reject_done);
    }
  };

  const owing = (today?.drivers ?? []).filter((d) => d.you_owe > 0).sort((a, b) => b.you_owe - a.you_owe);

  const c = today?.counts;
  const over = c?.over_limit ?? 0;
  const pending = wds?.length ?? c?.withdrawals_pending ?? 0;

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_money} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={styles.hero} testID="hub-money-owed">
          <Text style={styles.heroLabel}>{t.cash_to_collect}</Text>
          <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>{formatINR(c?.cash_owed ?? 0)}</Text>
          <View style={styles.heroLine}>
            <Text style={styles.heroSub}>{t.owe_count(owing.length)}</Text>
            {over ? <View style={styles.heroFlag}><Text style={styles.heroFlagText}>{t.over_count(over)}</Text></View> : null}
          </View>
        </View>

        <TouchableOpacity style={[hubStyles.card, styles.earn]} onPress={() => router.push("/earnings" as never)} testID="hub-earnings-link">
          <View style={styles.earnIcon}><Icon name="create-outline" size={20} color={colors.live} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={hubStyles.name}>{t.enter_earnings}</Text>
            <Text style={hubStyles.sub}>{earn ? `${t.yesterday_word} · ${t.earnings_progress(earn.entered, earn.count)}` : t.earnings_title}</Text>
            {earn && earn.count ? <View style={{ marginTop: 6 }}><ProgressBar value={earn.entered / earn.count} /></View> : null}
          </View>
          <Icon name="chevron-forward" size={18} color={colors.muted} />
        </TouchableOpacity>

        <Segmented
          style={{ marginTop: spacing.lg }} testID="hub-money-tab" value={tab} onChange={setTab}
          options={[
            { key: "collect", label: t.seg_collect, count: owing.length },
            { key: "received", label: t.received },
            { key: "withdrawals", label: t.withdrawals, count: pending },
          ]}
        />
        {err && !act ? <Text style={hubStyles.err}>{err}</Text> : null}

        {tab === "collect" ? (
          <View style={[hubStyles.card, styles.panel]} testID="hub-cash-list">
            {!today ? <Empty>{t.loading}</Empty> : owing.length === 0 ? (
              <View style={styles.blank}>
                <Icon name="checkmark-circle-outline" size={40} color={colors.brand} />
                <Text style={styles.blankText}>{t.nobody_owes}</Text>
              </View>
            ) : owing.map((d, i) => (
              <View key={d.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} testID={`hub-cash-${d.driver_id}`}>
                <Avatar name={d.name} tone={d.over_limit ? "bad" : "mute"} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={hubStyles.name} numberOfLines={1}>{d.name ?? "—"}</Text>
                  <View style={styles.inline}>
                    <Text style={[styles.amount, d.over_limit ? { color: colors.alert } : null]}>{formatINR(d.you_owe)}</Text>
                    {d.over_limit ? <Tag tone="bad">{t.over_limit}</Tag> : null}
                  </View>
                </View>
                <Btn label={t.received} small onPress={() => setCash({ driver_id: d.driver_id, name: d.name, you_owe: d.you_owe })} testID={`hub-cash-btn-${d.driver_id}`} />
              </View>
            ))}
          </View>
        ) : null}

        {tab === "received" ? (
          <View style={[hubStyles.card, styles.panel]} testID="hub-received-list">
            {received === null ? <Empty>{t.loading}</Empty> : received.length === 0 ? <Empty>{t.cash_received_none}</Empty> : received.map((r, i) => (
              <View key={r.id} style={[styles.entry, i === 0 ? { borderTopWidth: 0 } : null]} testID={`hub-received-${r.id}`}>
                <View style={styles.entryTop}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[hubStyles.name, r.undone ? styles.struck : null]} numberOfLines={1}>{r.driver_name ?? "—"}</Text>
                    <Text style={hubStyles.sub} numberOfLines={2}>{[formatIST(r.created_at), r.reference, r.recorded_by ? t.by_who(r.recorded_by) : null].filter(Boolean).join(" · ")}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={[styles.amount, r.undone ? styles.struck : { color: colors.live }]}>{formatINR(r.amount)}</Text>
                    {r.undone ? <Tag tone="mute">{t.undone}</Tag>
                      : r.can_undo && undoing !== r.id ? (
                        <TouchableOpacity onPress={() => { setErr(null); setUndoing(r.id); }} hitSlop={8} testID={`hub-undo-${r.id}`}>
                          <Text style={styles.link}>{t.undo}</Text>
                        </TouchableOpacity>
                      ) : null}
                  </View>
                </View>
                {undoing === r.id ? (
                  <View style={styles.confirm} testID="hub-undo-confirm">
                    <Text style={styles.confirmText}>{t.undo_sure(formatINR(r.amount), r.driver_name ?? "")}</Text>
                    <View style={styles.btns}>
                      <Btn label={t.cancel} small kind="ghost" onPress={() => setUndoing(null)} disabled={busyId === r.id} style={{ flex: 1 }} />
                      <Btn label={t.undo_yes} small kind="danger" onPress={() => undo(r)} busy={busyId === r.id} style={{ flex: 1 }} testID="hub-undo-yes" />
                    </View>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {tab === "withdrawals" ? (
          <View style={styles.cards} testID="hub-wd-list">
            {wds === null ? <Empty>{t.loading}</Empty> : wds.length === 0 ? (
              <View style={styles.blank}>
                <Icon name="checkmark-done-circle-outline" size={40} color={colors.line} />
                <Text style={styles.blankText}>{t.no_withdrawals}</Text>
              </View>
            ) : wds.map((w) => {
              const short = w.payable_now != null && w.amount > w.payable_now + 0.005;
              const busy = busyId === w.id;
              const canSend = !!today?.razorpayx_ready && !!w.bank_kind;
              return (
                <View key={w.id} style={hubStyles.card} testID={`hub-wd-${w.id}`}>
                  <View style={styles.entryTop}>
                    <Avatar name={w.driver_name} tone={short ? "warn" : "ok"} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={hubStyles.name} numberOfLines={1}>{w.driver_name ?? "—"}</Text>
                      <Text style={hubStyles.sub} numberOfLines={2}>
                        {formatISTDate(w.requested_at)} · {w.bank_kind ? t.pay_to(`${w.bank_kind === "vpa" ? "UPI" : "bank"} ${w.bank_masked ?? ""}`.trim()) : t.no_bank}
                      </Text>
                    </View>
                    <Text style={styles.amount}>{formatINR(w.amount)}</Text>
                  </View>
                  {short ? <Text style={[hubStyles.warn, { marginTop: spacing.md, marginBottom: 0 }]}>{t.less_than_asked} {t.payable_now(formatINR(w.payable_now ?? 0))}</Text> : null}
                  <View style={styles.btns}>
                    <Btn label={t.reject} small kind="danger" disabled={busy} style={{ flex: 1 }}
                      onPress={() => { setText(""); setErr(null); setAct({ w, kind: "reject" }); }} testID={`hub-wd-reject-${w.id}`} />
                    <Btn label={t.mark_paid} small kind={canSend ? "ghost" : "primary"} disabled={short || busy} style={{ flex: 1 }}
                      onPress={() => { setText(""); setErr(null); setAct({ w, kind: "manual" }); }} testID={`hub-wd-manual-${w.id}`} />
                    {canSend ? <Btn label={t.pay_now} small disabled={short || busy} style={{ flex: 1 }}
                      onPress={() => { setErr(null); setAct({ w, kind: "send" }); }} testID={`hub-wd-pay-${w.id}`} /> : null}
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <CashSheet target={cash} onClose={() => setCash(null)} onDone={(m) => { setCash(null); say(m); reload(); }} />

      <BottomSheet visible={!!act} onClose={() => (busyId ? undefined : setAct(null))} testID="hub-wd-sheet"
        title={act ? `${act.w.driver_name ?? ""} · ${formatINR(act.w.amount)}` : ""}>
        {act?.kind === "send" ? (
          <Text style={styles.confirmText} testID="hub-wd-sure">
            {t.pay_now_sure(formatINR(act.w.amount), `${act.w.bank_kind === "vpa" ? "UPI" : "bank"} ${act.w.bank_masked ?? ""}`.trim())}
          </Text>
        ) : (
          <>
            <Text style={hubStyles.label}>{act?.kind === "manual" ? t.paid_ref : t.reject_why}</Text>
            <TextInput testID="hub-wd-text" value={text} onChangeText={setText} style={hubStyles.input} placeholderTextColor={colors.muted} />
          </>
        )}
        {err && act ? <Text style={hubStyles.err} testID="hub-wd-err">{err}</Text> : null}
        <Btn label={act?.kind === "send" ? t.pay_now : act?.kind === "manual" ? t.mark_paid : t.reject} kind={act?.kind === "reject" ? "danger" : "primary"}
          onPress={confirmAct} busy={!!busyId} style={{ marginTop: spacing.md }} testID="hub-wd-confirm" />
      </BottomSheet>
    </SafeAreaView>
  );
}

const ON_DARK = "#C9CDC5";       // quiet text on the charcoal card

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.ink, borderRadius: radius.xl, padding: spacing.lg },
  heroLabel: { fontFamily: fonts.uiMed, fontSize: 13, color: ON_DARK },
  heroAmount: { fontFamily: fonts.display, fontSize: 44, lineHeight: 52, color: colors.white, marginTop: 2 },
  heroLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4, flexWrap: "wrap" },
  heroSub: { fontFamily: fonts.uiMed, fontSize: 14, color: ON_DARK },
  heroFlag: { backgroundColor: "#E8806F", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  heroFlagText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.onBrand },
  earn: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.md },
  earnIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" },
  panel: { marginTop: spacing.md, paddingVertical: 2 },
  cards: { marginTop: spacing.md, gap: spacing.md },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 2 },
  amount: { fontFamily: fonts.dataMed, fontSize: 16, color: colors.ink },
  struck: { textDecorationLine: "line-through", color: colors.muted },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.alert },
  entry: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line },
  entryTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  confirm: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: "#F8E4E0" },
  confirmText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 20 },
  btns: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  blank: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl },
  blankText: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted, textAlign: "center" },
});
