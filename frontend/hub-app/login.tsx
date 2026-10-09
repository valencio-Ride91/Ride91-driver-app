// Sign in — and, for an account that covers every hub, pick which hub to open.
import React, { useEffect, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useI18n } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { Icon } from "@/src/hub/kit";
import { Btn, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface HubRow { id: string; name: string }

export default function Login() {
  const t = useHubText();
  const { lang, setLang } = useI18n();
  const { session, signIn, chooseHub, signOut } = useHubSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hubs, setHubs] = useState<HubRow[] | null>(null);

  // Signed in but no hub yet (a fleet manager or owner): load the hubs.
  const needsHub = !!session && !session.hubId;
  useEffect(() => {
    if (!needsHub) return;
    hubApi.get<{ items?: HubRow[] } | HubRow[]>("/admin/hubs")
      .then((r) => setHubs(Array.isArray(r) ? r : r.items ?? []))
      .catch(() => setHubs([]));
  }, [needsHub]);

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) return setErr(t.signin_need);
    setBusy(true);
    setErr(null);
    try {
      await signIn(username, password);
      setPassword("");
    } catch (e: any) {
      setErr(e?.status === 401 ? t.signin_bad : e?.status === 429 ? t.signin_locked : t.signin_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.top}>
            <Image source={require("@/assets/images/ride91-wordmark.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="Ride91" />
            <TouchableOpacity style={styles.lang} onPress={() => setLang(lang === "hi" ? "en" : "hi")} testID="hub-login-lang">
              <Text style={styles.langText}>{lang === "hi" ? "हिं" : "EN"}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.kicker}>{t.app_name}</Text>

          {needsHub ? (
            <>
              <Text style={styles.h1} testID="hub-pick-title">{t.pick_hub}</Text>
              <Text style={styles.sub}>{t.pick_hub_sub}</Text>
              {hubs === null ? <Text style={styles.sub}>{t.loading}</Text> : hubs.map((h) => (
                <TouchableOpacity key={h.id} style={styles.hubRow} onPress={() => chooseHub(h.id, h.name)} testID={`hub-pick-${h.id}`}>
                  <Text style={styles.hubName}>{h.name}</Text>
                  <Icon name="chevron-forward" size={18} color={colors.muted} />
                </TouchableOpacity>
              ))}
              {hubs !== null && hubs.length === 0 ? <Text style={styles.sub} testID="hub-pick-none">{t.pick_none}</Text> : null}
              <Btn label={t.sign_out} kind="ghost" onPress={signOut} style={{ marginTop: spacing.lg }} testID="hub-pick-signout" />
            </>
          ) : (
            <>
              <Text style={styles.h1} testID="hub-login-title">{t.signin_title}</Text>
              <Text style={styles.sub}>{t.signin_sub}</Text>
              <TextInput
                testID="hub-login-username"
                value={username}
                onChangeText={setUsername}
                placeholder={t.username}
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[hubStyles.input, styles.field]}
              />
              <TextInput
                testID="hub-login-password"
                value={password}
                onChangeText={setPassword}
                placeholder={t.password}
                placeholderTextColor={colors.muted}
                secureTextEntry
                onSubmitEditing={submit}
                style={[hubStyles.input, styles.field]}
              />
              {err ? <Text style={hubStyles.err} testID="hub-login-err">{err}</Text> : null}
              <Btn label={t.signin} onPress={submit} busy={busy} style={{ marginTop: spacing.md }} testID="hub-login-submit" />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl, flexGrow: 1 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xl },
  logo: { width: 170, height: 55 },
  lang: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.lg, backgroundColor: colors.ink },
  langText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  kicker: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.live, letterSpacing: 1.5, marginTop: spacing.sm, marginBottom: spacing.xl },
  h1: { fontFamily: fonts.display, fontSize: 30, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 15, color: colors.muted, marginTop: 6, marginBottom: spacing.md, lineHeight: 21 },
  field: { marginTop: spacing.sm, paddingVertical: 14, fontSize: 16 },
  hubRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm,
  },
  hubName: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.ink },
  chev: { fontFamily: fonts.uiBold, fontSize: 22, color: colors.muted },
});
