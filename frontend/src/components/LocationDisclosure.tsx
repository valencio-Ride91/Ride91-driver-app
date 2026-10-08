// The notice shown before Android's own location prompt.
//
// The app tracks location in the background, so the driver has to be told
// plainly — what is collected, why, and that it continues with the app closed
// — and has to agree, before the phone is asked for the permission. Google
// Play requires exactly this for background location; it is also simply the
// honest thing to do. "Not now" leaves location off; the driver can come back
// to it from the "Location off" pill or by starting duty.
import React from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, radius, spacing } from "@/src/theme";

export const LocationDisclosure: React.FC<{ visible: boolean; onAnswer: (allow: boolean) => void }> = ({ visible, onAnswer }) => {
  const c = useCardText();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onAnswer(false)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="location-disclosure">
          <Text style={styles.title}>{c.loc_disc_title}</Text>
          <Text style={styles.lead}>{c.loc_disc_lead}</Text>
          <Text style={styles.point}>• {c.loc_disc_point_office}</Text>
          <Text style={styles.point}>• {c.loc_disc_point_duty}</Text>
          <Text style={styles.point}>• {c.loc_disc_point_always}</Text>
          <Text style={styles.foot}>{c.loc_disc_foot}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => onAnswer(true)} testID="location-disclosure-allow">
            <Text style={styles.btnText}>{c.loc_disc_allow}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnGhost} onPress={() => onAnswer(false)} testID="location-disclosure-later">
            <Text style={styles.btnGhostText}>{c.loc_disc_later}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(16,35,28,0.55)", justifyContent: "center", padding: spacing.lg },
  sheet: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg },
  title: { fontFamily: fonts.display, fontSize: 20, color: colors.ink, marginBottom: spacing.sm },
  lead: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, lineHeight: 21, marginBottom: spacing.sm },
  point: { fontFamily: fonts.ui, fontSize: 14, color: colors.ink, lineHeight: 21, marginBottom: 4 },
  foot: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, lineHeight: 18, marginTop: spacing.sm },
  btn: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: 14, alignItems: "center", marginTop: spacing.md },
  btnText: { fontFamily: fonts.uiBold, color: colors.onBrand, fontSize: 15 },
  btnGhost: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  btnGhostText: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 14 },
});
