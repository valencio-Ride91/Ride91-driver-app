// Fetch wrapper for the Ride91 backend.
import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const AUTH_TOKEN_KEY = "ride91.token";

async function tokenHeader(): Promise<Record<string, string>> {
  const t = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE}/api${path}`;
  const auth = await tokenHeader();
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
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
