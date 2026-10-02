// Settings: fleet-wide values (cash limit, driver share, hubs) that ops used
// to be hardcoded, plus self-service change-password. Editing the fleet values
// is owner-only; the backend enforces it and the form is read-only otherwise.
import { useCallback, useEffect, useState } from "react";
import { api, SettingsData } from "../api";
import { AdminIdentity } from "../auth";

type Milestone = { key: string; label: string; amount: number; reward: number };

export default function Settings({ admin }: { admin: AdminIdentity }) {
  const isOwner = admin.role === "owner";
  const [data, setData] = useState<SettingsData | null>(null);
  const [cashLimit, setCashLimit] = useState("");
  const [share, setShare] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // rewards
  const [rw, setRw] = useState<Record<string, string>>({});
  const [ms, setMs] = useState<Milestone[]>([]);
  const [rwSaving, setRwSaving] = useState(false);
  const [rwMsg, setRwMsg] = useState<string | null>(null);
  const [rwErr, setRwErr] = useState<string | null>(null);
  const setRwField = (k: string, v: string) => setRw((p) => ({ ...p, [k]: v }));

  // payment credentials (Razorpay)
  const [pKeyId, setPKeyId] = useState("");
  const [pKeySecret, setPKeySecret] = useState("");
  const [pWebhook, setPWebhook] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);

  // loyalty wallet
  const [wEnabled, setWEnabled] = useState(true);
  const [wPerDay, setWPerDay] = useState("");
  const [wMinGross, setWMinGross] = useState("");
  const [wStart, setWStart] = useState("");
  const [wCadence, setWCadence] = useState("");
  const [wBusy, setWBusy] = useState(false);
  const [wMsg, setWMsg] = useState<string | null>(null);
  const [wErr, setWErr] = useState<string | null>(null);

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
    setRw({
      reward_daily_target: String(s.reward_daily_target),
      reward_top_car_day: String(s.reward_top_car_day),
      reward_week_car_target: String(s.reward_week_car_target),
      reward_top_car_week: String(s.reward_top_car_week),
      reward_week_driver_target: String(s.reward_week_driver_target),
      reward_top_driver_week: String(s.reward_top_driver_week),
      reward_days_required: String(s.reward_days_required),
      yearly_top_driver: String(s.yearly_top_driver),
      yearly_top_car: String(s.yearly_top_car),
    });
    setMs((s.loyalty_milestones ?? []).map((m) => ({ ...m })));
    setWEnabled(!!s.loyalty_wallet_enabled);
    setWPerDay(String(s.loyalty_wallet_per_day ?? ""));
    setWMinGross(String(s.loyalty_wallet_min_gross ?? ""));
    setWStart(s.loyalty_wallet_start_date ?? "");
    setWCadence(String(s.loyalty_wallet_payout_every_days ?? ""));
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

  const saveRewards = async () => {
    setRwErr(null); setRwMsg(null);
    const nums: Record<string, number> = {};
    for (const [k, v] of Object.entries(rw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return setRwErr(`"${k.replace(/_/g, " ")}" must be a positive number.`);
      nums[k] = Math.round(n);
    }
    if (nums.reward_days_required < 1 || nums.reward_days_required > 7) return setRwErr("Days required must be 1–7.");
    for (const m of ms) {
      if (!Number.isFinite(m.amount) || m.amount < 1) return setRwErr("Each milestone needs an earnings threshold of at least ₹1.");
      if (!Number.isFinite(m.reward) || m.reward < 0) return setRwErr("Each milestone reward must be a positive number.");
    }
    setRwSaving(true);
    try {
      const s = await api.put<SettingsData & { ok: boolean }>("/admin/settings", {
        ...nums,
        loyalty_milestones: ms.map((m) => ({ key: m.key, label: m.label, amount: Math.round(m.amount), reward: Math.round(m.reward) })),
      });
      setData(s);
      setMs((s.loyalty_milestones ?? []).map((m) => ({ ...m })));
      setRwMsg("Reward settings saved.");
      setTimeout(() => setRwMsg(null), 3000);
    } catch (e: any) {
      const d = e?.body?.detail;
      setRwErr(d === "owner_only" ? "Only an owner can change these." : d === "bad_milestone" ? "Check the milestone rows." : "Could not save.");
    } finally {
      setRwSaving(false);
    }
  };

  const savePayments = async () => {
    setPayErr(null); setPayMsg(null);
    const body: Record<string, string> = {};
    if (pKeyId.trim()) body.razorpay_key_id = pKeyId.trim();
    if (pKeySecret.trim()) body.razorpay_key_secret = pKeySecret.trim();
    if (pWebhook.trim()) body.razorpay_webhook_secret = pWebhook.trim();
    if (Object.keys(body).length === 0) return setPayErr("Enter at least one value to update.");
    setPayBusy(true);
    try {
      const s = await api.put<SettingsData>("/admin/settings", body);
      setData(s);
      setPKeyId(""); setPKeySecret(""); setPWebhook("");   // never keep secrets in the form
      setPayMsg("Payment credentials updated.");
      setTimeout(() => setPayMsg(null), 4000);
    } catch (e: any) {
      setPayErr(e?.body?.detail === "owner_only" ? "Only an owner can change these." : "Could not save.");
    } finally {
      setPayBusy(false);
    }
  };

  const saveWallet = async () => {
    setWErr(null); setWMsg(null);
    const perDay = Number(wPerDay), minGross = Number(wMinGross), cadence = Number(wCadence);
    if (!Number.isFinite(perDay) || perDay < 0) return setWErr("Per-day amount must be 0 or more.");
    if (!Number.isFinite(minGross) || minGross < 0) return setWErr("Minimum gross must be 0 or more.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wStart)) return setWErr("Start date must be YYYY-MM-DD.");
    setWBusy(true);
    try {
      const s = await api.put<SettingsData>("/admin/settings", {
        loyalty_wallet_enabled: wEnabled,
        loyalty_wallet_per_day: Math.round(perDay),
        loyalty_wallet_min_gross: Math.round(minGross),
        loyalty_wallet_start_date: wStart,
        loyalty_wallet_payout_every_days: Number.isFinite(cadence) && cadence > 0 ? Math.round(cadence) : 90,
      });
      setData(s);
      setWMsg("Loyalty wallet settings saved.");
      setTimeout(() => setWMsg(null), 3000);
    } catch (e: any) {
      setWErr(e?.body?.detail === "owner_only" ? "Only an owner can change these." : "Could not save.");
    } finally {
      setWBusy(false);
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
        <h2 style={{ marginTop: 0 }}>Reward thresholds {isOwner ? "" : <span className="tag muted" style={{ marginLeft: 8 }}>owner only</span>}</h2>

        <h3 style={{ margin: "8px 0 4px", fontSize: 14 }}>Weekly</h3>
        <div className="form-grid">
          <NumField label="Top car of day — min daily gross (₹)" k="reward_daily_target" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top car of day — bonus (₹)" k="reward_top_car_day" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top car of week — min weekly gross (₹)" k="reward_week_car_target" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top car of week — bonus (₹)" k="reward_top_car_week" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top driver of week — min weekly gross (₹)" k="reward_week_driver_target" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top driver of week — bonus (₹)" k="reward_top_driver_week" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Days required (1–7)" k="reward_days_required" rw={rw} set={setRwField} dis={!isOwner} />
        </div>

        <h3 style={{ margin: "16px 0 4px", fontSize: 14 }}>Yearly (per hub)</h3>
        <div className="form-grid">
          <NumField label="Top driver of the year — bonus (₹)" k="yearly_top_driver" rw={rw} set={setRwField} dis={!isOwner} />
          <NumField label="Top car of the year — bonus (₹)" k="yearly_top_car" rw={rw} set={setRwField} dis={!isOwner} />
        </div>

        <h3 style={{ margin: "16px 0 4px", fontSize: 14 }}>Loyalty milestones (cumulative earnings)</h3>
        <table className="data" style={{ marginBottom: 8 }}>
          <thead><tr><th>Label</th><th>Earned ≥ (₹)</th><th>Reward (₹)</th></tr></thead>
          <tbody>
            {ms.map((m, i) => (
              <tr key={m.key}>
                <td>
                  <input value={m.label} disabled={!isOwner}
                    onChange={(e) => setMs((p) => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                </td>
                <td style={{ width: 90 }}>
                  <input type="number" min={1} value={m.amount} disabled={!isOwner}
                    onChange={(e) => setMs((p) => p.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} />
                </td>
                <td style={{ width: 120 }}>
                  <input type="number" min={0} value={m.reward} disabled={!isOwner}
                    onChange={(e) => setMs((p) => p.map((x, j) => j === i ? { ...x, reward: Number(e.target.value) } : x))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted-sm">Loyalty vests only while a driver is active (forfeit if they leave). All reward payouts are manual.</div>

        {rwErr ? <div className="err">{rwErr}</div> : null}
        {rwMsg ? <div className="tag ok" style={{ display: "inline-block", marginTop: 10 }}>{rwMsg}</div> : null}
        {isOwner ? (
          <div className="form-actions">
            <button className="primary" onClick={saveRewards} disabled={rwSaving}>{rwSaving ? "Saving…" : "Save reward settings"}</button>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 20, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Loyalty wallet {isOwner ? "" : <span className="tag muted" style={{ marginLeft: 8 }}>owner only</span>}</h2>
        <div className="muted-sm" style={{ marginBottom: 10 }}>
          A balance that grows every qualifying day a driver works, paid out by ops, and <strong>forfeited if they leave</strong>. The strongest retention lock — paid on top of the 30% share.
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 10 }}>
          <input type="checkbox" checked={wEnabled} disabled={!isOwner} onChange={(e) => setWEnabled(e.target.checked)} style={{ width: "auto" }} />
          Enabled
        </label>
        <div className="form-grid">
          <label>Accrual per qualifying day (₹)
            <input type="number" min={0} value={wPerDay} disabled={!isOwner} onChange={(e) => setWPerDay(e.target.value)} />
          </label>
          <label>Min daily gross to count a day (₹)
            <input type="number" min={0} value={wMinGross} disabled={!isOwner} onChange={(e) => setWMinGross(e.target.value)} />
          </label>
          <label>Accrue from (business date)
            <input type="date" value={wStart} disabled={!isOwner} onChange={(e) => setWStart(e.target.value)} />
          </label>
          <label>Suggested payout every (days)
            <input type="number" min={1} value={wCadence} disabled={!isOwner} onChange={(e) => setWCadence(e.target.value)} />
          </label>
        </div>
        <div className="muted-sm" style={{ marginTop: 6 }}>
          A day counts when that driver's gross ≥ the minimum. At ₹{wPerDay || 0}/day that's about ₹{((Number(wPerDay) || 0) * 26).toLocaleString("en-IN")}/month of lock-in per active driver.
        </div>
        {wErr ? <div className="err">{wErr}</div> : null}
        {wMsg ? <div className="tag ok" style={{ display: "inline-block", marginTop: 10 }}>{wMsg}</div> : null}
        {isOwner ? (
          <div className="form-actions">
            <button className="primary" onClick={saveWallet} disabled={wBusy}>{wBusy ? "Saving…" : "Save loyalty wallet"}</button>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 20, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Payment credentials — Razorpay {isOwner ? "" : <span className="tag muted" style={{ marginLeft: 8 }}>owner only</span>}</h2>

        <div className="muted-sm" style={{ marginBottom: 10 }}>
          Status:{" "}
          <span className={`tag ${data?.payments?.razorpay_enabled ? "live" : "muted"}`}>
            {data?.payments?.razorpay_enabled ? "connected" : "not configured"}
          </span>
          {data?.payments?.source ? <span style={{ marginLeft: 6 }}>· source: {data.payments.source}</span> : null}
        </div>
        <table className="data" style={{ marginBottom: 12 }}>
          <tbody>
            <tr><td>Key ID</td><td style={{ fontFamily: "ui-monospace, monospace" }}>{data?.payments?.razorpay_key_id ?? <span className="muted-sm">—</span>}</td></tr>
            <tr><td>Key Secret</td><td>{data?.payments?.razorpay_key_secret_set ? <span className="tag ok">set</span> : <span className="muted-sm">not set</span>}</td></tr>
            <tr><td>Webhook Secret</td><td>{data?.payments?.razorpay_webhook_secret_set ? <span className="tag ok">set</span> : <span className="muted-sm">not set</span>}</td></tr>
          </tbody>
        </table>

        {isOwner ? (
          <>
            <div className="muted-sm" style={{ marginBottom: 6 }}>Enter new values to rotate. Leave a field blank to keep the current one. Secrets are never shown back.</div>
            <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <label>New Key ID
                <input value={pKeyId} onChange={(e) => setPKeyId(e.target.value)} placeholder="rzp_live_…" autoComplete="off" />
              </label>
              <label>New Key Secret
                <input type="password" value={pKeySecret} onChange={(e) => setPKeySecret(e.target.value)} placeholder="•••••••• (leave blank to keep)" autoComplete="new-password" />
              </label>
              <label>New Webhook Secret
                <input type="password" value={pWebhook} onChange={(e) => setPWebhook(e.target.value)} placeholder="•••••••• (leave blank to keep)" autoComplete="new-password" />
              </label>
            </div>
            <div className="muted-sm" style={{ marginTop: 6 }}>
              After changing the Webhook Secret, update it in Razorpay → Settings → Webhooks (URL: <code>{data?.payments?.webhook_url ?? "/api/webhooks/razorpay"}</code>).
            </div>
            {payErr ? <div className="err">{payErr}</div> : null}
            {payMsg ? <div className="tag ok" style={{ display: "inline-block", marginTop: 10 }}>{payMsg}</div> : null}
            <div className="form-actions">
              <button className="primary" onClick={savePayments} disabled={payBusy}>{payBusy ? "Saving…" : "Update credentials"}</button>
            </div>
          </>
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

function NumField({ label, k, rw, set, dis }: { label: string; k: string; rw: Record<string, string>; set: (k: string, v: string) => void; dis: boolean }) {
  return (
    <label>{label}
      <input type="number" min={0} value={rw[k] ?? ""} disabled={dis} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
}
