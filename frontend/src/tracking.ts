// Tracking health context.
// - Every 4 min: request a balanced-accuracy location and POST /tracking/ping
// - Every 60s: heartbeat with permission_ok + network_up
// The pill in the header reads from here.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";

import { api } from "@/src/api";

export type HealthState = "synced" | "no_network" | "location_off" | "service_killed";

interface TrackingCtx {
  health: HealthState;
  lat: number | null;
  lng: number | null;
  permissionOk: boolean;
  requestPermission: () => Promise<boolean>;
}

const Ctx = createContext<TrackingCtx | null>(null);

const PING_MS = 4 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

export const TrackingProvider: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const [permissionOk, setPermissionOk] = useState(false);
  const [online, setOnline] = useState(true);
  const [pos, setPos] = useState<{ lat: number | null; lng: number | null }>({
    lat: null,
    lng: null,
  });
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestPermission = useCallback(async () => {
    if (Platform.OS === "web") {
      // Best-effort on web preview
      try {
        const p = await new Promise<GeolocationPosition | null>((resolve) => {
          if (!navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (x) => resolve(x),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 5000 },
          );
        });
        if (p) {
          setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
          setPermissionOk(true);
          return true;
        }
        setPermissionOk(false);
        return false;
      } catch {
        setPermissionOk(false);
        return false;
      }
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    const ok = status === "granted";
    setPermissionOk(ok);
    if (ok) {
      try {
        const p = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      } catch {
        // ignore
      }
    }
    return ok;
  }, []);

  useEffect(() => {
    const sub = NetInfo.addEventListener((s) => {
      setOnline(!!(s.isConnected && s.isInternetReachable !== false));
    });
    return () => sub();
  }, []);

  // Auto-request on enable
  useEffect(() => {
    if (enabled) {
      requestPermission();
    }
  }, [enabled, requestPermission]);

  const singlePing = useCallback(async () => {
    if (!permissionOk) return;
    try {
      let coords = pos;
      if (Platform.OS !== "web") {
        const p = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coords = { lat: p.coords.latitude, lng: p.coords.longitude };
        setPos(coords);
      }
      if (coords.lat != null && coords.lng != null) {
        try {
          await api.post("/tracking/ping", {
            recorded_at: new Date().toISOString(),
            lat: coords.lat,
            lng: coords.lng,
          });
        } catch {
          // offline — that's fine
        }
      }
    } catch {
      // ignore
    }
  }, [permissionOk, pos]);

  const heartbeat = useCallback(async () => {
    try {
      await api.post("/tracking/heartbeat", {
        ts: new Date().toISOString(),
        permission_ok: permissionOk,
        network_up: online,
      });
    } catch {
      // ignore
    }
  }, [permissionOk, online]);

  useEffect(() => {
    if (!enabled) {
      if (pingRef.current) clearInterval(pingRef.current);
      if (beatRef.current) clearInterval(beatRef.current);
      pingRef.current = null;
      beatRef.current = null;
      return;
    }
    singlePing();
    heartbeat();
    pingRef.current = setInterval(singlePing, PING_MS);
    beatRef.current = setInterval(heartbeat, HEARTBEAT_MS);
    return () => {
      if (pingRef.current) clearInterval(pingRef.current);
      if (beatRef.current) clearInterval(beatRef.current);
    };
  }, [enabled, singlePing, heartbeat]);

  const health: HealthState = !online
    ? "no_network"
    : !permissionOk
    ? "location_off"
    : "synced";

  const value = useMemo<TrackingCtx>(
    () => ({ health, lat: pos.lat, lng: pos.lng, permissionOk, requestPermission }),
    [health, pos.lat, pos.lng, permissionOk, requestPermission],
  );
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useTracking = (): TrackingCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTracking outside provider");
  return c;
};
