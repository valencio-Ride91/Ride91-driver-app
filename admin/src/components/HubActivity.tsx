// Hub activity board — a live duty roster for one hub's drivers on a chosen
// business day: who's on duty, which platforms they're online on, on-duty &
// working time, distance, and last GPS ping. Today refreshes live; past days
// are a static snapshot.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HubActivity as HubActivityData } from "../api";
import { fmtDur, fmtAgo, todayISO, platformColor } from "./duty-format";

export default function HubActivity({ hubId }: { hubId: string }) {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState<HubActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const isToday = date === todayISO();

  const load = useCallback(async () => {
    try {
      setData(await api.get<HubActivityData>(`/admin/hubs/${hubId}/activity?date=${date}`));
    } finally {
      setLoading(false);
    }
  }, [hubId, date]);

  useEffect(() => {
    load();
    if (!isToday) return;                       // only poll the live (today) view
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, isToday]);

  return (
    <div>
      <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>Business date
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        {isToday
          ? <span className="tag live">{data?.on_duty_now ?? 0} on duty now</span>
          : <span className="tag muted">past day</span>}
        <span className="muted-sm">{isToday ? "live · refreshes every 30s" : "end-of-day snapshot"}</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Code</th><th>Driver</th><th>Car</th><th>Status</th><th>On platforms</th>
              <th style={{ textAlign: "right" }}>On-duty</th>
              <th style={{ textAlign: "right" }}>Working</th>
              <th style={{ textAlign: "right" }}>Distance</th>
              <th>Last ping</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="empty">Loading…</td></tr>
            ) : (data?.items ?? []).length === 0 ? (
              <tr><td colSpan={9} className="empty">No drivers in this hub.</td></tr>
            ) : data!.items.map((r) => (
              <tr key={r.driver_id} style={{ opacity: r.active ? 1 : 0.55 }}>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.code ?? "—"}</td>
                <td>
                  <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name ?? r.driver_id.slice(0, 8)}</Link>
                  <div className="muted-sm">{r.shift_type}</div>
                </td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.vehicle_number ?? "—"}</td>
                <td>
                  {isToday
                    ? (r.on_duty ? <span className="tag live">on duty</span> : <span className="tag muted">off</span>)
                    : <span className="muted-sm">—</span>}
                </td>
                <td>
                  {r.current_platforms.length
                    ? r.current_platforms.map((p) => (
                        <span key={p} className="tag" style={{ marginRight: 4, background: platformColor(p), color: "#fff" }}>{p}</span>
                      ))
                    : <span className="muted-sm">—</span>}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtDur(r.on_duty_seconds)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                  {fmtDur(r.working_seconds)}
                  {/* time online on each app; a driver on two apps at once accrues on both */}
                  {Object.entries(r.per_platform_seconds ?? {}).filter(([, s]) => s > 0).map(([p, s]) => (
                    <div key={p} className="muted-sm" style={{ whiteSpace: "nowrap" }} data-testid={`plat-time-${p}`}>
                      <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: platformColor(p), marginRight: 4 }} />
                      {p} {fmtDur(s)}
                    </div>
                  ))}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{r.distance_km.toFixed(1)} km</td>
                <td className="muted-sm">
                  {fmtAgo(r.last_ping_at)}
                  {r.tracking === "stopped" ? (
                    <div>
                      <span className="tag alert" data-testid="tracking-stopped"
                        title={r.tracking_reason === "location_off"
                          ? "The driver's phone reported that location is switched off or not allowed for the app."
                          : "No position from this phone for over 10 minutes: phone off, no network, or the phone closed the app."}>
                        {r.tracking_reason === "location_off" ? "location off" : "tracking stopped"}
                      </span>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
