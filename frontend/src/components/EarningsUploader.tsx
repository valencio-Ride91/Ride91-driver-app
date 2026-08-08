// Earnings screenshot uploader. Reads an image from the gallery, POSTs it to
// /api/earnings/extract, shows the model's parsed numbers in a confirmation
// sheet, and (on Save) enqueues a /close-out with those numbers.
//
// Design note: the extraction only READS the screenshot. Nothing hits the
// driver's ledger until they tap Save on the confirmation sheet — the driver
// stays in control of what enters the books.

import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";

import { BottomSheet } from "@/src/components/ui";
import { api } from "@/src/api";
import { useSync } from "@/src/sync";
import { formatINR, useI18n } from "@/src/i18n";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

type Platform = "uber" | "rapido" | "ola";

interface Extracted {
  platform: Platform;
  gross_amount: number | null;
  trips: number | null;
  cash_collected: number | null;
  period_hint: string | null;
  confidence: number;
}

interface Props {
  onImported: () => void;    // called after a platform_cash row is enqueued
}

export const EarningsUploader: React.FC<Props> = ({ onImported }) => {
  const { t } = useI18n();
  const { enqueue } = useSync();
  const [busy, setBusy] = useState<Platform | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewB64, setPreviewB64] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [cash, setCash] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const pickAndExtract = useCallback(async (platform: Platform) => {
    setErr(null);
    // CAMERA CAPTURE ONLY — gallery picker is disabled per spec (Part 4).
    // Kept as image picker for now with note; will move to camera in Part 7.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr("Photo library permission needed to read screenshots.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      base64: true,
      exif: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setPreviewUri(asset.uri);
    const b64Full = asset.base64 ? `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}` : null;
    setPreviewB64(b64Full);
    setBusy(platform);
    try {
      const b64 = asset.base64 ?? "";
      const r = await api.post<Extracted & { raw: string }>("/earnings/extract", {
        platform,
        image_base64: b64,
        mime: asset.mimeType ?? "image/jpeg",
        client_action_id: Crypto.randomUUID(),
      });
      setExtracted(r);
      // Cash-collected is the only figure the driver types now.
      setCash(r.cash_collected != null ? String(r.cash_collected) : "");
    } catch (e: any) {
      setErr(e?.body?.detail || "Could not read the screenshot. Try again.");
      setPreviewUri(null);
      setPreviewB64(null);
    } finally {
      setBusy(null);
    }
  }, []);

  const save = useCallback(async () => {
    if (!extracted) return;
    const conf = extracted.confidence;
    await enqueue("/platform-cash", {
      platform: extracted.platform,
      cash_amount: parseFloat(cash || "0"),
      image_ref: previewB64,
      confidence: conf,
    });
    setExtracted(null);
    setPreviewUri(null);
    setPreviewB64(null);
    setCash("");
    onImported();
  }, [extracted, cash, previewB64, enqueue, onImported]);

  const close = () => {
    setExtracted(null);
    setPreviewUri(null);
    setPreviewB64(null);
    setErr(null);
  };

  const lowConf = (extracted?.confidence ?? 0) < 0.5;

  return (
    <View style={styles.wrap}>
      <Text style={styles.h3}>Upload screenshot</Text>
      <Text style={styles.sub}>
        We only read the cash-collected figure. This is provisional until the
        fleet statement settles.
      </Text>
      <View style={styles.row}>
        {(["uber", "rapido", "ola"] as Platform[]).map((p) => (
          <TouchableOpacity
            key={p}
            testID={`upload-${p}-btn`}
            disabled={!!busy}
            onPress={() => pickAndExtract(p)}
            style={[
              styles.upBtn,
              { borderColor: platformColors[p] },
              busy === p ? { opacity: 0.7 } : null,
            ]}
          >
            <View style={[styles.dot, { backgroundColor: platformColors[p] }]} />
            <Text style={styles.upTitle}>{platformLabels[p]}</Text>
            {busy === p ? <ActivityIndicator size="small" color={platformColors[p]} /> : null}
          </TouchableOpacity>
        ))}
      </View>
      {err ? <Text style={styles.err} testID="upload-error">{err}</Text> : null}

      <BottomSheet
        visible={!!extracted}
        onClose={close}
        title={`Confirm ${extracted ? platformLabels[extracted.platform] : ""} cash`}
        testID="extract-sheet"
      >
        {extracted ? (
          <View>
            <View style={styles.confRow}>
              {previewUri ? (
                <Image source={{ uri: previewUri }} style={styles.thumb} />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={styles.confHint}>
                  {extracted.period_hint ?? "Extracted values"}
                </Text>
                <Text
                  style={[styles.confConf, lowConf ? { color: colors.alert, fontFamily: fonts.uiBold } : null]}
                  testID="extract-confidence"
                >
                  {Math.round(extracted.confidence * 100)}% confidence
                  {lowConf ? "  ·  LOW — check carefully" : ""}
                </Text>
              </View>
            </View>

            <FieldBlock label="Cash collected">
              <TextInput
                testID="extract-cash"
                value={cash}
                onChangeText={setCash}
                keyboardType="numeric"
                style={styles.field}
                placeholder="₹0"
                placeholderTextColor={colors.muted}
              />
            </FieldBlock>

            {cash ? (
              <Text style={styles.summary} testID="extract-summary">
                Recording {formatINR(parseFloat(cash || "0"))} of{" "}
                {platformLabels[extracted.platform]} cash for today (provisional).
              </Text>
            ) : null}

            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={close}
                testID="extract-cancel"
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={save}
                testID="extract-save"
              >
                <Text style={styles.primaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
};

const FieldBlock: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <View style={{ marginBottom: spacing.md }}>
    <Text style={styles.label}>{label}</Text>
    {children}
  </View>
);

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  h3: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  row: { flexDirection: "row", gap: spacing.sm },
  upBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.card,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  upTitle: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink },
  upSub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  err: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.alert },
  confRow: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.md, alignItems: "center" },
  thumb: {
    width: 64,
    height: 96,
    borderRadius: radius.sm,
    backgroundColor: colors.line,
  },
  confHint: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  confConf: { fontFamily: fonts.data, fontSize: 12, color: colors.muted, marginTop: 2 },
  summary: {
    fontFamily: fonts.uiMed,
    fontSize: 13,
    color: colors.live,
    marginBottom: spacing.sm,
  },
  label: {
    fontFamily: fonts.uiMed,
    fontSize: 12,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  field: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fonts.dataMed,
    fontSize: 17,
    color: colors.ink,
  },
  actions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  primaryBtn: {
    flex: 1,
    backgroundColor: colors.live,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.white },
  secondaryBtn: {
    flex: 1,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  secondaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.ink },
});
