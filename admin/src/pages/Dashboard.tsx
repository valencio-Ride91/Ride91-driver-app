// Dashboard: Ride91 operating picture — duty, the cash loop, fleet, and
// bookings — plus 30-day trend charts. Metrics are for an employer-operator,
// not a commission marketplace: no admin-commission / wallet / franchise.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, DashboardData } from "../api";
import { AreaChart, BarPairChart } from "../components/Charts";

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const dayLabel = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

function Kpi({
  label,
  value,
  sub,
  tone,
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "alert" | "amber";
  to?: string;
}) {
  const body = (
    <div className="tile">
      <div className="kicker">{label}</div>
      <div
        className="value"
        style={{
          color:
            tone === "alert" ? "var(--alert)" : tone === "amber" ? "var(--amber)" : undefined,
        }}
      >
        {value}
      </div>
      {sub ? <span className={"tag " + (tone === "alert" ? "alert" : "ok")}>{sub}</span> : null}
    </div>
  );
  return to ? (
    <Link to={to} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    body
  );
}

export default function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<DashboardData>("/admin/dashboard");
        if (alive) setD(r);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const c = d?.cards;
  const dash = loading ? "—" : "0";
  const grossPts = (d?.series ?? []).map((s) => ({ label: dayLabel(s.date), value: s.gross }));
  const cashDepPts = (d?.series ?? []).map((s) => ({
    label: dayLabel(s.date),
    a: s.cash,
    b: s.deposited,
  }));

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="sub">Business day {d?.business_date ?? "—"} · refreshes every 20 s</div>

      {/* Fleet & duty */}
      <div className="tiles">
        <Kpi
          label="Drivers"
          value={c ? String(c.total_drivers) : dash}
          sub={c ? `${c.approved_drivers} approved` : undefined}
          to="/drivers"
        />
        <Kpi
          label="Waiting for approval"
          value={c ? String(c.drivers_waiting) : dash}
          tone={c && c.drivers_waiting > 0 ? "amber" : undefined}
          to="/drivers"
        />
        <Kpi label="On duty now" value={c ? String(c.on_duty_now) : dash} sub="Live map →" to="/live-map" />
        <Kpi label="Vehicles" value={c ? String(c.total_vehicles) : dash} />
      </div>

      {/* Cash loop */}
      <h2 style={{ marginTop: 24 }}>Cash</h2>
      <div className="tiles">
        <Kpi
          label="Owed by drivers"
          value={c ? inr(c.cash_owed) : dash}
          tone={c && c.cash_owed > 0 ? "alert" : "ok"}
          to="/drivers"
        />
        <Kpi
          label="Over limit"
          value={c ? String(c.over_limit) : dash}
          tone={c && c.over_limit > 0 ? "alert" : "ok"}
          sub={c && c.over_limit > 0 ? "Action needed" : "All clear"}
          to="/drivers"
        />
        <Kpi label="Paid in today" value={c ? inr(c.paid_today) : dash} tone="ok" />
        <Kpi label="Collected (settled)" value={c ? inr(c.collected_all) : dash} />
      </div>

      {/* Bookings */}
      <h2 style={{ marginTop: 24 }}>Bookings</h2>
      <div className="tiles">
        <Kpi label="Open bookings" value={d ? String(d.bookings.open) : dash} to="/bookings" />
        <Kpi label="Booked today" value={d ? String(d.bookings.today) : dash} to="/bookings" />
        <Kpi label="Scheduled ahead" value={d ? String(d.bookings.scheduled_ahead) : dash} to="/bookings" />
        <Kpi label="Total bookings" value={d ? String(d.bookings.total) : dash} to="/bookings" />
      </div>

      {/* Trends */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="kicker">Gross earnings per day (settled, last 30 days)</div>
        <AreaChart points={grossPts} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="kicker">
          Cash collected vs deposited per day —{" "}
          <span style={{ color: "var(--live)" }}>collected</span> /{" "}
          <span style={{ color: "var(--amber)" }}>deposited</span>
        </div>
        <BarPairChart points={cashDepPts} />
      </div>
    </div>
  );
}
