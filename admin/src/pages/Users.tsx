// Admin accounts (owner only). Create logins with a role, change roles,
// enable/disable, reset passwords, and delete. The backend refuses to remove
// the last owner or your own account.
import { useCallback, useEffect, useState } from "react";
import { api, AdminUserRow, HubRow } from "../api";
import { AdminIdentity } from "../auth";

const ROLES = ["viewer", "hub_manager", "manager", "owner"] as const;
const ROLE_HELP = "viewer = read-only · hub_manager = drivers + cars of one hub · manager = all ops · owner = accounts + settings";

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default function Users({ admin }: { admin: AdminIdentity }) {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [hubs, setHubs] = useState<HubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [uName, setUName] = useState("");
  const [uPw, setUPw] = useState("");
  const [uRole, setURole] = useState<typeof ROLES[number]>("manager");
  const [uHub, setUHub] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, h] = await Promise.all([
        api.get<{ items: AdminUserRow[] }>("/admin/users"),
        api.get<{ items: HubRow[] }>("/admin/hubs"),
      ]);
      setRows(u.items);
      setHubs(h.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000); };

  const create = async () => {
    setErr(null);
    if (uName.trim().length < 3) return setErr("Username must be at least 3 characters.");
    if (uPw.length < 6) return setErr("Password must be at least 6 characters.");
    if (uRole === "hub_manager" && !uHub) return setErr("Pick a hub for the hub manager.");
    setSaving(true);
    try {
      await api.post("/admin/users", { username: uName.trim(), password: uPw, role: uRole, hub_id: uRole === "hub_manager" ? uHub : null });
      setUName(""); setUPw(""); setURole("manager"); setUHub(""); setAdding(false);
      await load();
      flash("Account created.");
    } catch (e: any) {
      setErr(mapErr(e));
    } finally {
      setSaving(false);
    }
  };

  const setRole = async (u: AdminUserRow, role: string) => {
    // A hub_manager needs a hub — default to their existing one or the first hub.
    let hub_id: string | null = null;
    if (role === "hub_manager") {
      hub_id = u.hub_id || hubs[0]?.id || null;
      if (!hub_id) return setErr("Create a hub first — a hub manager must be scoped to one.");
    }
    try { await api.patch(`/admin/users/${u.id}`, { role, hub_id }); await load(); flash(`${u.username} → ${role}.`); }
    catch (e: any) { setErr(mapErr(e)); }
  };
  const setHub = async (u: AdminUserRow, hub_id: string) => {
    try { await api.patch(`/admin/users/${u.id}`, { hub_id }); await load(); flash(`${u.username} hub updated.`); }
    catch (e: any) { setErr(mapErr(e)); }
  };
  const toggleActive = async (u: AdminUserRow) => {
    try { await api.patch(`/admin/users/${u.id}`, { active: !u.active }); await load(); }
    catch (e: any) { setErr(mapErr(e)); }
  };
  const resetPw = async (u: AdminUserRow) => {
    const pw = window.prompt(`New password for ${u.username} (min 6 chars):`, "");
    if (!pw) return;
    if (pw.length < 6) return setErr("Password must be at least 6 characters.");
    try { await api.patch(`/admin/users/${u.id}`, { password: pw }); flash(`Password reset for ${u.username}.`); }
    catch (e: any) { setErr(mapErr(e)); }
  };
  const del = async (u: AdminUserRow) => {
    if (!window.confirm(`Delete ${u.username}? Their sessions end immediately.`)) return;
    try { await api.del(`/admin/users/${u.id}`); await load(); flash(`${u.username} deleted.`); }
    catch (e: any) { setErr(mapErr(e)); }
  };

  const mapErr = (e: any) => {
    const d = e?.body?.detail;
    if (d === "cannot_remove_last_owner") return "Can't remove the last owner.";
    if (d === "cannot_delete_self") return "You can't delete your own account.";
    if (d === "username_taken") return "That username is taken.";
    if (d === "hub_required_for_hub_manager") return "A hub manager must be assigned a hub.";
    if (d === "hub_not_found") return "That hub no longer exists.";
    return "Action failed.";
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Admin accounts</h1>
          <div className="sub">{rows.length} account{rows.length === 1 ? "" : "s"} · {ROLE_HELP}</div>
        </div>
        <button className="primary" onClick={() => { setAdding(!adding); setErr(null); }}>{adding ? "Close" : "New account"}</button>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}

      {adding ? (
        <div className="card onboard">
          <h2>New admin account</h2>
          <div className="form-grid">
            <label>Username *
              <input value={uName} onChange={(e) => setUName(e.target.value)} autoComplete="off" />
            </label>
            <label>Password *
              <input type="password" value={uPw} onChange={(e) => setUPw(e.target.value)} autoComplete="new-password" />
            </label>
            <label>Role
              <select value={uRole} onChange={(e) => setURole(e.target.value as typeof ROLES[number])}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            {uRole === "hub_manager" ? (
              <label>Hub *
                <select value={uHub} onChange={(e) => setUHub(e.target.value)}>
                  <option value="">Select a hub…</option>
                  {hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>
          {err ? <div className="err">{err}</div> : null}
          <div className="form-actions">
            <button className="ghost" onClick={() => setAdding(false)} disabled={saving}>Cancel</button>
            <button className="primary" onClick={create} disabled={saving}>{saving ? "Saving…" : "Create account"}</button>
          </div>
        </div>
      ) : null}

      {err && !adding ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <table className="data">
          <thead>
            <tr><th>Username</th><th>Role</th><th>Hub</th><th>Status</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty">Loading…</td></tr>
            ) : rows.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                <td style={{ fontWeight: 600 }}>
                  {u.username}
                  {u.username === admin.username ? <span className="tag muted" style={{ marginLeft: 6 }}>you</span> : null}
                </td>
                <td>
                  <select value={u.role} onChange={(e) => setRole(u, e.target.value)} style={{ padding: "4px 8px" }}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td>
                  {u.role === "hub_manager" ? (
                    <select value={u.hub_id ?? ""} onChange={(e) => setHub(u, e.target.value)} style={{ padding: "4px 8px" }}>
                      {hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                    </select>
                  ) : <span className="muted-sm">—</span>}
                </td>
                <td>
                  <span className={`tag ${u.active ? "live" : "muted"}`}>{u.active ? "active" : "disabled"}</span>
                </td>
                <td>{fmtWhen(u.created_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => toggleActive(u)}>{u.active ? "Disable" : "Enable"}</button>
                  <button className="ghost" onClick={() => resetPw(u)}>Reset PW</button>
                  <button className="ghost danger-ghost" onClick={() => del(u)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
