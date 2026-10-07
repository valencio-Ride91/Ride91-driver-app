// Shift board — the hub's live view of the coming shift, one row per driver:
// when their shift is, whether the wake-up alarm is set on their phone,
// whether they said they are coming, and whether they have started duty.
//
// The hub also sets shift times here: per driver in the row, or for all day /
// night drivers at once. A driver with no shift time has no alarm at all.
//
// Refreshes every 20 seconds. The server works every status out from the
// alarm answers and duty records at that moment; nothing here is typed in.
import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ShiftBoardData, ShiftBoardRow } from "../api";
import { AdminIdentity } from "../auth";

const REASON: Record<string, string> = {
  unwell: "Unwell", family_emergency: "Family emergency", vehicle_problem: "Vehicle problem",
  transport_problem: "Transport problem", personal: "Personal", other: "Other",
};

// How each status reads on the board, and how loud it is.
const STATUS: Record<string, { label: string; tone: string }> = {
  no_shift_time: { label: "No shift time", tone: "muted" },
  alarm_pending: { label: "Alarm not rung yet", tone: "muted" },
  ringing: { label: "Alarm ringing", tone: "amber" },
  no_answer: { label: "No answer", tone: "alert" },
  coming: { label: "Coming", tone: "live" },
  not_coming: { label: "Not coming", tone: "alert" },
  late: { label: "Said coming, not started", tone: "alert" },
  not_started: { label: "Not started", tone: "alert" },
  started: { label: "On duty", tone: "live" },
};
// The order the summary chips appear in: what needs the hub first.
const CHIP_ORDER = ["not_coming", "no_answer", "not_started", "late", "ringing", "coming", "started", "alarm_pending", "no_shift_time"];

const PHONE: Record<string, { label: string; tone: string; hint: string }> = {
  ready: { label: "Alarm set", tone: "live", hint: "The app has set the alarm on this phone." },
  unknown: { label: "App has it", tone: "muted", hint: "An older app version fetched the shift but does not report whether the alarm is set. Update the app to see this." },
  not_picked_up: { label: "Not on phone yet", tone: "amber", hint: "The app has not fetched this shift. The driver must open the app once after the shift time is set." },
  notifications_off: { label: "Notifications off", tone: "alert", hint: "Notifications are switched off for the app, so the alarm cannot show. The driver must allow them (Profile > Shift alarm)." },
  no_alarm_in_app: { label: "Old app, no alarm", tone: "alert", hint: "This phone has an app version without the alarm. Install the latest app." },
};

