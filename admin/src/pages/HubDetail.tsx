// Hub detail — the hub's home base. Shows the hub's vehicles (with day/night
// driver slots you can allot), its drivers, and add-driver / add-vehicle that
// create them already set to this hub. Hub-managers manage their own hub here.
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, HubRoster } from "../api";

export default function HubDetail() {
  const { id = "" } = useParams();
  const [data, setData] = useState<HubRoster | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState<"none" | "driver" | "vehicle">("none");

  // add-driver form
  const [dName, setDName] = useState("");
  const [dPhone, setDPhone] = useState("+91");
  const [dPassword, setDPassword] = useState("");
  const [dShift, setDShift] = useState("day");
  // add-vehicle form
  const [vNumber, setVNumber] = useState("");
  const [vModel, setVModel] = useState("Citroën ëC3");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<HubRoster>(`/admin/hubs/${id}/roster`));
    } catch (e: any) {
      setErr(e?.body?.detail === "out_of_hub_scope" ? "This hub isn't yours." : "Could not load hub.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };

  // Allot (or clear) a car's day/night slot to a driver — atomic on the server.
  const allot = async (vehicleId: string, shift: "day" | "night", driverId: string) => {
    setErr(null);
    try {
      await api.post(`/admin/vehicles/${vehicleId}/assign`, { shift, driver_id: driverId || null });
      await load();
      flash("Allotment updated.");
    } catch {
      setErr("Could not allot the vehicle.");
    }
  };

  const addVehicle = async () => {
    setErr(null);
    if (vNumber.trim().length < 3) return setErr("Enter a valid number plate.");
    setSaving(true);
    try {
      await api.post("/admin/vehicles", { number: vNumber.trim(), model: vModel.trim() || "Citroën ëC3", hub_id: id });
      setVNumber(""); setAdding("none"); await load(); flash("Vehicle added to hub.");
    } catch (e: any) {
      setErr(e?.body?.detail === "vehicle_number_exists" ? "That plate already exists." : e?.body?.detail === "hub_full" ? "This hub is full." : "Could not add vehicle.");
    } finally { setSaving(false); }
  };

  const addDriver = async () => {
    setErr(null);
    if (!dName.trim()) return setErr("Name is required.");
    if (dPhone.trim().length < 6) return setErr("Enter a valid phone.");
    if (dPassword.length < 6) return setErr("Password must be at least 6 characters.");
    setSaving(true);
    try {
      await api.post("/admin/drivers", { name: dName.trim(), phone: dPhone.trim(), password: dPassword, hub_id: id, shift_type: dShift });
      setDName(""); setDPhone("+91"); setDPassword(""); setAdding("none"); await load(); flash("Driver added to hub.");
    } catch (e: any) {
      setErr(e?.body?.detail === "phone_already_registered" ? "A driver with that phone exists." : "Could not add driver.");
    } finally { setSaving(false); }
  };

  if (loading) return <div className="card"><div className="empty">Loading…</div></div>;
  if (!data) return <div className="card"><div className="empty">{err ?? "Not found."}</div></div>;

  const { hub, vehicles, drivers } = data;

  // Any of the hub's drivers can be put in a slot; the server sets their shift.
  const Slot = ({ vehId, shift, current }: { vehId: string; shift: "day" | "night"; current: { driver_id: string; name: string | null } | null }) => (
    <select
      value={current?.driver_id ?? ""}
      onChange={(e) => allot(vehId, shift, e.target.value)}
      style={{ padding: "4px 8px", minWidth: 150 }}
    >
      <option value="">— unassigned —</option>
      {drivers.map((d) => (
        <option key={d.id} value={d.id}>{d.code ? `${d.code} · ` : ""}{d.name}</option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="sub"><Link to="/hubs">← Hubs</Link></div>
          <h1>{hub.name}</h1>
          <div className="sub">{hub.city ?? "—"} · {vehicles.length}/{hub.capacity} cars · {drivers.length} drivers</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setAdding(adding === "vehicle" ? "none" : "vehicle"); setErr(null); }}>{adding === "vehicle" ? "Close" : "Add vehicle"}</button>
          <button className="primary" onClick={() => { setAdding(adding === "driver" ? "none" : "driver"); setErr(null); }}>{adding === "driver" ? "Close" : "Add driver"}</button>
        </div>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}
      {err ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      {adding === "vehicle" ? (
        <div className="card onboard">
          <h2>Add vehicle to {hub.name}</h2>
          <div className="form-grid">
            <label>Number plate *<input value={vNumber} onChange={(e) => setVNumber(e.target.value)} placeholder="MH-12-AB-1234" /></label>
            <label>Model<input value={vModel} onChange={(e) => setVModel(e.target.value)} /></label>
          </div>
          <div className="form-actions"><button className="ghost" onClick={() => setAdding("none")}>Cancel</button><button className="primary" onClick={addVehicle} disabled={saving}>{saving ? "Saving…" : "Add vehicle"}</button></div>
        </div>
      ) : null}

      {adding === "driver" ? (
        <div className="card onboard">
          <h2>Add driver to {hub.name}</h2>
          <div className="form-grid">
            <label>Name *<input value={dName} onChange={(e) => setDName(e.target.value)} /></label>
            <label>Phone * (login)<input value={dPhone} onChange={(e) => setDPhone(e.target.value)} /></label>
            <label>Password * (app)<input value={dPassword} onChange={(e) => setDPassword(e.target.value)} placeholder="min 6 chars" autoComplete="new-password" /></label>
            <label>Shift<select value={dShift} onChange={(e) => setDShift(e.target.value)}><option value="day">Day</option><option value="night">Night</option></select></label>
          </div>
          <div className="form-actions"><button className="ghost" onClick={() => setAdding("none")}>Cancel</button><button className="primary" onClick={addDriver} disabled={saving}>{saving ? "Saving…" : "Add driver"}</button></div>
        </div>
      ) : null}

      <h2 style={{ marginTop: 20 }}>Vehicles &amp; allotment</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Car</th><th>Model</th><th>Day driver</th><th>Night driver</th></tr></thead>
          <tbody>
            {vehicles.length === 0 ? <tr><td colSpan={4} className="empty">No vehicles in this hub yet.</td></tr> : vehicles.map((v) => (
              <tr key={v.id}>
                <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{v.number}</td>
                <td>{v.model}</td>
                <td><Slot vehId={v.id} shift="day" current={v.day_driver} /></td>
                <td><Slot vehId={v.id} shift="night" current={v.night_driver} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 20 }}>Drivers</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Code</th><th>Driver</th><th>Shift</th><th>Car</th><th>Active</th></tr></thead>
          <tbody>
            {drivers.length === 0 ? <tr><td colSpan={5} className="empty">No drivers in this hub yet.</td></tr> : drivers.map((d) => (
              <tr key={d.id} style={{ opacity: d.active ? 1 : 0.55 }}>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{d.code ?? "—"}</td>
                <td><Link to={`/drivers/${d.id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{d.name}</Link><div className="muted-sm" style={{ fontFamily: "ui-monospace, monospace" }}>{d.phone}</div></td>
                <td>{d.shift_type}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{vehicles.find((v) => v.id === d.vehicle_id)?.number ?? <span className="muted-sm">—</span>}</td>
                <td>{d.active ? <span className="tag live">active</span> : <span className="tag muted">off</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
