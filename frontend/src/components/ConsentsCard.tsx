// Consent list: toggle any consent on/off. Each change is appended
// server-side to consent_events so we retain a full audit trail. The UI
// only shows the current state per kind.

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useSync } from "@/src/sync";
import { colors, fonts, radius, spacing } from "@/src/theme";
import { useI18n } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";

export interface ConsentRow {
  kind: string;
  label: string;
  granted: boolean;
  last_change_at: string | null;
}

export const ConsentsCard: React.FC = () => {
  const { t } = useI18n();
  const c = useCardText();
  const [items, setItems] = useState<ConsentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const { enqueue } = useSync();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ items: ConsentRow[] }>("/consents");
      setItems(r.items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (row: ConsentRow, next: boolean) => {
      const doIt = async () => {
        setSaving(row.kind);
        // Optimistic local flip so the switch responds instantly.
        setItems((prev) =>
          prev.map((r) =>
            r.kind === row.kind ? { ...r, granted: next, last_change_at: new Date().toISOString() } : r,
          ),
        );
        try {
          await enqueue("/consents", { kind: row.kind, granted: next });
          // Give the sync worker time to flush before re-reading server state,
          // otherwise the optimistic row can be overwritten by stale data.
          setTimeout(refresh, 1200);
        } finally {
          setSaving(null);
        }
      };
      if (!next && row.granted) {
        // Withdrawing → confirm.
        Alert.alert(
          c.consent_withdraw_q,
          c.consent_withdraw_body(c.consent_label(row.kind, row.label)),
          [
            { text: t.cancel, style: "cancel" },
            { text: c.consent_withdraw, style: "destructive", onPress: doIt },
          ],
        );
      } else {
        doIt();
      }
    },
    [enqueue, refresh, c, t],
  );

  return (
    <View testID="consents-card">
      <Text style={styles.h2}>{c.consents}</Text>
      <Text style={styles.sub}>
        {c.consents_sub}
      </Text>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: spacing.md }} />
      ) : (
        items.map((r) => (
          <View
            key={r.kind}
            testID={`consent-row-${r.kind}`}
            style={styles.row}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{c.consent_label(r.kind, r.label)}</Text>
              <Text style={styles.meta}>
                {r.last_change_at
                  ? c.consent_changed(r.granted, r.last_change_at.slice(0, 10))
                  : c.consent_undecided}
              </Text>
            </View>
            <Switch
              testID={`consent-toggle-${r.kind}`}
              value={r.granted}
              disabled={saving === r.kind}
              onValueChange={(v) => toggle(r, v)}
              trackColor={{ true: colors.live, false: colors.line }}
              thumbColor={colors.white}
              accessibilityRole="switch"
              accessibilityLabel={r.label}
              accessibilityState={{ checked: r.granted, disabled: saving === r.kind }}
            />
          </View>
        ))
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  sub: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  label: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 14 },
  meta: { fontFamily: fonts.ui, color: colors.muted, fontSize: 12, marginTop: 2 },
});
