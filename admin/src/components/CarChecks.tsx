// Vehicle checks — the inspections and service entries the hub manager records
// in the Ride91 Hub app, for every car of the hub.
//
// An inspection marks each point of the car OK or "needs attention"; the
// points that needed attention are listed here with their notes. Service
// history is the work done on each car, with the date it was done.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface CheckItem { status: "ok" | "attention" | "not_checked"; note: string | null }
interface CheckRow {
  id: string;
  vehicle_number: string | null;
  items: Record<string, CheckItem>;
  attention: string[];
  battery_note: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}
interface ServiceRow {
  id: string;
  vehicle_number: string | null;
  kind: string;
  service_date: string;
  note: string | null;
  cost: number | null;
  created_by: string | null;
}

const ITEM: Record<string, string> = {
  tyres: "Tyres", spare_tyre: "Spare tyre", brake_fluid: "Brake fluid", coolant: "Coolant", motor_oil: "Motor oil",
  wipers: "Wipers", headlights: "Headlights", dash_camera: "Dash camera", gps: "GPS",
};
const KIND: Record<string, string> = {
  service: "Full service", tyres: "Tyres changed", wipers: "Wipers changed", brakes: "Brakes", battery: "Battery work", other: "Other work",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const day = (ymd: string) => new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const mono = { fontFamily: "ui-monospace, monospace" } as const;

export default function CarChecks({ hubId }: { hubId: string }) {
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ checks: CheckRow[]; services: ServiceRow[] }>(`/admin/hubs/${hubId}/car-checks`);
      setChecks(r.checks);
      setServices(r.services);
      setErr(null);
    } catch {
      setErr("Could not load vehicle checks.");
    }
  }, [hubId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div data-testid="car-checks">
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 16px 6px" }}>
          <h2 style={{ margin: 0 }}>Inspections</h2>
          <div className="muted-sm">Recorded by the hub manager in the Ride91 Hub app. Points left unmarked were not checked.</div>
          {err ? <div className="err">{err}</div> : null}
        </div>
        <table className="data">
          <thead>
            <tr><th>When</th><th>Car</th><th>Result</th><th>Needs attention</th><th>Battery report</th><th>Notes</th><th>By</th></tr>
          </thead>
          <tbody>
            {checks === null ? (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            ) : checks.length === 0 ? (
              <tr><td colSpan={7} className="empty">No inspection recorded yet.</td></tr>
            ) : checks.map((c) => {
              const done = Object.values(c.items).filter((i) => i.status !== "not_checked").length;
              return (
                <tr key={c.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(c.created_at)}</td>
                  <td style={mono}>{c.vehicle_number ?? "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {c.attention.length
                      ? <span className="tag warn">{c.attention.length} {c.attention.length === 1 ? "needs" : "need"} attention</span>
                      : done ? <span className="tag ok">All OK</span> : <span className="muted-sm">note only</span>}
                    <div className="muted-sm">{done} of {Object.keys(ITEM).length} checked</div>
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    {c.attention.length === 0 ? <span className="muted-sm">—</span> : c.attention.map((k) => (
                      <div key={k}>{ITEM[k] ?? k}{c.items[k]?.note ? <span className="muted-sm"> · {c.items[k].note}</span> : null}</div>
                    ))}
                  </td>
                  <td style={{ maxWidth: 220 }}>{c.battery_note ?? <span className="muted-sm">—</span>}</td>
                  <td style={{ maxWidth: 220 }}>{c.notes ?? <span className="muted-sm">—</span>}</td>
                  <td className="muted-sm">{c.created_by}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <div style={{ padding: "14px 16px 6px" }}>
          <h2 style={{ margin: 0 }}>Service history</h2>
          <div className="muted-sm">Work done on each car, newest first.</div>
        </div>
        <table className="data">
          <thead>
            <tr><th>Date done</th><th>Car</th><th>Work</th><th>Details</th><th style={{ textAlign: "right" }}>Cost</th><th>By</th></tr>
          </thead>
          <tbody>
            {checks !== null && services.length === 0 ? (
              <tr><td colSpan={6} className="empty">No service recorded yet.</td></tr>
            ) : services.map((s) => (
              <tr key={s.id}>
                <td style={{ whiteSpace: "nowrap" }}>{day(s.service_date)}</td>
                <td style={mono}>{s.vehicle_number ?? "—"}</td>
                <td>{KIND[s.kind] ?? s.kind}</td>
                <td style={{ maxWidth: 320 }}>{s.note ?? <span className="muted-sm">—</span>}</td>
                <td style={{ textAlign: "right", ...mono }}>{s.cost != null ? `₹${s.cost.toLocaleString("en-IN")}` : "—"}</td>
                <td className="muted-sm">{s.created_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
