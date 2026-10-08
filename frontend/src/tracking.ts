// Location tracking.
//
// Two things run while a driver is signed in:
//
//   * A background tracker (Android foreground service, see locationTask.ts)
//     that reports the phone's position to the fleet about once a minute,
//     with the app open, closed or the screen off.
//   * A foreground watcher that keeps `lat` / `lng` here fresh, for the Home
//     map and for stamping duty actions with where they happened.
//
// "Location is working" needs three things to be true, and each can change
// behind the app's back, so all three are re-checked every time the driver
// comes back to the app and once a minute:
//
//   1. the app has location permission,
//   2. location is switched on in the phone,
//   3. the background tracker is actually running (the phone may have killed
//      it; if so it is restarted here).
//
// The header pill and the Start-duty check read from this.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Linking, Platform } from "react-native";
import * as Location from "expo-location";
import NetInfo from "@react-native-community/netinfo";

import { api } from "@/src/api";
import { LocationDisclosure } from "@/src/components/LocationDisclosure";
import { LOCATION_TASK } from "@/src/locationTask";
import { getCardText } from "@/src/i18n/cards";

export type HealthState = "synced" | "no_network" | "location_off" | "service_killed";

interface TrackingCtx {
  health: HealthState;
  lat: number | null;
  lng: number | null;
  permissionOk: boolean;
  /** Permission granted AND location switched on in the phone. */
  locationOk: boolean;
  /** Ask for location. `byDriver` false = the app's own ask on sign-in, which
   *  shows the notice at most once per run so it never nags. */
  requestPermission: (byDriver?: boolean) => Promise<boolean>;
  /** Get location working, asking the driver for whatever is missing.
   *  Resolves true once permission is granted and location is on. */
  ensureLocation: () => Promise<boolean>;
  /** Try to start the background tracker again; true if it is now running. */
  restartTracker: () => Promise<boolean>;
  openSettings: () => void;
}

const Ctx = createContext<TrackingCtx | null>(null);

const PING_MS = 4 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

