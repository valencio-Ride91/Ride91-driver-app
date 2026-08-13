// Reusable card that lists a driver's document wallet with expiry-based
// status pills. Uploading images is intentionally kept inside a bottom-sheet
// so the caller can drop this in Profile / onboarding without owning the
// picker state.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useSync } from "@/src/sync";
import { colors, fonts, radius, spacing } from "@/src/theme";

export type DocStatus = "expired" | "expiring_soon" | "ok" | "missing";

export interface DocRow {
  id: string;
  type: string;
  label: string;
  number: string | null;
  expires_on: string | null;
  status: DocStatus;
  verified: boolean;
  updated_at?: string;
}

const STATUS_META: Record<DocStatus, { label: string; bg: string; fg: string }> = {
  expired: { label: "Expired", bg: "#F5D4CE", fg: colors.alert },
  expiring_soon: { label: "Renew ≤30d", bg: "#FBEAC8", fg: "#8A5A00" },
  ok: { label: "Valid", bg: "#DCEEE3", fg: colors.live },
  missing: { label: "Missing", bg: colors.line, fg: colors.muted },
};

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function addDaysIso(base: string, days: number): string {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DocumentsCard: React.FC = () => {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DocRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ items: DocRow[] }>("/documents");
      setRows(r.items);
    } catch {
      // keep whatever we have
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const attention = useMemo(
    () => rows.filter((r) => r.status !== "ok").length,
    [rows],
  );

  return (
    <View testID="documents-card">
      <View style={styles.rowBetween}>
        <Text style={styles.h2}>Documents</Text>
        {attention > 0 ? (
          <View style={[styles.badge, { backgroundColor: "#F5D4CE" }]}>
            <Text style={[styles.badgeText, { color: colors.alert }]}>
              {attention} need attention
            </Text>
          </View>
        ) : (
          <View style={[styles.badge, { backgroundColor: "#DCEEE3" }]}>
            <Text style={[styles.badgeText, { color: colors.live }]}>All valid</Text>
          </View>
        )}
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginVertical: spacing.md }} />
      ) : (
        rows.map((r) => (
          <TouchableOpacity
            key={r.id}
            testID={`doc-row-${r.type}`}
            style={styles.docRow}
            onPress={() => setEditing(r)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.docLabel}>{r.label}</Text>
              <Text style={styles.docMeta}>
                {r.number ? `${r.number} · ` : ""}
                {r.expires_on ? `expires ${r.expires_on}` : "no expiry on file"}
              </Text>
            </View>
            <View
              testID={`doc-status-${r.type}`}
              style={[styles.pill, { backgroundColor: STATUS_META[r.status].bg }]}
            >
              <Text style={[styles.pillText, { color: STATUS_META[r.status].fg }]}>
                {STATUS_META[r.status].label}
              </Text>
            </View>
          </TouchableOpacity>
        ))
      )}
      <DocEditor
        doc={editing}
        onClose={(saved) => {
          setEditing(null);
          if (saved) {
            // Delay the refresh a bit so the offline sync worker has a
            // window to actually POST — otherwise the row briefly shows
            // the stale status pill.
            setTimeout(refresh, 1200);
          }
        }}
      />
    </View>
  );
};

// ---------------------------------------------------------------------------
// Doc editor sheet
// ---------------------------------------------------------------------------

const DocEditor: React.FC<{ doc: DocRow | null; onClose: (saved: boolean) => void }> = ({
  doc,
  onClose,
}) => {
  const [number, setNumber] = useState<string>("");
  const [expires, setExpires] = useState<string>("");
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { enqueue } = useSync();

  useEffect(() => {
    setNumber(doc?.number ?? "");
    setExpires(doc?.expires_on ?? "");
    setImageB64(null);
    setErr(null);
  }, [doc?.id]);

  const pickImage = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Photo permission needed", "Allow photo library access to upload a document image.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.6,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      if (a.base64) {
        setImageB64(`data:${a.mimeType ?? "image/jpeg"};base64,${a.base64}`);
      }
    } catch (e: any) {
      setErr(e?.message ?? "picker_error");
    }
  }, []);

  const save = useCallback(async () => {
    if (!doc) return;
    // Validate YYYY-MM-DD.
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      setErr("Expiry must be YYYY-MM-DD");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await enqueue("/documents", {
        type: doc.type,
        number: number || null,
        expires_on: expires || null,
        image_b64: imageB64 ?? undefined,
      });
      // Give the sync worker time to POST before we bounce a re-read at the
      // parent, so the status pill picks up the new expiry.
      onClose(true);
    } catch (e: any) {
      setErr(e?.body?.detail ?? e?.message ?? "save_failed");
    } finally {
      setSaving(false);
    }
  }, [doc, number, expires, imageB64, enqueue, onClose]);

  return (
    <Modal
      transparent
      animationType="slide"
      visible={!!doc}
      onRequestClose={() => onClose(false)}
    >
      <Pressable style={styles.sheetBackdrop} onPress={() => onClose(false)}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>{doc?.label ?? "Document"}</Text>
          <Text style={styles.sheetSub}>{doc?.type ?? ""}</Text>

          <Text style={styles.field}>Document number</Text>
          <TextInput
            testID="doc-input-number"
            style={styles.input}
            value={number}
            onChangeText={setNumber}
            placeholder="e.g. KA01 2020 0001234"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
          />

          <Text style={styles.field}>Expiry (YYYY-MM-DD)</Text>
          <TextInput
            testID="doc-input-expires"
            style={styles.input}
            value={expires}
            onChangeText={setExpires}
            placeholder={todayIso()}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
          />
          <View style={styles.expiryHelpers}>
            {[30, 90, 180, 365].map((d) => (
              <TouchableOpacity
                key={d}
                testID={`doc-expiry-plus-${d}`}
                style={styles.helper}
                onPress={() => setExpires(addDaysIso(todayIso(), d))}
              >
                <Text style={styles.helperText}>+{d}d</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            testID="doc-pick-image"
            style={styles.imgBtn}
            onPress={pickImage}
          >
            <Text style={styles.imgBtnText}>
              {imageB64 ? "Image chosen · tap to change" : "Attach photo of document"}
            </Text>
          </TouchableOpacity>

          {err ? (
            <Text style={styles.errText} testID="doc-err">
              {err}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
            <TouchableOpacity
              testID="doc-cancel"
              style={styles.secondary}
              onPress={() => onClose(false)}
              disabled={saving}
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="doc-save"
              style={styles.primary}
              onPress={save}
              disabled={saving}
            >
              <Text style={styles.primaryText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 0.4 },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  docLabel: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 14 },
  docMeta: {
    fontFamily: fonts.ui,
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  pillText: { fontFamily: fonts.uiBold, fontSize: 11 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(16,35,28,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.line,
    marginBottom: spacing.md,
  },
  sheetTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    color: colors.ink,
  },
  sheetSub: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    marginBottom: spacing.md,
  },
  field: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  input: {
    fontFamily: fonts.dataMed,
    fontSize: 15,
    color: colors.ink,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  expiryHelpers: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 8,
  },
  helper: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  helperText: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.ink },
  imgBtn: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderStyle: "dashed",
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: "center",
    backgroundColor: colors.paper,
  },
  imgBtnText: { fontFamily: fonts.uiMed, color: colors.ink, fontSize: 13 },
  errText: {
    fontFamily: fonts.uiMed,
    color: colors.alert,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  primary: {
    flex: 1,
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 15 },
});
