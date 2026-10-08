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
  day_driver?: string | null;
  night_driver?: string | null;
  day_open?: boolean;
  night_open?: boolean;
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
  code: string | null;
  hub_id: string | null;
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
    hub_id?: string | null;
    hub_name: string | null;
    hub_lat: number | null;
    hub_lng: number | null;
    shift_type: string | null;
    shift_start_time: string | null;
    shift_end_time: string | null;
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
  shift_alarms: Array<Record<string, any>>;
}

export interface NotificationRow {
  id: string;
  driver_id: string;
  direction: "from_driver" | "to_driver";
  body: string;
  created_at: string;
  created_by: string | null;
  read: boolean;
  kind?: "system" | null;          // "system": an automatic note, not typed by the driver
  driver_name?: string | null;
  driver_phone?: string | null;
}

export interface VehicleLiveRow {
  vehicle_id: string | null;       // null: a driver with no car, shown from their phone
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

export interface RewardCar {
  vehicle_id: string;
  number: string | null;
  week_gross: number;
  yesterday_gross: number;
  days_operated: number;
  drivers: Array<{ driver_id: string; name: string | null; shift: string }>;
  q_car_day: boolean;
  q_car_week: boolean;
  is_top_car_day: boolean;
  is_top_car_week: boolean;
}

export interface RewardDriver {
  driver_id: string;
  name: string | null;
  phone: string | null;
  shift: string;
  week_gross: number;
  yesterday_gross: number;
  days_operated: number;
  q_driver_week: boolean;
  is_top_driver_week: boolean;
}

export interface RewardHub {
  hub_id: string | null;
  hub_name: string | null;
  week_gross?: number;
  cars: RewardCar[];
  drivers: RewardDriver[];
}

export interface RewardsResponse {
  week_start: string;
  days_remaining: number;
  hubs: RewardHub[];
  thresholds: {
    daily_target: number; top_car_day: number;
    week_car_target: number; top_car_week: number;
    week_driver_target: number; top_driver_week: number;
    days_required: number;
  };
}

export interface LoyaltyMilestone {
  key: string;
  label: string;
  reward: number;
  amount: number;
  reached: boolean;
  vested: boolean;
  forfeited: boolean;
}

export interface LoyaltyDriver {
  driver_id: string;
  name: string | null;
  phone: string | null;
  shift: string;
  year_gross: number;
  tenure_days: number | null;
  next_milestone: { key: string; label: string; reward: number; amount: number; remaining: number; progress: number } | null;
  vested_total: number;
  milestones: LoyaltyMilestone[];
  is_top_driver_year?: boolean;
  wallet_balance?: number;
  wallet_accrued?: number;
  wallet_paid?: number;
  att_good_days?: number;
  att_min_days?: number;
  att_qualified?: boolean;
  att_bonus?: number;
  att_paid?: boolean;
  att_month?: string;
}

export interface LoyaltyCar {
  vehicle_id: string;
  number: string | null;
  year_gross: number;
  drivers: Array<{ driver_id: string; name: string | null; shift: string }>;
  is_top_car_year?: boolean;
}

export interface LoyaltyHub {
  hub_id: string | null;
  hub_name: string | null;
  year_gross?: number;
  drivers: LoyaltyDriver[];
  cars: LoyaltyCar[];
}

export interface LoyaltyResponse {
  year: string;
  hubs: LoyaltyHub[];
  milestones: Array<{ key: string; label: string; reward: number; amount: number }>;
  thresholds: { top_driver_year: number; top_car_year: number };
  wallet_enabled?: boolean;
  attendance_enabled?: boolean;
}

export interface HubRosterVehicle {
  id: string;
  number: string;
  model: string;
  day_driver: { driver_id: string; name: string | null } | null;
  night_driver: { driver_id: string; name: string | null } | null;
}
export interface HubRosterDriver {
  id: string;
  name: string | null;
  phone: string | null;
  code: string | null;
  shift_type: string;
  vehicle_id: string | null;
  active: boolean;
}
export interface HubRoster {
  hub: HubRow;
  vehicles: HubRosterVehicle[];
  drivers: HubRosterDriver[];
}

export interface EarningsRow {
  driver_id: string;
  name: string | null;
  phone: string | null;
  code: string | null;
  shift: string;
  gross_amount: number | null;
  cash_amount: number | null;
  source: string | null;
  locked: boolean;
}

export interface EarningsForDate {
  date: string;
  platform: string;
  items: EarningsRow[];
  count: number;
}

// A driver's request to withdraw salary; the hub pays or rejects it.
export interface WithdrawalRow {
  id: string;
  driver_id: string;
  driver_name: string | null;
  driver_phone: string | null;
  amount: number;
  state: "pending" | "paid" | "rejected";
  method: "razorpayx" | "manual" | null;
  reference: string | null;
  note: string | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  payout_id: string | null;
  direct?: boolean | null;         // paid straight from the app, no hub approval
  direct_error?: string | null;    // why a direct transfer was not sent
  bank_kind: "bank_account" | "vpa" | null;
  bank_masked: string | null;
  // pending rows only: what the driver could be paid right now, and the cash they owe
  payable_now?: number;
  cash_owed?: number;
}
export interface WithdrawalsResponse {
  items: WithdrawalRow[];
  count: number;
  pending: number;
  razorpayx_ready: boolean;
}

export interface DutySegment {
  state: string;
  platforms: string[];
  from_ts: string;
  to_ts: string;
  seconds: number;
}
// One button the driver pressed in the app, and where they were.
export interface ActivityEntry {
  id: string | null;
  at: string;
  action: "start_duty" | "end_duty" | "apps_changed" | "to_charger" | "charging_started" | "charging_finished" | "no_change";
  state: string;
  turned_on: string[];
  turned_off: string[];
  online_on: string[];              // apps the driver was online on after the press
  lat: number | null;
  lng: number | null;
  // "tap": sent with the press. "nearby_ping": closest tracked position within 3 minutes.
  location_source: "tap" | "nearby_ping" | null;
  source: string;
}
export interface DutySummary {
  log?: ActivityEntry[];            // absent on older servers
  segments: DutySegment[];
  totals_seconds: Record<string, number>;
  on_duty: boolean;
  current_platform: string | null;
  current_platforms: string[];
  per_platform_seconds: Record<string, number>;
  on_duty_seconds: number;
  working_seconds: number;
  charging_seconds: number;
  current_state: string | null;
  distance_km: number;
  business_date: string;
  day_start: string;
  server_ts: string;
  last_ping_at?: string | null;
  last_lat?: number | null;
  last_lng?: number | null;
}
export interface HubActivityRow {
  driver_id: string;
  name: string | null;
  code: string | null;
  phone: string | null;
  shift_type: string;
  active: boolean;
  vehicle_number: string | null;
  on_duty: boolean;
  current_platforms: string[];
  on_duty_seconds: number;
  working_seconds: number;
  per_platform_seconds?: Record<string, number>;   // time online on each app
  distance_km: number;
  last_ping_at: string | null;
  // Today only. "stopped" = on duty but the phone has gone quiet.
  tracking?: "live" | "stopped" | null;
  tracking_reason?: "location_off" | "no_signal" | null;
}
export interface HubActivity {
  hub: { id: string; name: string | null };
  business_date: string;
  on_duty_now: number;
  items: HubActivityRow[];
  count: number;
}

export interface CollectionRow {
  driver_id: string;
  name: string | null;
  phone: string | null;
  code: string | null;
  total: number;
  count: number;
  last_at: string | null;
}

export interface CollectionsResponse {
  items: CollectionRow[];
  grand_total: number;
  count: number;
  from_date: string | null;
  to_date: string | null;
}

export interface CollectionQr {
  qr_code_id: string | null;
  image_url?: string | null;
  short_url?: string | null;
  status?: string;
  created_at?: string | null;
  code?: string | null;
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: "owner" | "manager" | "hub_manager" | "viewer";
  hub_id?: string | null;
  hub_name?: string | null;
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
  // Weekly reward thresholds + bonuses.
  reward_daily_target: number;
  reward_top_car_day: number;
  reward_week_car_target: number;
  reward_top_car_week: number;
  reward_week_driver_target: number;
  reward_top_driver_week: number;
  reward_days_required: number;
  // Loyalty milestones + yearly bonuses.
  loyalty_milestones: Array<{ key: string; label: string; amount: number; reward: number }>;
  yearly_top_driver: number;
  yearly_top_car: number;
  // Loyalty wallet config.
  loyalty_wallet_enabled: boolean;
  loyalty_wallet_per_day: number;
  loyalty_wallet_min_gross: number;
  loyalty_wallet_start_date: string;
  loyalty_wallet_payout_every_days: number;
  // Attendance config.
  attendance_enabled: boolean;
  attendance_daily_target: number;
  attendance_require_ontime: boolean;
  attendance_grace_minutes: number;
  attendance_monthly_min_days: number;
  attendance_monthly_min_gross: number;
  attendance_monthly_bonus: number;
  // Salary withdrawal.
  withdraw_min_amount: number;
  withdraw_direct: boolean;
  withdraw_direct_daily_max: number;
  razorpayx_ready?: boolean;       // RazorpayX payouts are set up on the server
  google_maps_web_key?: string | null;   // admin panel maps; null = OpenStreetMap
  // Razorpay credential status (never the secret values).
  payments?: PaymentsStatus;
}

export interface PaymentsStatus {
  razorpay_enabled: boolean;
  razorpay_key_id: string | null;
  razorpay_key_secret_set: boolean;
  razorpay_webhook_secret_set: boolean;
  source: "settings" | "env" | "none" | string;
  webhook_url: string;
  // RazorpayX (driver payouts). Absent on older servers.
  razorpayx_enabled?: boolean;
  razorpayx_key_id?: string | null;
  razorpayx_key_secret_set?: boolean;
  razorpayx_account_masked?: string | null;
  razorpayx_webhook_secret_set?: boolean;
  razorpayx_keys?: "own" | "shared" | "none";
  razorpayx_webhook_url?: string;
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

// One driver on the hub's shift board.
export interface ShiftBoardRow {
  driver_id: string;
  name: string | null;
  driver_phone?: string | null;
  shift_type: string;
  active: boolean;
  shift_start_time: string | null;      // "HH:MM" set by the hub, or null
  status: "no_shift_time" | "alarm_pending" | "ringing" | "no_answer" | "coming" | "not_coming" | "late" | "not_started" | "started";
  schedule_id?: string;
  shift_start?: string;
  alarm_at?: string;
  answered_at?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  back_by?: string | null;
  snoozes?: number;
  duty_started_at?: string | null;
  late_minutes?: number | null;
  // Is the alarm really set on the driver's phone?
  phone?: "ready" | "unknown" | "not_picked_up" | "notifications_off" | "no_alarm_in_app" | "may_ring_late";
}
export interface ShiftBoardData {
  items: ShiftBoardRow[];
  counts: Record<string, number>;
  count: number;
  server_ts: string;
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
