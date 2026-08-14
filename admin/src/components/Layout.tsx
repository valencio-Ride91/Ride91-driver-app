// Persistent shell with sidebar nav. Wraps every authed page.

import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { AdminIdentity, logout } from "../auth";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/drivers", label: "Drivers" },
  { to: "/live-map", label: "Live map" },
  { to: "/review/captures", label: "Capture reviews" },
  { to: "/review/documents", label: "Document reviews" },
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
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.label}
          </NavLink>
        ))}
        <div className="footer">
          <div>Signed in as</div>
          <div style={{ color: "#fff", fontWeight: 600, marginTop: 4 }}>{admin.username}</div>
          <button onClick={doLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
