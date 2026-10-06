// Loyalty milestones — the driver's journey up the earnings ladder.
//
// Top: how much they have earned in total and how much bonus that has already
// unlocked. Below: every milestone as a step on a vertical track, each with
// its own bonus, so the driver sees what is done, what is next (with progress
// and the amount still to go) and what lies further ahead.

import React from "react";
import { StyleSheet, Text, View, ViewStyle } from "react-native";

import { Card } from "@/src/components/ui";
import { formatINR } from "@/src/i18n";
import { colors, fonts, radius, spacing } from "@/src/theme";

export interface LoyaltyMilestone {
  key: string;
  label: string;
  reward: number;
  amount: number;
  reached: boolean;
  vested: boolean;
  forfeited: boolean;
}

export interface LoyaltyState {
  tenure_days: number | null;
  gross?: number;
  active: boolean;
  milestones: LoyaltyMilestone[];
  next: { key: string; label: string; reward: number; amount: number; remaining: number; progress: number } | null;
  vested_total: number;
}

const LIVE_TINT = "#E3F1EA";
const AMBER_TINT = "#FCF2D9";
const AMBER_INK = "#8A5D00";

function tenureText(days: number | null): string | null {
  if (days == null) return null;
  if (days < 60) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  const y = Math.floor(days / 365);
  const mo = Math.floor((days % 365) / 30);
  return mo ? `${y}y ${mo}mo` : `${y} year${y > 1 ? "s" : ""}`;
}

