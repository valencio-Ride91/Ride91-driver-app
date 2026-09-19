// Deposit QR bottom sheet shown from Home (banner) and Money (button).
//
// Replaces the old pseudo-QR (a dot grid hashed from the driver id, printing
// the static RIDE91-DEPOSIT-xxxx placeholder). This mints a real dynamic UPI
// QR from Razorpay — single-use, fixed-amount — so the driver can pay dues
// from any UPI app instead of the hosted checkout.
//
// The amount is never chosen here: the server sets it from the driver's
// actual dues. This screen only displays what it was handed.
//
// State machine:
//   loading -> active -> paid       (server confirmed via webhook, polled)
//                     -> expired    (close_by passed unpaid)
//           -> error | no_dues
//
// Payment is confirmed by polling the server, never by the driver saying so.
// The QR leaving the screen is not evidence that money moved.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Image } from "expo-image";
import * as Crypto from "expo-crypto";

import { BottomSheet } from "@/src/components/ui";
import { api, ApiError } from "@/src/api";
import { formatINR, useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

const POLL_MS = 3000;

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Dues in paise, from money/today. Used only to skip the call at zero. */
  duesPaise: number;
  /** Fired once the server confirms payment, so the parent can refetch. */
  onPaid?: () => void;
}

interface QrResp {
  qr_code_id: string;
  image_url: string | null;
  amount_paise: number;
  status: string;
  close_by: number;
  expires_in_seconds?: number;
}

interface QrStatusResp {
  status: "active" | "reconciled" | "closed" | string;
  qr_code_id: string;
  image_url: string | null;
  amount_paise: number;
  amount_received_paise?: number;
  payment_id?: string;
  close_by: number;
  expired: boolean;
  reconciled_at?: string;
}

type Phase = "loading" | "active" | "paid" | "expired" | "error" | "no_dues";

