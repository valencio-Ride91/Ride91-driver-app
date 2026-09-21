// Driver notifications — a simple two-way message thread with ops. Messages
// from ops are marked read on open. The driver can send a message to ops.
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useI18n, formatIST } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface Notif {
  id: string;
  direction: "from_driver" | "to_driver";
  body: string;
  created_at: string;
  read: boolean;
}

export default function Notifications() {
  const { t } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Notif[] }>("/notifications");
      setItems(r.items);
      // Mark unread ops→driver messages as read.
      const unread = r.items.filter((n) => n.direction === "to_driver" && !n.read);
      await Promise.all(unread.map((n) => api.post(`/notifications/${n.id}/read`).catch(() => {})));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.post("/notifications", { body: text.trim(), client_action_id: Crypto.randomUUID() });
      setText("");
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="notif-back" style={styles.back}>
          <Text style={styles.backText}>‹ {t.home}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t.notif_title}</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.live} /></View>
        ) : items.length === 0 ? (
          <View style={styles.center}><Text style={styles.empty}>{t.notif_empty}</Text></View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(n) => n.id}
            inverted
            contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
            renderItem={({ item }) => {
              const fromOps = item.direction === "to_driver";
              return (
                <View style={[styles.bubbleRow, { justifyContent: fromOps ? "flex-start" : "flex-end" }]}>
                  <View style={[styles.bubble, fromOps ? styles.opsBubble : styles.meBubble]}>
                    <Text style={[styles.bubbleText, fromOps ? styles.opsText : styles.meText]}>{item.body}</Text>
                    <Text style={[styles.bubbleMeta, fromOps ? styles.opsMeta : styles.meMeta]}>
                      {fromOps ? t.notif_from_ops : t.notif_from_you} · {formatIST(item.created_at)}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        <View style={styles.composer}>
          <TextInput
            testID="notif-input"
            value={text}
            onChangeText={setText}
            placeholder={t.notif_placeholder}
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
          />
          <TouchableOpacity
            testID="notif-send"
            style={[styles.sendBtn, (sending || !text.trim()) && { opacity: 0.5 }]}
            onPress={send}
            disabled={sending || !text.trim()}
          >
            {sending ? <ActivityIndicator color={colors.white} /> : <Text style={styles.sendText}>{t.notif_send}</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { width: 60 },
  backText: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.muted },
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted },
  bubbleRow: { flexDirection: "row" },
  bubble: { maxWidth: "78%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.lg },
  opsBubble: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  meBubble: { backgroundColor: colors.live },
  bubbleText: { fontFamily: fonts.uiMed, fontSize: 15 },
  opsText: { color: colors.ink },
  meText: { color: colors.white },
  bubbleMeta: { fontFamily: fonts.ui, fontSize: 10, marginTop: 4 },
  opsMeta: { color: colors.muted },
  meMeta: { color: colors.white, opacity: 0.8 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontFamily: fonts.uiMed,
    fontSize: 15,
    color: colors.ink,
  },
  sendBtn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.white },
});
