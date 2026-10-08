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
}

export interface CarDriver { driver_id: string; name: string | null; shift_type: string; vehicle_id: string | null; you_owe: number }

export interface CarsData { cars: HubCar[]; drivers: CarDriver[] }