function clock(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
}
function dayLabel(iso?: string | null) {
  if (!iso) return "";
  const d = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const t = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const yesterday = new Date(Date.now() - 86400000);
  if (d(t) === d(today)) return "today";
  if (d(t) === d(tomorrow)) return "tomorrow";
  if (d(t) === d(yesterday)) return "yesterday";
  return t.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

export default function ShiftBoard({ hubId }: { hubId: string }) {
  const { admin } = useOutletContext<{ admin: AdminIdentity }>();
  const canEdit = admin?.role !== "viewer";
  const [data, setData] = useState<ShiftBoardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkTime, setBulkTime] = useState("");
  const [bulkWho, setBulkWho] = useState<"day" | "night" | "all">("day");

  const load = useCallback(async () => {
    try {
      setData(await api.get<ShiftBoardData>(`/admin/hubs/${hubId}/shift-board`));
      setErr(null);
    } catch {
      setErr("Could not load the shift board.");
    }
  }, [hubId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  const say = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(null), 4000);
  };

  const saveOne = async (r: ShiftBoardRow) => {
    const value = edits[r.driver_id];
    if (value === undefined) return;
    setBusy(r.driver_id);
    setErr(null);
    try {
      await api.patch(`/admin/drivers/${r.driver_id}`, { shift_start_time: value });
      setEdits((e) => {
        const next = { ...e };
        delete next[r.driver_id];
        return next;
      });
      await load();
      say(value ? `${r.name ?? "Driver"}: shift time set to ${value}. The alarm rings one hour before.` : `${r.name ?? "Driver"}: shift time cleared, no alarm.`);
    } catch {
      setErr("Could not save the shift time.");
    } finally {
      setBusy(null);
    }
  };

  const saveBulk = async () => {
    if (!bulkTime) return;
    setBusy("bulk");
    setErr(null);
    try {
      const r = await api.post<{ updated: number }>(`/admin/hubs/${hubId}/shift-times`, { shift_start_time: bulkTime, shift_type: bulkWho });
      await load();
      say(`Shift time ${bulkTime} set for ${r.updated} driver${r.updated === 1 ? "" : "s"}.`);
    } catch {
      setErr("Could not set the shift times.");
    } finally {
      setBusy(null);
    }
  };

  const rows = data?.items ?? [];
  const noTime = rows.filter((r) => r.status === "no_shift_time").length;

  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="shift-board">
      <h2 style={{ marginTop: 0 }}>Shift board</h2>
      <div className="muted-sm" style={{ marginBottom: 10 }}>
        Each driver's next shift: is the alarm set, did they answer it, and have they started. The alarm rings on the driver's phone one hour before the shift time. Updates every 20 seconds.
      </div>

      {data ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }} data-testid="shift-chips">
          {CHIP_ORDER.filter((k) => (data.counts[k] ?? 0) > 0).map((k) => (
            <span key={k} className={`tag ${STATUS[k].tone}`}>{STATUS[k].label}: {data.counts[k]}</span>
          ))}
        </div>
      ) : null}

      {noTime > 0 ? (
        <div className="err" style={{ marginBottom: 10 }} data-testid="shift-no-time">
          {noTime} driver{noTime === 1 ? " has" : "s have"} no shift time, so no alarm will ring for them. Set a time below.
        </div>
      ) : null}

      {canEdit ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <span style={{ fontSize: 13 }}>Set shift time for</span>
          <select value={bulkWho} onChange={(e) => setBulkWho(e.target.value as "day" | "night" | "all")} style={{ width: "auto" }}>
            <option value="day">all day drivers</option>
            <option value="night">all night drivers</option>
            <option value="all">every driver</option>
          </select>
          <input type="time" value={bulkTime} onChange={(e) => setBulkTime(e.target.value)} style={{ width: "auto" }} />
          <button className="primary" onClick={saveBulk} disabled={!bulkTime || busy === "bulk"}>{busy === "bulk" ? "Saving…" : "Apply"}</button>
        </div>
      ) : null}

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 10 }}>{msg}</div> : null}
      {err ? <div className="err" style={{ marginBottom: 10 }}>{err}</div> : null}

      <div style={{ overflowX: "auto" }}>
        <table className="data" style={{ margin: 0 }}>
          <thead>
            <tr><th>Driver</th><th>Shift time</th><th>Next shift</th><th>Alarm on phone</th><th>Answer</th><th>Duty</th></tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="empty">No drivers in this hub.</td></tr>
            ) : rows.map((r) => {
              const st = STATUS[r.status] ?? { label: r.status, tone: "muted" };
              const ph = r.phone ? PHONE[r.phone] : null;
              const editing = edits[r.driver_id] !== undefined;
              return (
                <tr key={r.driver_id} style={{ opacity: r.active ? 1 : 0.55 }} data-testid={`shift-row-${r.driver_id}`}>
                  <td>
                    <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name ?? r.driver_id.slice(0, 8)}</Link>
                    <div className="muted-sm">{r.shift_type}</div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {canEdit ? (
                      <>
                        <input type="time" value={edits[r.driver_id] ?? r.shift_start_time ?? ""} style={{ width: "auto" }}
                          onChange={(e) => setEdits((x) => ({ ...x, [r.driver_id]: e.target.value }))} />
                        {editing ? (
                          <button className="primary" style={{ marginLeft: 6 }} onClick={() => saveOne(r)} disabled={busy === r.driver_id}>
                            {busy === r.driver_id ? "…" : "Save"}
                          </button>
                        ) : null}
                      </>
                    ) : (r.shift_start_time ?? <span className="muted-sm">not set</span>)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.shift_start ? (
                      <>
                        <div>{clock(r.shift_start)} <span className="muted-sm">{dayLabel(r.shift_start)}</span></div>
                        <div className="muted-sm">alarm {clock(r.alarm_at)}</div>
                      </>
                    ) : <span className="muted-sm">—</span>}
                  </td>
                  <td>
                    {r.status === "no_shift_time" ? <span className="muted-sm">no alarm</span>
                      : ph ? <span className={`tag ${ph.tone}`} title={ph.hint}>{ph.label}</span>
                      : <span className="muted-sm">—</span>}
                  </td>
                  <td>
                    <span className={`tag ${st.tone}`}>{st.label}</span>
                    {r.status === "not_coming" ? (
                      <div className="muted-sm" style={{ marginTop: 3 }}>
                        {r.reason_code === "other" && r.reason_note ? r.reason_note : (REASON[r.reason_code ?? ""] ?? r.reason_code ?? "")}
                        {r.back_by ? ` · back by ${r.back_by}` : ""}
                      </div>
                    ) : null}
                    {r.answered_at && r.status !== "no_shift_time" ? <div className="muted-sm">answered {clock(r.answered_at)}</div> : null}
                    {r.snoozes ? <div className="muted-sm">snoozed {r.snoozes}×</div> : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.duty_started_at ? (
                      <>
                        <div>started {clock(r.duty_started_at)}</div>
                        {r.late_minutes ? <div className="muted-sm" style={{ color: "var(--alert)" }}>{r.late_minutes} min late</div> : <div className="muted-sm">on time</div>}
                      </>
                    ) : <span className="muted-sm">{r.status === "no_shift_time" ? "—" : "not started"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
