// Horizontal proportional bar of today's shift, coloured by platform.
// Offline periods are hatched (rendered as diagonal stripes via alternating
// bands to avoid a heavy SVG dependency).
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts, platformColors, spacing } from "@/src/theme";
import type { DutySegment } from "@/src/duty";
import { formatDuration } from "@/src/i18n";

interface Props {
  segments: DutySegment[];
  shiftSeconds: number;
  workingSeconds: number;
}

const HatchStripe: React.FC = () => (
  <View style={styles.hatchWrap}>
    <View style={styles.hatchBase} />
    <View style={styles.hatchLines}>
      {Array.from({ length: 20 }).map((_, i) => (
        <View key={i} style={styles.hatchLine} />
      ))}
    </View>
  </View>
);

export const DutyStripe: React.FC<Props> = ({ segments, shiftSeconds, workingSeconds }) => {
  const total = segments.reduce((a, s) => a + s.seconds, 0) || 1;
  return (
    <View style={styles.wrap} testID="duty-stripe">
      <View style={styles.header}>
        <Text style={styles.label}>Shift</Text>
        <Text style={styles.value} testID="duty-stripe-working">
          {formatDuration(workingSeconds)} / {formatDuration(shiftSeconds)}
        </Text>
      </View>
      <View style={styles.bar}>
        {segments.length === 0 ? (
          <View style={[styles.segment, { flex: 1, backgroundColor: colors.line }]} />
        ) : (
          segments.map((s, i) => {
            const flex = Math.max(s.seconds / total, 0.005);
            if (s.state === "offline") {
              return (
                <View
                  key={i}
                  style={{ flex }}
                  testID={`duty-seg-${i}-offline`}
                >
                  <HatchStripe />
                </View>
              );
            }
            const color = platformColors[s.state] ?? colors.muted;
            return (
              <View
                key={i}
                style={[styles.segment, { flex, backgroundColor: color }]}
                testID={`duty-seg-${i}-${s.state}`}
              />
            );
          })
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {},
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  label: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  value: { fontFamily: fonts.dataMed, fontSize: 13, color: colors.ink },
  bar: {
    flexDirection: "row",
    height: 18,
    borderRadius: 9,
    overflow: "hidden",
    backgroundColor: colors.line,
  },
  segment: { height: "100%" },
  hatchWrap: { flex: 1, overflow: "hidden" },
  hatchBase: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.muted },
  hatchLines: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    justifyContent: "space-between",
    opacity: 0.35,
  },
  hatchLine: {
    width: 2,
    height: "100%",
    backgroundColor: colors.paper,
    transform: [{ skewX: "-25deg" }],
  },
});
