// Drivers: the fleet roster + onboarding + lifecycle. Ops can add a vehicle,
// add a driver, edit a driver, deactivate / reactivate, archive (reversible),
// and open a per-driver detail page. Archived drivers are hidden by default.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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

interface EditState {
  id: string;
  name: string;
  phone: string;
  hub_name: string;
  shift_type: string;
  vehicle_id: string;
}

export default function Drivers() {
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
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
  // edit modal
  const [edit, setEdit] = useState<EditState | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        api.get<{ items: DriverRow[] }>(`/admin/drivers${showArchived ? "?include_archived=true" : ""}`),
        api.get<{ items: VehicleRow[] }>("/admin/vehicles"),
      ]);
      setRows(d.items);
      setVehicles(v.items);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

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
      const v = await api.post<VehicleRow>("/admin/vehicles", { number: vNumber.trim(), model: vModel.trim() || "Citroën ëC3" });
      setVNumber("");
      await load();
      setPanel("driver");
      setDVehicle(v.id);
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
        name: dName.trim(), phone: dPhone.trim(), vehicle_id: dVehicle || null,
        hub_name: dHub.trim() || null, shift_type: dShift,
      });
      setDName(""); setDPhone("+91"); setDVehicle(""); setDHub("");
      setPanel("none");
      await load();
      flash("Driver added.");
    } catch (e: any) {
      setErr(e?.body?.detail === "phone_already_registered" ? "A driver with that phone already exists." : "Could not add driver.");
    } finally {
      setSaving(false);
    }
  };

  const patchDriver = async (id: string, body: Record<string, unknown>, ok: string) => {
    try {
      await api.patch(`/admin/drivers/${id}`, body);
      await load();
      flash(ok);
    } catch {
      setErr("Could not update driver.");
    }
  };

  const archive = async (r: DriverRow) => {
    if (!window.confirm(`Archive ${r.name}? They'll be deactivated and their vehicle freed. This is reversible.`)) return;
    try {
      await api.del(`/admin/drivers/${r.id}`);
      await load();
      flash(`${r.name} archived.`);
    } catch {
      setErr("Could not archive driver.");
    }
  };

  const restore = async (r: DriverRow) => {
    try {
      await api.post(`/admin/drivers/${r.id}/restore`);
      await load();
      flash(`${r.name} restored.`);
    } catch {
      setErr("Could not restore driver.");
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    if (!edit.name.trim()) return setErr("Name is required.");
    if (edit.phone.trim().length < 6) return setErr("Enter a valid phone number.");
    setSaving(true);
    setErr(null);
    try {
      await api.patch(`/admin/drivers/${edit.id}`, {
        name: edit.name.trim(), phone: edit.phone.trim(),
        hub_name: edit.hub_name.trim() || null, shift_type: edit.shift_type,
        vehicle_id: edit.vehicle_id || null,
      });
      setEdit(null);
      await load();
      flash("Driver updated.");
    } catch (e: any) {
      setErr(e?.body?.detail === "phone_already_registered" ? "A driver with that phone already exists." : "Could not update driver.");
    } finally {
      setSaving(false);
    }
  };

  const freeVehicles = vehicles.filter((v) => !v.assigned);
  // For the edit modal: free vehicles PLUS the one this driver already holds.
  const editVehicleOptions = (currentId: string) =>
    vehicles.filter((v) => !v.assigned || v.id === currentId);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Drivers</h1>
          <div className="sub">
            {rows.length} driver{rows.length === 1 ? "" : "s"} · {vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginRight: 6 }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ width: "auto" }} />
            Show archived
          </label>
          <Link to="/vehicles"><button className="ghost">Vehicles</button></Link>
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
                {freeVehicles.map((v) => (<option key={v.id} value={v.id}>{v.number} · {v.model}</option>))}
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
            <div className="muted-sm" style={{ marginBottom: 8 }}>No unassigned vehicles — add one first, or leave the driver unassigned.</div>
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
              <th>Name</th><th>Phone</th><th>Hub</th><th>Shift</th><th>Vehicle</th>
              <th>State</th><th>Cash</th><th>Last ping</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="empty">No drivers yet — use “New driver” to onboard one.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} style={{ opacity: r.archived ? 0.55 : 1 }}>
                <td style={{ fontWeight: 600 }}>
                  <Link to={`/drivers/${r.id}`} style={{ color: "var(--ink)" }}>{r.name}</Link>
                  {r.archived ? <span className="tag muted" style={{ marginLeft: 6 }}>archived</span> : null}
                </td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.phone}</td>
                <td>{r.hub_name ?? "—"}</td>
                <td>{r.shift_type ?? "—"}</td>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.vehicle_number ?? "—"}</td>
                <td>
                  <span className="dot-ind" style={{ background: r.on_duty ? "var(--live)" : "var(--muted)" }} />
                  {r.archived ? "archived" : r.on_duty ? "On duty" : (r.active ? (r.current_state ?? "off") : "inactive")}
                </td>
                <td>
                  ₹{r.cash_in_hand.toLocaleString("en-IN")}
                  {r.cash_over_limit ? <span className="tag alert" style={{ marginLeft: 6 }}>OVER</span> : null}
                </td>
                <td style={{ color: r.last_ping_at ? "inherit" : "var(--muted)" }}>{pingAge(r.last_ping_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {r.archived ? (
                    <button className="ghost" onClick={() => restore(r)}>Restore</button>
                  ) : (
                    <>
                      <button className="ghost" onClick={() => setEdit({
                        id: r.id, name: r.name, phone: r.phone,
                        hub_name: r.hub_name ?? "", shift_type: r.shift_type ?? "day",
                        vehicle_id: r.vehicle_id ?? "",
                      })}>Edit</button>
                      {r.active ? (
                        <button className="ghost" onClick={() => patchDriver(r.id, { active: false }, `${r.name} deactivated.`)} title="Deactivate">Off</button>
                      ) : (
                        <button className="ghost" onClick={() => patchDriver(r.id, { active: true }, `${r.name} reactivated.`)} title="Reactivate">On</button>
                      )}
                      <button className="ghost danger-ghost" onClick={() => archive(r)}>Archive</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit ? (
        <div onClick={() => setEdit(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "92vw" }}>
            <h2 style={{ marginTop: 0 }}>Edit driver</h2>
            <div className="form-grid">
              <label>Name *
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
              <label>Phone *
                <input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
              </label>
              <label>Vehicle
                <select value={edit.vehicle_id} onChange={(e) => setEdit({ ...edit, vehicle_id: e.target.value })}>
                  <option value="">Unassigned</option>
                  {editVehicleOptions(edit.vehicle_id).map((v) => (<option key={v.id} value={v.id}>{v.number} · {v.model}</option>))}
                </select>
              </label>
              <label>Shift
                <select value={edit.shift_type} onChange={(e) => setEdit({ ...edit, shift_type: e.target.value })}>
                  <option value="day">Day</option>
                  <option value="night">Night</option>
                </select>
              </label>
              <label className="col-2">Hub
                <input value={edit.hub_name} onChange={(e) => setEdit({ ...edit, hub_name: e.target.value })} />
              </label>
            </div>
            {err ? <div className="err">{err}</div> : null}
            <div className="form-actions">
              <button className="ghost" onClick={() => setEdit(null)} disabled={saving}>Cancel</button>
              <button className="primary" onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