export const LoyaltyMilestonesCard: React.FC<{ data: LoyaltyState; style?: ViewStyle }> = ({ data, style }) => {
  const ms = data.milestones ?? [];
  const next = data.next;
  const done = ms.filter((m) => m.vested).length;
  // Older servers don't send `gross`; derive it from the next milestone.
  const earned =
    data.gross ?? (next ? next.amount - next.remaining : ms.length ? ms[ms.length - 1].amount : 0);
  const tenure = tenureText(data.tenure_days);

  return (
    <Card testID="rewards-loyalty-card" style={style}>
      <View style={styles.head}>
        <Text style={styles.title}>Loyalty milestones 🎖️</Text>
        {tenure ? <Text style={styles.hint}>{tenure} with Ride91</Text> : null}
      </View>

      {/* Where the driver stands */}
      <View style={styles.summary}>
        <View style={styles.summaryCol}>
          <Text style={styles.kicker}>TOTAL EARNED</Text>
          <Text style={styles.hero} testID="loyalty-earned" numberOfLines={1} adjustsFontSizeToFit>{formatINR(earned)}</Text>
        </View>
        <View style={[styles.summaryCol, styles.summaryRight]}>
          <Text style={styles.kicker}>BONUS UNLOCKED</Text>
          <Text style={[styles.hero, styles.heroLive]} testID="loyalty-unlocked" numberOfLines={1} adjustsFontSizeToFit>
            +{formatINR(data.vested_total ?? 0)}
          </Text>
        </View>
      </View>
      {ms.length ? (
        <Text style={styles.count}>
          {done} of {ms.length} milestone{ms.length === 1 ? "" : "s"} reached
        </Text>
      ) : null}

      {/* The ladder */}
      {ms.length === 0 ? (
        <Text style={styles.empty}>No milestones have been set yet.</Text>
      ) : (
        <View style={styles.ladder}>
          {ms.map((m, i) => {
            const isNext = !!next && next.key === m.key;
            const last = i === ms.length - 1;
            const pathDone = !last && ms[i + 1].reached;
            const pct = isNext ? Math.round(Math.max(0, Math.min(1, next!.progress)) * 100) : 0;
            return (
              <View key={m.key} style={styles.step} testID={`loyalty-step-${m.key}`}>
                <View style={styles.railCol}>
                  <View
                    style={[
                      styles.node,
                      m.vested ? styles.nodeDone : null,
                      m.forfeited ? styles.nodeLost : null,
                      isNext ? styles.nodeNext : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.nodeText,
                        m.vested || m.forfeited ? styles.nodeTextOn : null,
                        isNext ? styles.nodeTextNext : null,
                      ]}
                    >
                      {m.vested ? "✓" : m.forfeited ? "✕" : i + 1}
                    </Text>
                  </View>
                  {!last ? <View style={[styles.rail, pathDone ? styles.railDone : null]} /> : null}
                </View>

                <View
                  style={[
                    styles.body,
                    isNext ? styles.bodyNext : null,
                    last ? (isNext ? styles.bodyNextLast : styles.bodyLast) : null,
                  ]}
                >
                  <View style={styles.rowHead}>
                    <Text style={[styles.label, !m.reached && !isNext ? styles.labelAhead : null]}>{m.label}</Text>
                    <Text
                      style={[
                        styles.reward,
                        m.vested ? styles.rewardDone : null,
                        m.forfeited ? styles.rewardLost : null,
                        isNext ? styles.rewardNext : null,
                      ]}
                    >
                      +{formatINR(m.reward)}
                    </Text>
                  </View>

                  {m.vested ? (
                    <Text style={[styles.status, styles.statusDone]}>Unlocked · added to your wallet</Text>
                  ) : m.forfeited ? (
                    <Text style={[styles.status, styles.statusLost]}>Reached, but lost on leaving</Text>
                  ) : isNext ? (
                    <>
                      <View style={styles.bar}>
                        <View style={[styles.barFill, { width: `${pct}%` as const }]} />
                      </View>
                      <View style={styles.nextFoot}>
                        <Text style={styles.toGo}>{formatINR(next!.remaining)} to go</Text>
                        <Text style={styles.pct}>{pct}%</Text>
                      </View>
                    </>
                  ) : (
                    <Text style={styles.status}>Unlocks at {formatINR(m.amount)} earned</Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {ms.length > 0 && !next && done === ms.length ? (
        <Text style={styles.allDone}>You&apos;ve reached every milestone. Thank you!</Text>
      ) : null}

      <Text style={styles.note}>
        Bonuses land in your loyalty wallet and are paid by the office. Milestones unlock only while you&apos;re active.
      </Text>
    </Card>
  );
};

const NODE = 26;

const styles = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  hint: { fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted },

  summary: {
    flexDirection: "row",
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  summaryCol: { flex: 1 },
  summaryRight: { alignItems: "flex-end" },
  kicker: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.8 },
  hero: { fontFamily: fonts.dataMed, fontSize: 22, color: colors.ink, marginTop: 2 },
  heroLive: { color: colors.live },
  count: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.muted, marginTop: spacing.sm },

  ladder: { marginTop: spacing.md },
  step: { flexDirection: "row" },
  railCol: { width: NODE, alignItems: "center" },
  node: {
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeDone: { backgroundColor: colors.live, borderColor: colors.live },
  nodeLost: { backgroundColor: colors.alert, borderColor: colors.alert },
  nodeNext: { borderColor: colors.amber, backgroundColor: AMBER_TINT },
  nodeText: { fontFamily: fonts.dataMed, fontSize: 12, color: colors.muted },
  nodeTextOn: { color: colors.white, fontFamily: fonts.uiBold },
  nodeTextNext: { color: AMBER_INK },
  rail: { flex: 1, width: 2, backgroundColor: colors.line, marginVertical: 2 },
  railDone: { backgroundColor: colors.live },

  body: { flex: 1, marginLeft: spacing.md, paddingBottom: spacing.lg, paddingTop: 3 },
  bodyNext: {
    backgroundColor: AMBER_TINT,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
    marginTop: -4,
  },
  bodyLast: { paddingBottom: 0 },
  bodyNextLast: { marginBottom: 0 },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink, flexShrink: 1, paddingRight: spacing.sm },
  labelAhead: { color: colors.muted },
  reward: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.muted },
  rewardDone: { color: colors.live },
  rewardLost: { color: colors.alert, textDecorationLine: "line-through" },
  rewardNext: { color: AMBER_INK },
  status: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 2 },
  statusDone: { color: colors.live, fontFamily: fonts.uiMed },
  statusLost: { color: colors.alert },

  bar: { height: 8, borderRadius: 4, backgroundColor: colors.card, marginTop: 8, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4, backgroundColor: colors.amber },
  nextFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  toGo: { fontFamily: fonts.uiBold, fontSize: 12, color: AMBER_INK },
  pct: { fontFamily: fonts.data, fontSize: 12, color: AMBER_INK },

  empty: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, marginTop: spacing.md },
  allDone: {
    fontFamily: fonts.uiBold,
    fontSize: 13,
    color: colors.live,
    backgroundColor: LIVE_TINT,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    overflow: "hidden",
    textAlign: "center",
  },
  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.md },
});
