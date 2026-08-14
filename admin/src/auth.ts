// Lightweight auth wrapper. Login / logout / me — thin, uses api.ts.

import { api, getToken, setToken } from "./api";

export interface AdminIdentity {
  username: string;
}

export async function login(username: string, password: string): Promise<AdminIdentity> {
  const r = await api.post<{ token: string; username: string }>(
    "/admin/login",
    { username, password },
  );
  setToken(r.token);
  return { username: r.username };
}

export async function me(): Promise<AdminIdentity | null> {
  if (!getToken()) return null;
  try {
    const r = await api.get<AdminIdentity>("/admin/me");
    return r;
  } catch {
    setToken(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await api.post("/admin/logout");
  } catch {
    // ignore — token may already be dead server-side
  }
  setToken(null);
}
