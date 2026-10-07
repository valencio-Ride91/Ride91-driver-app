// Horizontal proportional bar of today's shift, coloured by the app the driver
// was online on. A stretch on two or three apps at once is drawn as stacked
// bands, one per app. Below the bar: how long the driver has been online on
// each app today.
//
// Offline periods are hatched (rendered as diagonal stripes via alternating
// bands to avoid a heavy SVG dependency).
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts, platformColors, platformLabels, spacing } from "@/src/theme";
import type { DutySegment } from "@/src/duty";
import { formatDuration } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";

interface Props {
  segments: DutySegment[];
  shiftSeconds: number;
  workingSeconds: number;
  /** Seconds online on each app today, from the server. */
  perPlatformSeconds?: Record<string, number>;
}

const LEGEND_ORDER = ["uber", "rapido", "ola"];

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

// The apps a segment was online on. New rows carry `platforms`; older ones
// name a single app in `state`.
const appsOf = (s: DutySegment): string[] =>
  s.platforms?.length ? s.platforms : LEGEND_ORDER.includes(s.state) ? [s.state] : [];

export const DutyStripe: React.FC<Props> = ({ segments, shiftSeconds, workingSeconds, perPlatformSeconds }) => {
  const c = useCardText();
  const total = segments.reduce((a, s) => a + s.seconds, 0) || 1;
  const legend = LEGEND_ORDER.filter((p) => (perPlatformSeconds?.[p] ?? 0) > 0);
  return (
    <View style={styles.wrap} testID="duty-stripe">
      <View style={styles.header}>
        <Text style={styles.label}>{c.shift}</Text>
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
            const apps = appsOf(s);
            if (apps.length > 1) {
              return (
                <View key={i} style={{ flex }} testID={`duty-seg-${i}-${apps.join("+")}`}>
                  {apps.map((p) => (
                    <View key={p} style={{ flex: 1, backgroundColor: platformColors[p] ?? colors.muted }} />
                  ))}
                </View>
              );
            }
            const color = platformColors[apps[0] ?? s.state] ?? colors.muted;
            return (
              <View
                key={i}
                style={[styles.segment, { flex, backgroundColor: color }]}
                testID={`duty-seg-${i}-${apps[0] ?? s.state}`}
              />
            );
          })
        )}
      </View>
      {legend.length > 0 ? (
        <View style={styles.legend} testID="duty-stripe-legend">
          {legend.map((p) => (
            <View key={p} style={styles.legendItem} testID={`duty-time-${p}`}>
              <View style={[styles.legendDot, { backgroundColor: platformColors[p] }]} />
              <Text style={styles.legendText}>
                {platformLabels[p]} {formatDuration(perPlatformSeconds![p])}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
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
  legend: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: fonts.dataMed, fontSize: 12, color: colors.ink },
  hatchWrap: { flex: 1, overflow: "hidden" },
  hatchBase: { ...StyleSheet.absoluteFill, backgroundColor: colors.muted },
  hatchLines: {
    ...StyleSheet.absoluteFill,
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
