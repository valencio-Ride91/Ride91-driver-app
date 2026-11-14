// Referrals — who referred whom, and what each link has earned. A referrer
// earns a share of the referred driver's fares on every day those fares reach
// the daily minimum; each month is paid into the referrer's salary from the
// pay day of the next month. Hub managers see the links that touch their hub.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ReferralsResponse } from "../api";

function fmtINR(n: number | null | undefined) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthLabel(ym: string) {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}
function dayLabel(d: string | null | undefined) {
  if (!d) return "—";
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(0, 4)}`;
}
function shiftMonth(ym: string, by: number) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

export default function Referrals() {
  const [month, setMonth] = useState<string | null>(null);   // null = the current month
  const [data, setData] = useState<ReferralsResponse | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<ReferralsResponse>(`/admin/referrals${month ? `?month=${month}` : ""}`);
      setData(d);
      if (!month) setCurrent(d.month);
      setErr(null);
    } catch {
      setErr("Could not load referrals.");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const shown = data?.month ?? month ?? "";
  const atCurrent = !!current && shown >= current;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Referrals</h1>
          <div className="sub">
            {data ? (
              data.enabled
                ? <>A referrer earns {Math.round(data.rate * 1000) / 10}% of a referred driver's fares on every day they reach {fmtINR(data.daily_min)}. Paid into salary from {dayLabel(data.pay_date)}.</>
                : <>Referrals are switched off in Settings. Nothing is being earned or paid.</>
            ) : "—"}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button className="ghost" data-testid="ref-prev" onClick={() => setMonth(shiftMonth(shown, -1))} disabled={!shown}>‹</button>
        <strong data-testid="ref-month" style={{ minWidth: 140, textAlign: "center" }}>{shown ? monthLabel(shown) : "—"}</strong>
        <button className="ghost" data-testid="ref-next" onClick={() => setMonth(shiftMonth(shown, 1))} disabled={!shown || atCurrent}>›</button>
        <span style={{ flex: 1 }} />
        <span className="tag muted" style={{ fontSize: 13 }}>This month: <strong>{fmtINR(data?.totals.month_amount)}</strong></span>
        <span className="tag muted" style={{ fontSize: 13 }}>Paid so far, all time: <strong>{fmtINR(data?.totals.lifetime_paid)}</strong></span>
      </div>

      {err ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      {loading ? (
        <div className="card"><div className="empty">Loading…</div></div>
      ) : !data || data.rows.length === 0 ? (
        <div className="card"><div className="empty">No referrals yet. Pick "Referred by" when adding a driver.</div></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="data" data-testid="ref-table">
            <thead>
              <tr>
                <th>Referrer</th>
                <th>Referred driver</th>
                <th>Since</th>
                <th style={{ textAlign: "right" }}>{monthLabel(data.month)}</th>
                <th>Paid?</th>
                <th style={{ textAlign: "right" }}>Paid, all time</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={`${r.referrer.id}-${r.referred.id}-${r.since}-${i}`}>
                  <td>
                    <Link to={`/drivers/${r.referrer.id}`}>{r.referrer.name ?? "—"}</Link>
                    <div className="muted-sm">{r.referrer.hub_name ?? "No hub"}{r.referrer.removed ? " · removed" : ""}</div>
                  </td>
                  <td>
                    <Link to={`/drivers/${r.referred.id}`}>{r.referred.name ?? "—"}</Link>
                    <div className="muted-sm">{r.referred.hub_name ?? "No hub"}{r.referred.removed ? " · removed" : ""}</div>
                  </td>
                  <td>
                    {dayLabel(r.since)}
                    {r.until ? <div className="muted-sm">ended {dayLabel(r.until)}</div> : null}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <strong>{fmtINR(r.month_amount)}</strong>
                    <div className="muted-sm">{r.month_days === 1 ? "1 day" : `${r.month_days} days`}</div>
                  </td>
                  <td>
                    {r.month_paid
                      ? <span className="tag ok">Paid</span>
                      : <span className="tag muted">On {dayLabel(data.pay_date)}</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>{fmtINR(r.lifetime_paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted-sm" style={{ marginTop: 12 }}>
        A day counts once all its fares are in. Paid months are locked: a correction after the pay day is not paid.
        Days whose fares arrive after their month was paid are paid with the next month.
        Only the owner can change a driver's referrer, from the driver's page.
      </div>
    </div>
  );
}
