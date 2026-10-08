// The hub map on the phone: the Leaflet page from mapHtml.ts in a web view.
// Metro picks HubMap.web.tsx for the browser preview instead.
//
// The page is loaded once; new positions are pushed into it, so the map does
// not jump back to its starting view every time the hub's data refreshes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import { MapData, MapLabels, mapHtml } from "@/src/hub/mapHtml";

export interface HubMapProps {
  data: MapData;
  labels: MapLabels;
  onOpen: (driverId: string) => void;
  /** The map script did not arrive (no internet when the map was opened). */
  onFailed?: () => void;
}

// The page's own address. Map tiles are fetched with this as the referrer,
// which the OpenStreetMap tile servers ask every app to send.
const PAGE = `${process.env.EXPO_PUBLIC_BACKEND_URL ?? "https://ride91.app"}/`;

export const HubMap: React.FC<HubMapProps> = ({ data, labels, onOpen, onFailed }) => {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const [html] = useState(() => mapHtml(data, labels));
  const json = useMemo(() => JSON.stringify(data), [data]);
  const latest = useRef(json);

  const push = useCallback(() => {
    web.current?.injectJavaScript(`window.setData && window.setData(${latest.current}); true;`);
  }, []);

  useEffect(() => {
    latest.current = json;
    if (ready.current) push();
  }, [json, push]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={web}
        testID="hub-map"
        // Just under fully opaque: a known guard against Android web views
        // crashing when their screen is moved by a navigation animation.
        style={[StyleSheet.absoluteFill, { opacity: 0.99 }]}
        originWhitelist={["*"]}
        source={{ html, baseUrl: PAGE }}
        javaScriptEnabled
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        overScrollMode="never"
        // The only link on the page is the map's credit; open it in the browser.
        onShouldStartLoadWithRequest={(req) => {
          if (req.url === PAGE || req.url.startsWith("about:")) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        onMessage={(e) => {
          let m: { ready?: boolean; failed?: boolean; open?: string } = {};
          try {
            m = JSON.parse(e.nativeEvent.data);
          } catch {
            return;
          }
          if (m.ready) {
            ready.current = true;
            push();
          } else if (m.failed) {
            onFailed?.();
          } else if (typeof m.open === "string") {
            onOpen(m.open);
          }
        }}
      />
    </View>
  );
};
