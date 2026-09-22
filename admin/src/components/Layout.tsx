// Persistent shell with sidebar nav. Wraps every authed page.

import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { AdminIdentity, logout } from "../auth";

// `hub` marks the pages a scoped hub_manager may see (their hub's drivers,
// cars, and reward standings). Everyone else (viewer/manager/owner) sees all
// non-owner items; owner adds Admin accounts.
const NAV: { to: string; label: string; end?: boolean; ownerOnly?: boolean; hub?: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/bookings", label: "Bookings" },
  { to: "/drivers", label: "Drivers", hub: true },
  { to: "/vehicles", label: "Vehicles", hub: true },
  { to: "/hubs", label: "Hubs", hub: true },
  { to: "/cash", label: "Cash" },
  { to: "/rewards", label: "Earnings & rewards", hub: true },
  { to: "/requests", label: "Requests" },
  { to: "/live-map", label: "Live map" },
  { to: "/review/captures", label: "Capture reviews" },
  { to: "/review/documents", label: "Document reviews" },
  { to: "/review/inspections", label: "Inspections" },
  { to: "/shift-alarms", label: "Shift alarms" },
  { to: "/payouts", label: "Payouts" },
  { to: "/audit", label: "Audit log" },
  { to: "/users", label: "Admin accounts", ownerOnly: true },
  { to: "/settings", label: "Settings" },
];

interface Props {
  admin: AdminIdentity;
  onLogout: () => void;
}

export default function Layout({ admin, onLogout }: Props) {
  const nav = useNavigate();
  const doLogout = async () => {
    await logout();
    onLogout();
    nav("/login", { replace: true });
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" />
          Ride91 · Ops
        </div>
        {NAV.filter((n) => {
          if (admin.role === "hub_manager") return n.hub;   // scoped to their hub's pages
          return !n.ownerOnly || admin.role === "owner";
        }).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.label}
          </NavLink>
        ))}
        <div className="footer">
          <div>Signed in as</div>
          <div style={{ color: "#fff", fontWeight: 600, marginTop: 4 }}>{admin.username}</div>
          <div className="muted-sm" style={{ color: "rgba(255,255,255,.5)" }}>
            {admin.role}{admin.role === "hub_manager" && admin.hub_name ? ` · ${admin.hub_name}` : ""}
          </div>
          <button onClick={doLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
