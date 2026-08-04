import { Tabs } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts } from "@/src/theme";
import { useI18n } from "@/src/i18n";

const TabIcon: React.FC<{ label: string; focused: boolean }> = ({ label, focused }) => (
  <View style={styles.iconWrap}>
    <View style={[styles.dot, { backgroundColor: focused ? colors.live : colors.line }]} />
    <Text style={[styles.iconLabel, { color: focused ? colors.ink : colors.muted }]}>{label}</Text>
  </View>
);

export default function TabsLayout() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.line,
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label={t.home} focused={focused} />,
          tabBarButtonTestID: "tab-home",
        }}
      />
      <Tabs.Screen
        name="money"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label={t.money} focused={focused} />,
          tabBarButtonTestID: "tab-money",
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label={t.requests} focused={focused} />,
          tabBarButtonTestID: "tab-requests",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label={t.profile} focused={focused} />,
          tabBarButtonTestID: "tab-profile",
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { alignItems: "center", gap: 4, width: 68 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  iconLabel: { fontFamily: fonts.uiMed, fontSize: 12 },
});
