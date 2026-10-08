// Deposit by link — how the driver hands in the collection cash they owe.
//
// One tap asks the server for a payment link for the amount owed and opens it.
// While the link is open the app keeps asking the server whether it has been
// paid (every few seconds, and at once when the driver comes back to the app),
// so "You owe" drops as soon as the payment goes through. The link can also be
// shared, for when someone else is paying on the driver's behalf.
//
// The server owns the amount and decides when a link is paid; the app only
// shows what it is told.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { formatINR } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface DepositLink {
  client_action_id: string;
  status: "created" | "paid" | "expired" | "cancelled";
  short_url: string | null;
  amount: number;
  amount_received: number;
}

const POLL_MS = 3000;
const LIVE_TINT = colors.brandTint;
const AMBER_TINT = "#FCF2D9";
const AMBER_INK = "#8A5D00";

export const DepositByLink: React.FC<{ owe: number; onPaid?: () => void }> = ({ owe, onPaid }) => {
  const c = useCardText();
  const [link, setLink] = useState<DepositLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paidMsg, setPaidMsg] = useState<string | null>(null);
  // The link we are waiting on. Only a payment of THIS link is announced, so
  // an old paid link found on opening the tab is not reported again.
  const waitingFor = useRef<string | null>(null);

  const settle = useCallback((l: DepositLink | null) => {
    if (!l) return setLink(null);
    if (l.status === "created") {
      waitingFor.current = l.client_action_id;
      return setLink(l);
    }
    if (l.status === "paid" && waitingFor.current === l.client_action_id) {
      setPaidMsg(c.dep_paid(formatINR(l.amount_received || l.amount)));
      setTimeout(() => setPaidMsg(null), 8000);
      onPaid?.();
    }
    waitingFor.current = null;
    setLink(null);
  }, [c, onPaid]);

  const check = useCallback(async () => {
    try {
      const r = await api.get<{ link: DepositLink | null }>("/money/deposit-link");
      settle(r.link);
    } catch {
      // older server or offline — try again on the next tick
    }
  }, [settle]);

  // On opening the tab: pick up a link that is still open.
  useEffect(() => {
    check();
  }, [check]);

  // While a link is open, keep checking — and check at once when the driver
  // returns from the payment page.
  const open = link?.status === "created";
  useEffect(() => {
    if (!open) return;
    const id = setInterval(check, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [open, check]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const l = await api.post<DepositLink>("/money/deposit-link", { client_action_id: Crypto.randomUUID() });
      settle(l);
      if (l.status === "created" && l.short_url) await Linking.openURL(l.short_url).catch(() => {});
    } catch (e: any) {
      const d = e?.body?.detail;
      if (d === "just_paid" || d === "no_dues") {
        onPaid?.();          // already settled — just show the new balance
      } else {
        setErr(d === "razorpay_not_configured" ? c.dep_err_setup : c.dep_err_generic);
      }
    } finally {
      setBusy(false);
    }
  };

  const reopen = () => {
    if (link?.short_url) Linking.openURL(link.short_url).catch(() => {});
  };

  const share = () => {
    if (link?.short_url) Share.share({ message: c.dep_share_msg(formatINR(link.amount), link.short_url) }).catch(() => {});
  };

  if (open && link) {
    return (
      <View style={styles.wrap} testID="deposit-link-open">
        <View style={styles.waitRow}>
          <ActivityIndicator color={AMBER_INK} size="small" />
          <Text style={styles.waitText}>{c.dep_waiting(formatINR(link.amount))}</Text>
        </View>
        <TouchableOpacity style={styles.btn} onPress={reopen} testID="deposit-link-reopen">
          <Text style={styles.btnText}>{c.dep_open}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnGhost} onPress={share} testID="deposit-link-share">
          <Text style={styles.btnGhostText}>{c.dep_share}</Text>
        </TouchableOpacity>
        <Text style={styles.note}>{c.dep_note}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {paidMsg ? <Text style={styles.done} testID="deposit-link-paid">{paidMsg}</Text> : null}
      {owe >= 1 ? (
        <>
          <TouchableOpacity style={[styles.btn, busy ? styles.btnOff : null]} onPress={start} disabled={busy} testID="deposit-link-btn">
            {busy ? <ActivityIndicator color={colors.onBrand} /> : <Text style={styles.btnText}>{c.dep_btn(formatINR(owe))}</Text>}
          </TouchableOpacity>
          {err ? <Text style={styles.err} testID="deposit-link-err">{err}</Text> : null}
          <Text style={styles.note}>{c.dep_note}</Text>
        </>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.xs },
  btn: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: 14, alignItems: "center", marginTop: spacing.sm },
  btnOff: { opacity: 0.4 },
  btnText: { fontFamily: fonts.uiBold, color: colors.onBrand, fontSize: 15 },
  btnGhost: {
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card,
    paddingVertical: 12, alignItems: "center", marginTop: spacing.sm,
  },
  btnGhostText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 14 },
  waitRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: AMBER_TINT,
    borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.sm,
  },
  waitText: { flex: 1, fontFamily: fonts.uiMed, fontSize: 13, color: AMBER_INK },
  done: {
    fontFamily: fonts.uiBold, fontSize: 13, color: colors.live, backgroundColor: LIVE_TINT, borderRadius: radius.md,
    overflow: "hidden", paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginTop: spacing.sm,
  },
  err: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.alert, marginTop: spacing.sm },
  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.sm },
});
