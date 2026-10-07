// Activity log — every button the driver pressed in the app on one day, and
// where they were when they pressed it: Start / End duty, each Uber / Rapido /
// Ola switch, and the charging steps. Newest first, with the same presses
// pinned on a map underneath.
//
// The position is the one the phone sent with the press. When a press came
// without one, the closest tracked position within a few minutes is used and
// marked "approx."; if there is none either, the row says so rather than guess.
import { useMemo } from "react";
import { ActivityEntry } from "../api";
import { platformColor } from "./duty-format";
import FleetMap, { MapPin } from "./FleetMap";

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

export default function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  // Numbered in the order they happened; shown newest first.
  const numbered = useMemo(() => entries.map((e, i) => ({ e, n: i + 1 })), [entries]);
  const pins = useMemo<MapPin[]>(() => numbered
    .filter(({ e }) => e.lat != null && e.lng != null)
    .map(({ e, n }) => ({
      id: e.id ?? `${e.at}-${n}`,
      lat: e.lat as number,
      lng: e.lng as number,
      color: dotColor(e),
      label: String(n),
      title: `${n}. ${describe(e)}`,
      lines: [`${fmtTime(e.at)}${e.location_source === "nearby_ping" ? " · approx. position" : ""}`],
    })), [numbered]);

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

          {pins.length ? (
            <div style={{ height: 300, marginTop: 10, borderRadius: 8, overflow: "hidden", border: "1px solid var(--line)" }}>
              {/* "always": keep every press of the chosen day in view */}
              <FleetMap pins={pins} fit="always" />
            </div>
          ) : <div className="muted-sm" style={{ marginTop: 8 }}>No positions were recorded with these presses, so there is nothing to show on a map.</div>}
        </>
      )}
    </div>
  );
}
