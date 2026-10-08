// Browser preview of the hub map: the same Leaflet page as the phone, in an
// iframe instead of a web view.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { HubMapProps } from "@/src/hub/HubMap";
import { mapHtml } from "@/src/hub/mapHtml";

export const HubMap: React.FC<HubMapProps> = ({ data, labels, onOpen, onFailed }) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const [html] = useState(() => mapHtml(data, labels));
  const latest = useRef(data);

  const push = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ ride91Map: latest.current }, "*");
  }, []);

  useEffect(() => {
    latest.current = data;
    if (ready.current) push();
  }, [data, push]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let m: { ready?: boolean; failed?: boolean; open?: string } = {};
      try {
        m = JSON.parse(e.data);
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
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onOpen, onFailed, push]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <iframe
        ref={frame}
        data-testid="hub-map"
        title="map"
        srcDoc={html}
        sandbox="allow-scripts allow-popups"
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </View>
  );
};
