// Live map — OpenStreetMap via Leaflet. Free, no API key.
import { useEffect, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import { api, VehicleLiveRow } from "../api";

// react-leaflet doesn't bundle its own marker icons — inline SVG dots keep
// the deploy tiny and dependency-free.
const dotIcon = (color: string, stale: boolean) =>
  L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:9px;background:${color};border:2px solid #fff;box-shadow:0 0 0 2px rgba(16,35,28,.25);${stale ? "opacity:0.5;" : ""}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

const BENGALURU: [number, number] = [12.9716, 77.5946];

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

  const center: [number, number] = rows.length && rows[0]
    ? [rows[0].lat, rows[0].lng]
    : BENGALURU;

  return (
    <div>
      <h1>Live map</h1>
      <div className="sub">
        {loading ? "Loading…" : `${rows.length} vehicle${rows.length === 1 ? "" : "s"} · last ping every 15 s. Stale = older than 10 min.`}
      </div>
      <div className="map-wrap">
        <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {rows.map((r) => (
            <Marker
              key={r.vehicle_id}
              position={[r.lat, r.lng]}
              icon={dotIcon(r.stale ? "#67756D" : "#0B7A4B", r.stale)}
            >
              <Popup>
                <div style={{ minWidth: 200 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>{r.vehicle_number ?? r.vehicle_id.slice(0, 8)}</div>
                  <div style={{ color: "#67756D", fontSize: 12, marginBottom: 8 }}>{r.driver_name ?? "unassigned"}</div>
                  <div style={{ fontSize: 12 }}>Speed: {r.speed_kmph != null ? `${r.speed_kmph.toFixed(0)} km/h` : "—"}</div>
                  <div style={{ fontSize: 12 }}>SoC: {r.soc_pct != null ? `${r.soc_pct}%` : "—"}</div>
                  <div style={{ fontSize: 12 }}>Accuracy: {r.accuracy_m != null ? `${r.accuracy_m.toFixed(0)} m` : "—"}</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {r.age_minutes != null ? `${r.age_minutes.toFixed(0)} min ago` : "—"}
                    {r.stale ? <span className="tag warn" style={{ marginLeft: 6 }}>STALE</span> : null}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
