// Hubs: locations that hold up to `capacity` cars (default 12). Each vehicle
// sits under a hub, and weekly rewards are decided within a hub.
import { useCallback, useEffect, useState } from "react";
import { api, HubRow } from "../api";

interface EditState { id: string; name: string; city: string; capacity: string }

export default function Hubs() {
  const [rows, setRows] = useState<HubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [capacity, setCapacity] = useState("12");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: HubRow[] }>("/admin/hubs");
      setRows(r.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); };

  const create = async () => {
    setErr(null);
    if (name.trim().length < 2) return setErr("Enter a hub name.");
    const cap = Number(capacity) || 12;
    setSaving(true);
    try {
      await api.post("/admin/hubs", { name: name.trim(), city: city.trim() || null, capacity: cap });
      setName(""); setCity(""); setCapacity("12"); setAdding(false);
      await load();
      flash("Hub created.");
    } catch (e: any) {
      setErr(e?.body?.detail === "hub_name_exists" ? "A hub with that name exists." : "Could not create hub.");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    setSaving(true);
    setErr(null);
    try {
      await api.patch(`/admin/hubs/${edit.id}`, {
        name: edit.name.trim(), city: edit.city.trim() || null, capacity: Number(edit.capacity) || 12,
      });
      setEdit(null);
      await load();
      flash("Hub updated.");
    } catch (e: any) {
      setErr(e?.body?.detail === "hub_name_exists" ? "A hub with that name exists." : "Could not update hub.");
    } finally {
      setSaving(false);
    }
  };

  const del = async (h: HubRow) => {
    if (!window.confirm(`Delete ${h.name}? (only allowed when no cars are assigned)`)) return;
    try {
      await api.del(`/admin/hubs/${h.id}`);
      await load();
      flash(`${h.name} deleted.`);
    } catch (e: any) {
      setErr(e?.body?.detail === "hub_has_cars" ? "Move its cars to another hub first." : "Could not delete hub.");
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Hubs</h1>
          <div className="sub">{rows.length} hub{rows.length === 1 ? "" : "s"} · each holds up to its capacity in cars</div>
        </div>
        <button className="primary" onClick={() => { setAdding(!adding); setErr(null); }}>{adding ? "Close" : "New hub"}</button>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}

      {adding ? (
        <div className="card onboard">
          <h2>New hub</h2>
          <div className="form-grid">
            <label>Name *
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wakad Pune Hub" />
            </label>
            <label>City
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Pune" />
            </label>
            <label>Capacity (cars)
              <input type="number" min={1} max={100} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </label>
          </div>
          {err ? <div className="err">{err}</div> : null}
          <div className="form-actions">
            <button className="ghost" onClick={() => setAdding(false)} disabled={saving}>Cancel</button>
            <button className="primary" onClick={create} disabled={saving}>{saving ? "Saving…" : "Create hub"}</button>
          </div>
        </div>
      ) : null}

      {err && !adding ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <table className="data">
          <thead><tr><th>Hub</th><th>City</th><th>Cars</th><th>Capacity</th><th>Free seats</th><th></th></tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">No hubs yet — create one (e.g. “Wakad Pune Hub”).</td></tr>
            ) : rows.map((h) => (
              <tr key={h.id}>
                <td style={{ fontWeight: 600 }}>{h.name}</td>
                <td>{h.city ?? "—"}</td>
                <td>{h.car_count}</td>
                <td>{h.capacity}</td>
                <td>
                  <span className={`tag ${h.seats_left === 0 ? "alert" : h.seats_left <= 2 ? "amber" : "muted"}`}>{h.seats_left} left</span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => setEdit({ id: h.id, name: h.name, city: h.city ?? "", capacity: String(h.capacity) })}>Edit</button>
                  <button className="ghost danger-ghost" onClick={() => del(h)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit ? (
        <div onClick={() => setEdit(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "92vw" }}>
            <h2 style={{ marginTop: 0 }}>Edit hub</h2>
            <div className="form-grid">
              <label>Name *<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label>City<input value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></label>
              <label>Capacity<input type="number" min={1} max={100} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></label>
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
