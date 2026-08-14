// Root App: routes + auth bootstrap.

import { useEffect, useState } from "react";
import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Drivers from "./pages/Drivers";
import LiveMap from "./pages/LiveMap";
import Captures from "./pages/Captures";
import Documents from "./pages/Documents";

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
            <Route path="/drivers" element={<Drivers />} />
            <Route path="/live-map" element={<LiveMap />} />
            <Route path="/review/captures" element={<Captures />} />
            <Route path="/review/documents" element={<Documents />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  );
}
