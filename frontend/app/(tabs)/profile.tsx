import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { DocumentsCard } from "@/src/components/DocumentsCard";
import { ConsentsCard } from "@/src/components/ConsentsCard";
import { BankAccountCard } from "@/src/components/BankAccountCard";
import { ChangePasswordCard } from "@/src/components/ChangePasswordCard";
import { ShiftAlarmCard } from "@/src/components/ShiftAlarmCard";
import { useAuth } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, radius, spacing } from "@/src/theme";

export default function Profile() {
  const { t } = useI18n();
  const c = useCardText();
  const { driver, vehicle, signOut } = useAuth();
  const router = useRouter();

  const hubText =
    driver?.hub_name
      ? `${driver.hub_name} · ${driver.hub_lat?.toFixed(4)}, ${driver.hub_lng?.toFixed(4)}`
      : c.hub_not_set;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.profile} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card testID="profile-driver-card">
          <Text style={styles.name}>{driver?.name ?? "—"}</Text>
          <Text style={styles.mono}>{driver?.phone}</Text>
        </Card>

        <TouchableOpacity testID="profile-requests-link" onPress={() => router.push("/requests" as never)} style={{ marginTop: spacing.md }}>
          <Card>
            <View style={styles.navRow}>
              <Text style={styles.navRowText}>{t.requests}</Text>
              <Text style={styles.navRowChevron}>›</Text>
            </View>
          </Card>
        </TouchableOpacity>

        <Card testID="profile-vehicle-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.h2}>{c.vehicle}</Text>
          <View style={styles.kv}>
            <Text style={styles.k}>{c.veh_number}</Text>
            <Text style={styles.v}>{driver?.vehicle_number ?? "—"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>{c.veh_model}</Text>
            <Text style={styles.v}>{vehicle?.model ?? "Citroën ëC3"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>{c.veh_battery}</Text>
            <Text style={styles.v}>{vehicle?.current_soc ?? "—"}%</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>{c.home_hub}</Text>
            <Text style={styles.v} testID="profile-hub-info">{hubText}</Text>
          </View>
        </Card>

        {/* The wake-up alarm: on/off, when it rings, and a test button. */}
        <ShiftAlarmCard style={{ marginTop: spacing.md }} />

        <Card testID="profile-documents-card" style={{ marginTop: spacing.md }}>
          <DocumentsCard />
        </Card>

        <Card testID="profile-bank-card" style={{ marginTop: spacing.md }}>
          <BankAccountCard />
        </Card>

        <Card testID="profile-consents-card" style={{ marginTop: spacing.md }}>
          <ConsentsCard />
        </Card>

        <Card testID="profile-password-card" style={{ marginTop: spacing.md }}>
          <ChangePasswordCard />
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
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navRowText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.ink },
  navRowChevron: { fontFamily: fonts.uiBold, fontSize: 22, color: colors.muted },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  k: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
  v: { fontFamily: fonts.dataMed, color: colors.ink, fontSize: 14, textAlign: "right", maxWidth: "60%" },
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
