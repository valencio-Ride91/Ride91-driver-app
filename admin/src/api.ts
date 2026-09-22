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
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export interface VehicleRow {
  id: string;
  number: string;
  model: string;
  current_soc: number | null;
  current_range_km: number | null;
  assigned: boolean;
  assigned_driver?: string | null;
  retired?: boolean;
  hub_id?: string | null;
  hub_name?: string | null;
}

export interface HubRow {
  id: string;
  name: string;
  city: string | null;
  capacity: number;
  lat: number | null;
  lng: number | null;
  car_count: number;
  seats_left: number;
  created_at: string | null;
}

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
  shift_type: string | null;
  active: boolean;
  archived: boolean;
  status: string;
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

export interface DriverDetail {
  driver: {
    id: string;
    name: string;
    phone: string;
    hub_name: string | null;
    hub_lat: number | null;
    hub_lng: number | null;
    shift_type: string | null;
    status: string;
    active: boolean;
    archived: boolean;
    vehicle_id: string | null;
    qr_code: string | null;
    created_at: string | null;
  };
  vehicle: (VehicleRow & Record<string, unknown>) | null;
  balance: {
    collected_to_yesterday: number;
    paid_in_total: number;
    paid_in_today: number;
    balance: number;
    you_owe: number;
    in_credit: number;
    over_limit: boolean;
    cash_limit: number;
  };
  documents: Array<Record<string, any>>;
  captures: Array<Record<string, any>>;
  inspections: Array<Record<string, any>>;
  requests: Array<Record<string, any>>;
  payouts: Array<Record<string, any>>;
  deposits: Array<Record<string, any>>;
  notifications: NotificationRow[];
}

export interface NotificationRow {
  id: string;
  driver_id: string;
  direction: "from_driver" | "to_driver";
  body: string;
  created_at: string;
  created_by: string | null;
  read: boolean;
  driver_name?: string | null;
  driver_phone?: string | null;
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

// ---- Ops queues ------------------------------------------------------------

export interface CashRow {
  driver_id: string;
  name: string | null;
  phone: string | null;
  hub_name: string | null;
  collected_to_yesterday: number;
  paid_in_total: number;
  paid_in_today: number;
  balance: number;
  you_owe: number;
  in_credit: number;
  over_limit: boolean;
}

export interface CashResponse {
  items: CashRow[];
  totals: {
    collected_to_yesterday: number;
    paid_in_total: number;
    paid_in_today: number;
    owed: number;
    over_limit: number;
  };
  count: number;
  cash_limit: number;
  as_of_business_date: string;
}

export interface RequestRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  type: "advance" | "holiday" | "extra_hours" | string;
  payload: Record<string, unknown>;
  state: "pending" | "approved" | "rejected" | string;
  created_at: string;
  decided_at: string | null;
  decided_by?: string;
  decision_note?: string | null;
}

export interface InspectionRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  vehicle_id: string | null;
  vehicle_number: string | null;
  day_key: string;
  created_at: string;
  exterior_video_mime: string | null;
  has_photo: boolean;
}

export interface RewardsRow {
  driver_id: string;
  name: string | null;
  phone: string | null;
  hub_id: string | null;
  hub_name: string | null;
  yesterday_gross: number;
  week_gross: number;
  driver_earnings: number;
  days_operated: number;
  q_daily: boolean;
  q_car_week: boolean;
  q_driver_week: boolean;
}

export interface HubLeaders { top_car_day: string | null; top_car_week: string | null; top_driver_week: string | null }

export interface RewardsResponse {
  items: RewardsRow[];
  count: number;
  week_start: string;
  days_remaining: number;
  share_rate: number;
  hubs: Array<{ hub_id: string; hub_name: string | null; drivers: number; week_gross: number }>;
  totals: { yesterday_gross: number; week_gross: number };
  thresholds: {
    daily_target: number; top_car_day: number;
    week_car_target: number; top_car_week: number;
    week_driver_target: number; top_driver_week: number;
    days_required: number;
  };
  leaders_by_hub: Record<string, HubLeaders>;
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: "owner" | "manager" | "viewer";
  active: boolean;
  created_at: string | null;
  created_by: string | null;
  last_login_at: string | null;
}

export interface SettingsData {
  cash_limit: number;
  driver_share: number;
  hubs: Array<{ name: string; lat?: number; lng?: number }>;
  business_day_cutoff_ist?: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string | null;
  actor_role: string | null;
  action: string;
  target: string;
  meta: Record<string, unknown>;
}

// Client-side CSV download — turns rows into a file the browser saves. Values
// are quoted and embedded quotes doubled, per RFC 4180.
export function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Multipart upload (the JSON `api` helper can't send files). Used by the
// platform-cash import. Returns parsed JSON or throws with the error body.
export async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const t = getToken();
  const headers: Record<string, string> = {};
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API_BASE}/api${path}`, { method: "POST", headers, body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`api ${res.status}`) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export interface AlarmRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  schedule_id: string;
  phase: "start" | "end" | string;
  response: string;
  reason_code: string | null;
  reason_note: string | null;
  back_by: string | null;
  eta_minutes: number | null;
  fired_at: string | null;
  responded_at: string | null;
  created_at: string;
}
