// Lets a driver change the password ops issued them. Collapsed by default;
// expands to current / new / confirm fields.
import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { api } from "@/src/api";
import { useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

export function ChangePasswordCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const reset = () => { setCur(""); setNext(""); setConfirm(""); setErr(null); };

  const submit = async () => {
    setErr(null); setOk(false);
    if (next.length < 6) return setErr(t.pw_short);
    if (next !== confirm) return setErr(t.pw_mismatch);
    setBusy(true);
    try {
      await api.post("/auth/change-password", { old_password: cur, new_password: next });
      setOk(true);
      reset();
      setTimeout(() => { setOk(false); setOpen(false); }, 1800);
    } catch (e: any) {
      setErr(e?.body?.detail === "wrong_current_password" ? t.pw_wrong : t.login_error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <TouchableOpacity
        testID="change-password-toggle"
        style={styles.header}
        onPress={() => { setOpen(!open); reset(); setOk(false); }}
      >
        <Text style={styles.h2}>{t.change_password}</Text>
        <Text style={styles.chevron}>{open ? "▾" : "›"}</Text>
      </TouchableOpacity>

      {open ? (
        <View style={styles.body}>
          <TextInput
            testID="pw-current" value={cur} onChangeText={setCur} secureTextEntry
            autoCapitalize="none" placeholder={t.pw_current} placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            testID="pw-new" value={next} onChangeText={setNext} secureTextEntry
            autoCapitalize="none" placeholder={t.pw_new} placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <TextInput
            testID="pw-confirm" value={confirm} onChangeText={setConfirm} secureTextEntry
            autoCapitalize="none" placeholder={t.pw_confirm} placeholderTextColor={colors.muted}
            style={styles.input}
          />
          {err ? <Text style={styles.err} testID="pw-err">{err}</Text> : null}
          {ok ? <Text style={styles.ok} testID="pw-ok">{t.pw_changed}</Text> : null}
          <TouchableOpacity
            testID="pw-save"
            style={[styles.cta, (busy || !cur || !next) && { opacity: 0.6 }]}
            onPress={submit}
            disabled={busy || !cur || !next}
          >
            {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.ctaText}>{t.pw_save}</Text>}
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  chevron: { fontFamily: fonts.uiBold, fontSize: 20, color: colors.muted },
  body: { marginTop: spacing.md, gap: spacing.sm },
  input: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fonts.uiMed,
    fontSize: 16,
    color: colors.ink,
  },
  cta: { backgroundColor: colors.live, borderRadius: radius.md, paddingVertical: 13, alignItems: "center", marginTop: spacing.xs },
  ctaText: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.white },
  err: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.alert },
  ok: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.live },
});
