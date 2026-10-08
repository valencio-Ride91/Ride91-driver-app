// Ride91 Hub — the hub manager's app. This folder is the routes root when the
// project is built with APP_VARIANT=hub (see app.config.js); the driver app's
// routes live in ../app and are not part of this build.
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { RootErrorBoundary } from "@/src/components/ErrorBoundary";
import { I18nProvider } from "@/src/i18n";
import { HubSessionProvider, useHubSession } from "@/src/hub/session";
import { HubTodayProvider } from "@/src/hub/today";
import { colors } from "@/src/theme";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

const Router: React.FC = () => {
  const { session, loading } = useHubSession();
  const router = useRouter();
  const segments = useSegments();

  // Signed out, or signed in without a hub chosen yet -> the sign-in screen
  // (which also holds the hub picker). Otherwise -> the tabs.
  useEffect(() => {
    if (loading) return;
    const onLogin = segments[0] === "login";
    const ready = !!session?.hubId;
    if (!ready && !onLogin) router.replace("/login");
    else if (ready && onLogin) router.replace("/(tabs)");
  }, [session, loading, segments, router]);

  return (
    <HubTodayProvider>
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="driver/[id]" options={{ presentation: "card" }} />
          <Stack.Screen name="driver-form" options={{ presentation: "card" }} />
          <Stack.Screen name="car/[id]" options={{ presentation: "card" }} />
          <Stack.Screen name="car-check" options={{ presentation: "card" }} />
          <Stack.Screen name="settings" options={{ presentation: "card" }} />
          <Stack.Screen name="handover/[vehicleId]" options={{ presentation: "card" }} />
          <Stack.Screen name="earnings" options={{ presentation: "card" }} />
        </Stack>
      </View>
    </HubTodayProvider>
  );
};

export default function RootLayout() {
  const [fontLoaded, fontErr] = useAppFonts();
  const ready = fontLoaded || !!fontErr;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <RootErrorBoundary>
        <I18nProvider>
          <HubSessionProvider>
            <Router />
          </HubSessionProvider>
        </I18nProvider>
      </RootErrorBoundary>
    </SafeAreaProvider>
  );
}
