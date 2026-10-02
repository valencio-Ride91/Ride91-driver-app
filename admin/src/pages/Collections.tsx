// Collections — money riders pay directly via each driver's collection QR.
// This is tracked money only: it does NOT affect a driver's cash-in-hand,
// dues, gross, or rewards. Shows the fleet grand total and a per-driver
// breakdown, and lets ops generate / view a driver's permanent QR.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, CollectionsResponse, CollectionQr } from "../api";

function fmtINR(n: number) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default function Collections() {
  const [data, setData] = useState<CollectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qrFor, setQrFor] = useState<{ id: string; name: string | null } | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (from) q.set("from_date", from);
    if (to) q.set("to_date", to);
    const qs = q.toString();
    try {
      setData(await api.get<CollectionsResponse>(`/admin/collections${qs ? `?${qs}` : ""}`));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Collections</h1>
          <div className="sub">Money riders pay via drivers' QR codes · tracked only (doesn't touch dues or the 30% split)</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, max-content)", gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 14, minWidth: 180 }}>
          <div className="muted-sm">Total collected</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "var(--live, #16a34a)" }}>{fmtINR(data?.grand_total ?? 0)}</div>
        </div>
        <div className="card" style={{ padding: 14, minWidth: 140 }}>
          <div className="muted-sm">Payments</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{data?.count ?? 0}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>From (business date)
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from || to) ? <button className="ghost" onClick={() => { setFrom(""); setTo(""); }}>Clear</button> : null}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr><th>Code</th><th>Driver</th><th style={{ textAlign: "right" }}>Collected</th><th style={{ textAlign: "center" }}>Payments</th><th>Last payment</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : (data?.items ?? []).length === 0 ? (
              <tr><td colSpan={6} className="empty">No collections yet.</td></tr>
            ) : data!.items.map((r) => (
              <tr key={r.driver_id}>
                <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{r.code ?? <span className="muted-sm">—</span>}</td>
                <td>
                  <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name ?? r.driver_id.slice(0, 8)}</Link>
                  {r.phone ? <div className="muted-sm" style={{ fontFamily: "ui-monospace, monospace" }}>{r.phone}</div> : null}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{fmtINR(r.total)}</td>
                <td style={{ textAlign: "center" }}>{r.count}</td>
                <td>{fmtWhen(r.last_at)}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="ghost" onClick={() => setQrFor({ id: r.driver_id, name: r.name })}>QR</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="muted-sm" style={{ marginTop: 12 }}>
        Generate a driver's QR from here or their detail page — it's permanent and reusable. The rider scans it and enters the fare; the money reaches your Razorpay account tagged to that driver.
      </div>

      {qrFor ? <QrModal driverId={qrFor.id} name={qrFor.name} onClose={() => setQrFor(null)} /> : null}
    </div>
  );
}

function QrModal({ driverId, name, onClose }: { driverId: string; name: string | null; onClose: () => void }) {
  const [qr, setQr] = useState<CollectionQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<CollectionQr>(`/admin/drivers/${driverId}/collection-qr`)
      .then(setQr).catch(() => setErr("Could not load QR."))
      .finally(() => setLoading(false));
  }, [driverId]);

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      setQr(await api.post<CollectionQr>(`/admin/drivers/${driverId}/collection-qr`));
    } catch (e: any) {
      setErr(e?.body?.detail === "razorpay_not_configured" ? "Razorpay isn't configured on the server yet." : "Could not generate QR.");
    } finally {
      setBusy(false);
    }
  };

  const has = qr && qr.qr_code_id && qr.image_url;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: "92vw", textAlign: "center" }}>
        <h2 style={{ marginTop: 0 }}>Collection QR</h2>
        <div className="muted-sm" style={{ marginBottom: 4 }}>{name ?? driverId.slice(0, 8)}</div>
        {qr?.code ? <div style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, marginBottom: 12 }}>{qr.code}</div> : null}
        {loading ? <div className="empty">Loading…</div> : has ? (
          <>
            <img src={qr!.image_url!} alt="Collection QR" style={{ width: 240, height: 240, objectFit: "contain", border: "1px solid var(--line)", borderRadius: 8 }} />
            <div className="muted-sm" style={{ marginTop: 8 }}>Rider scans this and enters the fare.</div>
            <div className="form-actions" style={{ justifyContent: "center" }}>
              <a className="ghost" href={qr!.image_url!} download={`ride91-qr-${driverId.slice(0, 8)}.png`} target="_blank" rel="noreferrer">Download</a>
              {qr!.short_url ? <a className="ghost" href={qr!.short_url} target="_blank" rel="noreferrer">Open link</a> : null}
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="empty" style={{ marginBottom: 8 }}>No QR for this driver yet.</div>
            {err ? <div className="err">{err}</div> : null}
            <div className="form-actions" style={{ justifyContent: "center" }}>
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button className="primary" onClick={generate} disabled={busy}>{busy ? "Generating…" : "Generate QR"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
