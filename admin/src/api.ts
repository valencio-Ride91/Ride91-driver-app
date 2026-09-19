// API client for the Ride91 admin site. Reads the base URL from
// VITE_API_URL (fall back to /api which the Vite dev proxy handles). The
// admin token is kept in localStorage under `ride91.admin.token`.

const RAW_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
export const API_BASE = RAW_BASE ? RAW_BASE.replace(/\/$/, "") : "";

const TOKEN_KEY = "ride91.admin.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

interface ApiError extends Error {
  status: number;
  body: unknown;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (t) headers.Authorization = `Bearer ${t}`;
  const url = `${API_BASE}/api${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
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

// ---------------------------------------------------------------------------
// Types shared across screens.
// ---------------------------------------------------------------------------

export interface DashboardData {
  business_date: string;
  cards: {
    total_drivers: number;
    approved_drivers: number;
    drivers_waiting: number;
    total_vehicles: number;
    on_duty_now: number;
    cash_owed: number;
    over_limit: number;
    collected_all: number;
    paid_all: number;
    paid_today: number;
  };
  bookings: {
    by_status: Record<string, number>;
    open: number;
    today: number;
    scheduled_ahead: number;
    total: number;
  };
  series: { date: string; gross: number; cash: number; deposited: number }[];
  server_ts: string;
}

export interface BookingRow {
  id: string;
  ref: string;
  rider_name: string;
  rider_phone: string;
  pickup_text: string;
  drop_text: string;
  scheduled_at: string | null;
  vehicle_type: string | null;
  fare_estimate: number | null;
  notes: string | null;
  status: string;
  driver_id: string | null;
  vehicle_id: string | null;
  source: string;
  business_date: string;
  created_at: string;
  updated_at: string;
}

export interface DriverRow {
  id: string;
  name: string;
  phone: string;
  hub_name: string | null;
  vehicle_number: string | null;
  vehicle_id: string | null;
  vehicle_soc: number | null;
  vehicle_range_km: number | null;
  on_duty: boolean;
  current_state: string | null;
  cash_in_hand: number;
  cash_over_limit: boolean;
  last_ping_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
}

export interface VehicleLiveRow {
  vehicle_id: string;
  vehicle_number: string | null;
  driver_id: string | null;
  driver_name: string | null;
  hub_name: string | null;
  lat: number;
  lng: number;
  speed_kmph: number | null;
  soc_pct: number | null;
  accuracy_m: number | null;
  recorded_at: string;
  age_minutes: number | null;
  stale: boolean;
}

export interface CaptureRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  driver_hub: string | null;
  day_key: string;
  duration_s: number;
  distance_from_hub_km: number | null;
  hub_warn: boolean;
  review_flag_movement: boolean;
  movement_m: number;
  start_lat: number;
  start_lng: number;
  created_at: string;
  review_decision?: "approve" | "reject";
  reviewed_at?: string;
  reviewed_by?: string;
}

export interface DocumentRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  type: string;
  label: string;
  number: string | null;
  expires_on: string | null;
  status: string;
  verified: boolean;
  updated_at: string;
  review_decision?: "approve" | "reject";
  reviewed_at?: string;
  reviewed_by?: string;
}

export interface AdminSummary {
  total_drivers: number;
  on_duty_now: number;
  captures_pending: number;
  documents_pending: number;
  business_date: string;
}

export interface PayoutRow {
  id: string;
  driver_id: string;
  amount_rupees: number;
  mode: "IMPS" | "UPI";
  status: string;
  utr?: string;
  reference_id?: string;
  narration?: string;
  created_by?: string;
  created_at: string;
  updated_at?: string;
  razorpayx_payout_id?: string;
}
