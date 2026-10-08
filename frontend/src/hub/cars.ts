// What the hub app knows about the hub's cars and who can drive them.

export interface HubCar {
  id: string;
  number: string | null;
  model: string | null;
  current_soc: number | null;
  odometer_km: number | null;
  day_driver: { driver_id: string; name: string | null } | null;
  night_driver: { driver_id: string; name: string | null } | null;
  last_handover: { created_at: string; from_driver_name: string | null; to_driver_name: string | null; damage_note: string | null } | null;
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
  photo_count: number | null;
  created_at: string;
  created_by: string | null;
}

export interface CarHistory {
  vehicle: { id: string; number: string | null; model: string | null; current_soc: number | null; odometer_km: number | null };
  checks: CarCheck[];
  services: CarService[];
  last_done: Record<string, string>;
  handovers: CarHandover[];
}

export interface CarDriver { driver_id: string; name: string | null; shift_type: string; vehicle_id: string | null; you_owe: number }

export interface CarsData { cars: HubCar[]; drivers: CarDriver[] }
