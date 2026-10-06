import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { Card } from "./ui";
import { api } from "@/src/api";
import { formatINR } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";
import { useCardText } from "@/src/i18n/cards";

interface CollectionQr {
  qr_code_id: string | null;
  image_url?: string | null;
  short_url?: string | null;
  code?: string | null;
  enabled?: boolean;
}
interface CollectionsToday {
  business_date: string;
  total: number;
  count: number;
  items: { amount: number; at: string }[];
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  } catch {
    return "";
  }
}

// Shows the driver's own collection QR so they can hold the phone up for a
// rider to scan and pay, plus today's running total that updates live as each
// payment lands (with a "received" flash).
export const CollectionQrCard: React.FC = () => {
  const c = useCardText();
  const [qr, setQr] = useState<CollectionQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [full, setFull] = useState(false);
  const [today, setToday] = useState<CollectionsToday | null>(null);
  const [received, setReceived] = useState<number | null>(null);   // flash amount
  const prevRef = useRef<{ count: number; total: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setQr(await api.get<CollectionQr>("/money/collection-qr"));
    } catch {
      // keep whatever we had
    } finally {
      setLoading(false);
    }
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const d = await api.get<CollectionsToday>("/money/collections/today");
      const prev = prevRef.current;
      if (prev && d.count > prev.count) {
        // One or more new payments landed since the last poll — flash the delta.
        setReceived(Math.round((d.total - prev.total) * 100) / 100);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setReceived(null), 6000);
      }
      prevRef.current = { count: d.count, total: d.total };
      setToday(d);
    } catch {
      // offline — keep last
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    loadToday();
    const id = setInterval(loadToday, 8000);   // live-ish: new payment shows within ~8s
    return () => { clearInterval(id); if (flashTimer.current) clearTimeout(flashTimer.current); };
  }, [loadToday]);

  if (loading) {
    return (
      <Card testID="collection-qr-card">
        <ActivityIndicator color={colors.ink} />
      </Card>
    );
  }

  if (!qr || !qr.image_url) {
    return (
      <Card testID="collection-qr-card">
        <Text style={styles.title}>{c.collect_payment}</Text>
        <Text style={styles.hint}>
          {qr?.enabled === false
            ? c.qr_not_setup
            : c.qr_not_ready}
        </Text>
      </Card>
    );
  }

  return (
    <Card testID="collection-qr-card">
      <Text style={styles.title}>{c.collect_payment}</Text>
      <Text style={styles.hint}>{c.show_to_rider}</Text>
      <TouchableOpacity style={styles.qrWrap} onPress={() => setFull(true)} activeOpacity={0.85}>
        <Image source={{ uri: qr.image_url }} style={styles.qr} resizeMode="contain" />
      </TouchableOpacity>
      {qr.code ? <Text style={styles.code}>{qr.code}</Text> : null}
      <Text style={styles.tapHint}>{c.tap_enlarge}</Text>

      {received != null ? (
        <View style={styles.flash} testID="collection-received">
          <Text style={styles.flashText}>{c.received(formatINR(received))}</Text>
        </View>
      ) : null}

      <View style={styles.todayRow}>
        <Text style={styles.todayLabel}>{c.collected_today}</Text>
        <Text style={styles.todayValue} testID="collections-today-total">
          {formatINR(today?.total ?? 0)} · {c.pays(today?.count ?? 0)}
        </Text>
      </View>
      {today && today.items.length > 0 ? (
        <View style={styles.recent}>
          {today.items.slice(0, 5).map((it, i) => (
            <View key={i} style={styles.recentRow}>
              <Text style={styles.recentAmt}>{formatINR(it.amount)}</Text>
              <Text style={styles.recentTime}>{fmtTime(it.at)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.noneYet}>{c.no_payments_today}</Text>
      )}

      <Modal visible={full} transparent animationType="fade" onRequestClose={() => setFull(false)}>
        <Pressable style={styles.modalBg} onPress={() => setFull(false)}>
          <View style={styles.modalCard}>
            <Image source={{ uri: qr.image_url }} style={styles.qrBig} resizeMode="contain" />
            {qr.code ? <Text style={styles.codeBig}>{qr.code}</Text> : null}
            <Text style={styles.closeHint}>{c.tap_close}</Text>
          </View>
        </Pressable>
      </Modal>
    </Card>
  );
};

const styles = StyleSheet.create({
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: 2 },
  hint: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  qrWrap: { alignItems: "center", marginTop: spacing.md },
  qr: { width: 220, height: 220, backgroundColor: colors.white, borderRadius: radius.md },
  code: { fontFamily: fonts.dataMed, fontSize: 16, color: colors.ink, textAlign: "center", marginTop: spacing.sm, letterSpacing: 1 },
  tapHint: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, textAlign: "center", marginTop: 4 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  modalCard: { backgroundColor: colors.white, borderRadius: radius.lg, padding: spacing.lg, alignItems: "center" },
  qrBig: { width: 300, height: 300 },
  codeBig: { fontFamily: fonts.dataMed, fontSize: 20, color: colors.ink, marginTop: spacing.md, letterSpacing: 1 },
  closeHint: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: spacing.md },
  flash: { backgroundColor: "#dcfce7", borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 12, marginTop: spacing.md },
  flashText: { fontFamily: fonts.uiBold, fontSize: 15, color: "#166534", textAlign: "center" },
  todayRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  todayLabel: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  todayValue: { fontFamily: fonts.dataMed, fontSize: 16, color: colors.live },
  recent: { marginTop: spacing.sm },
  recentRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  recentAmt: { fontFamily: fonts.data, fontSize: 14, color: colors.ink },
  recentTime: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  noneYet: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: spacing.sm },
});
