// Hub manager app: who is signed in, which hub they run, and the API client.
//
// A hub manager signs in with the same account they use on the admin panel.
// Their account is tied to one hub, so the app opens straight on it. A fleet
// manager or owner (no hub of their own) picks which hub to look at.
//
// The token lives in the phone's secure storage under its own key, apart from
// the driver app's, so both apps can sit on one phone without sharing logins.
//
// The office can change an account while the app is open (move a manager to
// another hub, change their role). The app checks /admin/me when it opens,
// when it comes back to the front, and whenever the server refuses something
// (403), and follows the change instead of failing on every screen.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

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

// Roles that may use this app. A viewer can sign in to the admin panel but
// every Hub app screen needs hub-manager rights.
const HUB_ROLES = ["hub_manager", "manager", "owner"];
export const canUseHubApp = (role: string | null | undefined) => HUB_ROLES.includes(role ?? "");

let currentToken: string | null = null;
let onUnauthorised: (() => void) | null = null;
let onForbidden: (() => void) | null = null;

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
    // Refused: maybe the account was changed. Check who we are now.
    if (res.status === 403 && sentToken && sentToken === currentToken) onForbidden?.();
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

/** Why the app last signed itself out, shown on the sign-in screen. */
export type HubNotice = "changed" | "no_access" | null;

interface Ctx {
  session: HubSession | null;
  loading: boolean;
  notice: HubNotice;
  signIn: (username: string, password: string) => Promise<void>;
  chooseHub: (id: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
}

interface Me { username: string; role: string; hub_id: string | null; hub_name: string | null }

const SessionCtx = createContext<Ctx | null>(null);

export const HubSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<HubSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<HubNotice>(null);
  const sessionRef = useRef<HubSession | null>(null);
  sessionRef.current = session;

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

  // Bring the saved session in line with the account as the office has it now.
  const lastSync = useRef(0);
  const sync = useCallback(async (force = false) => {
    const s = sessionRef.current;
    if (!s?.token) return;
    if (!force && Date.now() - lastSync.current < 15000) return;   // one check per burst of refusals
    lastSync.current = Date.now();
    let me: Me;
    try {
      me = await request<Me>("GET", "/admin/me");
    } catch {
      return;      // offline, or signed out by the 401 handler already
    }
    if (sessionRef.current?.token !== s.token) return;
    if (!canUseHubApp(me.role)) {
      setNotice("no_access");
      await save(null);
      return;
    }
    if (me.role === "hub_manager") {
      if (!me.hub_id) {
        setNotice("changed");
        await save(null);
      } else if (me.hub_id !== s.hubId || me.role !== s.role || (me.hub_name ?? null) !== s.hubName) {
        await save({ ...s, role: me.role, hubId: me.hub_id, hubName: me.hub_name ?? null });
      }
      return;
    }
    // Manager / owner: they chose the hub themselves; keep it unless it is gone.
    const cur: HubSession = me.role !== s.role ? { ...s, role: me.role } : s;
    if (cur !== s) await save(cur);
    if (cur.hubId) {
      try {
        const r = await request<{ items?: { id: string }[] } | { id: string }[]>("GET", "/admin/hubs");
        const hubs = Array.isArray(r) ? r : r.items ?? [];
        if (!hubs.some((h) => h.id === cur.hubId) && sessionRef.current?.token === cur.token) {
          // The hub was removed: back to the hub picker.
          await save({ ...cur, hubId: null, hubName: null });
        }
      } catch {
        // try again next time
      }
    }
  }, [save]);

  useEffect(() => {
    onForbidden = () => {
      sync();
    };
    return () => {
      onForbidden = null;
    };
  }, [sync]);

  // On open (once the saved session is read back) and on every return to the app.
  const token = session?.token ?? null;
  useEffect(() => {
    if (!token) return;
    sync(true);
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") sync(true);
    });
    return () => sub.remove();
  }, [token, sync]);

  const signIn = useCallback(async (username: string, password: string) => {
    const r = await request<{ token: string; username: string; role: string; hub_id: string | null; hub_name: string | null }>(
      "POST", "/admin/login", { username: username.trim(), password });
    if (!canUseHubApp(r.role)) {
      // Signed in fine, but this account has no Hub app rights: let go of it.
      currentToken = r.token;
      try {
        await request("POST", "/admin/logout");
      } catch {
        // the session runs out by itself
      }
      currentToken = null;
      const err = new Error("no_access") as ApiError;
      err.status = 403;
      err.body = { detail: "no_access" };
      throw err;
    }
    setNotice(null);
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

  const value = useMemo<Ctx>(() => ({ session, loading, notice, signIn, chooseHub, signOut }), [session, loading, notice, signIn, chooseHub, signOut]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
};

export const useHubSession = (): Ctx => {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useHubSession outside provider");
  return c;
};
