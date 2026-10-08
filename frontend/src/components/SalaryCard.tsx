// Salary cash-out. Shows what the driver has earned, what has been paid, what
// is being held back against collection cash they still owe, and so what they
// can withdraw now — with a button to withdraw it. When direct withdrawal is
// available the money goes straight to their bank; otherwise the withdrawal
// goes to the hub as a request.
//
// The server owns every number here; the app only asks. A request is sent
// directly (not through the offline queue) because the driver needs to know
// straight away whether it was accepted.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View, ViewStyle } from "react-native";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { BottomSheet, Card } from "@/src/components/ui";
import { formatINR, formatISTDate } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface WithdrawalRequest {
  id: string;
  amount: number;
  state: "pending" | "paid" | "rejected";
  requested_at: string;
  note?: string | null;
}

interface Salary {
  share_rate: number;
  earned: number;
  paid: number;
  pending: number;
  cash_owed: number;
  cash_held_back: number;
  available: number;
  min_amount: number;
  bank_saved: boolean;
  has_pending: boolean;
  requests: WithdrawalRequest[];
  payments?: Payment[];      // absent on older servers
  direct?: boolean;          // a withdrawal goes straight to the bank, no hub approval
}

interface WithdrawResult {
  direct?: boolean;          // true when the money was sent straight away
  request: WithdrawalRequest;
}

// One salary payment the driver received, by transfer or by hand.
interface Payment {
  id: string;
  amount: number;
  at: string;
  method: "bank" | "upi" | "hand";
  status: "paid" | "processing";
  reference?: string | null;
}

const LIVE_TINT = colors.brandTint;
const AMBER_TINT = "#FCF2D9";
const AMBER_INK = "#8A5D00";

