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
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import Audit from "./pages/Audit";

import { AdminIdentity, me } from "./auth";

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
            <Route path="/" element={<Dashboard />} />
            <Route path="/bookings" element={<Bookings />} />
            <Route path="/drivers" element={<Drivers />} />
            <Route path="/drivers/:id" element={<DriverDetail />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/hubs" element={<Hubs />} />
            <Route path="/cash" element={<Cash />} />
            <Route path="/rewards" element={<Rewards />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/live-map" element={<LiveMap />} />
            <Route path="/review/captures" element={<Captures />} />
            <Route path="/review/documents" element={<Documents />} />
            <Route path="/review/inspections" element={<Inspections />} />
            <Route path="/shift-alarms" element={<ShiftAlarms />} />
            <Route path="/payouts" element={<Payouts />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings admin={admin} />} />
            {admin.role === "owner" ? <Route path="/users" element={<Users admin={admin} />} /> : null}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
