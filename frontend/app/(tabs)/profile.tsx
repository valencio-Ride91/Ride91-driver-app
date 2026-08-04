import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

export default function Profile() {
  const { t } = useI18n();
  const { driver, vehicle, signOut } = useAuth();

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.profile} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card testID="profile-driver-card">
          <Text style={styles.name}>{driver?.name ?? "—"}</Text>
          <Text style={styles.mono}>{driver?.phone}</Text>
        </Card>

        <Card testID="profile-vehicle-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.h2}>Vehicle</Text>
          <View style={styles.kv}>
            <Text style={styles.k}>Number</Text>
            <Text style={styles.v}>{driver?.vehicle_number ?? "—"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Model</Text>
            <Text style={styles.v}>{vehicle?.model ?? "Citroën ëC3"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Battery</Text>
            <Text style={styles.v}>{vehicle?.current_soc ?? "—"}%</Text>
          </View>
        </Card>

        <TouchableOpacity onPress={signOut} style={styles.logout} testID="logout-btn">
          <Text style={styles.logoutText}>{t.logout}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  name: { fontFamily: fonts.display, fontSize: 24, color: colors.ink },
  mono: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.muted, marginTop: 4 },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  k: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
  v: { fontFamily: fonts.dataMed, color: colors.ink, fontSize: 14 },
  logout: {
    marginTop: spacing.xl,
    borderColor: colors.alert,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  logoutText: { fontFamily: fonts.uiBold, color: colors.alert, fontSize: 15 },
});
