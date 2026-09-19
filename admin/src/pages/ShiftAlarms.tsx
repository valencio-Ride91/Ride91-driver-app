// Shift alarms — the fleet's responses to start/end shift alarms. Read-only
// log: who acknowledged, who said they weren't coming, and the reason given.
import { useCallback, useEffect, useState } from "react";
import { api, AlarmRow } from "../api";

const RESPONSE_TONE: Record<string, string> = {
  awake: "live",
  heading_back: "live",
  delayed: "amber",
  snooze: "amber",
  not_coming: "alert",
};

const REASON_LABEL: Record<string, string> = {
  unwell: "Unwell",
  family_emergency: "Family emergency",
  vehicle_problem: "Vehicle problem",
  transport_problem: "Transport problem",
  personal: "Personal",
  other: "Other",
};

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default function ShiftAlarms() {
  const [rows, setRows] = useState<AlarmRow[]>([]);
  const [notComing, setNotComing] = useState(0);
  const [loading, setLoading] = useState(true);
  const [onlyNotComing, setOnlyNotComing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: AlarmRow[]; not_coming: number }>("/admin/shift-alarms");
      setRows(r.items);
      setNotComing(r.not_coming);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const shown = onlyNotComing ? rows.filter((r) => r.response === "not_coming") : rows;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Shift alarms</h1>
          <div className="sub">
            {loading ? "Loading…" : `${rows.length} responses · `}
            {!loading && notComing > 0 ? <span style={{ color: "var(--alert)" }}>{notComing} not coming</span> : "all clear"}
          </div>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={onlyNotComing} onChange={(e) => setOnlyNotComing(e.target.checked)} style={{ width: "auto" }} />
          "Not coming" only
        </label>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Responded</th><th>Driver</th><th>Phase</th><th>Response</th><th>Reason</th><th>ETA / back by</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : shown.length === 0 ? (
              <tr><td colSpan={6} className="empty">No responses.</td></tr>
            ) : shown.map((r) => (
              <tr key={r.id}>
                <td>{fmtWhen(r.responded_at || r.created_at)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.driver_name ?? r.driver_id.slice(0, 8)}</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{r.driver_phone}</div>
                </td>
                <td><span className="tag muted">{r.phase}</span></td>
                <td><span className={`tag ${RESPONSE_TONE[r.response] ?? "muted"}`}>{r.response.replace(/_/g, " ")}</span></td>
                <td>
                  {r.reason_code ? (REASON_LABEL[r.reason_code] ?? r.reason_code) : "—"}
                  {r.reason_note ? <div className="muted-sm">{r.reason_note}</div> : null}
                </td>
                <td>
                  {r.phase === "end" && r.eta_minutes != null
                    ? `${Math.round(r.eta_minutes)} min`
                    : r.phase === "start" && r.back_by
                      ? r.back_by
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
