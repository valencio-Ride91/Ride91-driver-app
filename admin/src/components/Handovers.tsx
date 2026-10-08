// Shift changes — the record the hub manager makes in the Ride91 Hub app each
// time a car changes hands: who returned it, who took it, battery, odometer,
// any new damage, and photos. Click a row to see its photos.
//
// This is the evidence for "which shift did that scratch happen on": the car's
// condition is on file at every handover, with the name of who recorded it.
import { useCallback, useEffect, useState } from "react";
import { api, HandoverDetail, HandoverRow } from "../api";

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default function Handovers({ hubId }: { hubId: string }) {
  const [rows, setRows] = useState<HandoverRow[] | null>(null);
  const [open, setOpen] = useState<HandoverDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: HandoverRow[] }>(`/admin/hubs/${hubId}/handovers`);
      setRows(r.items);
      setErr(null);
    } catch {
      setErr("Could not load shift changes.");
    }
  }, [hubId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const show = async (h: HandoverRow) => {
    if (open?.id === h.id) return setOpen(null);
    setLoadingId(h.id);
    try {
      setOpen(await api.get<HandoverDetail>(`/admin/handovers/${h.id}`));
    } catch {
      setErr("Could not load the photos.");
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="card" style={{ padding: 0 }} data-testid="handovers">
      <div style={{ padding: "14px 16px 6px" }}>
        <h2 style={{ margin: 0 }}>Shift changes</h2>
        <div className="muted-sm">Recorded in the Ride91 Hub app when a car changes hands. Click a row for its photos.</div>
        {err ? <div className="err">{err}</div> : null}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>When</th><th>Car</th><th>Returned by</th><th>Taken by</th>
            <th style={{ textAlign: "right" }}>Battery</th><th style={{ textAlign: "right" }}>Odometer</th>
            <th>Damage</th><th>Photos</th><th>Recorded by</th>
          </tr>
        </thead>
        <tbody>
          {rows === null ? (
            <tr><td colSpan={9} className="empty">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={9} className="empty">No shift changes recorded yet.</td></tr>
          ) : rows.map((h) => (
            <tr key={h.id} onClick={() => show(h)} style={{ cursor: "pointer", background: open?.id === h.id ? "var(--line)" : undefined }}>
              <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(h.created_at)}</td>
              <td style={{ fontFamily: "ui-monospace, monospace" }}>{h.vehicle_number ?? "—"}</td>
              <td>{h.from_driver_name ?? <span className="muted-sm">—</span>}</td>
              <td>{h.to_driver_name ?? <span className="muted-sm">—</span>}</td>
              <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{h.soc_pct != null ? `${h.soc_pct}%` : "—"}</td>
              <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{h.odometer_km != null ? `${Math.round(h.odometer_km).toLocaleString("en-IN")} km` : "—"}</td>
              <td style={{ maxWidth: 240 }}>{h.damage_note ? <span className="tag warn" style={{ whiteSpace: "normal" }}>{h.damage_note}</span> : <span className="muted-sm">none</span>}</td>
              <td>{loadingId === h.id ? "…" : h.photo_count}</td>
              <td className="muted-sm">{h.created_by}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {open ? (
        <div style={{ padding: 16, borderTop: "1px solid var(--line)" }} data-testid="handover-photos">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {open.vehicle_number} · {fmtWhen(open.created_at)}
            {open.cash_due ? <span className="muted-sm" style={{ marginLeft: 8, fontWeight: 400 }}>cash owed by the returning driver at that moment: ₹{open.cash_due.toLocaleString("en-IN")}</span> : null}
          </div>
          {open.photos.length === 0 ? <div className="muted-sm">No photos were taken for this shift change.</div> : (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {open.photos.map((p, i) => (
                <figure key={i} style={{ margin: 0, width: 220 }}>
                  <a href={p.data.startsWith("data:") ? p.data : `data:image/jpeg;base64,${p.data}`} target="_blank" rel="noreferrer">
                    <img src={p.data.startsWith("data:") ? p.data : `data:image/jpeg;base64,${p.data}`} alt={p.label}
                      style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
                  </a>
                  <figcaption className="muted-sm" style={{ textTransform: "capitalize" }}>{p.label}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
