// Lightweight auth wrapper. Login / logout / me — thin, uses api.ts.

import { api, getToken, setToken } from "./api";

export type AdminRole = "owner" | "manager" | "viewer";

export interface AdminIdentity {
  username: string;
  role: AdminRole;
}

export async function login(username: string, password: string): Promise<AdminIdentity> {
  const r = await api.post<{ token: string; username: string; role: AdminRole }>(
    "/admin/login",
    { username, password },
  );
  setToken(r.token);
  return { username: r.username, role: r.role };
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
