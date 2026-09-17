// BankAccountCard — driver saves their payout destination (bank a/c or UPI VPA).
//
// Ops uses the saved details to trigger fleet-to-driver payouts via RazorpayX.
// The Contact + Fund Account are created lazily on the first payout (see
// backend _ensure_rzpx_contact_and_fund_account), which keeps sensitive
// account numbers off Razorpay servers for drivers who never receive a
// payout.

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { api } from "@/src/api";
import { colors, fonts, radius, spacing } from "@/src/theme";

type Kind = "bank_account" | "vpa";

interface Saved {
  saved: boolean;
  kind?: Kind;
  masked?: string;
  account_holder?: string;
  ifsc?: string;
  verified?: boolean;
  updated_at?: string;
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const BankAccountCard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>("bank_account");
  const [holder, setHolder] = useState("");
  const [acc, setAcc] = useState("");
  const [acc2, setAcc2] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [vpa, setVpa] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.get<Saved>("/payouts/bank-account");
      setSaved(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = () => {
    setEditing(true);
    setKind(saved?.kind ?? "bank_account");
    setHolder(saved?.account_holder ?? "");
    setAcc("");
    setAcc2("");
    setIfsc(saved?.ifsc ?? "");
    setVpa("");
  };

  const cancel = () => {
    setEditing(false);
    setAcc("");
    setAcc2("");
    setVpa("");
  };

  const validate = (): string | null => {
    if (kind === "bank_account") {
      if (!holder.trim()) return "Enter the account-holder name.";
      if (!/^\d{6,26}$/.test(acc)) return "Account number should be 6–26 digits.";
      if (acc !== acc2) return "Account numbers don't match.";
      if (!IFSC_RE.test(ifsc.toUpperCase())) return "IFSC looks wrong (e.g. HDFC0001234).";
    } else {
      if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(vpa)) return "Enter a valid UPI ID (e.g. name@upi).";
    }
    return null;
  };

