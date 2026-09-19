// Drivers: the fleet roster + onboarding. Ops can add a vehicle, add a
// driver (assigning a vehicle), and deactivate drivers.
import { useCallback, useEffect, useState } from "react";
import { api, DriverRow, VehicleRow } from "../api";

function pingAge(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function Drivers() {
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<"none" | "driver" | "vehicle">("none");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // driver form
  const [dName, setDName] = useState("");
  const [dPhone, setDPhone] = useState("+91");
  const [dVehicle, setDVehicle] = useState("");
  const [dHub, setDHub] = useState("");
  const [dShift, setDShift] = useState("day");
  // vehicle form
  const [vNumber, setVNumber] = useState("");
  const [vModel, setVModel] = useState("Citroën ëC3");

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        api.get<{ items: DriverRow[] }>("/admin/drivers"),
        api.get<{ items: VehicleRow[] }>("/admin/vehicles"),
      ]);
      setRows(d.items);
      setVehicles(v.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };

  const createVehicle = async () => {
    setErr(null);
    if (vNumber.trim().length < 3) return setErr("Enter a valid number plate.");
    setSaving(true);
    try {
      const v = await api.post<VehicleRow>("/admin/vehicles", {
        number: vNumber.trim(),
        model: vModel.trim() || "Citroën ëC3",
      });
      setVNumber("");
      await load();
      setPanel("driver");
      setDVehicle(v.id); // preselect the vehicle just created
      flash(`Vehicle ${v.number} added.`);
    } catch (e: any) {
      setErr(e?.body?.detail === "vehicle_number_exists" ? "That number plate already exists." : "Could not add vehicle.");
    } finally {
      setSaving(false);
    }
  };

  const createDriver = async () => {
    setErr(null);
    if (!dName.trim()) return setErr("Name is required.");
    if (dPhone.trim().length < 6) return setErr("Enter a valid phone number.");
    setSaving(true);
    try {
      await api.post("/admin/drivers", {
        name: dName.trim(),
        phone: dPhone.trim(),
        vehicle_id: dVehicle || null,
        hub_name: dHub.trim() || null,
        shift_type: dShift,
      });
      setDName("");
      setDPhone("+91");
      setDVehicle("");
      setDHub("");
      setPanel("none");
      await load();
      flash("Driver added.");
    } catch (e: any) {
      setErr(
        e?.body?.detail === "phone_already_registered"
          ? "A driver with that phone already exists."
          : "Could not add driver.",
      );
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (id: string, active: boolean) => {
    try {
      await api.patch(`/admin/drivers/${id}`, { active });
      await load();
    } catch {
      setErr("Could not update driver.");
    }
  };

  const freeVehicles = vehicles.filter((v) => !v.assigned);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Drivers</h1>
          <div className="sub">
            {rows.length} driver{rows.length === 1 ? "" : "s"} · {vehicles.length} vehicle
            {vehicles.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setPanel(panel === "vehicle" ? "none" : "vehicle"); setErr(null); }}>
            {panel === "vehicle" ? "Close" : "New vehicle"}
          </button>
          <button className="primary" onClick={() => { setPanel(panel === "driver" ? "none" : "driver"); setErr(null); }}>
            {panel === "driver" ? "Close" : "New driver"}
          </button>
        </div>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}

      {panel === "vehicle" ? (
        <div className="card onboard">
          <h2>Add vehicle</h2>
          <div className="form-grid">
            <label>Number plate *
              <input value={vNumber} onChange={(e) => setVNumber(e.target.value)} placeholder="KA-01-EV-0091" />
            </label>
            <label>Model
              <input value={vModel} onChange={(e) => setVModel(e.target.value)} />
            </label>
          </div>
          {err ? <div className="err">{err}</div> : null}
          <div className="form-actions">
            <button className="ghost" onClick={() => setPanel("none")} disabled={saving}>Cancel</button>
            <button className="primary" onClick={createVehicle} disabled={saving}>{saving ? "Saving…" : "Add vehicle"}</button>
          </div>
        </div>
      ) : null}

      {panel === "driver" ? (
        <div className="card onboard">
          <h2>Add driver</h2>
          <div className="form-grid">
            <label>Name *
              <input value={dName} onChange={(e) => setDName(e.target.value)} placeholder="Full name" />
            </label>
            <label>Phone * (login identity)
              <input value={dPhone} onChange={(e) => setDPhone(e.target.value)} placeholder="+9198…" />
            </label>
            <label>Vehicle
              <select value={dVehicle} onChange={(e) => setDVehicle(e.target.value)}>
                <option value="">Unassigned</option>
                {freeVehicles.map((v) => (
                  <option key={v.id} value={v.id}>{v.number} · {v.model}</option>
                ))}
              </select>
            </label>
            <label>Shift
              <select value={dShift} onChange={(e) => setDShift(e.target.value)}>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
            </label>
            <label className="col-2">Hub
              <input value={dHub} onChange={(e) => setDHub(e.target.value)} placeholder="e.g. Koramangala Hub" />
            </label>
          </div>
          {freeVehicles.length === 0 ? (
            <div className="muted-sm" style={{ marginBottom: 8 }}>
              No unassigned vehicles — add one first, or leave the driver unassigned.
            </div>
          ) : null}
          {err ? <div className="err">{err}</div> : null}
          <div className="form-actions">
            <button className="ghost" onClick={() => setPanel("none")} disabled={saving}>Cancel</button>
            <button className="primary" onClick={createDriver} disabled={saving}>{saving ? "Saving…" : "Add driver"}</button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Name</th><th>Phone</th><th>Hub</th><th>Vehicle</th>
              <th>State</th><th>Cash</th><th>Last ping</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">No drivers yet — use “New driver” to onboard one.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.phone}</td>
                <td>{r.hub_name ?? "—"}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.vehicle_number ?? "—"}</td>
                <td>
                  <span className="dot-ind" style={{ background: r.on_duty ? "var(--live)" : "var(--muted)" }} />
                  {r.on_duty ? "On duty" : (r.current_state ?? "off")}
                </td>
                <td>
                  ₹{r.cash_in_hand.toLocaleString("en-IN")}
                  {r.cash_over_limit ? <span className="tag alert" style={{ marginLeft: 6 }}>OVER</span> : null}
                </td>
                <td style={{ color: r.last_ping_at ? "inherit" : "var(--muted)" }}>{pingAge(r.last_ping_at)}</td>
                <td>
                  <button className="ghost" onClick={() => setActive(r.id, false)} title="Deactivate">Deactivate</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