const mmss = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const DepositSheet: React.FC<Props> = ({ visible, onClose, duesPaise, onPaid }) => {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [qr, setQr] = useState<QrResp | null>(null);
  const [remaining, setRemaining] = useState(0);
  const actionId = useRef<string | null>(null);
  const paidNotified = useRef(false);

  const mint = useCallback(async () => {
    if (duesPaise <= 0) {
      setPhase("no_dues");
      return;
    }
    setPhase("loading");
    setQr(null);
    paidNotified.current = false;
    try {
      const cid = Crypto.randomUUID();
      actionId.current = cid;
      const r = await api.post<QrResp>("/payments/razorpay/qr", {
        client_action_id: cid,
      });
      setQr(r);
      setRemaining(r.close_by - Math.floor(Date.now() / 1000));
      setPhase("active");
    } catch (e) {
      const body = (e as ApiError)?.body as { detail?: string } | undefined;
      setPhase(body?.detail === "no_dues" ? "no_dues" : "error");
    }
  }, [duesPaise]);

  // Mint on open; clear on close so reopening never shows a stale QR.
  useEffect(() => {
    if (visible) {
      void mint();
    } else {
      actionId.current = null;
      setQr(null);
      setPhase("loading");
    }
  }, [visible, mint]);

  // Countdown. Expiry follows close_by from the server, not a local timer.
  useEffect(() => {
    if (phase !== "active" || !qr) return;
    const tick = setInterval(() => {
      const left = qr.close_by - Math.floor(Date.now() / 1000);
      setRemaining(left);
      if (left <= 0) setPhase("expired");
    }, 1000);
    return () => clearInterval(tick);
  }, [phase, qr]);

  // Poll for confirmation. Only 'reconciled' counts as paid.
  useEffect(() => {
    if (phase !== "active" || !actionId.current) return;
    let live = true;
    const poll = setInterval(async () => {
      const cid = actionId.current;
      if (!cid || !live) return;
      try {
        const s = await api.get<QrStatusResp>(`/payments/razorpay/qr/${cid}`);
        if (!live) return;
        if (s.status === "reconciled") {
          setPhase("paid");
          if (!paidNotified.current) {
            paidNotified.current = true;
            onPaid?.();
          }
        } else if (s.status === "closed" || s.expired) {
          setPhase("expired");
        }
      } catch {
        // Transient — the webhook may lag. Keep polling until expiry.
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [phase, onPaid]);

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t.deposit_cash} testID="deposit-sheet">
      {phase === "loading" ? (
        <View style={styles.center} testID="deposit-loading">
          <ActivityIndicator color={colors.live} />
        </View>
      ) : phase === "no_dues" ? (
        <View style={styles.center} testID="deposit-no-dues">
          <Text style={styles.bigMsg}>{t.qr_no_dues}</Text>
        </View>
      ) : phase === "error" ? (
        <View style={styles.center} testID="deposit-error">
          <Text style={[styles.bigMsg, { color: colors.alert }]}>{t.qr_error}</Text>
          <TouchableOpacity style={styles.btn} onPress={mint} testID="deposit-retry">
            <Text style={styles.btnTxt}>{t.retry}</Text>
          </TouchableOpacity>
        </View>
      ) : phase === "paid" ? (
        <View style={styles.center} testID="deposit-paid">
          <View style={styles.tickCircle}>
            <Text style={styles.tick}>✓</Text>
          </View>
          <Text style={[styles.bigMsg, { color: colors.live }]}>{t.qr_paid}</Text>
          <Text style={styles.amountPaid} testID="deposit-paid-amount">
            {formatINR((qr?.amount_paise ?? 0) / 100)}
          </Text>
          <Text style={styles.hint}>{t.qr_paid_hint}</Text>
        </View>
      ) : phase === "expired" ? (
        <View style={styles.center} testID="deposit-expired">
          <Text style={[styles.bigMsg, { color: colors.amber }]}>{t.qr_expired}</Text>
          <TouchableOpacity style={styles.btn} onPress={mint} testID="deposit-new-qr">
            <Text style={styles.btnTxt}>{t.qr_new}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View testID="deposit-active">
          {/* Amount first: it is the fact that matters, and it is not editable. */}
          <Text style={styles.amountLabel}>{t.qr_amount}</Text>
          <Text style={styles.amount} testID="deposit-amount">
            {formatINR((qr?.amount_paise ?? 0) / 100)}
          </Text>
          <Text style={styles.hint}>{t.scan_to_deposit}</Text>

          <View style={styles.qrBox} testID="deposit-qr">
            {qr?.image_url ? (
              <Image
                source={{ uri: qr.image_url }}
                style={styles.qrImg}
                contentFit="contain"
                transition={120}
                testID="deposit-qr-image"
              />
            ) : (
              <View style={styles.center}>
                <ActivityIndicator color={colors.live} />
              </View>
            )}
          </View>

          <View style={styles.footRow}>
            <Text style={styles.waiting} testID="deposit-waiting">
              {t.qr_waiting}
            </Text>
            <Text
              style={[styles.timer, remaining <= 60 && { color: colors.alert }]}
              testID="deposit-timer"
            >
              {t.qr_expires_in} {mmss(remaining)}
            </Text>
          </View>
          <Text style={styles.fixedHint}>{t.qr_fixed_hint}</Text>
        </View>
      )}
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.xl },
  bigMsg: {
    fontFamily: fonts.displayMed,
    fontSize: 18,
    color: colors.ink,
    textAlign: "center",
  },
  hint: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.md,
    textAlign: "center",
  },
  fixedHint: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.muted,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  amountLabel: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    textAlign: "center",
  },
  amount: {
    fontFamily: fonts.display,
    fontSize: 32,
    color: colors.ink,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  amountPaid: {
    fontFamily: fonts.display,
    fontSize: 28,
    color: colors.ink,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  qrBox: {
    aspectRatio: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.md,
    alignSelf: "center",
    width: "80%",
  },
  qrImg: { flex: 1, width: "100%" },
  footRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.md,
  },
  waiting: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  timer: { fontFamily: fonts.dataMed, fontSize: 13, color: colors.ink },
  btn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.lg,
  },
  btnTxt: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
  tickCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.live,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  tick: { color: colors.white, fontSize: 30, fontFamily: fonts.uiBold },
});
