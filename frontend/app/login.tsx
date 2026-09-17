import React, { useCallback, useEffect, useRef, useState } from "react";
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
import * as Linking from "expo-linking";

import { api } from "@/src/api";
import { useAuth, Driver } from "@/src/auth";
import { useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";
import {
  exchangeSessionId,
  googleLinkStart,
  googleLinkVerify,
  openGoogleAuth,
  type GoogleExchangeResult,
} from "@/src/google-auth";

type Stage = "phone" | "otp" | "google-link" | "google-otp";

interface GoogleLinkState {
  linkToken: string;
  email: string;
  picture?: string;
}

export default function Login() {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const [phone, setPhone] = useState("+919900000001");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<Stage>("phone");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gLink, setGLink] = useState<GoogleLinkState | null>(null);
  const consumedRef = useRef(false);

  // ---- Google exchange helper (shared by web-redirect + mobile popup) -----

  const finishGoogleExchange = useCallback(
    async (r: GoogleExchangeResult | null) => {
      if (!r) return;
      if (!r.needs_link) {
        await signIn(r.token, r.driver);
        return;
      }
      // Case C: driver needs to prove phone ownership before we bind Google.
      setGLink({ linkToken: r.link_token, email: r.google.email, picture: r.google.picture });
      setOtp("");
      setStage("google-link");
    },
    [signIn],
  );

  // Web mount + mobile cold-start: check the URL for ?session_id=…
  useEffect(() => {
    (async () => {
      if (consumedRef.current) return;
      let sessionId: string | null = null;
      if (Platform.OS === "web") {
        // Web comes back via a hard redirect — session_id is on the URL.
        const raw = typeof window !== "undefined" ? window.location.href : "";
        const m = /[?#&]session_id=([^&#]+)/.exec(raw);
        sessionId = m ? decodeURIComponent(m[1]) : null;
      } else {
        const initial = await Linking.getInitialURL();
        if (initial) {
          const m = /[?#&]session_id=([^&#]+)/.exec(initial);
          sessionId = m ? decodeURIComponent(m[1]) : null;
        }
      }
      if (!sessionId) return;
      consumedRef.current = true;
      setBusy(true);
      try {
        const r = await exchangeSessionId(sessionId);
        await finishGoogleExchange(r);
        // Clean the URL on web so a reload doesn't try to redeem again.
        if (Platform.OS === "web" && typeof window !== "undefined") {
          window.history.replaceState(
            window.history.state,
            document.title,
            window.location.pathname,
          );
        }
      } catch (e: any) {
        setErr(e?.body?.detail === "session_id_already_used" ? "Try signing in again." : "Google sign-in failed. Please try again.");
      } finally {
        setBusy(false);
      }
    })();
  }, [finishGoogleExchange]);

  // Mobile hot-link handler (app already open when the redirect fires).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Linking.addEventListener("url", async (event) => {
      const m = /[?#&]session_id=([^&#]+)/.exec(event.url);
      const sessionId = m ? decodeURIComponent(m[1]) : null;
      if (!sessionId || consumedRef.current) return;
      consumedRef.current = true;
      setBusy(true);
      try {
        const r = await exchangeSessionId(sessionId);
        await finishGoogleExchange(r);
      } catch {
        setErr("Google sign-in failed. Please try again.");
      } finally {
        setBusy(false);
      }
    });
    return () => sub.remove();
  }, [finishGoogleExchange]);

  // ---- Actions ------------------------------------------------------------

  const sendOtp = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/otp/request", { phone });
      setStage("otp");
    } catch {
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

  const startGoogle = async () => {
    setErr(null);
    setBusy(true);
    try {
      consumedRef.current = false;
      const sessionId = await openGoogleAuth();
      if (sessionId) {
        consumedRef.current = true;
        const r = await exchangeSessionId(sessionId);
        await finishGoogleExchange(r);
      }
      // Web returns null (hard redirect will kick in). Mobile without a
      // session_id → the user cancelled; leave busy off.
    } catch (e: any) {
      setErr(e?.body?.detail ?? "Google sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const linkPhone = async () => {
    if (!gLink) return;
    setErr(null);
    setBusy(true);
    try {
      await googleLinkStart(gLink.linkToken, phone);
      setOtp("");
      setStage("google-otp");
    } catch (e: any) {
      const d = e?.body?.detail;
      if (d === "driver_not_registered") setErr("This phone isn't registered with the fleet. Contact ops.");
      else if (d === "phone_linked_to_different_google") setErr("This phone is linked to a different Google account.");
      else setErr("Could not send code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const linkVerify = async () => {
    if (!gLink) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await googleLinkVerify(gLink.linkToken, phone, otp, Crypto.randomUUID());
      await signIn(r.token, r.driver);
    } catch (e: any) {
      const d = e?.body?.detail;
      if (d === "google_linked_to_other_driver") setErr("This Google account is already linked to another driver.");
      else if (d === "bad_otp") setErr("Wrong code");
      else setErr("Could not link. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const goBackToPhone = () => {
    setGLink(null);
    setOtp("");
    setErr(null);
    setStage("phone");
    consumedRef.current = false;
  };

  // ---- Render -------------------------------------------------------------

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

              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>

              <TouchableOpacity
                testID="login-google-button"
                style={[styles.googleBtn, busy && { opacity: 0.7 }]}
                onPress={startGoogle}
                disabled={busy}
              >
                <View style={styles.googleG}>
                  <Text style={styles.googleGText}>G</Text>
                </View>
                <Text style={styles.googleText}>Continue with Google</Text>
              </TouchableOpacity>
            </>
          ) : stage === "otp" ? (
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
              <TouchableOpacity onPress={goBackToPhone} style={styles.textBtn}>
                <Text style={styles.textBtnText}>← {phone}</Text>
              </TouchableOpacity>
            </>
          ) : stage === "google-link" ? (
            <>
              <View style={styles.linkedBadge} testID="login-google-linked-badge">
                <Text style={styles.linkedKicker}>SIGNED IN AS</Text>
                <Text style={styles.linkedEmail}>{gLink?.email}</Text>
              </View>
              <Text style={styles.h2}>One more step</Text>
              <Text style={styles.sub}>
                To finish signing in, confirm the phone number your fleet ops registered for you. We&apos;ll send an OTP.
              </Text>
              <TextInput
                testID="login-glink-phone-input"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                placeholder={t.phone_placeholder}
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              <TouchableOpacity
                testID="login-glink-send-button"
                style={[styles.cta, busy && { opacity: 0.7 }]}
                onPress={linkPhone}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={colors.white} /> : (
                  <Text style={styles.ctaText}>Send code</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={goBackToPhone} style={styles.textBtn}>
                <Text style={styles.textBtnText}>Use phone + OTP instead</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.linkedBadge}>
                <Text style={styles.linkedKicker}>SIGNED IN AS</Text>
                <Text style={styles.linkedEmail}>{gLink?.email}</Text>
              </View>
              <Text style={styles.h2}>Confirm your phone</Text>
              <Text style={styles.sub}>Enter the OTP sent to {phone}. We&apos;ll link Google to your driver account.</Text>
              <TextInput
                testID="login-glink-otp-input"
                value={otp}
                onChangeText={setOtp}
                keyboardType="number-pad"
                maxLength={6}
                placeholder={t.otp_placeholder}
                placeholderTextColor={colors.muted}
                style={[styles.input, styles.inputMono]}
              />
              <TouchableOpacity
                testID="login-glink-verify-button"
                style={[styles.cta, busy && { opacity: 0.7 }]}
                onPress={linkVerify}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={colors.white} /> : (
                  <Text style={styles.ctaText}>Link & sign in</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStage("google-link")} style={styles.textBtn}>
                <Text style={styles.textBtnText}>← Change phone</Text>
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
  h2: { fontFamily: fonts.display, fontSize: 22, color: colors.ink, marginTop: spacing.md },
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
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginVertical: spacing.md,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { fontFamily: fonts.uiBold, color: colors.muted, fontSize: 11, letterSpacing: 1 },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
  },
  googleG: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#4285F4",
    alignItems: "center",
    justifyContent: "center",
  },
  googleGText: {
    fontFamily: fonts.uiBold,
    color: colors.white,
    fontSize: 14,
    lineHeight: 16,
  },
  googleText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 16 },
  linkedBadge: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  linkedKicker: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 1,
  },
  linkedEmail: {
    fontFamily: fonts.dataMed,
    fontSize: 16,
    color: colors.ink,
    marginTop: 4,
  },
});
