// Auth context — token stored in secure storage; hydrates on mount.
//
// The driver stays signed in unless the server itself turns the login down
// (401/403: the password was reset, the account was removed, the session ran
// out). No signal, a timeout or a server outage is not a sign-out: the app
// keeps the last known profile and carries on, and queued taps are sent when
// the network is back. Before, any failed check at launch erased the login,
// so a driver who opened the app in a dead zone had to sign in again.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AppState } from "react-native";

import { storage } from "@/src/utils/storage";
import { AUTH_TOKEN_KEY, api } from "@/src/api";

// A type alias (not an interface) so it can be saved with the storage util.
export type Driver = {
  id: string;
  name: string;
  phone: string;
  vehicle_id: string;
  vehicle_number: string;
  qr_code: string;
  hub_name?: string | null;
  hub_lat?: number | null;
  hub_lng?: number | null;
};

// The last profile the server returned, for opening the app without signal.
// The offline queue also reads `driver.id` from it, so a tap saved by one
// driver is never sent under another driver's login on a shared phone.
export const PROFILE_KEY = "ride91.driver.profile";
type Profile = { driver: Driver; vehicle: Record<string, any> | null };

interface AuthCtx {
  loading: boolean;
  driver: Driver | null;
  vehicle: Record<string, any> | null;
  signIn: (token: string, driver: Driver) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [vehicle, setVehicle] = useState<Record<string, any> | null>(null);
  // Signed in (a token is saved) but the profile could not be fetched and none
  // is saved either: the first launch after an update, with no signal. The
  // check is repeated until it gets through, then the app opens by itself.
  const [waiting, setWaiting] = useState(false);

  const forget = useCallback(async () => {
    setWaiting(false);
    setDriver(null);
    setVehicle(null);
    await storage.secureRemove(AUTH_TOKEN_KEY);
    await storage.removeItem(PROFILE_KEY);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ driver: Driver; vehicle: Record<string, any> }>("/auth/me");
      setDriver(r.driver);
      setVehicle(r.vehicle);
      setWaiting(false);
      await storage.setItem(PROFILE_KEY, { driver: r.driver, vehicle: r.vehicle ?? null });
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        await forget();            // the server said no: sign out
        return;
      }
      // Offline, timed out, or the server is down: stay signed in with what we knew.
      const cached = await storage.getItem<Profile | null>(PROFILE_KEY, null);
      if (cached?.driver) {
        setDriver((d) => d ?? cached.driver);
        setVehicle((v) => v ?? cached.vehicle);
      } else {
        setWaiting(true);
      }
    }
  }, [forget]);

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [waiting, refresh]);

  // Back to the app: check the login again, so a password reset or a removal
  // by the hub shows as the sign-in screen instead of screens that fail.
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (st) => {
      if (st !== "active") return;
      if (await storage.secureGet<string>(AUTH_TOKEN_KEY, "")) refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  useEffect(() => {
    (async () => {
      const t = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
      if (t) await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const signIn = useCallback(async (token: string, d: Driver) => {
    await storage.secureSet(AUTH_TOKEN_KEY, token);
    await storage.setItem(PROFILE_KEY, { driver: d, vehicle: null });
    setDriver(d);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    // Revoke the session server-side so the token can't be reused. Best-effort:
    // a driver who is offline must still be able to sign out locally.
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore — token may already be dead, or the device is offline
    }
    await forget();
  }, [forget]);

  const value = useMemo<AuthCtx>(
    () => ({ loading, driver, vehicle, signIn, signOut, refresh }),
    [loading, driver, vehicle, signIn, signOut, refresh],
  );
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useAuth = (): AuthCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside provider");
  return c;
};
