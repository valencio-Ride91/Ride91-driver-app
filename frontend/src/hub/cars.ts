// What the hub app knows about the hub's cars and who can drive them.

export interface HubCar {
  id: string;
  number: string | null;
  model: string | null;
  current_soc: number | null;
  /** When the battery figure was taken (absent on an older server). */
  soc_at?: string | null;
  odometer_km: number | null;
  day_driver: { driver_id: string; name: string | null } | null;
  night_driver: { driver_id: string; name: string | null } | null;
  last_handover: { id?: string; created_at: string; from_driver_name: string | null; to_driver_name: string | null; damage_note: string | null; damage_repaired_at?: string | null } | null;
  // Absent on an older server.
  last_check?: { created_at: string; attention: string[] } | null;
  last_service_date?: string | null;
}

// The points of an inspection, in the order the manager walks round the car.
export const CHECK_ITEMS = ["tyres", "spare_tyre", "brake_fluid", "coolant", "motor_oil", "wipers", "headlights", "dash_camera", "gps"] as const;
export const SERVICE_KINDS = ["service", "tyres", "wipers", "brakes", "battery", "other"] as const;
export type CheckStatus = "ok" | "attention" | "not_checked";

export interface CarCheck {
  id: string;
  items: Record<string, { status: CheckStatus; note: string | null }>;
  attention: string[];
  battery_note: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}

export interface CarService {
  id: string;
  kind: string;
  service_date: string;
  note: string | null;
  cost: number | null;
  created_by: string | null;
}

export interface CarHandover {
  id: string;
  from_driver_name: string | null;
  to_driver_name: string | null;
  soc_pct: number | null;
  odometer_km: number | null;
  damage_note: string | null;
  damage_repaired_at?: string | null;
  damage_repaired_by?: string | null;
  photo_count: number | null;
  created_at: string;
  created_by: string | null;
}

export interface CarHistory {
  vehicle: { id: string; number: string | null; model: string | null; current_soc: number | null; odometer_km: number | null; soc_at?: string | null };
  /** Who drives it now, by shift (absent on an older server). */
  drivers?: { driver_id: string; name: string | null; shift: string }[];
  checks: CarCheck[];
  services: CarService[];
  last_done: Record<string, string>;
  handovers: CarHandover[];
}

export interface CarDriver { driver_id: string; name: string | null; shift_type: string; vehicle_id: string | null; you_owe: number }

export interface CarsData { cars: HubCar[]; drivers: CarDriver[] }

// "3 h ago" for a timestamp, in the app's words; empty when there is none.
export function ago(ts: string | null | undefined, t: { ago_now: string; ago_min: (n: number) => string; ago_hr: (n: number) => string; ago_day: (n: number) => string }): string {
  if (!ts) return "";
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return "";
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 2) return t.ago_now;
  if (min < 60) return t.ago_min(min);
  if (min < 48 * 60) return t.ago_hr(Math.floor(min / 60));
  return t.ago_day(Math.floor(min / 1440));
}

// A battery reading older than this is shown as stale.
export const SOC_STALE_MS = 12 * 3600 * 1000;
export const isStale = (ts: string | null | undefined) => !ts || Date.now() - new Date(ts).getTime() > SOC_STALE_MS;

// Damage from the last shift change that has not been marked repaired.
export const openDamage = (c: HubCar) => !!c.last_handover?.damage_note && !c.last_handover?.damage_repaired_at;
