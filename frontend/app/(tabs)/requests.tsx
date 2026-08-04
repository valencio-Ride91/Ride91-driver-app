import React, { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { BottomSheet, Card } from "@/src/components/ui";
import { api } from "@/src/api";
import { useI18n, formatINR } from "@/src/i18n";
import { useSync } from "@/src/sync";
import { colors, fonts, radius, spacing } from "@/src/theme";

type ReqType = "advance" | "holiday" | "extra_hours";

interface RequestRow {
  id: string;
  type: ReqType;
  payload: Record<string, any>;
  state: "pending" | "approved" | "rejected" | "paid";
  created_at: string;
}

const stateColor: Record<RequestRow["state"], string> = {
  pending: colors.amber,
  approved: colors.live,
  rejected: colors.alert,
  paid: colors.ink,
};

export default function Requests() {
  const { t } = useI18n();
  const { enqueue } = useSync();
  const [items, setItems] = useState<RequestRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [type, setType] = useState<ReqType>("advance");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [hours, setHours] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: RequestRow[] }>("/requests");
      setItems(r.items);
    } catch {
      // keep
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const submit = useCallback(async () => {
    let payload: Record<string, any> = { reason };
    if (type === "advance") payload = { amount: parseFloat(amount || "0"), reason };
    if (type === "holiday") payload = { date, reason };
    if (type === "extra_hours") payload = { hours: parseFloat(hours || "0"), reason };
    await enqueue("/requests", { type, payload });
    // Optimistic append
    setItems((prev) => [
      {
        id: `local-${Date.now()}`,
        type,
        payload,
        state: "pending",
        created_at: new Date().toISOString(),
      },
      ...prev,
    ]);
    setCreating(false);
    setAmount("");
    setReason("");
    setDate("");
    setHours("");
    setTimeout(load, 1500);
  }, [type, amount, reason, date, hours, enqueue, load]);

  const typeLabel: Record<ReqType, string> = {
    advance: t.request_advance,
    holiday: t.request_holiday,
    extra_hours: t.request_extra,
  };
  const stateLabel: Record<RequestRow["state"], string> = {
    pending: t.pending,
    approved: t.approved,
    rejected: t.rejected,
    paid: t.paid,
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.requests} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {items.length === 0 ? (
          <Text style={styles.empty}>No requests yet.</Text>
        ) : (
          items.map((r) => (
            <Card key={r.id} testID={`request-${r.id}`} style={{ marginBottom: spacing.sm }}>
              <View style={styles.reqRow}>
                <Text style={styles.reqType}>{typeLabel[r.type]}</Text>
                <View style={[styles.stateBadge, { backgroundColor: stateColor[r.state] }]}>
                  <Text style={styles.stateBadgeText}>{stateLabel[r.state]}</Text>
                </View>
              </View>
              <View style={styles.reqBody}>
                {r.type === "advance" ? (
                  <Text style={styles.reqPayload}>{formatINR(r.payload.amount ?? 0)}</Text>
                ) : null}
                {r.type === "holiday" ? (
                  <Text style={styles.reqPayload}>
                    {new Date(r.payload.date ?? r.created_at).toLocaleDateString()}
                  </Text>
                ) : null}
                {r.type === "extra_hours" ? (
                  <Text style={styles.reqPayload}>+{r.payload.hours} {t.hours}</Text>
                ) : null}
                {r.payload.reason ? (
                  <Text style={styles.reqReason}>{r.payload.reason}</Text>
                ) : null}
              </View>
              <Text style={styles.reqDate}>
                {new Date(r.created_at).toLocaleString()}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setCreating(true)}
        testID="new-request-btn"
      >
        <Text style={styles.fabText}>+ {t.new_request}</Text>
      </TouchableOpacity>

      <BottomSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title={t.new_request}
        testID="new-request-sheet"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Text style={styles.label}>{t.request_type}</Text>
          <View style={styles.typeRow}>
            {(["advance", "holiday", "extra_hours"] as ReqType[]).map((r) => (
              <TouchableOpacity
                key={r}
                testID={`request-type-${r}`}
                style={[
                  styles.typeBtn,
                  type === r ? styles.typeBtnActive : null,
                ]}
                onPress={() => setType(r)}
              >
                <Text
                  style={[
                    styles.typeText,
                    type === r ? { color: colors.white } : null,
                  ]}
                >
                  {typeLabel[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {type === "advance" ? (
            <FieldBlock label={t.amount}>
              <TextInput
                testID="req-amount"
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
                style={styles.field}
                placeholder="₹0"
                placeholderTextColor={colors.muted}
              />
            </FieldBlock>
          ) : null}
          {type === "holiday" ? (
            <FieldBlock label={t.date}>
              <TextInput
                testID="req-date"
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.muted}
                style={styles.field}
              />
            </FieldBlock>
          ) : null}
          {type === "extra_hours" ? (
            <FieldBlock label={t.hours}>
              <TextInput
                testID="req-hours"
                value={hours}
                onChangeText={setHours}
                keyboardType="numeric"
                style={styles.field}
                placeholder="0"
                placeholderTextColor={colors.muted}
              />
            </FieldBlock>
          ) : null}

          <FieldBlock label={t.reason}>
            <TextInput
              testID="req-reason"
              value={reason}
              onChangeText={setReason}
              style={[styles.field, { height: 80 }]}
              multiline
              placeholder="…"
              placeholderTextColor={colors.muted}
            />
          </FieldBlock>

          <View style={styles.actions}>
            <TouchableOpacity
              testID="req-cancel"
              style={styles.secondaryBtn}
              onPress={() => setCreating(false)}
            >
              <Text style={styles.secondaryText}>{t.cancel}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="req-submit" style={styles.primaryBtn} onPress={submit}>
              <Text style={styles.primaryText}>{t.submit}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </BottomSheet>
    </SafeAreaView>
  );
}

const FieldBlock: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <View style={{ marginBottom: spacing.md }}>
    <Text style={styles.label}>{label}</Text>
    {children}
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  empty: {
    fontFamily: fonts.ui,
    color: colors.muted,
    textAlign: "center",
    marginTop: spacing.xxl,
  },
  reqRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  reqType: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink },
  stateBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  stateBadgeText: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.white },
  reqBody: { marginTop: spacing.xs, gap: 2 },
  reqPayload: { fontFamily: fonts.dataMed, fontSize: 20, color: colors.ink },
  reqReason: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted },
  reqDate: { fontFamily: fonts.data, fontSize: 11, color: colors.muted, marginTop: 6 },
  fab: {
    position: "absolute",
    right: spacing.md,
    bottom: 76,
    backgroundColor: colors.live,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
  },
  fabText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
  label: {
    fontFamily: fonts.uiMed,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  typeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  typeBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  typeBtnActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  typeText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 13 },
  field: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fonts.uiMed,
    fontSize: 15,
    color: colors.ink,
  },
  actions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  primaryBtn: {
    flex: 1,
    backgroundColor: colors.live,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.white },
  secondaryBtn: {
    flex: 1,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  secondaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.ink },
});
