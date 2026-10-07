// Salary withdrawal requests — drivers ask to withdraw their salary from the
// app, and the hub pays or rejects each request here.
//
// Each pending row shows what the driver can be paid right now (their share of
// settled gross, less what has been paid, less the collection cash they still
// owe). The server re-checks that at the moment of payment, so a request that
// has since become unpayable is refused rather than overpaid.
//
// "Pay now" sends the money to the driver's saved bank / UPI through RazorpayX.
// "Mark paid" records a payment the hub made some other way (cash, own bank
// transfer) and needs a reference for the audit trail.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, WithdrawalRow, WithdrawalsResponse } from "../api";

function fmtINR(n: number) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

const ERRORS: Record<string, string> = {
  exceeds_available: "This is more than the driver can be paid right now (they may owe cash, or were paid since). Reject it or wait.",
  already_decided: "This request was already handled.",
  bank_account_not_saved: "The driver has not saved a bank account or UPI in the app. Use Mark paid if you pay another way.",
  razorpayx_not_configured: "RazorpayX payouts are not set up on the server. Use Mark paid if you pay another way.",
  reference_required: "A reference is required.",
};

export default function WithdrawalRequests({ hubId, onPaid }: { hubId?: string; onPaid?: () => void }) {
  const [data, setData] = useState<WithdrawalsResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<WithdrawalsResponse>(`/admin/withdrawals${hubId ? `?hub_id=${hubId}` : ""}`));
    } catch {
      // keep whatever we had; the next poll retries
    }
  }, [hubId]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); };

  const act = async (row: WithdrawalRow, path: "pay" | "reject", body: Record<string, unknown>, done: string) => {
    setBusyId(row.id); setErr(null);
    try {
      await api.post(`/admin/withdrawals/${row.id}/${path}`, body);
      flash(done);
      await load();
      if (path === "pay") onPaid?.();
    } catch (e: any) {
      const d = String(e?.body?.detail ?? "");
      setErr(ERRORS[d] ?? (d ? `Could not complete: ${d}` : "Could not complete the action."));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const who = (r: WithdrawalRow) => r.driver_name ?? r.driver_id.slice(0, 8);

  const payNow = (r: WithdrawalRow) => {
    const dest = r.bank_kind === "vpa" ? `UPI ${r.bank_masked}` : `bank account ${r.bank_masked}`;
    if (!window.confirm(`Send ${fmtINR(r.amount)} to ${who(r)} (${dest}) now?`)) return;
    act(r, "pay", { method: "razorpayx" }, `${fmtINR(r.amount)} sent to ${who(r)}.`);
  };
  const markPaid = (r: WithdrawalRow) => {
    const ref = window.prompt(`Record ${fmtINR(r.amount)} as paid to ${who(r)}.\nReference (receipt / UTR / "cash"):`, "");
    if (ref == null) return;
    if (ref.trim().length < 2) { setErr("A reference is required."); return; }
    act(r, "pay", { method: "manual", reference: ref.trim() }, `${fmtINR(r.amount)} recorded as paid to ${who(r)}.`);
  };
  const reject = (r: WithdrawalRow) => {
    const note = window.prompt(`Reject ${who(r)}'s request for ${fmtINR(r.amount)}?\nReason (the driver sees this):`, "");
    if (note == null) return;
    act(r, "reject", { decision: "reject", note: note.trim() || null }, "Request rejected.");
  };

  const pending = (data?.items ?? []).filter((r) => r.state === "pending");
  const decided = (data?.items ?? []).filter((r) => r.state !== "pending").slice(0, 10);

  return (
    <div className="card" style={{ padding: 0, marginBottom: 20 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>
          Salary withdrawal requests{" "}
          {pending.length ? <span className="tag amber">{pending.length} to pay</span> : <span className="tag muted">none waiting</span>}
        </div>
        {msg ? <span className="tag ok">{msg}</span> : null}
      </div>
      {err ? <div className="err" style={{ margin: 12 }}>{err}</div> : null}

      <table className="data">
        <thead>
          <tr>
            <th>Requested</th><th>Driver</th>
            <th style={{ textAlign: "right" }}>Asked for</th>
            <th style={{ textAlign: "right" }}>Payable now</th>
            <th style={{ textAlign: "right" }}>Cash owed</th>
            <th>Pay to</th><th></th>
          </tr>
        </thead>
        <tbody>
          {!data ? (
            <tr><td colSpan={7} className="empty">Loading…</td></tr>
          ) : pending.length === 0 ? (
            <tr><td colSpan={7} className="empty">No requests waiting. Drivers ask from the Earnings tab of the app.</td></tr>
          ) : pending.map((r) => {
            const short = r.payable_now != null && r.amount > r.payable_now + 0.005;
            const busy = busyId === r.id;
            return (
              <tr key={r.id}>
                <td>{fmtWhen(r.requested_at)}</td>
                <td>
                  <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{who(r)}</Link>
                  <div className="muted-sm" style={{ fontFamily: "ui-monospace, monospace" }}>{r.driver_phone}</div>
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{fmtINR(r.amount)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", color: short ? "var(--alert)" : "inherit" }}>
                  {r.payable_now != null ? fmtINR(r.payable_now) : "—"}
                  {short ? <div className="muted-sm" style={{ color: "var(--alert)" }}>less than asked</div> : null}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{r.cash_owed ? fmtINR(r.cash_owed) : "—"}</td>
                <td>
                  {r.bank_kind
                    ? <><div>{r.bank_kind === "vpa" ? "UPI" : "Bank"}</div><div className="muted-sm" style={{ fontFamily: "ui-monospace, monospace" }}>{r.bank_masked}</div></>
                    : <span className="muted-sm">not saved</span>}
                </td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  <button
                    className="primary"
                    onClick={() => payNow(r)}
                    disabled={busy || short || !r.bank_kind || !data.razorpayx_ready}
                    title={!data.razorpayx_ready ? "RazorpayX payouts are not set up on the server" : !r.bank_kind ? "Driver has not saved a bank account or UPI" : short ? "More than the driver can be paid right now" : ""}
                  >
                    {busy ? "…" : "Pay now"}
                  </button>{" "}
                  <button className="ghost" onClick={() => markPaid(r)} disabled={busy || short}>Mark paid</button>{" "}
                  <button className="ghost danger-ghost" onClick={() => reject(r)} disabled={busy}>Reject</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {decided.length ? (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <div className="muted-sm" style={{ padding: "10px 16px 0", fontWeight: 700 }}>Recently handled</div>
          <table className="data">
            <tbody>
              {decided.map((r) => (
                <tr key={r.id}>
                  <td>{fmtWhen(r.decided_at ?? r.requested_at)}</td>
                  <td style={{ fontWeight: 600 }}>{who(r)}</td>
                  <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtINR(r.amount)}</td>
                  <td>
                    {r.state === "paid"
                      ? <span className="tag live">paid{r.method === "manual" ? " · by hand" : ""}</span>
                      : <span className="tag alert">rejected</span>}
                  </td>
                  <td className="muted-sm">{r.reference ?? r.note ?? ""}</td>
                  <td className="muted-sm">{r.decided_by ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
