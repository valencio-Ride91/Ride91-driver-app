// Per-driver duty / activity card for the driver detail page. Shows a chosen
// business day's on-duty / working / charging time, distance, platforms, a
// per-platform breakdown, and a proportional timeline of the day's segments.
// Today refreshes live; past days are a static snapshot.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, DutySummary } from "../api";
import { fmtDur, fmtAgo, todayISO, platformColor } from "./duty-format";
import ActivityLog from "./ActivityLog";

const STATE_COLOR: Record<string, string> = {
  online: "var(--live, #16a34a)",
  not_online: "var(--muted)",
  charging: "#d9a400",
  to_charger: "#d9a400",
};

export default function DutyCard({ driverId }: { driverId: string }) {
  const [date, setDate] = useState(todayISO());
  const [d, setD] = useState<DutySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const isToday = date === todayISO();

  const load = useCallback(async () => {
    try {
      setD(await api.get<DutySummary>(`/admin/drivers/${driverId}/duty?date=${date}`));
    } finally {
      setLoading(false);
    }
  }, [driverId, date]);

  useEffect(() => {
    load();
    if (!isToday) return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, isToday]);

  const total = (d?.segments ?? []).reduce((a, s) => a + s.seconds, 0) || 1;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Duty &amp; activity</h2>
        <label style={{ fontSize: 13 }}>Date{" "}
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      {loading ? <div className="empty">Loading…</div> : !d ? <div className="empty">No data.</div> : (
        <>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", margin: "12px 0" }}>
            <Stat label="Status" node={isToday ? (d.on_duty ? <span className="tag live">on duty</span> : <span className="tag muted">off</span>) : <span className="muted-sm">—</span>} />
            <Stat label="On-duty" value={fmtDur(d.on_duty_seconds)} />
            <Stat label="Working" value={fmtDur(d.working_seconds)} />
            <Stat label="Charging" value={fmtDur(d.charging_seconds)} />
            <Stat label="Distance" value={`${d.distance_km.toFixed(1)} km`} />
            <Stat label="Last ping" value={fmtAgo(d.last_ping_at)} />
          </div>

          {d.current_platforms.length ? (
            <div style={{ marginBottom: 10 }}>
              {d.current_platforms.map((p) => (
                <span key={p} className="tag" style={{ marginRight: 4, background: platformColor(p), color: "#fff" }}>{p}</span>
              ))}
              <span className="muted-sm"> online now</span>
            </div>
          ) : null}

          {Object.keys(d.per_platform_seconds).length ? (
            <div className="muted-sm" style={{ marginBottom: 10 }}>
              {Object.entries(d.per_platform_seconds).map(([p, s]) => `${p}: ${fmtDur(s)}`).join("  ·  ")}
            </div>
          ) : null}

          {d.segments.length ? (
            <>
              <div style={{ display: "flex", height: 14, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
                {d.segments.map((s, i) => (
                  <div
                    key={i}
                    title={`${s.platforms.length ? s.platforms.join("+") : s.state} · ${fmtDur(s.seconds)}`}
                    style={{
                      width: `${(s.seconds / total) * 100}%`,
                      background: s.platforms.length ? platformColor(s.platforms[0]) : (STATE_COLOR[s.state] ?? "var(--line)"),
                    }}
                  />
                ))}
              </div>
              <div className="muted-sm" style={{ marginTop: 6 }}>Timeline of the day — hover a block for platform &amp; duration.</div>
            </>
          ) : <div className="empty">No duty recorded for this day.</div>}

          {d.log ? <ActivityLog entries={d.log} /> : null}
        </>
      )}
    </div>
  );
}

const Stat = ({ label, value, node }: { label: string; value?: string; node?: ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{node ?? value}</div>
  </div>
);
