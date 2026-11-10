// Fetch wrapper for the Ride91 backend.
import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const API_BASE = BASE;
export const AUTH_TOKEN_KEY = "ride91.token";

async function tokenHeader(): Promise<Record<string, string>> {
  const t = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

// A request that has not answered in time is given up, as if offline. Without
// a limit one stuck request (a weak signal that never quite drops) held up the
// offline queue until the app was restarted. A big upload (a document photo)
// gets longer, sized for a slow connection of about 10 KB a second, so it is
// not cut off halfway every time and left blocking the queue.
const TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 10 * 60000;
const timeoutFor = (payload: string | undefined) =>
  Math.min(MAX_TIMEOUT_MS, TIMEOUT_MS + ((payload?.length ?? 0) / 10000) * 1000);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE}/api${path}`;
  const auth = await tokenHeader();
  const payload = body ? JSON.stringify(body) : undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutFor(payload));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...auth },
      body: payload,
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  // A gateway/timeout error can return an HTML body; don't let JSON.parse throw
  // and mask the real status.
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const err = new Error(`api ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
};
