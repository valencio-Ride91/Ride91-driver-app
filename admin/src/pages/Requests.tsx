// Driver requests queue — advances, holidays, extra hours. Ops approves or
// rejects; an approved advance does not itself move any balance (that stays a
// separate deliberate action in the cash/advance ledger).
import { useCallback, useEffect, useState } from "react";
import { api, RequestRow } from "../api";

const TYPE_LABEL: Record<string, string> = {
  advance: "Advance",
  holiday: "Holiday",
  extra_hours: "Extra hours",
};

const STATE_TONE: Record<string, string> = {
  pending: "amber",
  approved: "live",
  rejected: "alert",
};

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function summarise(payload: Record<string, unknown>): string {
  if (!payload || typeof payload !== "object") return "—";
  const parts = Object.entries(payload)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toLocaleString("en-IN") : String(v)}`);
  return parts.length ? parts.join(" · ") : "—";
}

export default function Requests() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [pending, setPending] = useState(0);
  const [onlyPending, setOnlyPending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: RequestRow[]; pending: number }>(
        `/admin/requests${onlyPending ? "?state=pending" : ""}`,
      );
      setRows(r.items);
      setPending(r.pending);
    } finally {
      setLoading(false);
    }
  }, [onlyPending]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const decide = async (row: RequestRow, decision: "approve" | "reject") => {
    let note: string | null = null;
    if (decision === "reject") {
      note = window.prompt("Reason for rejecting (optional):", "") || null;
    }
    setBusyId(row.id);
    try {
      await api.post(`/admin/requests/${row.id}/decide`, { decision, note });
      setToast(`Request ${decision === "approve" ? "approved" : "rejected"}.`);
      setTimeout(() => setToast(null), 2000);
      await load();
    } catch (e: any) {
      setToast(String(e?.body?.detail ?? "Could not update."));
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Driver requests</h1>
          <div className="sub">{pending} pending · advances, holidays, extra hours</div>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} style={{ width: "auto" }} />
          Pending only
        </label>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>When</th><th>Driver</th><th>Type</th><th>Details</th><th>State</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">{onlyPending ? "Nothing pending." : "No requests yet."}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtWhen(r.created_at)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.driver_name ?? r.driver_id.slice(0, 8)}</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{r.driver_phone}</div>
                </td>
                <td>{TYPE_LABEL[r.type] ?? r.type}</td>
                <td style={{ maxWidth: 320 }}>{summarise(r.payload)}</td>
                <td>
                  <span className={`tag ${STATE_TONE[r.state] ?? "muted"}`}>{r.state}</span>
                  {r.decided_by ? <div className="muted-sm">by {r.decided_by}</div> : null}
                </td>
                <td style={{ textAlign: "right" }}>
                  {r.state === "pending" ? (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button className="primary" disabled={busyId === r.id} onClick={() => decide(r, "approve")}>Approve</button>
                      <button className="danger" disabled={busyId === r.id} onClick={() => decide(r, "reject")}>Reject</button>
                    </div>
                  ) : (
                    <span className="muted-sm">{r.decision_note || "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {toast ? (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--ink)", color: "#fff", padding: "12px 18px", borderRadius: 8, boxShadow: "var(--shadow)" }}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}
