import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useAuth, Driver } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

// Phone (username) + password, both issued by fleet ops. OTP/SMS was removed;
// ops owns driver onboarding and hands out the credentials directly.
export default function Login() {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const signInNow = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ token: string; driver: Driver }>("/auth/login", {
        phone: phone.trim(),
        password,
        client_action_id: Crypto.randomUUID(),
      });
      await signIn(r.token, r.driver);
    } catch (e: any) {
      setErr(e?.body?.detail === "invalid_credentials" ? t.login_bad_credentials : t.login_error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.brandRow}>
            <View style={styles.brandDot} />
            <Text style={styles.brandName}>Ride91</Text>
          </View>
          <Text style={styles.h1} testID="login-title">{t.login_title}</Text>
          <Text style={styles.sub}>{t.login_subtitle}</Text>

          <TextInput
            testID="login-phone-input"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
            autoCapitalize="none"
            placeholder={t.phone_placeholder}
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            testID="login-password-input"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder={t.password_placeholder}
            placeholderTextColor={colors.muted}
            style={styles.input}
            onSubmitEditing={signInNow}
            returnKeyType="go"
          />
          <TouchableOpacity
            testID="login-signin-button"
            style={[styles.cta, busy && { opacity: 0.7 }]}
            onPress={signInNow}
            disabled={busy || !phone || !password}
          >
            {busy ? <ActivityIndicator color={colors.white} /> : (
              <Text style={styles.ctaText}>{t.sign_in}</Text>
            )}
          </TouchableOpacity>

          {err ? <Text style={styles.error} testID="login-error">{err}</Text> : null}
          <Text style={styles.hint}>{t.login_help}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  container: { padding: spacing.xl, gap: spacing.md, flexGrow: 1 },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xxl,
    marginBottom: spacing.xxl,
  },
  brandDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.live },
  brandName: { fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  h1: { fontFamily: fonts.display, fontSize: 36, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 16, color: colors.muted, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    fontFamily: fonts.uiMed,
    fontSize: 18,
    color: colors.ink,
  },
  cta: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  ctaText: { fontFamily: fonts.uiBold, fontSize: 17, color: colors.white },
  error: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.alert, marginTop: spacing.sm },
  hint: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: spacing.xxl },
});
