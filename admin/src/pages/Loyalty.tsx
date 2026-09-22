// Loyalty & yearly — grouped by hub. Each hub shows a YEARLY board (top driver
// + top car of the year on cumulative gross, ★ = leader) and a LOYALTY roster
// (each driver's tenure, next milestone, and vested total). Amounts are paid
// manually by ops; this screen decides who.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, LoyaltyResponse, LoyaltyHub } from "../api";

function fmtINR(n: number) {
  return `₹${(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
function fmtTenure(days: number | null) {
  if (days == null) return "—";
  if (days < 60) return `${days}d`;
  const mo = Math.floor(days / 30);
  if (days < 365) return `${mo}mo`;
  const y = Math.floor(days / 365);
  const rem = Math.floor((days % 365) / 30);
  return rem ? `${y}y ${rem}mo` : `${y}y`;
}

export default function Loyalty() {
  const [data, setData] = useState<LoyaltyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<LoyaltyResponse>("/admin/loyalty"));
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
          <h1>Loyalty &amp; yearly</h1>
          <div className="sub">Year {data?.year ?? "—"} · loyalty vests only while active (leave = forfeit) · paid by ops</div>
        </div>
      </div>

      {th ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 16 }}>
          <RewardCard title="🏆 Top driver of the year" target="highest driver gross in the hub" reward={th.top_driver_year} />
          <RewardCard title="🏆 Top car of the year" target="highest combined car gross in the hub" reward={th.top_car_year} />
        </div>
      ) : null}

      {data?.milestones ? (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Loyalty milestones (tenure)</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {data.milestones.map((m) => (
              <span key={m.key} className="tag muted" style={{ fontSize: 13 }}>
                {m.label} → <strong>{fmtINR(m.reward)}</strong>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="card"><div className="empty">Loading…</div></div>
      ) : (data?.hubs ?? []).length === 0 ? (
        <div className="card"><div className="empty">No hubs with drivers yet.</div></div>
      ) : (
        data!.hubs.map((hub) => <HubBlock key={hub.hub_id ?? "none"} hub={hub} />)
      )}

      <div className="muted-sm" style={{ marginTop: 12 }}>
        ★ = current year leader in that hub. Vested = loyalty milestones the driver has reached while active (claimable). A driver who leaves forfeits milestones not yet reached.
      </div>
    </div>
  );
}

function HubBlock({ hub }: { hub: LoyaltyHub }) {
  const [tab, setTab] = useState<"drivers" | "cars">("drivers");
  return (
    <div className="card" style={{ marginBottom: 20, padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          {hub.hub_name ?? "No hub"}
          <span className="muted-sm" style={{ marginLeft: 8 }}>{hub.drivers.length} driver{hub.drivers.length === 1 ? "" : "s"} · {hub.cars.length} car{hub.cars.length === 1 ? "" : "s"}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className={tab === "drivers" ? "primary" : "ghost"} onClick={() => setTab("drivers")}>Drivers</button>
          <button className={tab === "cars" ? "primary" : "ghost"} onClick={() => setTab("cars")}>Cars</button>
        </div>
      </div>

      {tab === "drivers" ? (
        <table className="data">
          <thead><tr><th>Driver</th><th>Tenure</th><th>Next milestone</th><th style={{ textAlign: "right" }}>Vested</th><th style={{ textAlign: "right" }}>Year gross</th></tr></thead>
          <tbody>
            {hub.drivers.length === 0 ? <tr><td colSpan={5} className="empty">No drivers.</td></tr> : hub.drivers.map((d) => (
              <tr key={d.driver_id}>
                <td>
                  <Link to={`/drivers/${d.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{d.name ?? d.driver_id.slice(0, 8)}</Link>
                  <span className="muted-sm"> ({d.shift})</span>
                </td>
                <td>{fmtTenure(d.tenure_days)}</td>
                <td>
                  {d.next_milestone ? (
                    <span className="muted-sm">{d.next_milestone.label} · {d.next_milestone.days_remaining}d left · {fmtINR(d.next_milestone.reward)}</span>
                  ) : <span className="tag ok">all reached</span>}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {d.vested_total > 0 ? fmtINR(d.vested_total) : <span className="muted-sm">—</span>}
                </td>
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                  {fmtINR(d.year_gross)}
                  {d.is_top_driver_year ? <span className="tag live" style={{ marginLeft: 6 }}>★YEAR</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="data">
          <thead><tr><th>Car</th><th>Drivers (day / night)</th><th style={{ textAlign: "right" }}>Year gross</th></tr></thead>
          <tbody>
            {hub.cars.length === 0 ? <tr><td colSpan={3} className="empty">No cars.</td></tr> : hub.cars.map((c) => (
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
                <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {fmtINR(c.year_gross)}
                  {c.is_top_car_year ? <span className="tag live" style={{ marginLeft: 6 }}>★YEAR</span> : null}
                </td>
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