// `refreshKey`: change it to make the card reload now (e.g. after a cash
// deposit releases held-back salary).
export const SalaryCard: React.FC<{ style?: ViewStyle; onChanged?: () => void; refreshKey?: number }> = ({ style, onChanged, refreshKey }) => {
  const c = useCardText();
  const [data, setData] = useState<Salary | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Salary>("/money/salary"));
    } catch {
      // keep whatever we had (older server, or offline)
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  const openSheet = () => {
    if (!data) return;
    setAmount(String(Math.floor(data.available)));
    setErr(null);
    setOpen(true);
  };

  const submit = async () => {
    if (!data || busy) return;
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return setErr(c.sal_err_amount);
    if (a > data.available) return setErr(c.sal_err_exceeds);
    if (a < data.min_amount) return setErr(c.sal_below_min(formatINR(data.min_amount)));
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<WithdrawResult>("/money/salary/withdraw", { amount_rupees: a, client_action_id: Crypto.randomUUID() });
      setOpen(false);
      // Sent straight to the bank, or handed to the hub as a request.
      setSent(res?.direct ? c.sal_sent_direct(formatINR(res.request.amount)) : c.sal_sent);
      setTimeout(() => setSent(null), 6000);
      await load();
      onChanged?.();
    } catch (e: any) {
      const d = e?.body?.detail;
      setErr(
        d === "exceeds_available" || d === "nothing_to_withdraw" ? c.sal_err_exceeds
          : d === "withdrawal_pending" ? c.sal_err_pending
            : d === "below_minimum" ? c.sal_below_min(formatINR(data.min_amount))
              : c.sal_err_generic,
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  // Not available on this server yet — show nothing rather than a broken card.
  if (!data) return null;

  const pct = Math.round((data.share_rate ?? 0.3) * 100);
  const pendingReq = data.requests.find((r) => r.state === "pending");
  const openRequests = data.requests.filter((r) => r.state !== "paid");
  const payments = data.payments ?? [];
  const canWithdraw = !data.has_pending && data.available > 0 && data.available >= data.min_amount;

  // Why the button is off, in the driver's terms.
  let hint: string | null = null;
  let hintTone: "wait" | "info" = "info";
  if (pendingReq) {
    hint = c.sal_pending_note(formatINR(pendingReq.amount));
    hintTone = "wait";
  } else if (data.available <= 0 && data.cash_held_back > 0 && data.earned - data.paid > 0) {
    hint = c.sal_pay_cash_first(formatINR(data.cash_owed));
    hintTone = "wait";
  } else if (data.available <= 0) {
    hint = c.sal_nothing;
  } else if (data.available < data.min_amount) {
    hint = c.sal_below_min(formatINR(data.min_amount));
  } else if (!data.bank_saved) {
    hint = c.sal_add_bank;
  }

  return (
    <Card testID="salary-card" style={style}>
      <Text style={styles.title}>{c.sal_title}</Text>

      <View style={styles.summary}>
        <Text style={styles.kicker}>{c.sal_available}</Text>
        <Text style={[styles.hero, data.available > 0 ? styles.heroLive : null]} testID="salary-available">
          {formatINR(data.available)}
        </Text>
      </View>

      <Line label={c.sal_earned(pct)} value={formatINR(data.earned)} />
      <Line label={c.sal_paid} value={`− ${formatINR(data.paid)}`} />
      {data.pending > 0 ? <Line label={c.sal_requested} value={`− ${formatINR(data.pending)}`} /> : null}
      {data.cash_held_back > 0 ? <Line label={c.sal_cash_owed} value={`− ${formatINR(data.cash_held_back)}`} alert /> : null}

      {sent ? <Text style={[styles.hint, styles.hintDone]} testID="salary-sent">{sent}</Text> : null}
      {hint && !sent ? (
        <Text style={[styles.hint, hintTone === "wait" ? styles.hintWait : styles.hintInfo]} testID="salary-hint">{hint}</Text>
      ) : null}

      <TouchableOpacity
        testID="salary-withdraw-btn"
        style={[styles.btn, !canWithdraw ? styles.btnOff : null]}
        onPress={openSheet}
        disabled={!canWithdraw}
      >
        <Text style={styles.btnText}>{c.sal_withdraw}</Text>
      </TouchableOpacity>

      {/* Requests still waiting, or turned down. Paid ones move to the list below. */}
      {openRequests.length > 0 ? (
        <>
          <Text style={styles.section}>{c.sal_recent}</Text>
          {openRequests.slice(0, 3).map((r) => (
            <View key={r.id} style={styles.reqRow} testID={`salary-req-${r.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.reqAmt}>{formatINR(r.amount)}</Text>
                <Text style={styles.reqMeta}>
                  {formatISTDate(r.requested_at)}{r.state === "rejected" && r.note ? ` · ${r.note}` : ""}
                </Text>
              </View>
              <Text style={[styles.badge, r.state === "rejected" ? styles.badgeNo : styles.badgeWait]}>
                {c.sal_state[r.state] ?? r.state}
              </Text>
            </View>
          ))}
        </>
      ) : null}

      {/* Every payment received, by bank / UPI transfer or by hand. */}
      <Text style={styles.section}>{c.sal_payments}</Text>
      {payments.length === 0 ? (
        <Text style={styles.reqMeta} testID="salary-no-payments">{c.sal_no_payments}</Text>
      ) : payments.map((p) => (
        <View key={p.id} style={styles.reqRow} testID={`salary-pay-${p.id}`}>
          <View style={{ flex: 1 }}>
            <Text style={styles.reqAmt}>{formatINR(p.amount)}</Text>
            <Text style={styles.reqMeta}>
              {formatISTDate(p.at)} · {c.sal_pay_method[p.method] ?? p.method}
              {p.reference ? ` · ${c.sal_pay_ref(p.reference)}` : ""}
            </Text>
          </View>
          <Text style={[styles.badge, p.status === "paid" ? styles.badgePaid : styles.badgeWait]}>
            {p.status === "paid" ? c.sal_state.paid : c.sal_pay_processing}
          </Text>
        </View>
      ))}

      <Text style={styles.note}>{data.direct ? c.sal_note_direct : c.sal_note}</Text>

      <BottomSheet visible={open} onClose={() => (busy ? undefined : setOpen(false))} title={c.sal_withdraw} testID="salary-sheet">
        <Text style={styles.sheetLabel}>{c.sal_amount}</Text>
        <TextInput
          testID="salary-amount-input"
          value={amount}
          onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
          keyboardType="numeric"
          style={styles.input}
          placeholder="0"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.sheetHelp}>{c.sal_max(formatINR(data.available))}</Text>
        {data.direct ? <Text style={styles.sheetHelp} testID="salary-direct-help">{c.sal_direct_help}</Text> : null}
        {err ? <Text style={styles.err} testID="salary-err">{err}</Text> : null}
        <TouchableOpacity testID="salary-send-btn" style={[styles.btn, busy ? styles.btnOff : null]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.onBrand} /> : <Text style={styles.btnText}>{data.direct ? c.sal_send_direct : c.sal_send}</Text>}
        </TouchableOpacity>
      </BottomSheet>
    </Card>
  );
};

const Line: React.FC<{ label: string; value: string; alert?: boolean }> = ({ label, value, alert }) => (
  <View style={styles.line}>
    <Text style={[styles.lineLabel, alert ? { color: colors.alert } : null]}>{label}</Text>
    <Text style={[styles.lineVal, alert ? { color: colors.alert } : null]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  summary: { backgroundColor: colors.paper, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  kicker: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.8 },
  hero: { fontFamily: fonts.dataMed, fontSize: 30, color: colors.ink, marginTop: 2 },
  heroLive: { color: colors.live },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 },
  lineLabel: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink, flexShrink: 1, paddingRight: spacing.sm },
  lineVal: { fontFamily: fonts.data, fontSize: 14, color: colors.ink },
  hint: {
    fontFamily: fonts.uiMed, fontSize: 13, borderRadius: radius.md, overflow: "hidden",
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.sm,
  },
  hintInfo: { backgroundColor: colors.paper, color: colors.muted },
  hintWait: { backgroundColor: AMBER_TINT, color: AMBER_INK },
  hintDone: { backgroundColor: LIVE_TINT, color: colors.live, fontFamily: fonts.uiBold },
  btn: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: 14, alignItems: "center", marginTop: spacing.md },
  btnOff: { opacity: 0.4 },
  btnText: { fontFamily: fonts.uiBold, color: colors.onBrand, fontSize: 15 },
  section: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.8, marginTop: spacing.lg, marginBottom: spacing.xs },
  reqRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
  reqAmt: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.ink },
  reqMeta: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 1 },
  badge: { fontFamily: fonts.uiBold, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  badgePaid: { backgroundColor: LIVE_TINT, color: colors.live },
  badgeWait: { backgroundColor: AMBER_TINT, color: AMBER_INK },
  badgeNo: { backgroundColor: "#F8E4E0", color: colors.alert },
  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.md },
  sheetLabel: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.muted, marginTop: spacing.sm },
  input: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card,
    paddingHorizontal: spacing.md, paddingVertical: 12, fontFamily: fonts.dataMed, fontSize: 22, color: colors.ink, marginTop: spacing.xs,
  },
  sheetHelp: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: spacing.xs },
  err: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.alert, marginTop: spacing.sm },
});
