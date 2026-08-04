// Deposit QR bottom sheet shown from Home (banner) and Money (button).
// The pseudo-QR is deterministic from driver id so it looks stable.
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "@/src/components/ui";
import { useI18n } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

interface Props {
  visible: boolean;
  onClose: () => void;
  driverId: string;
  qrCode: string;
}

const hashDot = (s: string, i: number): boolean => {
  let h = 5381;
  for (let k = 0; k < s.length; k++) h = ((h << 5) + h) ^ s.charCodeAt(k);
  h = (h ^ (i * 2654435761)) >>> 0;
  return (h & 1) === 1;
};

export const DepositSheet: React.FC<Props> = ({ visible, onClose, driverId, qrCode }) => {
  const { t } = useI18n();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t.deposit_cash}
      testID="deposit-sheet"
    >
      <Text style={styles.hint}>{t.scan_to_deposit}</Text>
      <View style={styles.qrBox} testID="deposit-qr">
        <View style={styles.qrGrid}>
          {Array.from({ length: 49 }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.qrCell,
                {
                  backgroundColor: hashDot(driverId || "x", i) ? colors.ink : colors.card,
                },
              ]}
            />
          ))}
        </View>
      </View>
      <Text style={styles.code} testID="deposit-qr-code">
        {qrCode}
      </Text>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  hint: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.md,
  },
  qrBox: {
    aspectRatio: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.md,
    alignSelf: "center",
    width: "80%",
  },
  qrGrid: { flex: 1, flexDirection: "row", flexWrap: "wrap" },
  qrCell: { width: `${100 / 7}%`, aspectRatio: 1 },
  code: {
    marginTop: spacing.md,
    fontFamily: fonts.dataMed,
    textAlign: "center",
    color: colors.ink,
    fontSize: 14,
  },
});
