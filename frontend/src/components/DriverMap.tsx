// Native map wrapper (Android/iOS). Metro picks Map.web.tsx on web instead.
import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";

interface Props {
  lat: number | null;
  lng: number | null;
}

// Force Google provider on Android only — iOS builds don't ship in this
// app, and forcing PROVIDER_GOOGLE on iOS without an iOS Google Maps key
// would break the map on any accidental iOS build.
const MAP_PROVIDER = Platform.OS === "android" ? PROVIDER_GOOGLE : undefined;

export const DriverMap: React.FC<Props> = ({ lat, lng }) => {
  const region = {
    latitude: lat ?? 12.9716,
    longitude: lng ?? 77.5946,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };
  return (
    <View style={StyleSheet.absoluteFillObject}>
      <MapView
        provider={MAP_PROVIDER}
        style={StyleSheet.absoluteFillObject}
        region={region}
        showsUserLocation
        showsCompass={false}
        showsMyLocationButton={false}
      >
        {lat != null && lng != null ? (
          <Marker coordinate={{ latitude: lat, longitude: lng }} />
        ) : null}
      </MapView>
    </View>
  );
};
