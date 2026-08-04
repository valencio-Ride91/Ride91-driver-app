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

type Platform = "uber" | "rapido";

interface Extracted {
  platform: Platform;
  gross_amount: number | null;
  trips: number | null;
  cash_collected: number | null;
  period_hint: string | null;
  confidence: number;
}

interface Props {
  onImported: () => void;    // called after a close-out is enqueued
}

export const EarningsUploader: React.FC<Props> = ({ onImported }) => {
  const { t } = useI18n();
  const { enqueue } = useSync();
  const [busy, setBusy] = useState<Platform | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [gross, setGross] = useState("");
  const [trips, setTrips] = useState("");
  const [cash, setCash] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const pickAndExtract = useCallback(async (platform: Platform) => {
    setErr(null);
    // Request permission then open the gallery picker.
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
      setGross(r.gross_amount != null ? String(r.gross_amount) : "");
      setTrips(r.trips != null ? String(r.trips) : "");
      setCash(r.cash_collected != null ? String(r.cash_collected) : "");
    } catch (e: any) {
      setErr(e?.body?.detail || "Could not read the screenshot. Try again.");
      setPreviewUri(null);
    } finally {
      setBusy(null);
    }
  }, []);

  const save = useCallback(async () => {
    if (!extracted) return;
    const now = new Date().toISOString();
    await enqueue("/close-out", {
      platform: extracted.platform,
      from_ts: now,
      to_ts: now,
      trips: parseInt(trips || "0", 10),
      gross_amount: parseFloat(gross || "0"),
      cash_collected: parseFloat(cash || "0"),
    });
    setExtracted(null);
    setPreviewUri(null);
    setGross("");
    setTrips("");
    setCash("");
    onImported();
  }, [extracted, trips, gross, cash, enqueue, onImported]);

  const close = () => {
    setExtracted(null);
    setPreviewUri(null);
    setErr(null);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.h3}>Import from screenshot</Text>
      <Text style={styles.sub}>
        Screenshot your Uber or Rapido earnings and we'll read the numbers.
      </Text>
      <View style={styles.row}>
        {(["uber", "rapido"] as Platform[]).map((p) => (
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
            <View style={{ flex: 1 }}>
              <Text style={styles.upTitle}>{platformLabels[p]}</Text>
              <Text style={styles.upSub}>
                {busy === p ? "Reading…" : "Upload screenshot"}
              </Text>
            </View>
            {busy === p ? <ActivityIndicator color={platformColors[p]} /> : null}
          </TouchableOpacity>
        ))}
      </View>
      {err ? <Text style={styles.err} testID="upload-error">{err}</Text> : null}

      <BottomSheet
        visible={!!extracted}
        onClose={close}
        title={`Confirm ${extracted ? platformLabels[extracted.platform] : ""} earnings`}
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
                  style={styles.confConf}
                  testID="extract-confidence"
                >
                  {Math.round(extracted.confidence * 100)}% confidence
                </Text>
              </View>
            </View>

            <FieldBlock label="Gross">
              <TextInput
                testID="extract-gross"
                value={gross}
                onChangeText={setGross}
                keyboardType="numeric"
                style={styles.field}
                placeholder="₹0"
                placeholderTextColor={colors.muted}
              />
            </FieldBlock>
            <FieldBlock label="Trips">
              <TextInput
                testID="extract-trips"
                value={trips}
                onChangeText={setTrips}
                keyboardType="number-pad"
                style={styles.field}
                placeholder="0"
                placeholderTextColor={colors.muted}
              />
            </FieldBlock>
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

            {gross ? (
              <Text style={styles.summary} testID="extract-summary">
                Adding {formatINR(parseFloat(gross || "0"))} to today's{" "}
                {platformLabels[extracted.platform]} gross.
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
