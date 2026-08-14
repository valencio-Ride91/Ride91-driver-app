// Dashboard: 4 tiles hitting /admin/summary.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, AdminSummary } from "../api";

export default function Dashboard() {
  const [s, setS] = useState<AdminSummary | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<AdminSummary>("/admin/summary");
        if (alive) setS(r);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="sub">Live snapshot for business day {s?.business_date ?? "—"}. Refreshes every 15 s.</div>
      <div className="tiles">
        <Link to="/drivers" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="tile">
            <div className="kicker">Total drivers</div>
            <div className="value">{loading ? "—" : s?.total_drivers ?? 0}</div>
          </div>
        </Link>
        <Link to="/live-map" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="tile">
            <div className="kicker">On duty now</div>
            <div className="value">{loading ? "—" : s?.on_duty_now ?? 0}</div>
            <span className="tag ok">Live map →</span>
          </div>
        </Link>
        <Link to="/review/captures" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="tile">
            <div className="kicker">Captures to review</div>
            <div className="value" style={{ color: (s?.captures_pending ?? 0) > 0 ? "var(--alert)" : undefined }}>
              {loading ? "—" : s?.captures_pending ?? 0}
            </div>
            <span className={"tag " + ((s?.captures_pending ?? 0) > 0 ? "alert" : "ok")}>
              {(s?.captures_pending ?? 0) > 0 ? "Action needed" : "All clear"}
            </span>
          </div>
        </Link>
        <Link to="/review/documents" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="tile">
            <div className="kicker">Documents to verify</div>
            <div className="value" style={{ color: (s?.documents_pending ?? 0) > 0 ? "var(--amber)" : undefined }}>
              {loading ? "—" : s?.documents_pending ?? 0}
            </div>
            <span className={"tag " + ((s?.documents_pending ?? 0) > 0 ? "warn" : "ok")}>
              {(s?.documents_pending ?? 0) > 0 ? "Pending" : "Cleared"}
            </span>
          </div>
        </Link>
      </div>
    </div>
  );
}
