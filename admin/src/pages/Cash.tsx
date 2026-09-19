// Cash reconciliation — what each driver has collected (settled platform cash,
// to yesterday) minus what they've paid in (trusted deposits). Ops can record
// an off-app hand-in per driver, which posts to the same idempotent endpoint
// the driver's own screen relies on.
import { useCallback, useEffect, useState } from "react";
import { api, CashResponse, CashRow } from "../api";

function fmtINR(n: number) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function Cash() {
  const [data, setData] = useState<CashResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [depositFor, setDepositFor] = useState<CashRow | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("Cash handed at hub");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<CashResponse>("/admin/cash");
      setData(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const openDeposit = (row: CashRow) => {
    setDepositFor(row);
    setAmount(row.you_owe > 0 ? String(Math.round(row.you_owe)) : "");
    setReference(`HUB-${new Date().toISOString().slice(0, 10)}-${row.phone?.slice(-4) ?? ""}`);
    setReason("Cash handed at hub");
    setErr(null);
  };

  const submitDeposit = async () => {
    if (!depositFor) return;
    const a = Number(amount);
    if (!a || a <= 0) return setErr("Enter a valid amount.");
    if (reference.trim().length < 3) return setErr("Reference must be at least 3 characters.");
    if (reason.trim().length < 3) return setErr("A reason is required for the audit trail.");
    setSaving(true);
    setErr(null);
    try {
      const resp = await api.post<{ duplicate: boolean }>(
        `/admin/drivers/${depositFor.driver_id}/cash-deposit`,
        { amount: a, reference: reference.trim(), reason: reason.trim() },
      );
      setToast(resp.duplicate ? "Already recorded (same reference)." : `Recorded ${fmtINR(a)}.`);
      setTimeout(() => setToast(null), 2500);
      setDepositFor(null);
      await load();
    } catch (e: any) {
      setErr(String(e?.body?.detail ?? "Could not record the deposit."));
    } finally {
      setSaving(false);
    }
  };

  const rows = (data?.items ?? []).filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return (r.name ?? "").toLowerCase().includes(s) || (r.phone ?? "").toLowerCase().includes(s);
  });
  const t = data?.totals;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Cash reconciliation</h1>
          <div className="sub">
            Collected vs paid in · as of {data?.as_of_business_date ?? "—"} · limit{" "}
            {data ? fmtINR(data.cash_limit) : "—"}
          </div>
        </div>
        <input
          placeholder="Filter by driver / phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>

      {t ? (
        <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
          <Stat label="Outstanding (fleet)" value={fmtINR(t.owed)} tone={t.owed > 0 ? "alert" : "ok"} />
          <Stat label="Over limit" value={String(t.over_limit)} tone={t.over_limit > 0 ? "alert" : "ok"} />
          <Stat label="Paid in today" value={fmtINR(t.paid_in_today)} />
          <Stat label="Collected (to yest.)" value={fmtINR(t.collected_to_yesterday)} />
        </div>
      ) : null}

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Driver</th><th>Hub</th>
              <th style={{ textAlign: "right" }}>Collected</th>
              <th style={{ textAlign: "right" }}>Paid in</th>
              <th style={{ textAlign: "right" }}>Balance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">No drivers.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.driver_id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.name ?? r.driver_id.slice(0, 8)}</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{r.phone}</div>
                </td>
                <td>{r.hub_name ?? "—"}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtINR(r.collected_to_yesterday)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtINR(r.paid_in_total)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>
                  {r.in_credit > 0 ? (
                    <span style={{ color: "var(--live, #16a34a)" }}>+{fmtINR(r.in_credit)}</span>
                  ) : (
                    <span style={{ color: r.over_limit ? "var(--alert)" : "inherit" }}>{fmtINR(r.you_owe)}</span>
                  )}
                  {r.over_limit ? <span className="tag alert" style={{ marginLeft: 6 }}>OVER</span> : null}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button className="ghost" onClick={() => openDeposit(r)}>Record deposit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {depositFor ? (
        <div className="modal-backdrop" onClick={() => setDepositFor(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "90vw" }}>
            <h2 style={{ marginTop: 0 }}>Record cash — {depositFor.name}</h2>
            <div className="sub" style={{ marginBottom: 14 }}>
              Currently owes {fmtINR(depositFor.you_owe)}
            </div>
            <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <label>Amount (₹) *
                <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1500" />
              </label>
              <label>Reference * (receipt / slip no — also the dedup key)
                <input value={reference} onChange={(e) => setReference(e.target.value)} />
              </label>
              <label>Reason *
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </div>
            {err ? <div className="err">{err}</div> : null}
            <div className="form-actions">
              <button className="ghost" onClick={() => setDepositFor(null)} disabled={saving}>Cancel</button>
              <button className="primary" onClick={submitDeposit} disabled={saving}>{saving ? "Saving…" : "Record deposit"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--ink)", color: "#fff", padding: "12px 18px", borderRadius: 8, boxShadow: "var(--shadow)" }}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "alert" | "ok" }) => (
  <div className="card" style={{ padding: 14 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: tone === "alert" ? "var(--alert)" : "var(--ink)" }}>{value}</div>
  </div>
);
