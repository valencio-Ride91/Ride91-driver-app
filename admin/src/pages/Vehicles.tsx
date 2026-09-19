// Vehicles: the fleet's cars. Add, edit (plate / model / SoC / range), retire
// (reversible, refused while a driver holds it), and restore. Retired vehicles
// are hidden unless the toggle is on.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, VehicleRow } from "../api";

interface EditState {
  id: string;
  number: string;
  model: string;
  current_soc: string;
  current_range_km: string;
}

export default function Vehicles() {
  const [rows, setRows] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [vNumber, setVNumber] = useState("");
  const [vModel, setVModel] = useState("Citroën ëC3");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.get<{ items: VehicleRow[] }>(`/admin/vehicles${showRetired ? "?include_retired=true" : ""}`);
      setRows(v.items);
    } finally {
      setLoading(false);
    }
  }, [showRetired]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); };

  const create = async () => {
    setErr(null);
    if (vNumber.trim().length < 3) return setErr("Enter a valid number plate.");
    setSaving(true);
    try {
      await api.post("/admin/vehicles", { number: vNumber.trim(), model: vModel.trim() || "Citroën ëC3" });
      setVNumber(""); setAdding(false);
      await load();
      flash("Vehicle added.");
    } catch (e: any) {
      setErr(e?.body?.detail === "vehicle_number_exists" ? "That number plate already exists." : "Could not add vehicle.");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    if (edit.number.trim().length < 3) return setErr("Enter a valid number plate.");
    setSaving(true);
    setErr(null);
    try {
      await api.patch(`/admin/vehicles/${edit.id}`, {
        number: edit.number.trim(),
        model: edit.model.trim() || null,
        current_soc: edit.current_soc === "" ? null : Number(edit.current_soc),
        current_range_km: edit.current_range_km === "" ? null : Number(edit.current_range_km),
      });
      setEdit(null);
      await load();
      flash("Vehicle updated.");
    } catch (e: any) {
      setErr(e?.body?.detail === "vehicle_number_exists" ? "That number plate already exists." : "Could not update vehicle.");
    } finally {
      setSaving(false);
    }
  };

  const retire = async (v: VehicleRow) => {
    if (!window.confirm(`Retire ${v.number}? Reversible.`)) return;
    try {
      await api.del(`/admin/vehicles/${v.id}`);
      await load();
      flash(`${v.number} retired.`);
    } catch (e: any) {
      setErr(e?.body?.detail === "vehicle_in_use" ? "That vehicle is assigned to a driver — reassign it first." : "Could not retire vehicle.");
    }
  };

  const restore = async (v: VehicleRow) => {
    try {
      await api.post(`/admin/vehicles/${v.id}/restore`);
      await load();
      flash(`${v.number} restored.`);
    } catch {
      setErr("Could not restore vehicle.");
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="sub"><Link to="/drivers">← Drivers</Link></div>
          <h1>Vehicles</h1>
          <div className="sub">{rows.length} vehicle{rows.length === 1 ? "" : "s"}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginRight: 6 }}>
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} style={{ width: "auto" }} />
            Show retired
          </label>
          <button className="primary" onClick={() => { setAdding(!adding); setErr(null); }}>{adding ? "Close" : "New vehicle"}</button>
        </div>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}

      {adding ? (
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
            <button className="ghost" onClick={() => setAdding(false)} disabled={saving}>Cancel</button>
            <button className="primary" onClick={create} disabled={saving}>{saving ? "Saving…" : "Add vehicle"}</button>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <table className="data">
          <thead>
            <tr><th>Plate</th><th>Model</th><th>SoC</th><th>Range</th><th>Assigned to</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">No vehicles yet.</td></tr>
            ) : rows.map((v) => (
              <tr key={v.id} style={{ opacity: v.retired ? 0.55 : 1 }}>
                <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                  {v.number}
                  {v.retired ? <span className="tag muted" style={{ marginLeft: 6 }}>retired</span> : null}
                </td>
                <td>{v.model}</td>
                <td>{v.current_soc != null ? `${v.current_soc}%` : "—"}</td>
                <td>{v.current_range_km != null ? `${v.current_range_km} km` : "—"}</td>
                <td>{v.assigned_driver ? v.assigned_driver : <span className="muted-sm">free</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {v.retired ? (
                    <button className="ghost" onClick={() => restore(v)}>Restore</button>
                  ) : (
                    <>
                      <button className="ghost" onClick={() => setEdit({
                        id: v.id, number: v.number, model: v.model,
                        current_soc: v.current_soc?.toString() ?? "",
                        current_range_km: v.current_range_km?.toString() ?? "",
                      })}>Edit</button>
                      <button className="ghost danger-ghost" onClick={() => retire(v)}>Retire</button>
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
            <h2 style={{ marginTop: 0 }}>Edit vehicle</h2>
            <div className="form-grid">
              <label>Number plate *
                <input value={edit.number} onChange={(e) => setEdit({ ...edit, number: e.target.value })} />
              </label>
              <label>Model
                <input value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} />
              </label>
              <label>State of charge (%)
                <input type="number" min={0} max={100} value={edit.current_soc} onChange={(e) => setEdit({ ...edit, current_soc: e.target.value })} />
              </label>
              <label>Range (km)
                <input type="number" min={0} value={edit.current_range_km} onChange={(e) => setEdit({ ...edit, current_range_km: e.target.value })} />
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
