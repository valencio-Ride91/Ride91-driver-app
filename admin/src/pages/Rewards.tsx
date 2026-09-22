// Earnings & rewards — grouped by hub. Each hub shows a CARS board (day+night
// gross combined → top car of day/week) and a DRIVERS board (individual gross →
// top driver of week). ★ marks the current leader within that hub; ops pays them.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, RewardsResponse, RewardHub } from "../api";

function fmtINR(n: number) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default function Rewards() {
  const [data, setData] = useState<RewardsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<RewardsResponse>("/admin/rewards"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);

  const th = data?.thresholds;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Earnings &amp; rewards</h1>
          <div className="sub">Week of {data?.week_start ?? "—"} · {data?.days_remaining ?? 0} days to payout · rewards decided per hub, on top of the 30% share</div>
        </div>
      </div>

      {th ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
          <RewardCard title="🏆 Top car of the day" target={`car ≥ ${fmtINR(th.daily_target)} gross`} reward={th.top_car_day} />
          <RewardCard title="🏆 Top car of the week" target={`car ≥ ${fmtINR(th.week_car_target)} · all ${th.days_required} days`} reward={th.top_car_week} />
          <RewardCard title="🏆 Top driver of the week" target={`driver ≥ ${fmtINR(th.week_driver_target)} gross`} reward={th.top_driver_week} />
        </div>
      ) : null}

      {loading ? (
        <div className="card"><div className="empty">Loading…</div></div>
      ) : (data?.hubs ?? []).length === 0 ? (
        <div className="card"><div className="empty">No hubs with earnings yet.</div></div>
      ) : (
        data!.hubs.map((hub) => <HubBlock key={hub.hub_id ?? "none"} hub={hub} daysReq={th?.days_required ?? 7} />)
      )}

      <div className="muted-sm" style={{ marginTop: 12 }}>
        ★ = current leader in that hub. A car's gross combines its day + night drivers. Top driver is measured on the driver's own gross. Rewards are additional to the 30% share and paid by ops.
      </div>
    </div>
  );
}

function HubBlock({ hub, daysReq }: { hub: RewardHub; daysReq: number }) {
  const [tab, setTab] = useState<"cars" | "drivers">("cars");
  return (
    <div className="card" style={{ marginBottom: 20, padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          {hub.hub_name ?? "No hub"}
          <span className="muted-sm" style={{ marginLeft: 8 }}>{hub.cars.length} car{hub.cars.length === 1 ? "" : "s"} · {hub.drivers.length} driver{hub.drivers.length === 1 ? "" : "s"}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className={tab === "cars" ? "primary" : "ghost"} onClick={() => setTab("cars")}>Cars</button>
          <button className={tab === "drivers" ? "primary" : "ghost"} onClick={() => setTab("drivers")}>Drivers</button>
        </div>
      </div>

      {tab === "cars" ? (
        <table className="data">
          <thead><tr><th>Car</th><th>Drivers (day / night)</th><th style={{ textAlign: "right" }}>Yesterday</th><th style={{ textAlign: "right" }}>Week gross</th><th style={{ textAlign: "center" }}>Days</th><th style={{ textAlign: "center" }}>Reward</th></tr></thead>
          <tbody>
            {hub.cars.length === 0 ? <tr><td colSpan={6} className="empty">No cars.</td></tr> : hub.cars.map((c) => (
              <tr key={c.vehicle_id}>
                <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{c.number ?? c.vehicle_id.slice(0, 8)}</td>
                <td>
                  {c.drivers.length === 0 ? <span className="muted-sm">—</span> : c.drivers.map((d) => (
                    <span key={d.driver_id} style={{ marginRight: 8 }}>
                      <Link to={`/drivers/${d.driver_id}`} style={{ color: "var(--ink)" }}>{d.name}</Link>
                      <span className="muted-sm"> ({d.shift})</span>
                    </span>
                  ))}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                  {fmtINR(c.yesterday_gross)}
                  {c.is_top_car_day ? <span className="tag live" style={{ marginLeft: 6 }}>★DAY</span> : null}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {fmtINR(c.week_gross)}
                  {c.is_top_car_week ? <span className="tag live" style={{ marginLeft: 6 }}>★WEEK</span> : null}
                </td>
                <td style={{ textAlign: "center" }}><span className={c.days_operated >= daysReq ? "tag live" : "tag muted"}>{c.days_operated}/{daysReq}</span></td>
                <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                  {c.q_car_day ? <span className="tag ok" style={{ marginRight: 4 }} title="Cleared daily target">DAY</span> : null}
                  {c.q_car_week ? <span className="tag ok" title="Qualifies: top car of week">WEEK</span> : null}
                  {!c.q_car_day && !c.q_car_week ? <span className="muted-sm">—</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="data">
          <thead><tr><th>Driver</th><th>Shift</th><th style={{ textAlign: "right" }}>Yesterday</th><th style={{ textAlign: "right" }}>Week gross</th><th style={{ textAlign: "center" }}>Days</th><th style={{ textAlign: "center" }}>Reward</th></tr></thead>
          <tbody>
            {hub.drivers.length === 0 ? <tr><td colSpan={6} className="empty">No drivers.</td></tr> : hub.drivers.map((d) => (
              <tr key={d.driver_id}>
                <td>
                  <Link to={`/drivers/${d.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{d.name ?? d.driver_id.slice(0, 8)}</Link>
                  <div style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 12 }}>{d.phone}</div>
                </td>
                <td>{d.shift}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{fmtINR(d.yesterday_gross)}</td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {fmtINR(d.week_gross)}
                  {d.is_top_driver_week ? <span className="tag live" style={{ marginLeft: 6 }}>★TOP</span> : null}
                </td>
                <td style={{ textAlign: "center" }}><span className="tag muted">{d.days_operated}/{daysReq}</span></td>
                <td style={{ textAlign: "center" }}>{d.q_driver_week ? <span className="tag ok" title="Qualifies: top driver of week">DRV</span> : <span className="muted-sm">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
