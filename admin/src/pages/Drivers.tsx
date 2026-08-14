// Drivers table.
import { useEffect, useState } from "react";
import { api, DriverRow } from "../api";

function pingAge(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function Drivers() {
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<{ items: DriverRow[] }>("/admin/drivers");
        if (alive) setRows(r.items);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <h1>Drivers</h1>
      <div className="sub">{rows.length} driver{rows.length === 1 ? "" : "s"} · sorted by on-duty first</div>
      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Hub</th>
              <th>Vehicle</th>
              <th>SoC</th>
              <th>State</th>
              <th>Cash</th>
              <th>Last ping</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">No drivers yet.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.phone}</td>
                <td>{r.hub_name ?? "—"}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.vehicle_number ?? "—"}</td>
                <td>{r.vehicle_soc != null ? `${r.vehicle_soc}%` : "—"}</td>
                <td>
                  <span className="dot-ind" style={{ background: r.on_duty ? "var(--live)" : "var(--muted)" }} />
                  {r.on_duty ? "On duty" : (r.current_state ?? "off")}
                </td>
                <td>
                  ₹{r.cash_in_hand.toLocaleString("en-IN")}
                  {r.cash_over_limit ? <span className="tag alert" style={{ marginLeft: 6 }}>OVER</span> : null}
                </td>
                <td style={{ color: r.last_ping_at ? "inherit" : "var(--muted)" }}>{pingAge(r.last_ping_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
