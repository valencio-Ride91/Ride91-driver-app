// Payouts admin page — trigger RazorpayX payouts to drivers and view history.
//
// Flow per driver:
//   1. Pick a driver from the dropdown (loaded from /admin/drivers).
//   2. Choose an amount, mode (IMPS = bank, UPI = VPA), and narration.
//   3. Backend does contact + fund_account creation lazily, then POST /payouts
//      with an idempotency header.
//   4. Row appears in the history table below with initial status
//      ("processing" in test mode) and updates via webhook (or the manual
//      "Refresh" per-row action).

import { useEffect, useMemo, useState } from "react";
import { api, DriverRow, PayoutRow, downloadCsv } from "../api";

function fmtINR(n: number) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

const STATUS_TONE: Record<string, string> = {
  processed: "live",
  processing: "amber",
  queued: "amber",
  pending: "amber",
  reversed: "alert",
  failed: "alert",
  rejected: "alert",
  cancelled: "muted",
};

export default function Payouts() {
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [driverId, setDriverId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [mode, setMode] = useState<"IMPS" | "UPI">("IMPS");
  const [narration, setNarration] = useState<string>("Ride91 driver payout");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");

  const driverMap = useMemo(
    () => Object.fromEntries(drivers.map((d) => [d.id, d])),
    [drivers],
  );

  const load = async () => {
    try {
      const [drv, py] = await Promise.all([
        api.get<{ items: DriverRow[] }>("/admin/drivers"),
        api.get<{ items: PayoutRow[] }>("/admin/payouts?limit=200"),
      ]);
      setDrivers(drv.items ?? []);
      setRows(py.items ?? []);
    } catch (e) {
      // silent — refresh will re-try
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const submit = async () => {
    if (!driverId) {
      setError("Pick a driver.");
      return;
    }
    const a = Number(amount);
    if (!a || a <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const resp = await api.post<{ payout_id: string; status: string }>(
        "/admin/payouts/create",
        {
          driver_id: driverId,
          amount_rupees: a,
          mode,
          narration,
          client_action_id: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      );
      setOk(`Payout submitted (${resp.status}).`);
      setAmount("");
      await load();
    } catch (e: any) {
      const detail = e?.body?.detail ?? "Failed. Check keys / driver bank details.";
      setError(String(detail));
    } finally {
      setBusy(false);
    }
  };

  const refreshRow = async (id: string) => {
    try {
      await api.get(`/admin/payouts/${id}/refresh`);
      await load();
    } catch {
      // ignore
    }
  };

  const filteredRows = rows.filter((r) => {
    if (!filter) return true;
    const d = driverMap[r.driver_id];
    const q = filter.toLowerCase();
    return (
      r.utr?.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q) ||
      (d?.name || "").toLowerCase().includes(q) ||
      (d?.phone || "").toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <h1>Payouts</h1>
      <div className="sub">RazorpayX driver payouts · test mode</div>

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 16 }}>New payout</h2>
        <div style={styles.grid}>
          <div>
            <label style={styles.label}>Driver</label>
            <select
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              style={styles.input}
            >
              <option value="">— select —</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.phone}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={styles.label}>Amount (₹)</label>
            <input
              type="number"
              min={1}
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 2500"
              style={styles.input}
            />
          </div>
          <div>
            <label style={styles.label}>Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "IMPS" | "UPI")}
              style={styles.input}
            >
              <option value="IMPS">IMPS (bank)</option>
              <option value="UPI">UPI</option>
            </select>
          </div>
          <div style={{ gridColumn: "span 3" }}>
            <label style={styles.label}>Narration (≤30 chars)</label>
            <input
              type="text"
              value={narration}
              maxLength={30}
              onChange={(e) => setNarration(e.target.value)}
              style={styles.input}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
          <button
            className="primary"
            onClick={submit}
            disabled={busy}
            style={{ opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Submitting…" : "Send payout"}
          </button>
          {error ? <span className="tag alert">{error}</span> : null}
          {ok ? <span className="tag live">{ok}</span> : null}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="sub">{rows.length} payout{rows.length === 1 ? "" : "s"}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            placeholder="Filter by driver / UTR / status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ ...styles.input, maxWidth: 320, marginBottom: 0 }}
          />
          <button
            className="ghost"
            disabled={filteredRows.length === 0}
            onClick={() => downloadCsv(
              `ride91-payouts-${new Date().toISOString().slice(0, 10)}.csv`,
              ["When", "Driver", "Phone", "Amount", "Mode", "Status", "UTR", "Ref"],
              filteredRows.map((r) => {
                const d = driverMap[r.driver_id];
                return [fmtWhen(r.created_at), d?.name ?? r.driver_id, d?.phone ?? "", r.amount_rupees, r.mode, r.status, r.utr ?? "", r.reference_id ?? ""];
              }),
            )}
          >Export</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Driver</th>
              <th>Amount</th>
              <th>Mode</th>
              <th>Status</th>
              <th>UTR</th>
              <th>Ref</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr><td colSpan={8} className="empty">No payouts yet.</td></tr>
            ) : filteredRows.map((r) => {
              const d = driverMap[r.driver_id];
              const tone = STATUS_TONE[r.status] ?? "muted";
              return (
                <tr key={r.id}>
                  <td>{fmtWhen(r.created_at)}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d?.name ?? r.driver_id.slice(0, 8)}</div>
                    <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{d?.phone ?? ""}</div>
                  </td>
                  <td style={{ fontFamily: "ui-monospace, monospace" }}>{fmtINR(r.amount_rupees)}</td>
                  <td>{r.mode}</td>
                  <td><span className={`tag ${tone}`}>{r.status}</span></td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{r.utr ?? "—"}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{r.reference_id ?? "—"}</td>
                  <td>
                    <button className="ghost" onClick={() => refreshRow(r.id)}>Refresh</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 12,
  },
  label: {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--line)",
    fontSize: 14,
    fontFamily: "inherit",
    background: "#fff",
    color: "var(--ink)",
    marginBottom: 4,
  },
};
