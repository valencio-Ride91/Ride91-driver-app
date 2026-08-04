// Auth context — token stored in secure storage; hydrates on mount.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { storage } from "@/src/utils/storage";
import { AUTH_TOKEN_KEY, api } from "@/src/api";

export interface Driver {
  id: string;
  name: string;
  phone: string;
  vehicle_id: string;
  vehicle_number: string;
  qr_code: string;
}

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

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ driver: Driver; vehicle: Record<string, any> }>("/auth/me");
      setDriver(r.driver);
      setVehicle(r.vehicle);
    } catch {
      setDriver(null);
      setVehicle(null);
      await storage.secureRemove(AUTH_TOKEN_KEY);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const t = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
      if (t) await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const signIn = useCallback(async (token: string, d: Driver) => {
    await storage.secureSet(AUTH_TOKEN_KEY, token);
    setDriver(d);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await storage.secureRemove(AUTH_TOKEN_KEY);
    setDriver(null);
    setVehicle(null);
  }, []);

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
