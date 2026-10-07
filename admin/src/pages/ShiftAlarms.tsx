// Shift alarms. Inside a hub this opens with the live Shift board (who is
// coming, who is not, who has not answered, and where shift times are set),
// followed by the log of every alarm answer: who acknowledged, who said they
// weren't coming, and the reason given. Answers to test alarms are not shown.
import { useCallback, useEffect, useState } from "react";
import { api, AlarmRow } from "../api";
import ShiftBoard from "../components/ShiftBoard";

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

export default function ShiftAlarms({ hubId }: { hubId?: string }) {
  const [rows, setRows] = useState<AlarmRow[]>([]);
  const [notComing, setNotComing] = useState(0);
  const [loading, setLoading] = useState(true);
  const [onlyNotComing, setOnlyNotComing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: AlarmRow[]; not_coming: number }>(`/admin/shift-alarms${hubId ? `?hub_id=${hubId}` : ""}`);
      setRows(r.items);
      setNotComing(r.not_coming);
    } finally {
      setLoading(false);
    }
  }, [hubId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const shown = onlyNotComing ? rows.filter((r) => r.response === "not_coming") : rows;

  return (
    <div>
      {hubId ? <ShiftBoard hubId={hubId} /> : null}
      <div className="page-head">
        {hubId ? <div><h2 style={{ margin: 0 }}>Alarm answers</h2></div> : (
          <div>
            <h1>Shift alarms</h1>
            <div className="sub">
              {loading ? "Loading…" : `${rows.length} responses · `}
              {!loading && notComing > 0 ? <span style={{ color: "var(--alert)" }}>{notComing} not coming</span> : "all clear"}
            </div>
          </div>
        )}
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
              <tr><td colSpan={6} className="empty">No alarm answers yet. They appear here when a driver answers a real wake-up alarm.</td></tr>
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
