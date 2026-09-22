// Earnings + weekly reward leaderboard. Ops uses this to see each driver's
// gross/earnings and who qualifies for (and is leading) the weekly rewards.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, RewardsResponse, downloadCsv } from "../api";

function fmtINR(n: number) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default function Rewards() {
  const [data, setData] = useState<RewardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.get<RewardsResponse>("/admin/rewards"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const rows = (data?.items ?? []).filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return (r.name ?? "").toLowerCase().includes(s) || (r.phone ?? "").toLowerCase().includes(s);
  });
  const th = data?.thresholds;
  const leadersByHub = data?.leaders_by_hub ?? {};
  const leaderFor = (hubId: string | null) => (hubId ? leadersByHub[hubId] : undefined);

  const exportCsv = () => downloadCsv(
    `ride91-rewards-${data?.week_start ?? ""}.csv`,
    ["Driver", "Phone", "Hub", "Yesterday gross", "Week gross", "Driver earnings (30%)", "Days", "Daily ✓", "Car-week ✓", "Driver-week ✓"],
    rows.map((r) => [r.name ?? "", r.phone ?? "", r.hub_name ?? "", r.yesterday_gross, r.week_gross, r.driver_earnings, r.days_operated, r.q_daily ? "yes" : "", r.q_car_week ? "yes" : "", r.q_driver_week ? "yes" : ""]),
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Earnings &amp; rewards</h1>
          <div className="sub">
            Week of {data?.week_start ?? "—"} · {data?.days_remaining ?? 0} days to payout · driver share {Math.round((data?.share_rate ?? 0.3) * 100)}%
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Filter driver / phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
          <button className="ghost" onClick={exportCsv} disabled={rows.length === 0}>Export</button>
        </div>
      </div>

      {th ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
          <RewardCard title="🏆 Top car of the day" target={`${fmtINR(th.daily_target)} gross`} reward={th.top_car_day} />
          <RewardCard title="🏆 Top car of the week" target={`${fmtINR(th.week_car_target)} gross · all ${th.days_required} days`} reward={th.top_car_week} />
          <RewardCard title="🏆 Top driver of the week" target={`${fmtINR(th.week_driver_target)} earnings`} reward={th.top_driver_week} />
        </div>
      ) : null}

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Driver</th><th>Hub</th>
              <th style={{ textAlign: "right" }}>Yesterday</th>
              <th style={{ textAlign: "right" }}>Week gross</th>
              <th style={{ textAlign: "right" }}>Earnings (30%)</th>
              <th style={{ textAlign: "center" }}>Days</th>
              <th style={{ textAlign: "center" }}>Rewards</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="empty">No drivers.</td></tr>
            ) : rows.map((r) => {
              const L = leaderFor(r.hub_id);
              return (
              <tr key={r.driver_id}>
                <td>
                  <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name ?? r.driver_id.slice(0, 8)}</Link>
                  <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{r.phone}</div>
                </td>
                <td>{r.hub_name ?? <span className="muted-sm">no hub</span>}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                  {fmtINR(r.yesterday_gross)}
                  {L?.top_car_day === r.driver_id ? <span className="tag live" style={{ marginLeft: 6 }}>DAY</span> : null}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{fmtINR(r.week_gross)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtINR(r.driver_earnings)}</td>
                <td style={{ textAlign: "center" }}>
                  <span className={r.days_operated >= (th?.days_required ?? 7) ? "tag live" : "tag muted"}>{r.days_operated}/{th?.days_required ?? 7}</span>
                </td>
                <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                  {r.q_daily ? <span className="tag ok" title="Hit daily target" style={{ marginRight: 4 }}>D</span> : null}
                  {r.q_car_week ? <span className={`tag ${L?.top_car_week === r.driver_id ? "live" : "ok"}`} title="Qualifies: top car of week (in hub)" style={{ marginRight: 4 }}>{L?.top_car_week === r.driver_id ? "★CAR" : "CAR"}</span> : null}
                  {r.q_driver_week ? <span className={`tag ${L?.top_driver_week === r.driver_id ? "live" : "ok"}`} title="Qualifies: top driver of week (in hub)">{L?.top_driver_week === r.driver_id ? "★DRV" : "DRV"}</span> : null}
                  {!r.q_daily && !r.q_car_week && !r.q_driver_week ? <span className="muted-sm">—</span> : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted-sm" style={{ marginTop: 10 }}>
        ★ = current leader <strong>within that hub</strong> · CAR/DRV = qualifies for that weekly reward · D = hit yesterday's daily target. Rewards are decided per hub and are additional to the 30% share.
      </div>
    </div>
  );
}

const RewardCard = ({ title, target, reward }: { title: string; target: string; reward: number }) => (
  <div className="card" style={{ padding: 14 }}>
    <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
    <div className="muted-sm" style={{ marginTop: 2 }}>{target}</div>
    <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6, color: "var(--live, #16a34a)" }}>+₹{reward.toLocaleString("en-IN")}</div>
  </div>
);
