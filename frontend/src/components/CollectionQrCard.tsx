import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { Card } from "./ui";
import { api } from "@/src/api";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface CollectionQr {
  qr_code_id: string | null;
  image_url?: string | null;
  short_url?: string | null;
  code?: string | null;
  enabled?: boolean;
}

// Shows the driver's own collection QR so they can hold the phone up for a
// rider to scan and pay. Tap to enlarge for easy scanning.
export const CollectionQrCard: React.FC = () => {
  const [qr, setQr] = useState<CollectionQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [full, setFull] = useState(false);

  const load = useCallback(async () => {
    try {
      setQr(await api.get<CollectionQr>("/money/collection-qr"));
    } catch {
      // keep whatever we had
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
        <Text style={styles.title}>Collect payment</Text>
        <Text style={styles.hint}>
          {qr?.enabled === false
            ? "Not set up yet — ask the office to enable your QR."
            : "Your QR isn't ready yet. Pull down to refresh."}
        </Text>
      </Card>
    );
  }

  return (
    <Card testID="collection-qr-card">
      <Text style={styles.title}>Collect payment</Text>
      <Text style={styles.hint}>Show this to the rider to pay by UPI</Text>
      <TouchableOpacity style={styles.qrWrap} onPress={() => setFull(true)} activeOpacity={0.85}>
        <Image source={{ uri: qr.image_url }} style={styles.qr} resizeMode="contain" />
      </TouchableOpacity>
      {qr.code ? <Text style={styles.code}>{qr.code}</Text> : null}
      <Text style={styles.tapHint}>Tap to enlarge</Text>

      <Modal visible={full} transparent animationType="fade" onRequestClose={() => setFull(false)}>
        <Pressable style={styles.modalBg} onPress={() => setFull(false)}>
          <View style={styles.modalCard}>
            <Image source={{ uri: qr.image_url }} style={styles.qrBig} resizeMode="contain" />
            {qr.code ? <Text style={styles.codeBig}>{qr.code}</Text> : null}
            <Text style={styles.closeHint}>Tap anywhere to close</Text>
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
});
