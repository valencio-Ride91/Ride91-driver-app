// Web fallback (preview only): soft placeholder with coordinates.
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts, spacing } from "@/src/theme";

interface Props {
  lat: number | null;
  lng: number | null;
}

export const DriverMap: React.FC<Props> = ({ lat, lng }) => (
  <View style={styles.wrap}>
    <View style={styles.grid}>
      {Array.from({ length: 12 }).map((_, i) => (
        <View key={i} style={styles.gridLine} />
      ))}
    </View>
    <View style={styles.center}>
      <View style={styles.pinRing}>
        <View style={styles.pinDot} />
      </View>
      <Text style={styles.title}>Live map (native only)</Text>
      <Text style={styles.sub} testID="home-map-coords">
        {lat != null && lng != null
          ? `${lat.toFixed(5)},  ${lng.toFixed(5)}`
          : "Locating…"}
      </Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#DEE6DF",
    overflow: "hidden",
  },
  grid: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    justifyContent: "space-between",
    opacity: 0.5,
  },
  gridLine: { width: 1, backgroundColor: colors.line, height: "100%" },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  pinRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(11,122,75,0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.live,
  },
  title: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.muted },
  sub: { fontFamily: fonts.data, fontSize: 13, color: colors.muted },
});
