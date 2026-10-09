import { Tabs } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, IconName } from "@/src/hub/kit";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { colors, fonts } from "@/src/theme";

// The tab's icon (filled when it is the open tab), its name, and a count when
// something there is waiting.
const TabIcon: React.FC<{ icon: IconName; label: string; focused: boolean; count?: number }> = ({ icon, label, focused, count }) => (
  <View style={styles.iconWrap}>
    <View style={[styles.pill, focused ? { backgroundColor: colors.brandTint } : null]}>
      <Icon name={focused ? icon : (`${icon}-outline` as IconName)} size={22} color={focused ? colors.live : colors.muted} />
    </View>
    <Text style={[styles.iconLabel, focused ? { color: colors.ink, fontFamily: fonts.uiBold } : null]} numberOfLines={1}>{label}</Text>
    {count ? (
      <View style={styles.badge}><Text style={styles.badgeText}>{count > 9 ? "9+" : count}</Text></View>
    ) : null}
  </View>
);

export default function HubTabs() {
  const t = useHubText();
  const { today } = useHubToday();
  const insets = useSafeAreaInsets();
  const c = today?.counts;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line, height: 66 + insets.bottom, paddingTop: 8, paddingBottom: insets.bottom },
      }}
    >
      <Tabs.Screen name="index" options={{ tabBarIcon: ({ focused }) => <TabIcon icon="home" label={t.tab_today} focused={focused} count={today?.attention.length} />, tabBarButtonTestID: "hub-tab-today" }} />
      <Tabs.Screen name="drivers" options={{ tabBarIcon: ({ focused }) => <TabIcon icon="people" label={t.tab_drivers} focused={focused} />, tabBarButtonTestID: "hub-tab-drivers" }} />
      <Tabs.Screen name="cars" options={{ tabBarIcon: ({ focused }) => <TabIcon icon="car-sport" label={t.tab_cars} focused={focused} />, tabBarButtonTestID: "hub-tab-cars" }} />
      <Tabs.Screen name="money" options={{ tabBarIcon: ({ focused }) => <TabIcon icon="wallet" label={t.tab_money} focused={focused} count={c?.withdrawals_pending} />, tabBarButtonTestID: "hub-tab-money" }} />
      <Tabs.Screen name="inbox" options={{ tabBarIcon: ({ focused }) => <TabIcon icon="chatbubbles" label={t.tab_inbox} focused={focused} count={(c?.unread_messages ?? 0) + (c?.requests_pending ?? 0)} />, tabBarButtonTestID: "hub-tab-inbox" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { alignItems: "center", gap: 2, width: 70 },
  pill: { width: 48, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  iconLabel: { fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted },
  badge: { position: "absolute", top: -3, right: 8, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.alert, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderWidth: 2, borderColor: colors.card },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 9, color: colors.white },
});
