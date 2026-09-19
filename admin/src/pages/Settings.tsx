// Settings: fleet-wide values (cash limit, driver share, hubs) that ops used
// to be hardcoded, plus self-service change-password. Editing the fleet values
// is owner-only; the backend enforces it and the form is read-only otherwise.
import { useCallback, useEffect, useState } from "react";
import { api, SettingsData } from "../api";
import { AdminIdentity } from "../auth";

export default function Settings({ admin }: { admin: AdminIdentity }) {
  const isOwner = admin.role === "owner";
  const [data, setData] = useState<SettingsData | null>(null);
  const [cashLimit, setCashLimit] = useState("");
  const [share, setShare] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // change password
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api.get<SettingsData>("/admin/settings");
    setData(s);
    setCashLimit(String(s.cash_limit));
    setShare(String(Math.round(s.driver_share * 100)));
  }, []);

  useEffect(() => { load().catch(() => setErr("Could not load settings.")); }, [load]);

  const save = async () => {
    setErr(null); setMsg(null);
    const cl = Number(cashLimit);
    const sh = Number(share);
    if (!Number.isFinite(cl) || cl < 0) return setErr("Cash limit must be a positive number.");
    if (!Number.isFinite(sh) || sh < 0 || sh > 100) return setErr("Driver share must be 0–100%.");
    setSaving(true);
    try {
      const s = await api.put<SettingsData & { ok: boolean }>("/admin/settings", {
        cash_limit: Math.round(cl), driver_share: sh / 100,
      });
      setData(s);
      setMsg("Settings saved.");
      setTimeout(() => setMsg(null), 3000);
    } catch (e: any) {
      setErr(e?.body?.detail === "owner_only" ? "Only an owner can change these." : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setPwErr(null); setPwMsg(null);
    if (newPw.length < 6) return setPwErr("New password must be at least 6 characters.");
    if (newPw !== newPw2) return setPwErr("New passwords don't match.");
    setPwBusy(true);
    try {
      await api.post("/admin/change-password", { old_password: oldPw, new_password: newPw });
      setPwMsg("Password changed.");
      setOldPw(""); setNewPw(""); setNewPw2("");
      setTimeout(() => setPwMsg(null), 3000);
    } catch (e: any) {
      setPwErr(e?.body?.detail === "wrong_current_password" ? "Current password is incorrect." : "Could not change password.");
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div>
      <h1>Settings</h1>
      <div className="sub">Signed in as {admin.username} · role: {admin.role}</div>

      <div className="card" style={{ marginTop: 16, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Fleet values {isOwner ? "" : <span className="tag muted" style={{ marginLeft: 8 }}>owner only</span>}</h2>
        <div className="form-grid">
          <label>Cash limit (₹)
            <input type="number" min={0} value={cashLimit} disabled={!isOwner} onChange={(e) => setCashLimit(e.target.value)} />
          </label>
          <label>Driver share (%)
            <input type="number" min={0} max={100} value={share} disabled={!isOwner} onChange={(e) => setShare(e.target.value)} />
          </label>
        </div>
        <div className="muted-sm" style={{ marginTop: 8 }}>
          Business-day cutoff: {data?.business_day_cutoff_ist ?? "04:00"} IST (fixed).
        </div>
        {err ? <div className="err">{err}</div> : null}
        {msg ? <div className="tag ok" style={{ display: "inline-block", marginTop: 10 }}>{msg}</div> : null}
        {isOwner ? (
          <div className="form-actions">
            <button className="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 20, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Change my password</h2>
        <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
          <label>Current password
            <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
          </label>
          <label>New password
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          </label>
          <label>Confirm new password
            <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {pwErr ? <div className="err">{pwErr}</div> : null}
        {pwMsg ? <div className="tag ok" style={{ display: "inline-block", marginTop: 10 }}>{pwMsg}</div> : null}
        <div className="form-actions">
          <button className="primary" onClick={changePassword} disabled={pwBusy}>{pwBusy ? "Saving…" : "Change password"}</button>
        </div>
      </div>
    </div>
  );
}
