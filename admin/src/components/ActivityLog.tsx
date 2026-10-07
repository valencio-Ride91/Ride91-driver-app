// Activity log — every button the driver pressed in the app on one day, and
// where they were when they pressed it: Start / End duty, each Uber / Rapido /
// Ola switch, and the charging steps. Newest first, with the same presses
// pinned on a map underneath.
//
// The position is the one the phone sent with the press. When a press came
// without one, the closest tracked position within a few minutes is used and
// marked "approx."; if there is none either, the row says so rather than guess.
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { ActivityEntry } from "../api";
import { platformColor } from "./duty-format";

const APP: Record<string, string> = { uber: "Uber", rapido: "Rapido", ola: "Ola" };
const appName = (p: string) => APP[p] ?? p;

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}

/** What the press did, in plain words. */
export function describe(e: ActivityEntry): string {
  switch (e.action) {
    case "start_duty": return "Started duty";
    case "end_duty": return e.turned_off.length ? `Ended duty (was on ${e.turned_off.map(appName).join(", ")})` : "Ended duty";
    case "to_charger": return "Going to charger";
    case "charging_started": return "Charging started";
    case "charging_finished": return "Charging finished";
    case "apps_changed":
      return [...e.turned_on.map((p) => `${appName(p)} on`), ...e.turned_off.map((p) => `${appName(p)} off`)].join(", ");
    default:
      return e.state === "not_online" ? "Pressed Not online (already off every app)" : "Pressed again, nothing changed";
  }
}

function dotColor(e: ActivityEntry): string {
  if (e.action === "start_duty") return "#0B7A4B";
  if (e.action === "end_duty") return "#10231C";
  if (e.action.startsWith("charging") || e.action === "to_charger") return "#d9a400";
  const p = e.turned_on[0] ?? e.turned_off[0];
  return p ? platformColor(p) : "#67756D";
}

const pin = (color: string, n: number) =>
  L.divIcon({
    className: "",
    html: `<div style="min-width:20px;height:20px;border-radius:10px;background:${color};color:#fff;font:700 11px/20px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 0 0 1px rgba(16,35,28,.35);padding:0 3px">${n}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

// Keep every press in view when the day or the data changes.
function FitTo({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = points.map((p) => p.join(",")).join("|");
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 15);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 16 });
    // `key` stands in for `points`, which is a new array every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export default function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  // Numbered in the order they happened; shown newest first.
  const numbered = useMemo(() => entries.map((e, i) => ({ e, n: i + 1 })), [entries]);
  const placed = numbered.filter(({ e }) => e.lat != null && e.lng != null);
  const points = placed.map(({ e }) => [e.lat as number, e.lng as number] as [number, number]);

  return (
    <div style={{ marginTop: 18 }} data-testid="activity-log">
      <h3 style={{ margin: "0 0 4px" }}>Activity log <span className="muted-sm">({entries.length})</span></h3>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        Every button the driver pressed this day, and where they were when they pressed it.
      </div>
      {entries.length === 0 ? (
        <div className="empty">No button presses on this day.</div>
      ) : (
        <>
          <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
            <table className="data" style={{ margin: 0 }}>
              <thead>
                <tr><th>#</th><th>Time</th><th>What the driver did</th><th>Online on after</th><th>Where</th></tr>
              </thead>
              <tbody>
                {[...numbered].reverse().map(({ e, n }) => (
                  <tr key={e.id ?? `${e.at}-${n}`}>
                    <td>
                      <span style={{ display: "inline-block", minWidth: 20, textAlign: "center", borderRadius: 10, padding: "0 5px",
                        background: dotColor(e), color: "#fff", fontSize: 11, fontWeight: 700 }}>{n}</span>
                    </td>
                    <td style={{ fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>{fmtTime(e.at)}</td>
                    <td style={{ fontWeight: 600 }}>
                      {describe(e)}
                      {e.source !== "driver" ? <span className="tag muted" style={{ marginLeft: 6 }}>entered by admin</span> : null}
                    </td>
                    <td>
                      {e.online_on.length
                        ? e.online_on.map((p) => (
                            <span key={p} className="tag" style={{ marginRight: 4, background: platformColor(p), color: "#fff" }}>{appName(p)}</span>
                          ))
                        : <span className="muted-sm">none</span>}
                    </td>
                    <td className="muted-sm" style={{ whiteSpace: "nowrap" }}>
                      {e.lat != null && e.lng != null ? (
                        <>
                          <a href={`https://www.google.com/maps?q=${e.lat},${e.lng}`} target="_blank" rel="noreferrer"
                            style={{ fontFamily: "ui-monospace, monospace" }}>
                            {e.lat.toFixed(5)}, {e.lng.toFixed(5)}
                          </a>
                          {e.location_source === "nearby_ping"
                            ? <span title="The press came without a position; this is the closest tracked position within 3 minutes."> · approx.</span>
                            : null}
                        </>
                      ) : <span title="The phone had no position at that moment and none was tracked within 3 minutes.">no location</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {points.length ? (
            <div style={{ height: 280, marginTop: 10, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)" }}>
              <MapContainer center={points[points.length - 1]} zoom={14} style={{ height: "100%", width: "100%" }}>
                <TileLayer
                  attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitTo points={points} />
                {placed.map(({ e, n }) => (
                  <Marker key={e.id ?? `${e.at}-${n}`} position={[e.lat as number, e.lng as number]} icon={pin(dotColor(e), n)}>
                    <Popup>
                      <div style={{ minWidth: 160 }}>
                        <div style={{ fontWeight: 700 }}>{n}. {describe(e)}</div>
                        <div style={{ fontSize: 12, color: "#67756D" }}>
                          {fmtTime(e.at)}{e.location_source === "nearby_ping" ? " · approx. position" : ""}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          ) : <div className="muted-sm" style={{ marginTop: 8 }}>No positions were recorded with these presses, so there is nothing to show on a map.</div>}
        </>
      )}
    </div>
  );
}
