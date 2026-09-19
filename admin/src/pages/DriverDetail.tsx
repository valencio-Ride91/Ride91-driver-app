// Per-driver drill-down: profile + vehicle + cash balance, then recent
// documents, captures, inspections, requests, payouts and cash deposits — the
// one place ops can see everything about a single driver.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, DriverDetail as Detail } from "../api";

function fmtINR(n: number | undefined | null) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}
function fmtDay(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
}

export default function DriverDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Detail>(`/admin/drivers/${id}`);
      setData(d);
    } catch {
      setErr("Could not load driver.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const hardDelete = async () => {
    if (!window.confirm("Permanently delete this driver? This cannot be undone, and is only allowed when there is no financial history.")) return;
    try {
      await api.del(`/admin/drivers/${id}?hard=true`);
      nav("/drivers");
    } catch (e: any) {
      if (e?.body?.detail === "has_financial_history") {
        setErr("This driver has cash or payout history — archive instead of deleting to keep the audit trail.");
      } else {
        setErr("Could not delete driver.");
      }
    }
  };

  if (loading) return <div className="empty" style={{ padding: 40 }}>Loading…</div>;
  if (!data) return <div className="empty" style={{ padding: 40 }}>{err ?? "Not found."}</div>;

  const { driver, vehicle, balance } = data;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="sub"><Link to="/drivers">← Drivers</Link></div>
          <h1 style={{ marginBottom: 2 }}>
            {driver.name}
            {driver.archived ? <span className="tag muted" style={{ marginLeft: 8 }}>archived</span> : null}
            {!driver.active && !driver.archived ? <span className="tag amber" style={{ marginLeft: 8 }}>inactive</span> : null}
          </h1>
          <div className="sub" style={{ fontFamily: "ui-monospace, monospace" }}>{driver.phone}</div>
        </div>
        <button className="ghost danger-ghost" onClick={hardDelete}>Delete permanently</button>
      </div>

      {err ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <Stat label="Cash owed" value={fmtINR(balance.you_owe)} tone={balance.over_limit ? "alert" : undefined} />
        <Stat label="Paid in today" value={fmtINR(balance.paid_in_today)} />
        <Stat label="Collected (to yest.)" value={fmtINR(balance.collected_to_yesterday)} />
        <Stat label="Shift / hub" value={`${driver.shift_type ?? "—"} · ${driver.hub_name ?? "—"}`} small />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Vehicle</h2>
        {vehicle ? (
          <div className="sub">
            <strong style={{ fontFamily: "ui-monospace, monospace", color: "var(--ink)" }}>{String(vehicle.number)}</strong>
            {" · "}{String(vehicle.model)}
            {vehicle.current_soc != null ? ` · SoC ${vehicle.current_soc}%` : ""}
            {vehicle.current_range_km != null ? ` · ${vehicle.current_range_km} km range` : ""}
          </div>
        ) : (
          <div className="empty">No vehicle assigned.</div>
        )}
        {driver.qr_code ? <div className="muted-sm" style={{ marginTop: 8 }}>Deposit QR: {driver.qr_code}</div> : null}
      </div>

      <Section title="Documents" rows={data.documents} cols={[
        ["Document", (r) => r.label ?? r.type],
        ["Number", (r) => r.number ?? "—"],
        ["Expires", (r) => fmtDay(r.expires_on)],
        ["Status", (r) => <span className={`tag ${r.status === "expired" ? "alert" : r.status === "expiring_soon" ? "amber" : r.verified ? "ok" : "muted"}`}>{r.verified ? "verified" : r.status}</span>],
      ]} />

      <Section title="Requests" rows={data.requests} cols={[
        ["When", (r) => fmtWhen(r.created_at)],
        ["Type", (r) => r.type],
        ["State", (r) => <span className={`tag ${r.state === "approved" ? "live" : r.state === "rejected" ? "alert" : "amber"}`}>{r.state}</span>],
        ["Decided by", (r) => r.decided_by ?? "—"],
      ]} />

      <Section title="Cash deposits" rows={data.deposits} cols={[
        ["When", (r) => fmtWhen(r.occurred_at)],
        ["Amount", (r) => fmtINR(r.amount)],
        ["Source", (r) => r.source ?? "—"],
        ["Reference", (r) => r.reference ?? "—"],
      ]} />

      <Section title="Payouts" rows={data.payouts} cols={[
        ["When", (r) => fmtWhen(r.created_at)],
        ["Amount", (r) => fmtINR(r.amount_rupees)],
        ["Mode", (r) => r.mode ?? "—"],
        ["Status", (r) => <span className="tag muted">{r.status}</span>],
      ]} />

      <Section title="Captures" rows={data.captures} cols={[
        ["Day", (r) => r.day_key],
        ["Duration", (r) => r.duration_s != null ? `${r.duration_s}s` : "—"],
        ["Flags", (r) => (r.review_flag_movement ? "movement " : "") + (r.hub_warn ? "off-hub" : "") || "—"],
        ["Reviewed", (r) => r.review_decision ?? "—"],
      ]} />

      <Section title="Inspections" rows={data.inspections} cols={[
        ["Day", (r) => r.day_key],
        ["When", (r) => fmtWhen(r.created_at)],
      ]} />
    </div>
  );
}

const Stat = ({ label, value, tone, small }: { label: string; value: string; tone?: "alert"; small?: boolean }) => (
  <div className="card" style={{ padding: 14 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
    <div style={{ fontSize: small ? 15 : 22, fontWeight: 700, marginTop: 4, color: tone === "alert" ? "var(--alert)" : "var(--ink)" }}>{value}</div>
  </div>
);

function Section({ title, rows, cols }: {
  title: string;
  rows: Array<Record<string, any>>;
  cols: Array<[string, (r: Record<string, any>) => React.ReactNode]>;
}) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 20 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", fontWeight: 700 }}>
        {title} <span className="muted-sm">({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: 20 }}>None.</div>
      ) : (
        <table className="data">
          <thead><tr>{cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i}>{cols.map(([h, fn]) => <td key={h}>{fn(r)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
