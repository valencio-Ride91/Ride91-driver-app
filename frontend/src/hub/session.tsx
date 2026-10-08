// Hub manager app: who is signed in, which hub they run, and the API client.
//
// A hub manager signs in with the same account they use on the admin panel.
// Their account is tied to one hub, so the app opens straight on it. A fleet
// manager or owner (no hub of their own) picks which hub to look at.
//
// The token lives in the phone's secure storage under its own key, apart from
// the driver app's, so both apps can sit on one phone without sharing logins.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
const SESSION_KEY = "ride91.hub.session";

// A type alias (not an interface) so it satisfies the storage util's value type.
export type HubSession = {
  token: string;
  username: string;
  role: string;
  hubId: string | null;       // null until a fleet manager / owner picks one
  hubName: string | null;
};

export interface ApiError extends Error {
  status: number;
  body: any;
}

let currentToken: string | null = null;
let onUnauthorised: (() => void) | null = null;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const sentToken = currentToken;      // what this request actually carried
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    // The 12-hour session ran out: back to the sign-in screen. Only when the
    // refused request carried the session that is still current — a request
    // sent before the saved session was read back must not sign anyone out.
    if (res.status === 401 && sentToken && sentToken === currentToken) onUnauthorised?.();
    const err = new Error(`api ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export const hubApi = {
  get: <T,>(p: string) => request<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T,>(p: string) => request<T>("DELETE", p),
};

interface Ctx {
  session: HubSession | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  chooseHub: (id: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);

export const HubSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<HubSession | null>(null);
  const [loading, setLoading] = useState(true);

  const save = useCallback(async (s: HubSession | null) => {
    currentToken = s?.token ?? null;
    setSession(s);
    if (s) await storage.secureSet(SESSION_KEY, s);
    else await storage.secureRemove(SESSION_KEY);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await storage.secureGet<HubSession | null>(SESSION_KEY, null);
      if (s?.token) {
        currentToken = s.token;
        setSession(s);
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    onUnauthorised = () => {
      save(null);
    };
    return () => {
      onUnauthorised = null;
    };
  }, [save]);

  const signIn = useCallback(async (username: string, password: string) => {
    const r = await request<{ token: string; username: string; role: string; hub_id: string | null; hub_name: string | null }>(
      "POST", "/admin/login", { username: username.trim(), password });
    await save({ token: r.token, username: r.username, role: r.role, hubId: r.hub_id ?? null, hubName: r.hub_name ?? null });
  }, [save]);

  const chooseHub = useCallback(async (id: string, name: string) => {
    if (session) await save({ ...session, hubId: id, hubName: name });
  }, [session, save]);

  const signOut = useCallback(async () => {
    try {
      await request("POST", "/admin/logout");
    } catch {
      // signed out locally either way
    }
    await save(null);
  }, [save]);

  const value = useMemo<Ctx>(() => ({ session, loading, signIn, chooseHub, signOut }), [session, loading, signIn, chooseHub, signOut]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
};

export const useHubSession = (): Ctx => {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useHubSession outside provider");
  return c;
};
