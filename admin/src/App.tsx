// Root App: routes + auth bootstrap.

import { useEffect, useState } from "react";
import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Bookings from "./pages/Bookings";
import Drivers from "./pages/Drivers";
import LiveMap from "./pages/LiveMap";
import Captures from "./pages/Captures";
import Documents from "./pages/Documents";
import Payouts from "./pages/Payouts";
import Cash from "./pages/Cash";
import Requests from "./pages/Requests";
import Inspections from "./pages/Inspections";
import ShiftAlarms from "./pages/ShiftAlarms";
import DriverDetail from "./pages/DriverDetail";
import Vehicles from "./pages/Vehicles";
import Hubs from "./pages/Hubs";
import Rewards from "./pages/Rewards";
import Loyalty from "./pages/Loyalty";
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import Audit from "./pages/Audit";

import { AdminIdentity, me } from "./auth";

// Fleet-wide pages: a scoped hub_manager is bounced to their drivers list.
function Fleet({ admin, children }: { admin: AdminIdentity; children: JSX.Element }) {
  if (admin.role === "hub_manager") return <Navigate to="/drivers" replace />;
  return children;
}

export default function App() {
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    me()
      .then((a) => setAdmin(a))
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return <div style={{ padding: 40, color: "var(--muted)" }}>Loading…</div>;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={admin ? <Navigate to="/" replace /> : <Login onLogin={setAdmin} />}
        />
        {admin ? (
          <Route element={<Layout admin={admin} onLogout={() => setAdmin(null)} />}>
            {/* A hub_manager is scoped to their hub's drivers/cars/hubs/rewards.
                Fleet-wide pages redirect them to /drivers (matching the backend
                fleet_admin gate, so a typed URL can't reach fleet data). */}
            <Route path="/" element={<Fleet admin={admin}><Dashboard /></Fleet>} />
            <Route path="/bookings" element={<Fleet admin={admin}><Bookings /></Fleet>} />
            <Route path="/drivers" element={<Drivers />} />
            <Route path="/drivers/:id" element={<DriverDetail />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/hubs" element={<Hubs />} />
            <Route path="/cash" element={<Fleet admin={admin}><Cash /></Fleet>} />
            <Route path="/rewards" element={<Rewards />} />
            <Route path="/loyalty" element={<Loyalty />} />
            <Route path="/requests" element={<Fleet admin={admin}><Requests /></Fleet>} />
            <Route path="/live-map" element={<Fleet admin={admin}><LiveMap /></Fleet>} />
            <Route path="/review/captures" element={<Fleet admin={admin}><Captures /></Fleet>} />
            <Route path="/review/documents" element={<Fleet admin={admin}><Documents /></Fleet>} />
            <Route path="/review/inspections" element={<Fleet admin={admin}><Inspections /></Fleet>} />
            <Route path="/shift-alarms" element={<Fleet admin={admin}><ShiftAlarms /></Fleet>} />
            <Route path="/payouts" element={<Fleet admin={admin}><Payouts /></Fleet>} />
            <Route path="/audit" element={<Fleet admin={admin}><Audit /></Fleet>} />
            <Route path="/settings" element={<Fleet admin={admin}><Settings admin={admin} /></Fleet>} />
            {admin.role === "owner" ? <Route path="/users" element={<Users admin={admin} />} /> : null}
            <Route path="*" element={<Navigate to={admin.role === "hub_manager" ? "/drivers" : "/"} replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
