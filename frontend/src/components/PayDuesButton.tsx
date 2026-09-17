// PayDuesButton — opens Razorpay hosted checkout in expo-web-browser.
//
// Flow:
//   1. POST /api/payments/razorpay/orders → gets order_id + amount_paise
//   2. Opens /api/payments/razorpay/checkout via WebBrowser with the app's
//      deep-link as redirect.
//   3. The hosted page calls /verify on success and then hard-redirects
//      back to the app; if the redirect misses (Android CCT dismiss) we
//      also poll /status/{client_action_id} for up to 30s so the UI
//      settles on success from the webhook, not the callback.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as Crypto from "expo-crypto";

import { api, API_BASE, AUTH_TOKEN_KEY } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { colors, fonts, radius } from "@/src/theme";

WebBrowser.maybeCompleteAuthSession();

interface Props {
  duesPaise: number;
  onPaid?: () => void;
  disabled?: boolean;
}

interface OrderResp {
  order_id: string;
  amount_paise: number;
  currency: "INR";
  key_id: string;
  status: string;
}

interface StatusResp {
  status: "created" | "reconciled" | "failed" | string;
  order_id: string;
  payment_id?: string;
  amount_paise: number;
  reconciled_at?: string;
}

async function pollStatus(cid: string, tries = 15): Promise<StatusResp | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api.get<StatusResp>(`/payments/razorpay/status/${cid}`);
      if (r.status === "reconciled") return r;
      if (r.status === "failed") return r;
    } catch {
      // keep polling — webhook may lag briefly
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

export const PayDuesButton: React.FC<Props> = ({ duesPaise, onPaid, disabled }) => {
  const [busy, setBusy] = useState(false);

  const pay = useCallback(async () => {
    if (busy || duesPaise <= 0) return;
    setBusy(true);
    try {
      const client_action_id = Crypto.randomUUID();
      const order = await api.post<OrderResp>("/payments/razorpay/orders", {
        client_action_id,
        amount_rupees: duesPaise / 100,
      });
      const redirect = Linking.createURL("razorpay-return");
      // The hosted checkout page pulls the token-less /verify endpoint,
      // so we don't need to smuggle auth through the WebBrowser session.
      const token = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
      const checkoutUrl =
        `${API_BASE}/api/payments/razorpay/checkout` +
        `?order_id=${encodeURIComponent(order.order_id)}` +
        `&amount=${order.amount_paise}` +
        `&action=${encodeURIComponent(client_action_id)}` +
        `&redirect=${encodeURIComponent(redirect)}` +
        `&name=${encodeURIComponent("Ride91 driver")}` +
        (token ? `&_t=${encodeURIComponent(token.slice(0, 8))}` : "");

      const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, redirect);
      // Fire-and-poll: whether the driver hit success or Android dismissed
      // the tab early, the webhook + server verify is our source of truth.
      const settled = await pollStatus(client_action_id);
      if (settled?.status === "reconciled") {
        Alert.alert("Payment received", `₹${(settled.amount_paise / 100).toFixed(2)} deposited.`);
        onPaid?.();
      } else if (settled?.status === "failed") {
        Alert.alert("Payment failed", "The transaction didn't go through. Please try again.");
      } else if (result.type !== "dismiss") {
        Alert.alert("Still processing", "We'll update your cash-in-hand once we hear back from Razorpay.");
      }
    } catch (e: any) {
      const detail = e?.body?.detail;
      Alert.alert(
        "Couldn't start payment",
        detail === "razorpay_not_configured"
          ? "Razorpay isn't configured on the server."
          : detail === "no_dues"
            ? "You have no dues to pay right now."
            : detail === "amount_below_minimum"
              ? "Minimum payable amount is ₹1."
              : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, duesPaise, onPaid]);

  return (
    <TouchableOpacity
      testID="pay-dues-btn"
      style={[styles.btn, (busy || disabled) && styles.btnDisabled]}
      onPress={pay}
      disabled={busy || disabled || duesPaise <= 0}
    >
      {busy ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text style={styles.txt}>
          Pay ₹{(duesPaise / 100).toFixed(0)} dues via UPI / card
        </Text>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  btn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  btnDisabled: { opacity: 0.5 },
  txt: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
});
