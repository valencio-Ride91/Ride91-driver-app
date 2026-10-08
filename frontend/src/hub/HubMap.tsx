// The hub map on the phone: Google Maps, with a dot for each driver's last
// known position and a square for the hub. Metro picks HubMap.web.tsx for the
// browser preview instead.
//
// The dots are the drivers' positions as the server last heard them, not this
// phone's, so the map asks for no location permission. It opens framed around
// everyone, then leaves the view alone while the dots move; "Show all" frames
// them again. Tapping a dot tells the screen which driver was picked.
//
// The dots are small images rather than drawn views: image markers are the
// one kind every Android phone draws the same way.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";

import type { HubMapProps, PinKind } from "@/src/hub/mapTypes";
import { colors, fonts, radius } from "@/src/theme";

const ICONS: Record<PinKind | "hub", number> = {
  live: require("@/assets/images/hub-map/live.png"),
  quiet: require("@/assets/images/hub-map/quiet.png"),
  off: require("@/assets/images/hub-map/off.png"),
  hub: require("@/assets/images/hub-map/hub.png"),
};
// On-duty drivers are drawn over off-duty ones, and everyone over the hub.
const LAYER: Record<PinKind, number> = { live: 3, quiet: 3, off: 2 };

const CENTER = { x: 0.5, y: 0.5 };
const CLOSE = { latitudeDelta: 0.03, longitudeDelta: 0.03 };
// Nobody seen and no hub position: the whole country rather than a guessed city.
const INDIA = { latitude: 22.0, longitude: 79.0, latitudeDelta: 28, longitudeDelta: 28 };
const PADDING = { top: 70, right: 50, bottom: 70, left: 50 };

export const HubMap: React.FC<HubMapProps> = ({ data, selectedId, onSelect, fitLabel }) => {
  const map = useRef<MapView>(null);
  const ready = useRef(false);
  const placed = useRef(false);      // the first time there is something to show, frame it

  const points = useMemo(() => {
    const pts = data.pins.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    if (data.hub) pts.push({ latitude: data.hub.lat, longitude: data.hub.lng });
    return pts;
  }, [data]);

  // Fixed at first render; later moves go through the map itself.
  const [initial] = useState(() => (points.length ? { ...points[points.length - 1], ...CLOSE } : INDIA));

  const fit = useCallback((animated: boolean) => {
    if (points.length === 0) return;
    if (points.length === 1) map.current?.animateToRegion({ ...points[0], ...CLOSE }, animated ? 400 : 0);
    else map.current?.fitToCoordinates(points, { edgePadding: PADDING, animated });
  }, [points]);

  useEffect(() => {
    if (!ready.current || placed.current || points.length === 0) return;
    placed.current = true;
    fit(false);
  }, [points, fit]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        testID="hub-map"
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={initial}
        showsCompass={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        moveOnMarkerPress={false}
        onMapReady={() => {
          ready.current = true;
          if (!placed.current && points.length) {
            placed.current = true;
            fit(false);
          }
        }}
        onPress={(e) => {
          // A tap on empty map closes the driver's card; a tap on a dot does not.
          if (e.nativeEvent.action !== "marker-press") onSelect(null);
        }}
      >
        {data.hub ? (
          <Marker
            coordinate={{ latitude: data.hub.lat, longitude: data.hub.lng }}
            image={ICONS.hub}
            anchor={CENTER}
            zIndex={1}
            tappable={false}
            tracksViewChanges={false}
          />
        ) : null}
        {data.pins.map((p) => (
          <Marker
            // Keyed by its look as well, so a change of state swaps the image cleanly.
            key={`${p.id}:${p.kind}`}
            identifier={p.id}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            image={ICONS[p.kind]}
            anchor={CENTER}
            zIndex={p.id === selectedId ? 9 : LAYER[p.kind]}
            tracksViewChanges={false}
            onPress={(e) => {
              e.stopPropagation();
              onSelect(p.id);
            }}
          />
        ))}
      </MapView>
      <TouchableOpacity style={styles.fit} onPress={() => fit(true)} testID="hub-map-fit">
        <Text style={styles.fitText}>{fitLabel}</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  fit: {
    position: "absolute", top: 10, right: 10, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: colors.card, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, elevation: 2,
  },
  fitText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.ink },
});
