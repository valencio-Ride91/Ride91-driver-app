// Sticky header used on every tab. Shows language selector, unsynced pill,
// and health pill. Language selector is here, not buried in settings.
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";

import { colors, fonts, radius, spacing } from "@/src/theme";
import { useI18n, Lang } from "@/src/i18n";
import { useSync } from "@/src/sync";
import { useTracking } from "@/src/tracking";
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";
import { BottomSheet } from "@/src/components/ui";

const LANG_LABEL: Record<Lang, string> = { en: "EN", hi: "हिं", kn: "ಕನ್" };

// Single-truth status pill. Never shows two contradictory states.
// Priority: GPS off > No network > Saving N > On phone N > Synced
const singleStatus = (
  online: boolean,
  permissionOk: boolean,
  unsynced: number,
  t: ReturnType<typeof useI18n>["t"],
): { bg: string; fg: string; label: string; testID: string } => {
  if (!permissionOk) return { bg: colors.alert, fg: colors.white, label: t.health_location, testID: "status-gps-off" };
  if (!online && unsynced > 0)
    return { bg: colors.muted, fg: colors.white, label: `On phone ${unsynced}`, testID: "status-on-phone" };
  if (!online)
    return { bg: colors.muted, fg: colors.white, label: t.health_offline, testID: "status-offline" };
  if (unsynced > 0)
    return { bg: colors.amber, fg: colors.ink, label: `Saving ${unsynced}`, testID: "status-saving" };
  return { bg: colors.live, fg: colors.white, label: t.health_synced, testID: "status-synced" };
};

interface Props {
  title: string;
}

export const AppHeader: React.FC<Props> = ({ title }) => {
  const { lang, setLang, t } = useI18n();
  const { unsynced, online } = useSync();
  const { permissionOk, requestPermission } = useTracking();
  const { driver } = useAuth();
  const router = useRouter();
  const [langOpen, setLangOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const status = singleStatus(online, permissionOk, unsynced, t);

  useEffect(() => {
    if (!driver) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<{ unread: number }>("/notifications");
        if (alive) setUnread(r.unread ?? 0);
      } catch {
        // keep previous
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [driver]);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.title} testID="app-header-title">
          {title}
        </Text>
        <View style={styles.rightRow}>
          <TouchableOpacity
            style={styles.bellBtn}
            onPress={() => router.push("/notifications" as never)}
            testID="notif-bell"
          >
            <Text style={styles.bellIcon}>🔔</Text>
            {unread > 0 ? (
              <View style={styles.bellBadge} testID="notif-badge">
                <Text style={styles.bellBadgeText}>{unread > 9 ? "9+" : unread}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.healthPill, { backgroundColor: status.bg }]}
            onPress={() => {
              if (!permissionOk) requestPermission();
            }}
            testID={status.testID}
          >
            <Text style={[styles.healthText, { color: status.fg }]}>{status.label}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.langPill}
            onPress={() => setLangOpen(true)}
            testID="lang-selector"
          >
            <Text style={styles.langText}>{LANG_LABEL[lang]}</Text>
          </TouchableOpacity>
        </View>
      </View>
      {unsynced > 0 && online ? (
        <Text style={styles.unsyncedBanner} testID="unsynced-banner">
          {t.unsynced_msg(unsynced)}
        </Text>
      ) : null}

      <BottomSheet visible={langOpen} onClose={() => setLangOpen(false)} title={t.language}>
        {(["en", "hi", "kn"] as Lang[]).map((l) => (
          <TouchableOpacity
            key={l}
            testID={`lang-option-${l}`}
            onPress={() => {
              setLang(l);
              setLangOpen(false);
            }}
            style={[styles.langOption, l === lang ? styles.langOptionActive : null]}
          >
            <Text style={styles.langOptionText}>
              {LANG_LABEL[l]}  ·  {l === "en" ? "English" : l === "hi" ? "हिन्दी" : "ಕನ್ನಡ"}
            </Text>
          </TouchableOpacity>
        ))}
      </BottomSheet>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.paper,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontFamily: fonts.display, fontSize: 24, color: colors.ink },
  rightRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  bellBtn: { padding: 4 },
  bellIcon: { fontSize: 20 },
  bellBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.alert,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  bellBadgeText: { fontFamily: fonts.uiBold, fontSize: 9, color: colors.white },
  healthPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.lg,
  },
  healthText: { fontFamily: fonts.uiBold, fontSize: 12 },
  langPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.lg,
    backgroundColor: colors.ink,
  },
  langText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  unsyncedPill: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.amber,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  unsyncedText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.ink },
  unsyncedBanner: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    marginTop: 6,
  },
  langOption: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  langOptionActive: { backgroundColor: colors.paper },
  langOptionText: { fontFamily: fonts.uiMed, fontSize: 16, color: colors.ink },
});
