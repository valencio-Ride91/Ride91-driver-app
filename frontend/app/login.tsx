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

export default function Login() {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const [phone, setPhone] = useState("+919900000001");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"phone" | "otp">("phone");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sendOtp = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/otp/request", { phone });
      setStage("otp");
    } catch (e) {
      setErr("Could not send code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ token: string; driver: Driver }>("/auth/otp/verify", {
        phone,
        code: otp,
        client_action_id: Crypto.randomUUID(),
      });
      await signIn(r.token, r.driver);
    } catch (e: any) {
      setErr(e?.body?.detail === "driver_not_found" ? "Driver not registered" : "Wrong code");
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

          {stage === "phone" ? (
            <>
              <TextInput
                testID="login-phone-input"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                placeholder={t.phone_placeholder}
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              <TouchableOpacity
                testID="login-send-otp-button"
                style={[styles.cta, busy && { opacity: 0.7 }]}
                onPress={sendOtp}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={colors.white} /> : (
                  <Text style={styles.ctaText}>{t.send_otp}</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                testID="login-otp-input"
                value={otp}
                onChangeText={setOtp}
                keyboardType="number-pad"
                maxLength={6}
                placeholder={t.otp_placeholder}
                placeholderTextColor={colors.muted}
                style={[styles.input, styles.inputMono]}
              />
              <TouchableOpacity
                testID="login-verify-button"
                style={[styles.cta, busy && { opacity: 0.7 }]}
                onPress={verify}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={colors.white} /> : (
                  <Text style={styles.ctaText}>{t.verify_otp}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStage("phone")} style={styles.textBtn}>
                <Text style={styles.textBtnText}>← {phone}</Text>
              </TouchableOpacity>
            </>
          )}

          {err ? <Text style={styles.error} testID="login-error">{err}</Text> : null}
          <Text style={styles.hint}>{t.demo_hint}</Text>
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
  brandDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.live,
  },
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
  inputMono: { fontFamily: fonts.dataMed, letterSpacing: 6, textAlign: "center", fontSize: 22 },
  cta: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  ctaText: { fontFamily: fonts.uiBold, fontSize: 17, color: colors.white },
  textBtn: { alignSelf: "center", padding: spacing.md },
  textBtnText: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.muted },
  error: {
    fontFamily: fonts.uiMed,
    fontSize: 14,
    color: colors.alert,
    marginTop: spacing.sm,
  },
  hint: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    marginTop: spacing.xxl,
  },
});
