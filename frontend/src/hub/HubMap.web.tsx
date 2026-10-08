// Browser preview only: Google Maps is drawn by the phone, so here the dots
// are laid out on a plain panel by their positions. Enough to see who is on
// the map and to try tapping one.
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import type { HubMapProps } from "@/src/hub/mapTypes";
import { colors, fonts } from "@/src/theme";

const FILL = { live: colors.live, quiet: "#C98A00", off: colors.muted };

export const HubMap: React.FC<HubMapProps> = ({ data, selectedId, onSelect }) => {
  const all = [...data.pins.map((p) => [p.lat, p.lng]), ...(data.hub ? [[data.hub.lat, data.hub.lng]] : [])];
  const lats = all.map((p) => p[0]), lngs = all.map((p) => p[1]);
  const span = (v: number[]) => Math.max(Math.max(...v) - Math.min(...v), 0.0001);
  // 12%..88% of the panel, north up.
  const left = (lng: number) => `${12 + (76 * (lng - Math.min(...lngs))) / span(lngs)}%` as const;
  const top = (lat: number) => `${88 - (76 * (lat - Math.min(...lats))) / span(lats)}%` as const;

  return (
    <TouchableOpacity activeOpacity={1} style={styles.wrap} onPress={() => onSelect(null)} testID="hub-map">
      <Text style={styles.note}>Google Maps shows here on the phone</Text>
      {data.hub ? <View style={[styles.hub, { left: left(data.hub.lng), top: top(data.hub.lat) }]} /> : null}
      {data.pins.map((p) => (
        <TouchableOpacity
          key={p.id}
          testID={`hub-map-pin-${p.id}`}
          onPress={() => onSelect(p.id)}
          style={[styles.dot, { left: left(p.lng), top: top(p.lat), backgroundColor: FILL[p.kind] }, p.kind === "off" ? { opacity: 0.8 } : null, p.id === selectedId ? styles.picked : null]}
        />
      ))}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, backgroundColor: "#DEE6DF" },
  note: { position: "absolute", top: 12, left: 12, fontFamily: fonts.ui, fontSize: 11, color: colors.muted },
  dot: { position: "absolute", width: 22, height: 22, marginLeft: -11, marginTop: -11, borderRadius: 11, borderWidth: 3, borderColor: "#fff" },
  picked: { borderColor: colors.ink },
  hub: { position: "absolute", width: 20, height: 20, marginLeft: -10, marginTop: -10, borderRadius: 5, borderWidth: 3, borderColor: "#fff", backgroundColor: colors.ink },
});