export const TrackingProvider: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const [permissionOk, setPermissionOk] = useState(false);
  const [servicesOn, setServicesOn] = useState(true);
  // null = not known yet; false = should be running and is not.
  const [serviceUp, setServiceUp] = useState<boolean | null>(null);
  const [online, setOnline] = useState(true);
  const [pos, setPos] = useState<{ lat: number | null; lng: number | null }>({
    lat: null,
    lng: null,
  });
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const askedBackground = useRef(false);
  const webOk = useRef(false);

  // The notice that must come before Android's location prompt. `answer`
  // holds the waiting caller while the notice is on screen.
  const [answer, setAnswer] = useState<((allow: boolean) => void) | null>(null);
  const shownThisRun = useRef(false);
  const disclose = useCallback(async (byDriver: boolean): Promise<boolean> => {
    try {
      if ((await Location.getForegroundPermissionsAsync()).status === "granted") return true;
    } catch {
      // fall through and show the notice
    }
    // Shown once per run when the app is asking on its own; always when the
    // driver asked (the "Location off" pill, Start duty).
    if (!byDriver && shownThisRun.current) return false;
    shownThisRun.current = true;
    return new Promise<boolean>((resolve) => {
      setAnswer(() => (allow: boolean) => {
        setAnswer(null);
        resolve(allow);
      });
    });
  }, []);

  const webLocate = useCallback(async () => {
    // Best-effort on web preview
    let p: GeolocationPosition | null = null;
    try {
      p = await new Promise<GeolocationPosition | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (x) => resolve(x),
          () => resolve(null),
          { enableHighAccuracy: false, timeout: 5000 },
        );
      });
    } catch {
      p = null;
    }
    if (p) setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
    webOk.current = !!p;
    setPermissionOk(!!p);
    return !!p;
  }, []);

  // Start the OS-level background location service. This keeps reporting even
  // when the app is backgrounded or the screen is off (Android foreground
  // service). The task in locationTask.ts does the actual POST /tracking/ping.
  const startBackground = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web") return true;
    try {
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return true;
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 60000,        // ~every 60s
        distanceInterval: 40,       // or every 40m, whichever first
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: getCardText().track_title,
          notificationBody: getCardText().track_body,
          notificationColor: "#10231C",
        },
      });
      return true;
    } catch {
      return false;   // surfaced via the health pill
    }
  }, []);

  const stopBackground = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      }
    } catch {
      // ignore
    }
  }, []);

  // Read the three facts as they are right now, and restart the background
  // tracker if it should be running and is not. Never prompts the driver.
  const checkStatus = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web") return webOk.current;
    let perm = false;
    let services = true;
    try {
      perm = (await Location.getForegroundPermissionsAsync()).status === "granted";
      services = await Location.hasServicesEnabledAsync();
    } catch {
      // leave the pessimistic defaults
    }
    setPermissionOk(perm);
    setServicesOn(services);
    if (enabled && perm && services) setServiceUp(await startBackground());
    return perm && services;
  }, [enabled, startBackground]);

  const requestPermission = useCallback(async (byDriver = true) => {
    if (Platform.OS === "web") return webLocate();
    // Tell the driver what is collected and why, and get a yes, first.
    if (!(await disclose(byDriver))) {
      setPermissionOk(false);
      return false;
    }
    let ok = false;
    try {
      ok = (await Location.requestForegroundPermissionsAsync()).status === "granted";
    } catch {
      ok = false;
    }
    setPermissionOk(ok);
    if (ok && !askedBackground.current) {
      // Ask once per launch for "Allow all the time", so tracking keeps
      // running with the app closed. If the driver only grants while-in-use,
      // the foreground service still covers it while its notice is showing.
      askedBackground.current = true;
      try {
        const bg = await Location.getBackgroundPermissionsAsync();
        if (bg.status !== "granted" && bg.canAskAgain) await Location.requestBackgroundPermissionsAsync();
      } catch {
        // ignore — foreground service still covers the common case
      }
    }
    return ok;
  }, [webLocate, disclose]);

  const ensureLocation = useCallback(async () => {
    if (Platform.OS === "web") return webLocate();
    if (!(await requestPermission())) return false;
    let services = false;
    try {
      services = await Location.hasServicesEnabledAsync();
      if (!services && Platform.OS === "android") {
        // Shows Android's own "turn on location" dialog.
        await Location.enableNetworkProviderAsync();
        services = await Location.hasServicesEnabledAsync();
      }
    } catch {
      services = false;   // the driver said no
    }
    setServicesOn(services);
    if (services && enabled) setServiceUp(await startBackground());
    return services;
  }, [enabled, requestPermission, startBackground, webLocate]);

  const restartTracker = useCallback(async () => {
    const up = await startBackground();
    setServiceUp(up);
    return up;
  }, [startBackground]);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);

  useEffect(() => {
    const sub = NetInfo.addEventListener((s) => {
      setOnline(!!(s.isConnected && s.isInternetReachable !== false));
    });
    return () => sub();
  }, []);

  // Signed in: ask for permission (only the first time shows a prompt), then
  // re-check whenever the driver returns to the app — they may have just
  // changed something in the phone's settings.
  useEffect(() => {
    if (!enabled) {
      stopBackground();
      setServiceUp(null);
      return;
    }
    requestPermission(false).then(() => checkStatus());
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") checkStatus();
    });
    return () => sub.remove();
  }, [enabled, requestPermission, checkStatus, stopBackground]);

  // Keep lat/lng fresh while the app is open and location is usable. Seeded
  // with the last known fix so the map is right at once, even indoors.
  const usable = enabled && permissionOk && servicesOn;
  useEffect(() => {
    if (!usable || Platform.OS === "web") return;
    let alive = true;
    let watcher: Location.LocationSubscription | null = null;
    const take = (p: Location.LocationObject | null) => {
      if (alive && p) setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
    };
    Location.getLastKnownPositionAsync().then(take).catch(() => {});
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 10000, distanceInterval: 15 },
      take,
    )
      .then((w) => {
        if (alive) watcher = w;
        else w.remove();
      })
      .catch(() => {});
    return () => {
      alive = false;
      watcher?.remove();
    };
  }, [usable]);

  // Web preview can't run a background service: fall back to a direct ping so
  // the dashboard still shows a position during testing.
  const webPing = useCallback(async () => {
    if (Platform.OS !== "web" || !permissionOk || pos.lat == null || pos.lng == null) return;
    try {
      await api.post("/tracking/ping", {
        recorded_at: new Date().toISOString(),
        lat: pos.lat,
        lng: pos.lng,
      });
    } catch {
      // offline — fine
    }
  }, [permissionOk, pos]);

  // Once a minute: re-check, then tell the server how the phone is doing, so
  // the hub can see "location switched off" rather than just a silent driver.
  const heartbeat = useCallback(async () => {
    const ok = await checkStatus();
    try {
      await api.post("/tracking/heartbeat", {
        ts: new Date().toISOString(),
        permission_ok: ok,
        network_up: online,
      });
    } catch {
      // ignore
    }
  }, [checkStatus, online]);

  useEffect(() => {
    if (!enabled) return;
    heartbeat();
    beatRef.current = setInterval(heartbeat, HEARTBEAT_MS);
    return () => {
      if (beatRef.current) clearInterval(beatRef.current);
      beatRef.current = null;
    };
  }, [enabled, heartbeat]);

  useEffect(() => {
    if (!enabled || Platform.OS !== "web") return;   // web preview fallback
    webPing();
    pingRef.current = setInterval(webPing, PING_MS);
    return () => {
      if (pingRef.current) clearInterval(pingRef.current);
      pingRef.current = null;
    };
  }, [enabled, webPing]);

  const locationOk = permissionOk && servicesOn;
  const health: HealthState = !locationOk
    ? "location_off"
    : serviceUp === false
    ? "service_killed"
    : !online
    ? "no_network"
    : "synced";

  const value = useMemo<TrackingCtx>(
    () => ({ health, lat: pos.lat, lng: pos.lng, permissionOk, locationOk, requestPermission, ensureLocation, restartTracker, openSettings }),
    [health, pos.lat, pos.lng, permissionOk, locationOk, requestPermission, ensureLocation, restartTracker, openSettings],
  );
  return React.createElement(
    Ctx.Provider,
    { value },
    children,
    React.createElement(LocationDisclosure, { visible: answer !== null, onAnswer: (allow: boolean) => answer?.(allow) }),
  );
};

export const useTracking = (): TrackingCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTracking outside provider");
  return c;
};
