import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { AuthProvider, useAuth } from "@/src/auth";
import { SyncProvider } from "@/src/sync";
import { TrackingProvider } from "@/src/tracking";
import { DutyProvider } from "@/src/duty";
import { I18nProvider } from "@/src/i18n";
import { colors } from "@/src/theme";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

const Router: React.FC = () => {
  const { driver, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (loading) return;
    const inTabs = segments[0] === "(tabs)";
    if (!driver && inTabs) {
      router.replace("/login");
    } else if (driver && !inTabs) {
      router.replace("/(tabs)");
    }
  }, [driver, loading, segments, router]);

  return (
    <TrackingProvider enabled={!!driver}>
      <DutyProvider enabled={!!driver}>
        <View style={{ flex: 1, backgroundColor: colors.paper }}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}>
            <Stack.Screen name="login" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </View>
      </DutyProvider>
    </TrackingProvider>
  );
};

export default function RootLayout() {
  const [iconLoaded, iconErr] = useIconFonts();
  const [fontLoaded, fontErr] = useAppFonts();

  useEffect(() => {
    if ((iconLoaded || iconErr) && (fontLoaded || fontErr)) {
      SplashScreen.hideAsync();
    }
  }, [iconLoaded, iconErr, fontLoaded, fontErr]);

  const ready = (iconLoaded || iconErr) && (fontLoaded || fontErr);
  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SyncProvider>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </SyncProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
