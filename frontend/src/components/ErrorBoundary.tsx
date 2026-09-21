// Root error boundary. Without this, any error thrown while rendering shows a
// blank screen and the app looks like it "won't open" — with no clue why. This
// catches JS render/runtime errors and shows the message so it can be read (and
// screenshotted) on the device. It cannot catch native (non-JS) crashes.
import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { colors, fonts, radius, spacing } from "@/src/theme";

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surfaced in `adb logcat` / Metro for remote debugging.
    console.error("RootErrorBoundary caught:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.wrap}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.sub}>The app hit an error while starting. Please share this screen with support.</Text>
          <View style={styles.box}>
            <Text style={styles.msg}>{error.message || String(error)}</Text>
            {error.stack ? <Text style={styles.stack}>{error.stack.slice(0, 1200)}</Text> : null}
          </View>
          <TouchableOpacity style={styles.btn} onPress={() => this.setState({ error: null })}>
            <Text style={styles.btnText}>Try again</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.xl, paddingTop: 80, gap: spacing.md },
  title: { fontFamily: fonts.display, fontSize: 26, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted },
  box: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
    gap: spacing.sm,
  },
  msg: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.alert },
  stack: { fontFamily: fonts.dataMed, fontSize: 11, color: colors.muted },
  btn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  btnText: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.white },
});
