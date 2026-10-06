// PayDuesButton — shows what the driver owes, and nothing more.
//
// It used to start a Razorpay hosted checkout (order → web checkout → poll for
// the webhook). That payment function has been removed from the driver app;
// the control is kept as a greyed, non-interactive label so the amount due
// stays visible in the same place on the Earnings tab.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts, radius } from "@/src/theme";
import { useCardText } from "@/src/i18n/cards";

interface Props {
  duesPaise: number;
}

export const PayDuesButton: React.FC<Props> = ({ duesPaise }) => {
  const c = useCardText();
  return (
  <View
    testID="pay-dues-btn"
    style={[styles.btn, styles.btnDisabled]}
    accessibilityState={{ disabled: true }}
  >
    <Text style={styles.txt}>
      {c.pay_dues((duesPaise / 100).toFixed(0))}
    </Text>
  </View>
  );
};

const styles = StyleSheet.create({
  btn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  btnDisabled: { opacity: 0.5 },
  txt: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
});