  const save = useCallback(async () => {
    if (busy) return;
    const err = validate();
    if (err) {
      Alert.alert("Check details", err);
      return;
    }
    setBusy(true);
    try {
      const payload =
        kind === "bank_account"
          ? {
              kind,
              account_holder: holder.trim(),
              account_number: acc.trim(),
              ifsc: ifsc.trim().toUpperCase(),
            }
          : { kind, vpa: vpa.trim() };
      await api.post("/payouts/bank-account", payload);
      await load();
      setEditing(false);
    } catch (e: any) {
      const detail = e?.body?.detail;
      Alert.alert(
        "Couldn't save",
        detail === "invalid_ifsc"
          ? "IFSC looks wrong. Please double-check."
          : detail === "invalid_vpa"
            ? "That UPI ID looks wrong."
            : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, kind, holder, acc, acc2, ifsc, vpa, load]);

  if (loading) {
    return (
      <View style={styles.loading} testID="bank-account-loading">
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  if (!editing) {
    return (
      <View testID="bank-account-view">
        <View style={styles.rowBetween}>
          <Text style={styles.h2}>Payout destination</Text>
          {saved?.saved ? (
            <View
              style={[
                styles.badge,
                saved.verified ? styles.badgeOn : styles.badgePending,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  saved.verified ? styles.badgeTextOn : styles.badgeTextPending,
                ]}
              >
                {saved.verified ? "Verified" : "Pending verification"}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.sub}>
          Where Ride91 sends your Monday payout. Bank transfer (IMPS) or UPI —
          your choice.
        </Text>
        {saved?.saved ? (
          <View style={styles.savedBox} testID="bank-account-saved">
            <View style={styles.kv}>
              <Text style={styles.k}>Type</Text>
              <Text style={styles.v}>
                {saved.kind === "bank_account" ? "Bank account (IMPS)" : "UPI (VPA)"}
              </Text>
            </View>
            {saved.kind === "bank_account" ? (
              <>
                <View style={styles.kv}>
                  <Text style={styles.k}>Holder</Text>
                  <Text style={styles.v}>{saved.account_holder}</Text>
                </View>
                <View style={styles.kv}>
                  <Text style={styles.k}>Account</Text>
                  <Text style={styles.v} testID="bank-account-masked">
                    {saved.masked}
                  </Text>
                </View>
                <View style={styles.kv}>
                  <Text style={styles.k}>IFSC</Text>
                  <Text style={styles.v}>{saved.ifsc}</Text>
                </View>
              </>
            ) : (
              <View style={styles.kv}>
                <Text style={styles.k}>UPI ID</Text>
                <Text style={styles.v} testID="bank-account-masked">
                  {saved.masked}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No payout destination saved yet.</Text>
          </View>
        )}
        <TouchableOpacity
          testID="bank-account-edit-btn"
          style={styles.primary}
          onPress={startEdit}
        >
          <Text style={styles.primaryText}>
            {saved?.saved ? "Update details" : "Add bank / UPI"}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View testID="bank-account-edit">
      <Text style={styles.h2}>Payout destination</Text>
      <View style={styles.tabRow}>
        <TouchableOpacity
          testID="bank-tab-bank"
          style={[styles.tab, kind === "bank_account" && styles.tabActive]}
          onPress={() => setKind("bank_account")}
        >
          <Text
            style={[
              styles.tabText,
              kind === "bank_account" && styles.tabTextActive,
            ]}
          >
            Bank (IMPS)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="bank-tab-upi"
          style={[styles.tab, kind === "vpa" && styles.tabActive]}
          onPress={() => setKind("vpa")}
        >
          <Text
            style={[styles.tabText, kind === "vpa" && styles.tabTextActive]}
          >
            UPI
          </Text>
        </TouchableOpacity>
      </View>
      {kind === "bank_account" ? (
        <>
          <Text style={styles.label}>Account holder name</Text>
          <TextInput
            testID="bank-holder"
            value={holder}
            onChangeText={setHolder}
            placeholder="As on passbook"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoCapitalize="words"
          />
          <Text style={styles.label}>Account number</Text>
          <TextInput
            testID="bank-acc"
            value={acc}
            onChangeText={(t) => setAcc(t.replace(/\s/g, ""))}
            placeholder="6–26 digits"
            placeholderTextColor={colors.muted}
            style={styles.input}
            keyboardType="number-pad"
            secureTextEntry
          />
          <Text style={styles.label}>Confirm account number</Text>
          <TextInput
            testID="bank-acc2"
            value={acc2}
            onChangeText={(t) => setAcc2(t.replace(/\s/g, ""))}
            placeholder="Re-enter"
            placeholderTextColor={colors.muted}
            style={styles.input}
            keyboardType="number-pad"
          />
          <Text style={styles.label}>IFSC</Text>
          <TextInput
            testID="bank-ifsc"
            value={ifsc}
            onChangeText={(t) => setIfsc(t.toUpperCase().replace(/\s/g, ""))}
            placeholder="HDFC0001234"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoCapitalize="characters"
            maxLength={11}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>UPI ID (VPA)</Text>
          <TextInput
            testID="bank-vpa"
            value={vpa}
            onChangeText={(t) => setVpa(t.replace(/\s/g, ""))}
            placeholder="name@upi"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoCapitalize="none"
          />
          <Text style={styles.helper}>
            You&apos;ll receive UPI payouts here. Payment reaches you within minutes.
          </Text>
        </>
      )}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          testID="bank-cancel"
          style={styles.secondary}
          onPress={cancel}
          disabled={busy}
        >
          <Text style={styles.secondaryText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="bank-save"
          style={[styles.primary, styles.primaryFlex, busy && styles.disabled]}
          onPress={save}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.primaryText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  loading: { padding: spacing.lg, alignItems: "center" },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  sub: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, marginBottom: spacing.md },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeOn: { backgroundColor: "#E7F3EC" },
  badgePending: { backgroundColor: "#FBEDD5" },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 0.6 },
  badgeTextOn: { color: colors.live },
  badgeTextPending: { color: colors.amber },
  savedBox: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  emptyBox: {
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: "center",
  },
  emptyText: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  k: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
  v: { fontFamily: fonts.dataMed, color: colors.ink, fontSize: 14, textAlign: "right", maxWidth: "60%" },
  tabRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  tab: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  tabActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  tabText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 13 },
  tabTextActive: { color: colors.white },
  label: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontFamily: fonts.data,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.card,
  },
  helper: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    marginTop: 6,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  primary: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
  },
  primaryFlex: { flex: 1 },
  primaryText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 14 },
  secondary: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  secondaryText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 13 },
  disabled: { opacity: 0.5 },
});
