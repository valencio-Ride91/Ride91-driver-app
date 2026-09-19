// Audit log — a read-only trail of admin actions (who did what, when).
import { useCallback, useEffect, useState } from "react";
import { api, AuditRow, downloadCsv } from "../api";

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function metaSummary(meta: Record<string, unknown>): string {
  if (!meta || typeof meta !== "object") return "";
  return Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" · ");
}

export default function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: AuditRow[] }>("/admin/audit?limit=500");
      setRows(r.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const shown = rows.filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return (r.actor ?? "").toLowerCase().includes(s) || r.action.toLowerCase().includes(s) || r.target.toLowerCase().includes(s);
  });

  const exportCsv = () => downloadCsv(
    `ride91-audit-${new Date().toISOString().slice(0, 10)}.csv`,
    ["When", "Actor", "Role", "Action", "Target", "Details"],
    shown.map((r) => [fmtWhen(r.at), r.actor ?? "", r.actor_role ?? "", r.action, r.target, metaSummary(r.meta)]),
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">{loading ? "Loading…" : `${rows.length} recent actions`}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Filter by actor / action / target" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
          <button className="ghost" onClick={exportCsv} disabled={shown.length === 0}>Export CSV</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="empty">Loading…</td></tr>
            ) : shown.length === 0 ? (
              <tr><td colSpan={5} className="empty">No matching actions.</td></tr>
            ) : shown.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.at)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.actor ?? "—"}</div>
                  {r.actor_role ? <div className="muted-sm">{r.actor_role}</div> : null}
                </td>
                <td><span className="tag muted">{r.action}</span></td>
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{r.target || "—"}</td>
                <td className="muted-sm">{metaSummary(r.meta) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
