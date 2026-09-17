// PayoutsHistoryCard — driver-facing payouts list from RazorpayX.
//
// Read-only. Payouts are triggered by ops from the admin panel; the driver
// only sees the resulting rows. Statuses map to concise labels the driver
// actually understands ("Paid", "Processing", "Reversed", "Failed").

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { api } from "@/src/api";
import { formatINR, formatIST } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface Payout {
  id: string;
  amount_rupees: number;
  mode: "IMPS" | "UPI";
  status: string;
  utr?: string;
  narration?: string;
  reference_id?: string;
  created_at: string;
  updated_at?: string;
}

const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  processed: { label: "Paid", color: colors.live, bg: "#E7F3EC" },
  processing: { label: "Processing", color: colors.amber, bg: "#FBEDD5" },
  queued: { label: "Queued", color: colors.amber, bg: "#FBEDD5" },
  pending: { label: "Pending", color: colors.amber, bg: "#FBEDD5" },
  reversed: { label: "Reversed", color: colors.alert, bg: "#F3E3DF" },
  failed: { label: "Failed", color: colors.alert, bg: "#F3E3DF" },
  cancelled: { label: "Cancelled", color: colors.muted, bg: colors.paper },
  rejected: { label: "Rejected", color: colors.alert, bg: "#F3E3DF" },
};

export const PayoutsHistoryCard: React.FC = () => {
  const [items, setItems] = useState<Payout[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(false);
      const r = await api.get<{ items: Payout[] }>("/payouts/history");
      setItems(r.items ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View testID="payouts-history-card">
      <View style={styles.rowBetween}>
        <Text style={styles.h2}>Payouts</Text>
        <TouchableOpacity onPress={load} testID="payouts-refresh">
          <Text style={styles.link}>Refresh</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.sub}>
        Fleet-to-driver bank transfers. Payouts appear here once ops releases
        them. Save your bank / UPI in Profile first.
      </Text>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.ink} />
        </View>
      ) : error ? (
        <Text style={styles.errorText}>
          Couldn't load payouts. Pull to refresh.
        </Text>
      ) : (items?.length ?? 0) === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>No payouts yet.</Text>
        </View>
      ) : (
        items!.map((p) => {
          const s = STATUS_MAP[p.status] ?? {
            label: p.status,
            color: colors.muted,
            bg: colors.paper,
          };
          return (
            <View key={p.id} style={styles.row} testID={`payout-row-${p.id}`}>
              <View style={styles.rowTop}>
                <Text style={styles.amt}>{formatINR(p.amount_rupees)}</Text>
                <View style={[styles.badge, { backgroundColor: s.bg }]}>
                  <Text style={[styles.badgeText, { color: s.color }]}>
                    {s.label}
                  </Text>
                </View>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.meta}>
                  {p.mode} · {formatIST(p.created_at)}
                </Text>
                {p.utr ? (
                  <Text style={styles.utr} testID={`payout-utr-${p.id}`}>
                    UTR {p.utr}
                  </Text>
                ) : null}
              </View>
              {p.narration ? (
                <Text style={styles.narration}>{p.narration}</Text>
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, marginTop: 4, marginBottom: spacing.md },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.live },
  loading: { padding: spacing.lg, alignItems: "center" },
  errorText: {
    fontFamily: fonts.ui,
    color: colors.alert,
    fontSize: 13,
    padding: spacing.md,
    textAlign: "center",
  },
  emptyBox: {
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  emptyText: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted },
  row: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: spacing.md,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  amt: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 10, letterSpacing: 0.6 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  meta: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  utr: { fontFamily: fonts.data, fontSize: 11, color: colors.muted },
  narration: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 2 },
});
