// Native map wrapper (Android/iOS). Metro picks Map.web.tsx on web instead.
//
// The map follows the driver: it opens on their last known position (or their
// hub while there is no fix yet) and re-centres as they move. Dragging the map
// stops the following, so it never snaps back while the driver is looking
// around; the locate button brings it back.
import React, { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";

interface Props {
  lat: number | null;
  lng: number | null;
  /** Where to open the map while there is no fix yet — the driver's hub. */
  fallbackLat?: number | null;
  fallbackLng?: number | null;
}

// Force Google provider on Android only — iOS builds don't ship in this
// app, and forcing PROVIDER_GOOGLE on iOS without an iOS Google Maps key
// would break the map on any accidental iOS build.
const MAP_PROVIDER = Platform.OS === "android" ? PROVIDER_GOOGLE : undefined;

const CLOSE = { latitudeDelta: 0.02, longitudeDelta: 0.02 };
// No fix and no hub: show the whole country rather than guess a city.
const INDIA = { latitude: 22.0, longitude: 79.0, latitudeDelta: 28, longitudeDelta: 28 };

export const DriverMap: React.FC<Props> = ({ lat, lng, fallbackLat, fallbackLng }) => {
  const map = useRef<MapView>(null);
  const [following, setFollowing] = useState(true);
  // Fixed at first render; later moves go through animateToRegion.
  const [initial] = useState(() =>
    lat != null && lng != null
      ? { latitude: lat, longitude: lng, ...CLOSE }
      : fallbackLat != null && fallbackLng != null
        ? { latitude: fallbackLat, longitude: fallbackLng, ...CLOSE }
        : INDIA,
  );

  useEffect(() => {
    if (!following || lat == null || lng == null) return;
    map.current?.animateToRegion({ latitude: lat, longitude: lng, ...CLOSE }, 600);
  }, [following, lat, lng]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        provider={MAP_PROVIDER}
        style={StyleSheet.absoluteFill}
        initialRegion={initial}
        showsUserLocation
        showsCompass={false}
        showsMyLocationButton
        onPanDrag={() => setFollowing(false)}
      />
    </View>
  );
};
