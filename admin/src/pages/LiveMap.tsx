// Live map — where every car (or, for a driver with no car, their phone) was
// last seen. Drawn by FleetMap: Google Maps when a key is saved in Settings,
// OpenStreetMap otherwise.
import { useEffect, useMemo, useState } from "react";
import { api, VehicleLiveRow } from "../api";
import FleetMap, { MapPin } from "../components/FleetMap";

export default function LiveMap() {
  const [rows, setRows] = useState<VehicleLiveRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<{ items: VehicleLiveRow[] }>("/admin/vehicles/live");
        if (alive) setRows(r.items);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const pins = useMemo<MapPin[]>(() => rows.map((r) => ({
    id: r.vehicle_id ?? `d:${r.driver_id}`,
    lat: r.lat,
    lng: r.lng,
    color: r.stale ? "#67756D" : "#0B7A4B",
    faded: r.stale,
    title: r.vehicle_number ?? (r.vehicle_id ? r.vehicle_id.slice(0, 8) : "No car assigned"),
    lines: [
      `${r.driver_name ?? "unassigned"}${r.vehicle_id ? "" : " · from phone"}`,
      `Speed: ${r.speed_kmph != null ? `${r.speed_kmph.toFixed(0)} km/h` : "—"}`,
      `SoC: ${r.soc_pct != null ? `${r.soc_pct}%` : "—"}`,
      `Accuracy: ${r.accuracy_m != null ? `${r.accuracy_m.toFixed(0)} m` : "—"}`,
      `${r.age_minutes != null ? `${r.age_minutes.toFixed(0)} min ago` : "—"}${r.stale ? " · STALE" : ""}`,
    ],
  })), [rows]);

  return (
    <div>
      <h1>Live map</h1>
      <div className="sub">
        {loading ? "Loading…" : `${rows.length} vehicle${rows.length === 1 ? "" : "s"} · last ping every 15 s. Stale = older than 10 min.`}
      </div>
      <div className="map-wrap">
        {/* "once": open on the fleet, then leave the view alone across refreshes */}
        <FleetMap pins={pins} fit="once" />
      </div>
    </div>
  );
}
