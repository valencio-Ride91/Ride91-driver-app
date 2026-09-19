// Bookings — list + create. Still map-free by design: pickup and drop are
// free text, there is no geolocation, routing or dispatch. A booking is taken
// down here and lands in the backend model; assignment and a live map come
// later.
import { useCallback, useEffect, useState } from "react";
import { api, BookingRow } from "../api";

const inr = (n: number | null) =>
  n == null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "ASAP";

const VEHICLE_TYPES = ["Mini", "Sedan", "SUV", "Auto"];

interface FormState {
  rider_name: string;
  rider_phone: string;
  pickup_text: string;
  drop_text: string;
  asap: boolean;
  scheduled_local: string; // value of a datetime-local input
  vehicle_type: string;
  fare_estimate: string;
  notes: string;
}

const BLANK: FormState = {
  rider_name: "",
  rider_phone: "",
  pickup_text: "",
  drop_text: "",
  asap: true,
  scheduled_local: "",
  vehicle_type: "",
  fare_estimate: "",
  notes: "",
};

export default function Bookings() {
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(BLANK);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: BookingRow[]; total: number }>("/admin/bookings");
      setRows(r.items);
    } catch {
      setErr("Could not load bookings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = useCallback(async () => {
    setFormErr(null);
    if (!form.rider_name.trim() || !form.rider_phone.trim()) {
      setFormErr("Rider name and phone are required.");
      return;
    }
    if (!form.pickup_text.trim() || !form.drop_text.trim()) {
      setFormErr("Pickup and drop are required.");
      return;
    }
    if (!form.asap && !form.scheduled_local) {
      setFormErr("Pick a date & time, or choose ASAP.");
      return;
    }
    // datetime-local has no timezone; toISOString normalises to UTC, which is
    // what the backend compares scheduled_at against.
    let scheduled_at: string | null = null;
    if (!form.asap && form.scheduled_local) {
      const d = new Date(form.scheduled_local);
      if (isNaN(d.getTime())) {
        setFormErr("That date & time is not valid.");
        return;
      }
      scheduled_at = d.toISOString();
    }
    setSaving(true);
    try {
      await api.post("/admin/bookings", {
        rider_name: form.rider_name.trim(),
        rider_phone: form.rider_phone.trim(),
        pickup_text: form.pickup_text.trim(),
        drop_text: form.drop_text.trim(),
        scheduled_at,
        vehicle_type: form.vehicle_type || null,
        fare_estimate: form.fare_estimate ? Number(form.fare_estimate) : null,
        notes: form.notes.trim() || null,
      });
      setForm(BLANK);
      setShowForm(false);
      await load();
    } catch {
      setFormErr("Could not save the booking. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [form, load]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <div className="sub">
            Scheduled rides, taken down by ops. Pickup and drop are text for now — no map or dispatch
            yet.
          </div>
        </div>
        <button
          className="primary"
          onClick={() => {
            setShowForm((s) => !s);
            setFormErr(null);
          }}
        >
          {showForm ? "Close" : "New booking"}
        </button>
      </div>

      {showForm ? (
        <div className="card booking-form">
          <div className="form-grid">
            <label>
              Rider name *
              <input
                value={form.rider_name}
                onChange={(e) => set("rider_name", e.target.value)}
                placeholder="Full name"
              />
            </label>
            <label>
              Rider phone *
              <input
                value={form.rider_phone}
                onChange={(e) => set("rider_phone", e.target.value)}
                placeholder="+91…"
              />
            </label>
            <label className="col-2">
              Pickup *
              <input
                value={form.pickup_text}
                onChange={(e) => set("pickup_text", e.target.value)}
                placeholder="Pickup address / landmark"
              />
            </label>
            <label className="col-2">
              Drop *
              <input
                value={form.drop_text}
                onChange={(e) => set("drop_text", e.target.value)}
                placeholder="Drop address / landmark"
              />
            </label>
            <label>
              When
              <div className="asap-row">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.asap}
                    onChange={(e) => set("asap", e.target.checked)}
                  />
                  ASAP
                </label>
                <input
                  type="datetime-local"
                  value={form.scheduled_local}
                  disabled={form.asap}
                  onChange={(e) => set("scheduled_local", e.target.value)}
                />
              </div>
            </label>
            <label>
              Vehicle type
              <select value={form.vehicle_type} onChange={(e) => set("vehicle_type", e.target.value)}>
                <option value="">Any</option>
                {VEHICLE_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fare estimate (₹)
              <input
                type="number"
                min={0}
                value={form.fare_estimate}
                onChange={(e) => set("fare_estimate", e.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="col-2">
              Notes
              <textarea
                rows={2}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="Anything the driver should know"
              />
            </label>
          </div>
          {formErr ? <div className="err">{formErr}</div> : null}
          <div className="form-actions">
            <button className="ghost" onClick={() => setShowForm(false)} disabled={saving}>
              Cancel
            </button>
            <button className="primary" onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Create booking"}
            </button>
          </div>
        </div>
      ) : null}

      {err ? <div className="err">{err}</div> : null}

      {rows == null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No bookings yet. Use “New booking” to add the first one.</div>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Rider</th>
              <th>Pickup → Drop</th>
              <th>When</th>
              <th>Vehicle</th>
              <th>Fare est.</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>{b.ref}</td>
                <td>
                  {b.rider_name}
                  <div className="muted-sm">{b.rider_phone}</div>
                </td>
                <td>
                  {b.pickup_text} <span className="muted-sm">→</span> {b.drop_text}
                </td>
                <td>{when(b.scheduled_at)}</td>
                <td>{b.vehicle_type ?? "—"}</td>
                <td>{inr(b.fare_estimate)}</td>
                <td>
                  <span className="tag ok">{b.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
